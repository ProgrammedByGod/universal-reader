// Минимальная подделка API Обсидиана для проверки в обычном браузере
const P = HTMLElement.prototype
const applyOpts = (el, o = {}) => {
    if (typeof o === 'string') o = { cls: o }
    if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(' ') : o.cls
    if (o.text != null) el.textContent = o.text
    if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v)
    if (o.value != null) el.value = o.value
    if (o.type) el.type = o.type
    return el
}
P.createEl = function (tag, o, cb) { const el = applyOpts(document.createElement(tag), o); this.append(el); cb?.(el); return el }
P.createDiv = function (o, cb) { return this.createEl('div', o, cb) }
P.createSpan = function (o, cb) { return this.createEl('span', o, cb) }
P.empty = function () { this.innerHTML = '' }
P.addClass = function (...c) { this.classList.add(...c) }
P.removeClass = function (...c) { this.classList.remove(...c) }
P.toggleClass = function (c, v) { this.classList.toggle(c, v) }
P.hasClass = function (c) { return this.classList.contains(c) }
P.setText = function (t) { this.textContent = t }
P.hide = function () { this.style.display = 'none' }
P.show = function () { this.style.display = '' }
P.toggle = function (v) { this.style.display = v ? '' : 'none' }

export const Platform = { isMobile: !!window.__mobile, isDesktop: !window.__mobile }
export class Notice { constructor(m) { console.log('[Notice]', m) } }
export const normalizePath = p => p.replace(/\/+/g, '/').replace(/^\/|\/$/g, '')
export class TFile {}
window.TFileShim = TFile
export const setIcon = (el, name) => { el.textContent = ({ list: '☰', 'arrow-left': '←', 'arrow-right': '→', 'chevron-left': '‹', 'chevron-right': '›', minus: '−', plus: '+', contrast: '◐', search: '🔍', maximize: '⛶', x: '×' })[name] ?? name }
export const sanitizeHTMLToDom = html => {
    const t = document.createElement('template'); t.innerHTML = html
    t.content.querySelectorAll('script').forEach(s => s.remove())
    return t.content
}
export const MarkdownRenderer = {
    async render(app, md, el) {
        const fence = /^(~{3,}|`{3,})(\S*)\n([\s\S]*?)\n\1\s*$/.exec(md)
        if (fence) {
            const pre = document.createElement('pre'); const code = document.createElement('code')
            code.className = 'language-' + fence[2]; code.textContent = fence[3]; pre.append(code); el.append(pre); return
        }
        // очень простой markdown
        const html = md.split(/\n{2,}/).map(b => {
            const h = /^(#{1,6})\s+(.*)/.exec(b)
            if (h) return `<h${h[1].length}>${h[2]}</h${h[1].length}>`
            if (/^\|/.test(b)) return '<table>' + b.split('\n').filter(l => !/^\|[-| ]+\|$/.test(l)).map(l => '<tr>' + l.split('|').slice(1, -1).map(c => `<td>${c.trim()}</td>`).join('') + '</tr>').join('') + '</table>'
            return `<p>${b.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>')}</p>`
        }).join('')
        el.insertAdjacentHTML('beforeend', html)
    },
}
export class Component { load() {} unload() {} register() {} }
export class Plugin {
    constructor(app, manifest) { this.app = app; this.manifest = manifest; this.views = {}; this.extMap = {} }
    registerView(type, f) { this.views[type] = f }
    registerExtensions(exts, type) {
        for (const e of exts) { if (this.app.viewRegistry.typeByExtension[e]) throw new Error('Attempting to register an existing file extension "' + e + '"'); this.app.viewRegistry.typeByExtension[e] = type }
    }
    registerMarkdownPostProcessor(f) { window.mdpp = f } addCommand(c) { (window.commands ??= {})[c.id] = c } registerEvent() {} addSettingTab(t) { this.settingTab = t }
    async loadData() { return JSON.parse(localStorage.getItem('ur-data') || 'null') }
    async saveData(d) { localStorage.setItem('ur-data', JSON.stringify(d)) }
}
export class FileView extends Component {
    constructor(leaf) {
        super(); this.leaf = leaf; this.app = leaf.app
        this.containerEl = document.createElement('div'); this.containerEl.className = 'workspace-leaf-content'
        this.contentEl = this.containerEl.createDiv({ cls: 'view-content' })
    }
    async setState(state) { }
    getState() { return {} }
}
export class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = document.createElement('div') } }
export class Setting {
    constructor(parent) {
        this.settingEl = parent.createDiv({ cls: 'setting-item' })
        const info = this.settingEl.createDiv({ cls: 'setting-item-info' })
        this.nameEl = info.createDiv({ cls: 'setting-item-name' }); this.descEl = info.createDiv({ cls: 'setting-item-description' })
        this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' })
    }
    setName(n) { this.nameEl.textContent = n; return this }
    setDesc(d) { if (typeof d === 'string') this.descEl.textContent = d; else this.descEl.append(d); return this }
    addText(cb) { const i = this.controlEl.createEl('input', { type: 'text' }); const t = { setValue: v => { i.value = v; return t }, onChange: f => { i.oninput = () => f(i.value); return t } }; cb(t); return this }
    addDropdown(cb) { const sel = this.controlEl.createEl('select'); const d = { addOption: (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); return d }, setValue: v => { sel.value = v; return d }, onChange: f => { sel.onchange = () => f(sel.value); return d } }; cb(d); return this }
    addToggle(cb) {
        const el = this.controlEl.createDiv({ cls: 'checkbox-container' }); const i = el.createEl('input', { type: 'checkbox' })
        const t = { setValue: v => { i.checked = v; el.classList.toggle('is-enabled', v); return t }, setDisabled: v => { i.disabled = v; return t }, onChange: f => { i.onchange = () => { el.classList.toggle('is-enabled', i.checked); f(i.checked) }; return t } }
        cb(t); return this
    }
}
window.createFragment = cb => { const f = document.createDocumentFragment(); const d = document.createElement('div'); cb(d); f.append(...d.childNodes); return f }
export class Modal {
    constructor(app) { this.app = app; this.containerEl = document.createElement('div'); this.containerEl.className = 'modal-container'; this.modalEl = this.containerEl.createDiv({ cls: 'modal' }); this.titleEl = this.modalEl.createDiv({ cls: 'modal-title' }); this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' }) }
    open() { document.body.append(this.containerEl); window.lastModal = this; this.onOpen?.() }
    close() { this.onClose?.(); this.containerEl.remove() }
}
export class FuzzySuggestModal extends Modal {
    setPlaceholder() {}
    open() { super.open(); window.lastSuggest = this }
}
