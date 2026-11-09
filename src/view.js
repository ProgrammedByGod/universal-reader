// Окно читалки: панель инструментов, боковая панель (оглавление, поиск), строка состояния
import { LIBS_URL } from './libspack.js'
import { FileView, setIcon, Platform, MarkdownRenderer, sanitizeHTMLToDom, Notice, Modal } from 'obsidian'
import { openRenderer } from './open.js'
import { debounce, escapeHtml, extOf } from './util.js'
import { bytesOpener } from './formats/textual.js'
import { softFallback, tableToMarkdown, htmlToMarkdown } from './features.js'

const ENCODINGS = [['', 'Кодировка: авто'], ['utf-8', 'UTF-8'], ['windows-1251', 'Windows-1251'], ['koi8-r', 'KOI8-R'], ['ibm866', 'DOS (866)'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE'], ['windows-1252', 'Windows-1252'], ['iso-8859-5', 'ISO-8859-5'], ['x-mac-cyrillic', 'Mac Cyrillic'], ['koi8-u', 'KOI8-U']]

export const VIEW_TYPE = 'universal-reader-view'

const ZOOMS = [['fit-width', 'По ширине'], ['fit-page', 'По странице'], [50, '50%'], [75, '75%'], [100, '100%'], [125, '125%'], [150, '150%'], [200, '200%'], [300, '300%']]
const WIDTHS = [['narrow', 'Узко'], ['medium', 'Средне'], ['wide', 'Широко'], ['full', 'Во всю ширину'], ['spread', 'Две колонки']]

export class ReaderView extends FileView {
    asBook = false
    constructor(leaf, plugin) {
        super(leaf)
        this.plugin = plugin
        this.navigation = true
    }
    getViewType() { return VIEW_TYPE }
    getDisplayText() { return (this.file?.basename ?? 'Читалка') + (this.asHex ? ' (hex)' : '') }
    getIcon() { return 'book-open' }
    canAcceptExtension(ext) { return this.plugin.exts.has(ext) }
    async setState(state, result) {
        this.asBook = !!state?.asBook
        this.asHex = !!state?.asHex
        return super.setState(state, result)
    }
    getState() { return { ...super.getState(), asBook: this.asBook, asHex: this.asHex } }

    get settings() { return this.plugin.settings }

    async onLoadFile(file) {
        this.urls = []
        bytesOpener.fn = (bytes, name) => this.openBytesModal(bytes, name)
        this.buildShell()
        const ext = this.asBook ? 'md' : file.extension.toLowerCase()
        const ctx = this.makeCtx(file)
        this.ctx = ctx
        this.stage.replaceChildren(this.message('Открываю…'))
        try {
            const r = await openRenderer(ctx, file, ext, { asBook: this.asBook, asHex: this.asHex })
            if (this.file !== file) { r.destroy(); return }
            this.renderer = r
            this.stage.querySelector('.ur-message')?.remove()
            this.setupToolbar()
            this.buildToc()
            const pos = this.plugin.store.getPosition(this.posKey(file))
            await r.start(pos)
        } catch (e) {
            if (e?.libsMissing) { this.stage.replaceChildren(this.libsPanel(e)); return }
            console.error('[Читалка]', e)
            this.stage.replaceChildren(this.message('Не удалось открыть файл.\n\n' + (e?.message || e), true))
            // мягкий режим: вместо одной ошибки — что удалось узнать, текстовые строки и байты
            if (!this.asHex) try { const box = await softFallback(file, () => this.app.vault.readBinary(file), e, () => this.plugin.openAs(file, { asHex: true })); if (this.file === file) { box.classList.add('ur-scroll'); this.stage.replaceChildren(box) } } catch { /* остаётся сообщение */ }
        }
    }

    // открыть файл из архива или вложение письма в отдельном окне читалки
    openBytesModal(bytes, name) {
        const view = this
        const modal = new Modal(this.app)
        modal.modalEl.addClass('ur-bytes-modal')
        modal.titleEl?.setText?.(name)
        const root = modal.contentEl.createDiv({ cls: 'ur-root ur-nested' })
        const bar = root.createDiv({ cls: 'ur-toolbar' })
        const stage = root.createDiv({ cls: 'ur-body' }).createDiv({ cls: 'ur-stage' })
        const urls = [], cleanups = []
        let r = null
        const ext = extOf(name)
        const vfile = { name, basename: name.replace(/\.[^.]+$/, ''), extension: ext, path: (this.file?.path ?? '') + '/' + name, parent: this.file?.parent, stat: { size: bytes.length }, _bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
        const savedCleanups = this.cleanups
        const ctx = { ...this.makeCtx(vfile), urls, cleanups, file: vfile, mount: el => stage.append(el), onRelocate: () => {}, onHistory: () => {}, onZoomWheel: () => {}, onKey: () => {}, get settings() { return { ...view.settings, flow: 'scrolled', spread: false } } }
        this.cleanups = savedCleanups
        modal.onOpen = async () => {
            stage.replaceChildren(this.message('Открываю…'))
            try {
                r = await openRenderer(ctx, vfile, ext.toLowerCase(), {})
                stage.querySelector('.ur-message')?.remove()
                if (r.caps?.pages || r.caps?.flow) { this.button(bar, 'chevron-left', 'Назад', () => r.prev()); this.button(bar, 'chevron-right', 'Вперёд', () => r.next()) }
                await r.start(null)
            } catch (e) { stage.replaceChildren(e?.libsMissing ? this.libsPanel(e) : this.message('Не удалось открыть файл.\n\n' + (e?.message || e), true)) }
        }
        modal.onClose = () => { try { r?.destroy() } catch { /* ignore */ } for (const u of urls) URL.revokeObjectURL(u); for (const f of cleanups) { try { f() } catch { /* ignore */ } } }
        modal.open()
    }
    async onUnloadFile(file) {
        this.savePosition.flush?.()
        try { this.renderer?.clearSearch?.() } catch { /* ignore */ }
        this.renderer?.destroy()
        this.renderer = null
        for (const u of this.urls ?? []) URL.revokeObjectURL(u)
        for (const fn of this.cleanups ?? []) { try { fn() } catch { /* ignore */ } }
        this.cleanups = []
        this.urls = []
        this.contentEl.empty()
    }
    async onClose() { this.savePosition?.flush?.() }

    posKey(file) { return (this.asBook ? 'book:' : this.asHex ? 'hex:' : '') + file.path }

    makeCtx(file) {
        const view = this
        return {
            app: this.app,
            file,
            get settings() { return view.settings },
            urls: this.urls,
            cleanups: this.cleanups = [],
            mount: el => this.stage.append(el),
            loadLib: name => this.plugin.loadLib(name),
            loadAsset: name => this.plugin.loadAsset(name),
            assetBase: dir => this.plugin.assetBase(dir),
            renderMarkdown: (md, el, path) => MarkdownRenderer.render(this.app, md, el, path ?? file.path, this),
            sanitize: html => sanitizeHTMLToDom(html),
            themeColors: () => this.themeColors(),
            isDark: () => document.body.classList.contains('theme-dark'),
            onRelocate: info => this.onRelocate(info),
            onKey: (e, scrollable) => this.onKey(e, scrollable),
            onHistory: () => this.updateHistoryButtons(),
            onZoomWheel: dy => this.changeScale(dy < 0 ? 1 : -1),
            encoding: this.encoding || '',
            openBytes: (bytes, name) => this.openBytesModal(bytes, name),
        }
    }

    themeColors() {
        const cs = getComputedStyle(document.body)
        const v = (name, fb) => cs.getPropertyValue(name).trim() || fb
        return {
            bg: v('--background-primary', '#fff'),
            text: v('--text-normal', '#222'),
            accent: v('--text-accent', '#7b6cd9'),
            selection: v('--text-selection', 'rgba(120,120,255,.3)'),
        }
    }

    // нет пакета библиотек: объясняем и даём ссылку (сами ничего не скачиваем)
    libsPanel(e) {
        const d = document.createElement('div')
        d.className = 'ur-message ur-libs-missing'
        d.createEl('h3', { text: e.outdated ? 'Нужен новый пакет библиотек' : 'Нужен пакет библиотек' })
        d.createEl('p', { text: e.outdated
            ? 'Для этого формата нужна библиотека, которой нет в установленном пакете. Скачайте свежий пакет и замените им папку libs.'
            : 'Этот формат открывается с помощью дополнительной библиотеки. Она большая, поэтому её нет в версии из каталога Обсидиана — пакет таких библиотек нужно скачать отдельно.' })
        const ol = d.createEl('ol')
        ol.createEl('li', { text: 'Скачайте архив universal-reader-libs с GitHub (кнопка ниже).' })
        ol.createEl('li', { text: `Распакуйте его в папку плагина: ${this.plugin.manifest.dir}/ — там появится папка libs.` })
        ol.createEl('li', { text: 'Откройте файл заново (перезапускать Обсидиан не нужно).' })
        const b = d.createEl('button', { cls: 'mod-cta', text: 'Скачать с GitHub' })
        b.onclick = () => window.open(LIBS_URL)
        return d
    }

    message(text, isError) {
        const d = document.createElement('div')
        d.className = 'ur-message' + (isError ? ' is-error' : '')
        d.textContent = text
        return d
    }

    // ---------- каркас интерфейса ----------
    buildShell() {
        const c = this.contentEl
        c.empty()
        c.addClass('ur-root')
        this.toolbar = c.createDiv({ cls: 'ur-toolbar' })
        const body = c.createDiv({ cls: 'ur-body' })
        this.sidebar = body.createDiv({ cls: 'ur-sidebar' })
        this.stage = body.createDiv({ cls: 'ur-stage' })
        this.status = c.createDiv({ cls: 'ur-status' })
        this.statusLabel = this.status.createSpan({ cls: 'ur-status-label' })
        this.statusProgress = this.status.createSpan({ cls: 'ur-status-progress' })
        this.savePosition = debounce(() => {
            if (!this.renderer || !this.file) return
            const pos = this.renderer.getPosition?.()
            if (pos) this.plugin.store.setPosition(this.posKey(this.file), pos)
        }, 1500)
        this.contentEl.onkeydown = e => this.onKey(e, false, true)
        if (this.settings.sidebarOpen && !Platform.isMobile) this.sidebar.addClass('is-open')
    }

    button(parent, icon, label, onClick, cls = '') {
        const b = parent.createEl('button', { cls: 'clickable-icon ur-btn ' + cls, attr: { 'aria-label': label, title: label } })
        setIcon(b, icon)
        b.addEventListener('click', e => { e.preventDefault(); onClick(b) })
        return b
    }
    select(parent, options, value, onChange, label) {
        const s = parent.createEl('select', { cls: 'dropdown ur-select', attr: { 'aria-label': label, title: label } })
        for (const [v, t] of options) s.createEl('option', { value: String(v), text: t })
        s.value = String(value)
        s.addEventListener('change', () => onChange(s.value))
        return s
    }

    setupToolbar() {
        const r = this.renderer
        const caps = r.caps
        const t = this.toolbar
        t.empty()
        const left = t.createDiv({ cls: 'ur-tb-group' })
        if (caps.toc || caps.search) this.button(left, 'list', 'Оглавление и поиск', () => this.toggleSidebar())
        if (caps.history) {
            this.backBtn = this.button(left, 'arrow-left', 'Назад по переходам', () => r.back())
            this.fwdBtn = this.button(left, 'arrow-right', 'Вперёд по переходам', () => r.forward())
            this.updateHistoryButtons()
        }
        const nav = t.createDiv({ cls: 'ur-tb-group ur-tb-nav' })
        this.button(nav, 'chevron-left', 'Назад', () => r.prev())
        if (caps.pages) {
            this.pageInput = nav.createEl('input', { cls: 'ur-page-input', attr: { type: 'text', inputmode: 'numeric', title: 'Номер страницы — введите и нажмите Enter' } })
            this.pageTotal = nav.createSpan({ cls: 'ur-page-total' })
            this.pageInput.addEventListener('keydown', e => {
                e.stopPropagation()
                if (e.key === 'Enter') { const n = parseInt(this.pageInput.value, 10); if (n > 0) r.goToPage(n); this.pageInput.blur() }
            })
        }
        this.button(nav, 'chevron-right', 'Вперёд', () => r.next())

        const right = t.createDiv({ cls: 'ur-tb-group ur-tb-right' })
        const s = this.settings
        if (caps.flow) {
            const opts = [['paginated', 'Постранично'], ['scrolled', 'Прокрутка']]
            if (caps.spread) opts.push(['spread', 'Разворот'])
            const cur = s.flow === 'scrolled' ? 'scrolled' : (caps.spread && s.spread ? 'spread' : 'paginated')
            this.flowSelect = this.select(right, opts, cur, v => {
                if (v === 'spread') this.update({ flow: 'paginated', spread: true })
                else this.update({ flow: v, spread: false })
            }, 'Режим чтения')
        }
        if (caps.fontSize) {
            const g = right.createDiv({ cls: 'ur-font' })
            this.button(g, 'minus', 'Уменьшить шрифт', () => this.changeScale(-1))
            this.fontLabel = g.createSpan({ cls: 'ur-font-label', text: s.fontSize + '%' })
            this.button(g, 'plus', 'Увеличить шрифт', () => this.changeScale(1))
        }
        if (caps.width) this.select(right, WIDTHS, s.width, v => this.update({ width: v }), 'Ширина страницы')
        if (caps.zoom) this.zoomSelect = this.select(right, ZOOMS, s.zoom, v => this.update({ zoom: isNaN(Number(v)) ? v : Number(v) }), 'Масштаб')
        if (caps.invert) this.button(right, 'contrast', 'Инвертировать цвета (тёмная тема)', b => {
            r.setInverted(!r.inverted); b.toggleClass('is-active', r.inverted)
        }, r.inverted ? 'is-active' : '')
        if (caps.modes) {
            this.select(right, r.modeOptions ?? [['rendered', 'Вид'], ['source', 'Код']], r.mode, async v => { r.clearSearch?.(); await r.setMode(v) }, 'Отображение')
        }
        if (caps.scripts) {
            const b = right.createEl('button', { cls: 'ur-text-btn', text: 'Скрипты: выкл', attr: { title: 'Разрешить JavaScript на странице (в песочнице)' } })
            b.onclick = async () => { await r.setScripts(!r.scripts); b.setText(r.scripts ? 'Скрипты: вкл' : 'Скрипты: выкл'); b.toggleClass('is-active', r.scripts) }
        }
        if (this.ctx?.usedText && !this.asHex) this.select(right, ENCODINGS, this.encoding || '', async v => { this.encoding = v; const f = this.file; await this.onUnloadFile(f); await this.onLoadFile(f) }, 'Кодировка текста (если буквы показываются неправильно)')
        if (r.sheets || r.currentDoc || r.el?.querySelector?.('.ur-article, table, .ur-media-wrap, .ur-sysinfo, p, h1, h2')) this.button(right, 'clipboard-copy', r.currentDoc ? 'Скопировать главу как Markdown' : 'Скопировать как Markdown', () => this.copyMarkdown())
        if (caps.search) this.button(right, 'search', 'Поиск (Ctrl+F)', () => this.openSearch())
        this.button(right, 'maximize', 'Полный экран', () => this.toggleFullscreen())
    }

    async copyMarkdown() {
        const r = this.renderer
        let md = ''
        if (r?.sheets) md = tableToMarkdown(r.sheets[r.cur ?? 0].rows.slice(0, 5000))
        else if (r?.currentDoc) { const d = r.currentDoc(); if (d) md = htmlToMarkdown(d) }
        else if (r?.el) md = htmlToMarkdown(r.searchRoot ?? r.el)
        if (!md) { new Notice('Здесь нечего копировать как Markdown.'); return }
        try { await navigator.clipboard.writeText(md); new Notice('Скопировано как Markdown') } catch { new Notice('Не удалось скопировать в буфер обмена') }
    }

    update(patch) {
        Object.assign(this.settings, patch)
        this.plugin.saveSettings()
        this.renderer?.applySettings(this.settings)
        if (this.fontLabel) this.fontLabel.setText(this.settings.fontSize + '%')
        if (this.zoomSelect) this.zoomSelect.value = String(this.settings.zoom)
        if (this.flowSelect) this.flowSelect.value = this.settings.flow === 'scrolled' ? 'scrolled' : (this.renderer?.caps.spread && this.settings.spread ? 'spread' : 'paginated')
    }
    changeScale(dir) {
        const r = this.renderer
        if (!r) return
        if (r.caps.fontSize) {
            const steps = [60, 70, 80, 90, 100, 110, 120, 130, 150, 170, 200, 250]
            const cur = this.settings.fontSize
            const i = steps.findIndex(x => x >= cur)
            const next = steps[Math.max(0, Math.min(steps.length - 1, (i < 0 ? steps.length - 1 : i) + dir))]
            this.update({ fontSize: next })
        } else if (r.caps.zoom) {
            const nums = [50, 75, 100, 125, 150, 200, 300]
            const z = this.settings.zoom
            const cur = typeof z === 'number' ? z : 100
            const i = nums.indexOf(cur)
            this.update({ zoom: nums[Math.max(0, Math.min(nums.length - 1, (i < 0 ? 2 : i) + dir))] })
        }
    }
    updateHistoryButtons() {
        if (!this.backBtn || !this.renderer) return
        this.backBtn.toggleClass('is-disabled', !this.renderer.canGoBack)
        this.fwdBtn.toggleClass('is-disabled', !this.renderer.canGoForward)
    }

    onRelocate(info) {
        this.lastInfo = info
        const pct = Math.round((info.fraction ?? 0) * 100)
        this.statusProgress.setText(`${pct}%`)
        this.statusLabel.setText(info.label ?? '')
        if (this.pageInput && document.activeElement !== this.pageInput) this.pageInput.value = info.page ? String(info.page) : ''
        if (this.pageTotal) this.pageTotal.setText(info.pages ? `/ ${info.approx ? '≈' : ''}${info.pages}` : '')
        if (this.pageTotal) this.pageTotal.title = info.approx ? 'Страницы ещё пересчитываются под текущий шрифт и размер окна' : ''
        if (info.local) this.statusLabel.setText(`Примечания, стр. ${info.local}`)
        if (info.tocHref && this.tocEl) {
            for (const a of this.tocEl.querySelectorAll('.is-current')) a.removeClass('is-current')
            const cur = this.tocEl.querySelector(`[data-href="${CSS.escape(String(info.tocHref))}"]`)
            if (cur) cur.addClass('is-current')
        }
        this.savePosition()
    }

    onKey(e, scrollable, fromRoot) {
        const tag = (e.target?.tagName || '').toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return
        const r = this.renderer
        if (!r) return
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && r.caps.search) { e.preventDefault(); this.openSearch(); return }
        if (e.key === 'Escape' && this.sidebar.hasClass('is-open') && !Platform.isMobile) return
        if (scrollable || (fromRoot && r.el?.classList.contains('ur-scroll'))) {
            if (e.key === 'PageDown') { e.preventDefault(); r.next() }
            if (e.key === 'PageUp') { e.preventDefault(); r.prev() }
            return
        }
        if (['ArrowRight', 'PageDown', ' '].includes(e.key) && !(e.key === ' ' && this.settings.flow === 'scrolled')) { e.preventDefault(); r.next() }
        else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); r.prev() }
        else if (e.key === 'Home' && r.goToFraction) { e.preventDefault(); r.goToFraction(0) }
        else if (e.key === 'End' && r.goToFraction) { e.preventDefault(); r.goToFraction(1) }
    }

    toggleFullscreen() {
        if (document.fullscreenElement) document.exitFullscreen()
        else this.contentEl.requestFullscreen?.().catch(() => new Notice('Полноэкранный режим недоступен'))
    }

    // ---------- боковая панель ----------
    toggleSidebar(force) {
        const open = force ?? !this.sidebar.hasClass('is-open')
        this.sidebar.toggleClass('is-open', open)
        if (!Platform.isMobile) { this.settings.sidebarOpen = open; this.plugin.saveSettings() }
    }
    buildToc() {
        const sb = this.sidebar
        sb.empty()
        const r = this.renderer
        if (!r.caps.toc && !r.caps.search) { sb.removeClass('is-open'); return }
        const tabs = sb.createDiv({ cls: 'ur-sb-tabs' })
        this.tocPane = sb.createDiv({ cls: 'ur-sb-pane ur-toc-pane' })
        this.searchPane = sb.createDiv({ cls: 'ur-sb-pane ur-search-pane' })
        const tocTab = tabs.createEl('button', { text: 'Оглавление' })
        const searchTab = tabs.createEl('button', { text: 'Поиск' })
        const show = which => {
            tocTab.toggleClass('is-active', which === 'toc'); searchTab.toggleClass('is-active', which === 'search')
            this.tocPane.toggle(which === 'toc'); this.searchPane.toggle(which === 'search')
        }
        this.showPane = show
        tocTab.onclick = () => show('toc'); searchTab.onclick = () => show('search')
        if (Platform.isMobile) {
            const close = tabs.createEl('button', { cls: 'ur-sb-close', attr: { 'aria-label': 'Закрыть' } })
            setIcon(close, 'x'); close.onclick = () => this.toggleSidebar(false)
        }
        if (!r.caps.search) searchTab.hide()
        // оглавление
        const toc = r.caps.toc ? r.getToc() : []
        if (!toc.length) this.tocPane.createDiv({ cls: 'ur-empty', text: 'Оглавления нет' })
        else {
            this.tocEl = this.tocPane.createEl('ul', { cls: 'ur-toc' })
            const add = (ul, items, depth) => {
                for (const it of items) {
                    const li = ul.createEl('li')
                    const a = li.createEl('a', { text: it.label, cls: 'ur-toc-item' })
                    a.style.paddingLeft = (6 + depth * 14) + 'px'
                    if (typeof it.target === 'string' || typeof it.target === 'number') a.dataset.href = String(it.target)
                    a.onclick = () => { r.goTo(it.target); if (Platform.isMobile) this.toggleSidebar(false) }
                    if (it.subitems?.length) add(li.createEl('ul'), it.subitems, depth + 1)
                }
            }
            add(this.tocEl, toc, 0)
        }
        // поиск
        const form = this.searchPane.createDiv({ cls: 'ur-search-form' })
        this.searchInput = form.createEl('input', { attr: { type: 'search', placeholder: 'Искать в тексте…' } })
        const go = form.createEl('button', { text: 'Найти' })
        this.searchInfo = this.searchPane.createDiv({ cls: 'ur-search-info' })
        this.searchResults = this.searchPane.createDiv({ cls: 'ur-search-results' })
        const run = () => this.runSearch(this.searchInput.value)
        go.onclick = run
        this.searchInput.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') run() })
        show(toc.length || !r.caps.search ? 'toc' : 'search')
    }
    openSearch() {
        this.toggleSidebar(true)
        this.showPane?.('search')
        setTimeout(() => this.searchInput?.focus(), 30)
    }
    async runSearch(query) {
        const r = this.renderer
        if (!r?.caps.search || !this.searchResults) return
        const token = Symbol(); this.searchToken = token
        this.searchResults.empty()
        r.clearSearch?.()
        if (!query.trim()) { this.searchInfo.setText(''); return }
        this.searchInfo.setText('Ищу…')
        let count = 0
        try {
            for await (const res of r.search(query)) {
                if (this.searchToken !== token) return
                if (res.progress != null) { this.searchInfo.setText(`Ищу… ${Math.round(res.progress * 100)}%`); continue }
                if (res.label) this.searchResults.createDiv({ cls: 'ur-search-group', text: res.label })
                for (const it of res.items ?? []) {
                    count++
                    const row = this.searchResults.createDiv({ cls: 'ur-search-hit' })
                    const ex = it.excerpt
                    if (typeof ex === 'string') row.setText(ex)
                    else if (ex) row.innerHTML = `${escapeHtml(ex.pre)}<mark>${escapeHtml(ex.match)}</mark>${escapeHtml(ex.post)}`
                    row.onclick = () => {
                        for (const x of this.searchResults.querySelectorAll('.is-active')) x.removeClass('is-active')
                        row.addClass('is-active')
                        r.goToResult(it.target)
                        if (Platform.isMobile) this.toggleSidebar(false)
                    }
                }
            }
            if (this.searchToken === token) this.searchInfo.setText(count ? `Найдено: ${count}` : 'Ничего не найдено')
        } catch (e) {
            console.error(e)
            this.searchInfo.setText('Ошибка поиска: ' + (e?.message || e))
        }
    }
    onCssChange() { this.renderer?.applySettings(this.settings) }
}
