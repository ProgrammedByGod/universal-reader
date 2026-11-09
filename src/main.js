// Универсальная читалка для Обсидиана — альфа (только чтение)
import { Plugin, Platform, Notice, PluginSettingTab, Setting, normalizePath, TFile } from 'obsidian'
import { ReaderView, VIEW_TYPE } from './view.js'
import { ALL_EXTS, MOBILE_EXCLUDED, FORMAT_LIST, GROUPS, FORMAT_BY_EXT } from './registry.js'
import { LibraryStore } from './store.js'
import { FileInfoModal, pickAndCompare } from './infoModal.js'
import { lang, saveLang, NT } from './i18n.js'
import EMBEDDED_LIBS from 'embedded-libs'
import { LIBS_PACK, LIBS_URL, LibsMissingError } from './libspack.js'

const DEFAULTS = {
    folder: 'reader',
    lang: 'en',
    flow: 'paginated',
    spread: false,
    fontSize: 100,
    width: 'medium',
    zoom: 'fit-page',
    sidebarOpen: false,
    disabledExts: [],
    forcedExts: [],      // спорные расширения, которые пользователь велел забрать у другого плагина
    knownConflicts: [],  // о каких конфликтах уже сообщали (чтобы не напоминать при каждом запуске)
}

export default class UniversalReaderPlugin extends Plugin {
    exts = new Set()
    libCache = new Map()
    takenFromCore = [] // [расширение, чей был вид] — вернём при отключении или выгрузке
    busy = new Map() // расширение -> кем занято

    async onload() {
        this.settings = Object.assign({}, DEFAULTS, await this.loadData())
        // язык уже выбран при загрузке модуля (из localStorage); если там пусто — берём из настроек и перезапускаемся
        if (this.settings.lang !== lang && saveLang(this.settings.lang)) { this.reloadSelf(); return }
        // папка по умолчанию была «Читалка», теперь «reader»: переносим старую папку целиком, если новой ещё нет
        if (this.settings.folder === NT('Читалка')) {
            try {
                const old = this.app.vault.getAbstractFileByPath(NT('Читалка'))
                if (!old) this.settings.folder = DEFAULTS.folder
                else if (!this.app.vault.getAbstractFileByPath(DEFAULTS.folder)) { await this.app.vault.rename(old, DEFAULTS.folder); this.settings.folder = DEFAULTS.folder }
                await this.saveSettings()
            } catch (e) { console.warn('[Reader] folder move', e) }
        }
        this.store = new LibraryStore(this.app, () => this.settings.folder || DEFAULTS.folder)
        await this.store.load()

        this.registerView(VIEW_TYPE, leaf => new ReaderView(leaf, this))
        // Форматы забираем только после загрузки всех плагинов: если расширение уже занято, читалка уступает.
        // Забрать себе такое расширение можно вручную в настройках (блок «Конфликты с другими плагинами»).
        this.app.workspace.onLayoutReady(() => this.registerFormats())
        // ![[файл.epub]] в заметке: карточка файла с кнопками вместо пустой вставки
        this.registerMarkdownPostProcessor?.((el, mctx) => {
            const embeds = el.querySelectorAll('.internal-embed[src]')
            if (!embeds.length) return
            setTimeout(() => { for (const e of embeds) this.renderEmbed(e, mctx.sourcePath) }, 30)
        })

        this.addCommand({
            id: 'open-note-as-book',
            name: 'Открыть текущую заметку как книгу',
            checkCallback: checking => {
                const f = this.app.workspace.getActiveFile()
                if (!f || f.extension !== 'md') return false
                if (!checking) this.openAs(f, { asBook: true })
                return true
            },
        })
        this.addCommand({
            id: 'open-as-hex',
            name: 'Показать файл в шестнадцатеричном виде',
            checkCallback: checking => {
                const f = this.app.workspace.getActiveFile()
                if (!f) return false
                if (!checking) this.openAs(f, { asHex: true })
                return true
            },
        })
        this.addCommand({
            id: 'file-info',
            name: 'Сведения о файле',
            checkCallback: checking => { const f = this.app.workspace.getActiveFile(); if (!f) return false; if (!checking) new FileInfoModal(this.app, f).open(); return true },
        })
        this.addCommand({
            id: 'compare-files',
            name: 'Сравнить текущий файл с другим…',
            checkCallback: checking => { const f = this.app.workspace.getActiveFile(); if (!f) return false; if (!checking) pickAndCompare(this.app, f); return true },
        })
        this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
            if (!(file instanceof TFile)) return
            menu.addItem(i => i.setTitle('Сведения о файле').setIcon('info').onClick(() => new FileInfoModal(this.app, file).open()))
            menu.addItem(i => i.setTitle('Сравнить с другим файлом…').setIcon('git-compare').onClick(() => pickAndCompare(this.app, file)))
            if (file.extension === 'md') menu.addItem(i => i.setTitle('Открыть как книгу').setIcon('book-open').onClick(() => this.openAs(file, { asBook: true })))
            menu.addItem(i => i.setTitle('Показать в шестнадцатеричном виде').setIcon('binary').onClick(() => this.openAs(file, { asHex: true })))
        }))
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.store.rename(oldPath, file.path)))
        this.registerEvent(this.app.workspace.on('css-change', () => {
            for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view?.onCssChange?.()
        }))
        this.addSettingTab(new ReaderSettingTab(this.app, this))
    }

    get reg() { return this.app.viewRegistry }
    isAvailable(ext) { return !(Platform.isMobile && MOBILE_EXCLUDED.includes(ext)) }

    // Забрать расширение себе. Занятое другим плагином забираем, только если force (выбор пользователя).
    claim(ext, force = false) {
        if (this.exts.has(ext)) return true
        const reg = this.reg
        const owner = reg?.typeByExtension?.[ext]
        try {
            if (owner && owner !== VIEW_TYPE) throw new Error('taken')
            if (reg?.registerExtensions) reg.registerExtensions([ext], VIEW_TYPE)
            else this.registerExtensions([ext], VIEW_TYPE)
            this.exts.add(ext); this.busy.delete(ext)
            return true
        } catch (e) {
            // .svg всегда забираем у встроенного просмотра картинок; остальное — только по выбору пользователя
            if (owner && (force || (ext === 'svg' && owner === 'image')) && reg?.unregisterExtensions) {
                try {
                    reg.unregisterExtensions([ext]); reg.registerExtensions([ext], VIEW_TYPE)
                    this.exts.add(ext); this.takenFromCore.push([ext, owner]); this.busy.delete(ext)
                    return true
                } catch (e2) { console.warn(e2) }
            }
            this.busy.set(ext, owner || 'другой плагин')
            return false
        }
    }
    // Кто занял расширение: пробуем угадать плагин по названию его вида
    ownerName(viewType) {
        const ps = Object.values(this.app.plugins?.manifests ?? {})
        const vt = String(viewType).toLowerCase()
        const hit = ps.find(m => m.id && m.id !== this.manifest.id && (vt.includes(m.id.toLowerCase()) || m.id.toLowerCase().includes(vt.replace(/-?view$/, ''))))
        if (hit) return hit.name
        const CORE = { image: 'Обсидиан (картинки)', audio: 'Обсидиан (звук)', video: 'Обсидиан (видео)', pdf: 'Обсидиан (PDF)', markdown: 'Обсидиан (заметки)', canvas: 'Обсидиан (холсты)', bases: 'Обсидиан (базы)' }
        return CORE[viewType] ?? `плагин с видом «${viewType}»`
    }
    // Все спорные расширения: занятые другими и забранные у них вручную (кроме .svg у встроенных картинок)
    conflicts() {
        const out = new Map()
        for (const [ext, owner] of this.busy) if (!this.exts.has(ext)) out.set(ext, owner)
        for (const [ext, owner] of this.takenFromCore) if (!(ext === 'svg' && owner === 'image')) out.set(ext, owner)
        return [...out].filter(([ext]) => !this.settings.disabledExts.includes(ext) && this.isAvailable(ext)).sort((a, b) => a[0].localeCompare(b[0]))
    }
    async setForced(ext, on) {
        const set = new Set(this.settings.forcedExts)
        if (on) { set.add(ext); this.claim(ext, true) }
        else { set.delete(ext); this.release(ext); this.claim(ext) }
        this.settings.forcedExts = [...set]
        await this.saveSettings()
    }
    // После отключения чужого плагина расширение могло освободиться — заберём его
    recheckBusy() { for (const ext of [...this.busy.keys()]) if (!this.reg?.typeByExtension?.[ext]) this.claim(ext) }
    release(ext) {
        if (!this.exts.has(ext)) return
        const reg = this.reg
        try { reg?.unregisterExtensions?.([ext]) } catch (e) { console.warn(e) }
        this.exts.delete(ext)
        const i = this.takenFromCore.findIndex(x => x[0] === ext)
        if (i >= 0) { try { reg.registerExtensions([ext], this.takenFromCore[i][1]) } catch (e) { console.warn(e) } this.takenFromCore.splice(i, 1) }
    }

    renderEmbed(e, sourcePath) {
        if (e.classList.contains('ur-embed-done')) return
        const link = (e.getAttribute('src') || '').replace(/#.*$/, '')
        const file = this.app.metadataCache?.getFirstLinkpathDest?.(link, sourcePath)
        if (!(file instanceof TFile) || !this.exts?.has?.(file.extension.toLowerCase())) return
        const fmt = FORMAT_BY_EXT.get(file.extension.toLowerCase())
        e.empty?.() ?? (e.innerHTML = '')
        e.classList.add('ur-embed-done', 'is-loaded')
        const card = e.createDiv({ cls: 'ur-embed-card' })
        card.createDiv({ cls: 'ur-embed-name', text: file.name })
        const size = file.stat?.size; const kb = size == null ? '' : size < 1048576 ? `${(size / 1024).toFixed(1)} КБ` : `${(size / 1048576).toFixed(1)} МБ`
        card.createDiv({ cls: 'ur-embed-meta', text: [fmt?.name, kb].filter(Boolean).join(' · ') })
        const row = card.createDiv({ cls: 'ur-embed-buttons' })
        const open = row.createEl('button', { cls: 'mod-cta', text: 'Открыть в читалке' })
        open.onclick = ev => { ev.preventDefault(); ev.stopPropagation(); this.app.workspace.getLeaf(ev.ctrlKey || ev.metaKey).openFile(file) }
        const info = row.createEl('button', { text: 'Сведения' })
        info.onclick = ev => { ev.preventDefault(); ev.stopPropagation(); new FileInfoModal(this.app, file).open() }
    }

    registerFormats() {
        for (const ext of ALL_EXTS) {
            if (!this.isAvailable(ext) || this.settings.disabledExts.includes(ext)) continue
            this.claim(ext, this.settings.forcedExts.includes(ext))
        }
        // Сообщаем только о новых конфликтах — один раз, а не при каждом запуске
        const now = this.conflicts().filter(([ext]) => !this.exts.has(ext)).map(([ext]) => ext)
        const fresh = now.filter(e => !this.settings.knownConflicts.includes(e))
        if (fresh.length) {
            new Notice(`Читалка уступила другим плагинам: ${fresh.map(e => '.' + e).join(', ')}. Забрать их себе можно в настройках читалки.`, 10000)
            this.settings.knownConflicts = [...new Set([...this.settings.knownConflicts, ...now])]
            this.saveSettings()
        }
    }

    async setFormatEnabled(f, on) {
        const set = new Set(this.settings.disabledExts)
        for (const ext of f.exts) {
            if (on) { set.delete(ext); if (this.isAvailable(ext)) this.claim(ext, this.settings.forcedExts.includes(ext)) }
            else { set.add(ext); this.release(ext) }
        }
        this.settings.disabledExts = [...set]
        await this.saveSettings()
    }

    onunload() {
        this.store.save()
        const reg = this.reg
        try { reg?.unregisterExtensions?.([...this.exts]) } catch (e) { console.warn(e) }
        for (const [ext, owner] of this.takenFromCore) {
            try { reg.registerExtensions?.([ext], owner) } catch (e) { console.warn(e) }
        }
        this.exts.clear(); this.takenFromCore = []; this.busy.clear()
    }

    async openAs(file, state) {
        const leaf = this.app.workspace.getLeaf(false)
        await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path, ...state }, active: true })
    }

    async saveSettings() { await this.saveData(this.settings) }
    // перезапуск плагина, чтобы применить язык (строки переводятся при загрузке)
    reloadSelf(reopenSettings) {
        const app = this.app, id = this.manifest.id
        setTimeout(async () => {
            await app.plugins.disablePlugin(id)
            await app.plugins.enablePlugin(id)
            if (reopenSettings) { app.setting?.open?.(); app.setting?.openTabById?.(id) }
        }, 50)
    }

    // Тяжёлые библиотеки лежат в папке libs/ рядом с main.js и грузятся только при открытии нужного формата
    // большой двоичный файл из папки libs (.wasm)
    loadAsset(name) {
        const path = normalizePath(`${this.manifest.dir}/libs/${name}`)
        return this.app.vault.adapter.readBinary(path).catch(async () => { throw new LibsMissingError(name, (await this.libsStatus()).installed) })
    }
    // адрес папки внутри libs, чтобы библиотека сама подгружала свои файлы (Ruffle)
    assetBase(dir) {
        const url = this.app.vault.adapter.getResourcePath?.(normalizePath(`${this.manifest.dir}/libs/${dir}/x`))
        if (!url) throw new Error('Обсидиан не дал адрес папки плагина.')
        return url.replace(/[?#].*$/, '').replace(/x$/, '')
    }
    // установлен ли пакет библиотек и подходит ли он: libs/pack.json = { pack, version }
    async libsStatus() {
        const a = this.app.vault.adapter, dir = normalizePath(`${this.manifest.dir}/libs`)
        let info = null
        try { info = JSON.parse(await a.read(dir + '/pack.json')) } catch { /* нет файла */ }
        const installed = info ? true : await a.exists(dir + '/verovio.js').catch(() => false)
        return { installed, version: info?.version ?? null, pack: info?.pack ?? 0, ok: installed && (info?.pack ?? 0) >= LIBS_PACK }
    }
    loadLib(name) {
        if (this.libCache.has(name)) return this.libCache.get(name)
        const p = (async () => {
            let code = EMBEDDED_LIBS[name]
            if (!code) {
                const path = normalizePath(`${this.manifest.dir}/libs/${name}.js`)
                try { code = await this.app.vault.adapter.read(path) }
                catch { throw new LibsMissingError(name + '.js', (await this.libsStatus()).installed) }
            }
            const module = { exports: {} }
            const req = () => ({})
            // библиотеки собраны для браузера: прячем от них Node-окружение Обсидиана (process, Buffer, global)
            new Function('module', 'exports', 'require', 'process', 'Buffer', 'global', code)(module, module.exports, req, undefined, undefined, undefined)
            return module.exports
        })()
        p.catch(() => this.libCache.delete(name))
        this.libCache.set(name, p)
        return p
    }
}

class ReaderSettingTab extends PluginSettingTab {
    constructor(app, plugin) { super(app, plugin); this.plugin = plugin; this.query = ''; this.open = new Set() }
    display() {
        const { containerEl: c } = this
        const p = this.plugin
        c.empty()
        c.addClass('ur-settings')
        c.createEl('h2', { text: 'Универсальная читалка (альфа)' })
        new Setting(c).setName(NT('Language / Язык'))
            .setDesc(NT('Interface language. The plugin restarts to apply it. · Язык интерфейса, плагин перезапустится.'))
            .addDropdown(d => d.addOption('en', 'English').addOption('ru', NT('Русский')).setValue(p.settings.lang).onChange(async v => {
                p.settings.lang = v; await p.saveSettings(); saveLang(v); p.reloadSelf(true)
            }))
        const libs = new Setting(c).setName('Пакет библиотек').setDesc('Проверяю…')
        p.libsStatus().then(st => {
            libs.setDesc(st.ok ? `Установлен (версия ${st.version}). Открываются все форматы.`
                : st.installed ? 'Установлен устаревший пакет. Скачайте новый и замените им папку libs в папке плагина.'
                : 'Не установлен. Популярные форматы (Word, Excel, PowerPoint, TIFF, DjVu, RAR, SQLite, 3D-модели) встроены и открываются и так. Пакет нужен для редких тяжёлых: 7z, HEIC, RTF, ноты, CAD, научные данные, Flash и другие. Скачайте его с GitHub и положите папку libs в папку плагина.')
            if (!st.ok) libs.addButton(b => b.setButtonText('Скачать с GitHub').onClick(() => window.open(LIBS_URL)))
        })
        new Setting(c).setName('Папка для данных чтения')
            .setDesc('Здесь хранится library.json с местом чтения каждого файла.')
            .addText(t => t.setValue(p.settings.folder).onChange(async v => {
                p.settings.folder = v.trim() || DEFAULTS.folder
                await p.saveSettings()
            }))

        p.recheckBusy()
        const conflicts = p.conflicts()
        if (conflicts.length) {
            c.createEl('h3', { text: 'Конфликты с другими плагинами' })
            c.createEl('p', { cls: 'setting-item-description', text: 'Эти расширения уже открывает другой плагин, поэтому читалка их уступила. Включите переключатель, чтобы такой файл открывала читалка; выключите — и расширение вернётся прежнему плагину. Уже открытые вкладки нужно открыть заново.' })
            const box = c.createDiv({ cls: 'ur-set-conflicts' })
            for (const [ext, owner] of conflicts) {
                const f = FORMAT_BY_EXT.get(ext)
                const mine = p.exts.has(ext)
                new Setting(box).setName('.' + ext)
                    .setDesc(`${f ? f.name + ' · ' : ''}${mine ? 'Сейчас открывает читалка (до этого — ' : 'Сейчас открывает: '}${p.ownerName(owner)}${mine ? ')' : ''}`)
                    .addToggle(t => t.setValue(mine).onChange(async v => { await p.setForced(ext, v); this.display() }))
            }
        }

        c.createEl('h3', { text: 'Форматы' })
        c.createEl('p', { cls: 'setting-item-description', text: 'Выключенный формат читалка не забирает себе — такие файлы откроет Обсидиан или другой плагин. Если расширение уже занято другим плагином, читалка ему уступает (см. «Конфликты» выше). Изменения действуют сразу; уже открытые вкладки нужно открыть заново.' })
        const total = ALL_EXTS.filter(e => p.isAvailable(e)).length
        const summary = c.createEl('p', { cls: 'ur-set-summary' })
        const updateSummary = () => { summary.textContent = `Включено расширений: ${p.exts.size} из ${total}${Platform.isMobile ? ' (на телефоне тяжёлые форматы недоступны)' : ''}.` }
        updateSummary()

        const bar = c.createDiv({ cls: 'ur-set-bar' })
        const search = bar.createEl('input', { type: 'search', attr: { placeholder: 'Найти формат: например, fb2 или карты' } })
        search.value = this.query
        const allOn = bar.createEl('button', { text: 'Включить все' })
        const allOff = bar.createEl('button', { text: 'Выключить все' })
        const list = c.createDiv({ cls: 'ur-set-list' })

        const isOn = f => f.exts.some(e => p.exts.has(e))
        const render = () => {
            list.empty()
            const q = this.query.trim().toLowerCase().replace(/^\./, '')
            for (const [gid, gname] of GROUPS) {
                const items = FORMAT_LIST.filter(f => f.group === gid).filter(f => !q
                    || f.exts.some(e => e.startsWith(q)) || f.name.toLowerCase().includes(q) || f.desc.toLowerCase().includes(q) || gname.toLowerCase().includes(q))
                if (!items.length) continue
                const det = list.createEl('details', { cls: 'ur-set-group' })
                det.open = !!q || this.open.has(gid)
                det.addEventListener('toggle', () => { if (!q) det.open ? this.open.add(gid) : this.open.delete(gid) })
                const sum = det.createEl('summary')
                sum.createSpan({ cls: 'ur-set-gname', text: gname })
                const cnt = sum.createSpan({ cls: 'ur-set-count' })
                const gToggle = sum.createEl('button', { cls: 'ur-set-gbtn' })
                const updateGroup = () => {
                    const on = items.filter(isOn).length
                    cnt.textContent = ` ${on} из ${items.length}`
                    gToggle.textContent = on === items.length ? 'Выключить группу' : 'Включить группу'
                }
                gToggle.onclick = async e => {
                    e.preventDefault(); e.stopPropagation()
                    const turnOn = items.filter(isOn).length !== items.length
                    for (const f of items) await p.setFormatEnabled(f, turnOn)
                    render(); updateSummary()
                }
                updateGroup()
                for (const f of items) {
                    const avail = f.exts.filter(e => p.isAvailable(e))
                    const s = new Setting(det).setName(f.name)
                    const d = createFragment(fr => {
                        fr.createDiv({ text: f.desc })
                        fr.createDiv({ cls: 'ur-set-exts', text: f.exts.map(e => '.' + e).join('  ') })
                        const notes = []
                        if (Platform.isMobile && avail.length < f.exts.length) notes.push(avail.length ? 'На телефоне недоступны: ' + f.exts.filter(e => !avail.includes(e)).map(e => '.' + e).join(', ') : 'На телефоне недоступен — слишком тяжёлый')
                        else if (!Platform.isMobile && f.heavy) notes.push('На телефоне не включается — слишком тяжёлый')
                        const busy = f.exts.filter(e => p.busy.has(e) && !p.exts.has(e))
                        if (busy.length) notes.push('Уступлены другому плагину: ' + busy.map(e => `.${e} (${p.ownerName(p.busy.get(e))})`).join(', ') + ' — забрать можно в блоке «Конфликты»')
                        if (notes.length) fr.createDiv({ cls: 'ur-set-note', text: notes.join('. ') })
                    })
                    s.setDesc(d)
                    s.addToggle(t => t.setValue(isOn(f)).setDisabled(!avail.length).onChange(async v => {
                        await p.setFormatEnabled(f, v)
                        updateGroup(); updateSummary()
                        if (v && f.exts.some(e => p.busy.has(e) && !p.exts.has(e))) render()
                    }))
                }
            }
            if (!list.childElementCount) list.createEl('p', { cls: 'setting-item-description', text: 'Ничего не найдено.' })
        }
        search.addEventListener('input', () => { this.query = search.value; render() })
        allOn.onclick = async () => { for (const f of FORMAT_LIST) await p.setFormatEnabled(f, true); render(); updateSummary() }
        allOff.onclick = async () => { for (const f of FORMAT_LIST) await p.setFormatEnabled(f, false); render(); updateSummary() }
        render()
    }
}
