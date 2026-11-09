// Окна «Сведения о файле» и «Сравнить с другим файлом»
import { Modal, FuzzySuggestModal, Notice, TFile } from 'obsidian'
import { buildFileInfo, lineDiff, binaryCompare, fmtSize } from './features.js'
import { mapView } from './formats/maps.js'
import { diffView } from './formats/textual.js'
import { decodeText } from './util.js'

const plainCtx = (app, urls) => ({ app, urls, cleanups: [], themeColors: () => ({ bg: getComputedStyle(document.body).getPropertyValue('--background-primary').trim() || '#fff', text: getComputedStyle(document.body).getPropertyValue('--text-normal').trim() || '#222' }), isDark: () => document.body.classList.contains('theme-dark') })

export class FileInfoModal extends Modal {
    constructor(app, file) { super(app); this.file = file; this.urls = [] }
    async onOpen() {
        this.modalEl.addClass('ur-info-modal')
        this.titleEl?.setText?.('Сведения о файле')
        this.contentEl.addClass('ur-root')
        const box = this.contentEl.createDiv({ cls: 'ur-article' })
        box.setText('Читаю файл…')
        try {
            const bytes = await this.app.vault.readBinary(this.file)
            const ctx = plainCtx(this.app, this.urls)
            const el = await buildFileInfo({ file: this.file, bytes, mapView: (c, m) => mapView(c, m), ctx, onCompare: () => { this.close(); pickAndCompare(this.app, this.file) } })
            box.empty(); box.append(el)
        } catch (e) { box.setText('Не удалось прочитать файл: ' + (e?.message || e)) }
    }
    onClose() { for (const u of this.urls) URL.revokeObjectURL(u); this.contentEl.empty() }
}

class FilePicker extends FuzzySuggestModal {
    constructor(app, except, onPick) { super(app); this.except = except; this.onPick = onPick; this.setPlaceholder('С каким файлом сравнить?') }
    getItems() { return this.app.vault.getFiles().filter(f => f !== this.except) }
    getItemText(f) { return f.path }
    onChooseItem(f) { this.onPick(f) }
}
export const pickAndCompare = (app, file) => new FilePicker(app, file, other => new CompareModal(app, file, other).open()).open()

export class CompareModal extends Modal {
    constructor(app, a, b) { super(app); this.a = a; this.b = b }
    async onOpen() {
        this.modalEl.addClass('ur-info-modal')
        this.titleEl?.setText?.('Сравнение файлов')
        this.contentEl.addClass('ur-root')
        const box = this.contentEl.createDiv({ cls: 'ur-article' })
        box.setText('Сравниваю…')
        try {
            const [ba, bb] = await Promise.all([this.app.vault.readBinary(this.a), this.app.vault.readBinary(this.b)])
            const ua = new Uint8Array(ba), ub = new Uint8Array(bb)
            const isText = u => !u.subarray(0, 8000).includes(0)
            box.empty()
            box.createEl('p', { text: `${this.a.path} (${fmtSize(ua.length)}) ↔ ${this.b.path} (${fmtSize(ub.length)})` })
            if (isText(ua) && isText(ub)) {
                const d = lineDiff(decodeText(ua), decodeText(ub), this.a.name, this.b.name)
                if (d === '') { box.createEl('p', { text: binaryCompare(ua, ub).same ? '✅ Файлы совпадают байт в байт.' : '✅ Текст файлов совпадает (различаются только кодировка или переводы строк).' }); return }
                if (d == null) { box.createEl('p', { text: 'Файлы слишком большие или слишком разные для построчного сравнения.' }); return }
                const v = diffView(d); if (typeof v === 'string') box.insertAdjacentHTML('beforeend', v); else box.append(v)
            } else {
                const r = binaryCompare(ua, ub)
                box.createEl('p', { text: r.same ? '✅ Файлы совпадают байт в байт.' : `❌ Файлы различаются: отличается байтов — ${r.diff.toLocaleString('ru-RU')}, первое отличие на позиции ${r.first.toLocaleString('ru-RU')} (0x${r.first.toString(16)}).` })
            }
        } catch (e) { box.setText('Не удалось сравнить: ' + (e?.message || e)) }
    }
    onClose() { this.contentEl.empty() }
}
export { Notice, TFile }
