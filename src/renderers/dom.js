// Просмотрщики на обычном DOM: код, таблицы, веб-страницы, блокноты, разметка, презентации
import { domSearch, clearDomSearch, focusHit, escapeHtml } from '../util.js'

// Базовый класс: прокручиваемая область, поиск по тексту, позиция = доля прокрутки
export class ScrollRenderer {
    caps = { toc: false, search: true, fontSize: false, pages: false }
    constructor(ctx) {
        this.ctx = ctx
        this.el = document.createElement('div')
        this.el.className = 'ur-scroll'
        this.el.tabIndex = 0
        this.el.addEventListener('scroll', () => this.#emit())
        this.el.addEventListener('keydown', e => this.ctx.onKey?.(e, true))
    }
    get searchRoot() { return this.el }
    #emit() {
        const max = this.el.scrollHeight - this.el.clientHeight
        const fraction = max > 0 ? this.el.scrollTop / max : 1
        this.ctx.onRelocate({ fraction, page: null, pages: null, label: this.currentLabel?.() ?? '' })
    }
    async start(position) {
        await new Promise(r => requestAnimationFrame(r))
        if (position?.fraction != null) this.goToFraction(position.fraction)
        this.#emit()
    }
    getPosition() {
        const max = this.el.scrollHeight - this.el.clientHeight
        return { fraction: max > 0 ? this.el.scrollTop / max : 0 }
    }
    goToFraction(f) { this.el.scrollTop = f * (this.el.scrollHeight - this.el.clientHeight) }
    next() { this.el.scrollBy({ top: this.el.clientHeight * 0.9 }) }
    prev() { this.el.scrollBy({ top: -this.el.clientHeight * 0.9 }) }
    getToc() {
        const hs = Array.from(this.el.querySelectorAll('h1, h2, h3')).filter(h => h.textContent.trim())
        return hs.slice(0, 500).map(h => ({ label: h.textContent.trim().slice(0, 100), target: h, subitems: [] }))
    }
    goTo(target) { target?.scrollIntoView?.({ block: 'start' }) }
    async *search(query) {
        const items = domSearch(this.searchRoot, query)
        if (items.length) yield { label: `Найдено: ${items.length}`, items: items.slice(0, 1000) }
    }
    clearSearch() { clearDomSearch(this.searchRoot) }
    goToResult(mark) { focusHit(this.searchRoot, mark) }
    applySettings() {}
    destroy() { this.el.remove() }
}

// ---------- Код и текстовые данные ----------
const LANG = { json: 'json', xml: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', log: 'log',
    tex: 'latex', rst: 'rest', html: 'html', htm: 'html', svg: 'xml', adoc: 'asciidoc', org: 'org', csv: 'csv', tsv: 'tsv',
    py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', kt: 'kotlin', kts: 'kotlin',
    h: 'c', hpp: 'cpp', cc: 'cpp', cs: 'csharp', rs: 'rust', rb: 'ruby', pl: 'perl', sh: 'bash', zsh: 'bash', fish: 'bash', bat: 'batch',
    cmd: 'batch', ps1: 'powershell', vb: 'vbnet', vbs: 'vbnet', asm: 'nasm', gradle: 'groovy', vue: 'html', svelte: 'html',
    conf: 'ini', cfg: 'ini', env: 'bash', properties: 'properties', gitignore: 'ignore', editorconfig: 'ini', pot: 'po', srt: '', vtt: '', sbv: '',
    ass: 'ini', ssa: 'ini', sub: '', lrc: '', vcf: '', ics: '', eml: '', ris: '',
    jsonl: 'json', ndjson: 'json', geojson: 'json', har: 'json', reg: 'ini', desktop: 'ini', plist: 'xml', ttml: 'xml', dfxp: 'xml', smi: 'html',
    markdown: 'md', mdown: 'md', mkd: 'md', mmd: 'mermaid', mermaid: 'mermaid', abc: '',
    json5: 'json5', jsonc: 'json', webmanifest: 'json', map: 'json', arb: 'json', topojson: 'json',
    xsl: 'xml', xslt: 'xml', xsd: 'xml', dtd: 'xml', rdf: 'xml', xaml: 'xml', resx: 'xml', csproj: 'xml', vcxproj: 'xml', nzb: 'xml', gpx: 'xml', kml: 'xml',
    inf: 'ini', strings: 'c', ltx: 'latex', sty: 'latex', cls: 'latex', rest: 'rest', asciidoc: 'asciidoc', rej: 'diff',
    ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', clj: 'clojure', ml: 'ocaml', fs: 'fsharp', jl: 'julia', nim: 'nim', zig: 'zig', sol: 'solidity',
    tf: 'hcl', hcl: 'hcl', nix: 'nix', groovy: 'groovy', pas: 'pascal', f90: 'fortran', tcl: 'tcl', el: 'lisp', scm: 'scheme', lisp: 'lisp', rkt: 'racket',
    coffee: 'coffeescript', elm: 'elm', astro: 'html', pug: 'pug', glsl: 'glsl', wgsl: 'wgsl', hlsl: 'hlsl', cu: 'cpp', ino: 'arduino', gcode: 'gcode', ly: 'lilypond', typ: 'typst',
    asp: 'aspnet', aspx: 'aspnet', jsp: 'java', cshtml: 'cshtml', erb: 'erb', ejs: 'ejs', hbs: 'handlebars', twig: 'twig', liquid: 'liquid', j2: 'django',
    rmd: 'md', qmd: 'md', mdx: 'md', pem: '', ged: '', troff: '', text: '',
    // версия 0.5.0
    ldjson: 'json', jsonlines: 'json', geojsonl: 'json', 'code-workspace': 'json', 'code-snippets': 'json', 'sublime-project': 'json', 'sublime-settings': 'json',
    tfstate: 'json', xcstrings: 'json', ips: 'json', hjson: 'json5', avsc: 'json', 'sublime-syntax': 'yaml',
    ovf: 'xml', 'library-ms': 'xml', 'search-ms': 'xml', rng: 'xml', wsdl: 'xml', fo: 'xml', sch: 'xml', tmlanguage: 'xml', tmtheme: 'xml', qml: 'qml', ui: 'xml', xib: 'xml', storyboard: 'xml',
    service: 'ini', socket: 'ini', timer: 'ini', mount: 'ini', target: 'ini', container: 'ini', flatpakref: 'ini', flatpakrepo: 'ini', theme: 'ini', ovpn: 'ini', xcconfig: 'ini',
    pyi: 'python', pyw: 'python', mts: 'typescript', cts: 'typescript', cxx: 'cpp', hxx: 'cpp', hh: 'cpp', ipp: 'cpp', inl: 'cpp', shar: 'bash', objc: 'objectivec', matlab: 'matlab',
    d: 'd', cr: 'crystal', odin: 'go', gleam: 'rust', hx: 'haxe', purs: 'purescript', mojo: 'python', roc: 'elm', pyx: 'python', pxd: 'python', mli: 'ocaml', hrl: 'erlang',
    fsx: 'fsharp', fsi: 'fsharp', lhs: 'haskell', cljs: 'clojure', cljc: 'clojure', edn: 'clojure', move: 'rust', cairo: 'rust', vy: 'python',
    ada: 'ada', adb: 'ada', ads: 'ada', cob: 'cobol', cbl: 'cobol', f: 'fortran', for: 'fortran', f77: 'fortran', bas: 'basic', prg: 'basic', sv: 'verilog', svh: 'verilog', vhdl: 'vhdl',
    awk: 'awk', sed: 'bash', vim: 'vim', ahk: 'autohotkey', au3: 'autoit', applescript: 'applescript', bats: 'bash',
    sas: 'sas', do: 'stata', ado: 'stata', wl: 'wolfram', wls: 'wolfram', sage: 'python', mac: '', scad: 'c', ledger: '', journal: '', beancount: '',
    bzl: 'python', star: 'python', mk: 'makefile', mak: 'makefile', ninja: '', sbt: 'scala', podspec: 'ruby', gemspec: 'ruby', pbxproj: '', jsonnet: 'javascript', libsonnet: 'javascript',
    kdl: '', ron: 'rust', dhall: 'dhall', cson: 'coffeescript', tfvars: 'hcl', bicep: 'bicep', prj: '', mtl: '', ma: '', rnc: '',
    haml: 'haml', slim: 'slim', jade: 'pug', mustache: 'handlebars', njk: 'django', tpl: 'smarty', tmpl: 'django', razor: 'cshtml', marko: 'html', ftl: 'ftl',
    prisma: '', thrift: '', capnp: '', fbs: '', smithy: '', graphqls: 'graphql', feature: 'gherkin', robot: 'robotframework', http: 'http', bru: 'http',
    bst: 'latex', bbx: 'latex', cbx: 'latex', dtx: 'latex', ins: 'latex', rnw: 'latex', rd: 'latex', crash: 'log', spin: 'log', diag: 'log', lock: 'toml', psv: 'csv', dsv: 'csv', ssv: '', prn: '' }
const JSON_LIKE = new Set(['json', 'geojson', 'har', 'webmanifest', 'map', 'arb', 'topojson'])
const XML_LIKE = new Set(['xml', 'svg', 'xsl', 'xslt', 'xsd', 'rdf', 'xaml', 'resx', 'csproj', 'vcxproj', 'nzb'])

export const renderCode = async (ctx, container, text, ext) => {
    container.classList.add('ur-code')
    if (text.length > 400_000 || ext === 'log') {
        const pre = document.createElement('pre')
        pre.className = 'ur-plain-code'
        pre.textContent = text
        container.append(pre)
        return
    }
    const fence = '~'.repeat(Math.max(4, ...(text.match(/~{3,}/g) || []).map(s => s.length + 1)))
    await ctx.renderMarkdown(`${fence}${LANG[ext] ?? ext ?? ''}\n${text}\n${fence}`, container, ctx.file?.path ?? '')
    container.querySelectorAll('.copy-code-button').forEach(b => b.remove())
}

export class CodeRenderer extends ScrollRenderer {
    constructor(ctx, text, ext) { super(ctx); this.text = text; this.ext = ext; this.el.classList.add('ur-code-view') }
    async open() {
        if (JSON_LIKE.has(this.ext)) {
            try { JSON.parse(this.text) } catch (e) { this.el.append(errorBanner('Ошибка в JSON: ' + e.message)) }
        }
        if (XML_LIKE.has(this.ext)) {
            const d = new DOMParser().parseFromString(this.text, 'application/xml')
            const err = d.querySelector('parsererror')
            if (err) this.el.append(errorBanner('Ошибка в XML: ' + err.textContent.split('\n')[0]))
        }
        const box = document.createElement('div')
        this.el.append(box)
        await renderCode(this.ctx, box, this.text, this.ext)
    }
    getToc() { return [] }
}
const errorBanner = msg => Object.assign(document.createElement('div'), { className: 'ur-banner is-error ur-nosearch', textContent: msg })

// ---------- Таблицы ----------
const colName = n => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) } return s }

export class TableRenderer extends ScrollRenderer {
    // sheets: [{ name, rows: string[][] }]
    constructor(ctx, sheets) { super(ctx); this.sheets = sheets; this.el.classList.add('ur-table-view') }
    async open() {
        if (this.sheets.length > 1) {
            this.tabs = document.createElement('div')
            this.tabs.className = 'ur-sheet-tabs ur-nosearch'
            this.sheets.forEach((s, i) => {
                const b = document.createElement('button')
                b.textContent = s.name || `Лист ${i + 1}`
                b.onclick = () => this.show(i)
                this.tabs.append(b)
            })
            this.el.append(this.tabs)
        }
        this.body = document.createElement('div')
        this.body.className = 'ur-sheet-body'
        this.el.append(this.body)
        this.show(0)
    }
    get searchRoot() { return this.body }
    show(i, limit = 3000) {
        this.cur = i
        this.limit = limit
        this.tabs?.querySelectorAll('button').forEach((b, k) => b.classList.toggle('is-active', k === i))
        const rows = this.sheets[i].rows
        const cols = Math.max(0, ...rows.slice(0, 5000).map(r => r.length))
        const parts = ['<table class="ur-grid"><thead><tr><th class="ur-corner"></th>']
        for (let c = 0; c < cols; c++) parts.push(`<th>${colName(c)}</th>`)
        parts.push('</tr></thead><tbody>')
        const n = Math.min(rows.length, limit)
        for (let r = 0; r < n; r++) {
            parts.push(`<tr><th>${r + 1}</th>`)
            const row = rows[r]
            for (let c = 0; c < cols; c++) parts.push(`<td>${escapeHtml(row[c] ?? '')}</td>`)
            parts.push('</tr>')
        }
        parts.push('</tbody></table>')
        this.body.innerHTML = parts.join('')
        if (rows.length > n) {
            const more = document.createElement('button')
            more.className = 'ur-more ur-nosearch'
            more.textContent = `Показать ещё (показано ${n} из ${rows.length} строк)`
            more.onclick = () => this.show(i, limit + 5000)
            this.body.append(more)
        }
    }
    getToc() { return [] }
    async *search(query) {
        const q = query.trim().toLowerCase()
        if (!q) return
        for (let si = 0; si < this.sheets.length; si++) {
            const items = []
            const rows = this.sheets[si].rows
            for (let r = 0; r < rows.length && items.length < 500; r++) {
                const row = rows[r]
                for (let c = 0; c < row.length; c++) {
                    const v = String(row[c] ?? '')
                    const i = v.toLowerCase().indexOf(q)
                    if (i >= 0) items.push({ excerpt: { pre: `${colName(c)}${r + 1}: ` + v.slice(Math.max(0, i - 30), i), match: v.slice(i, i + q.length), post: v.slice(i + q.length, i + q.length + 30) }, target: { sheet: si, row: r, col: c } })
                }
            }
            if (items.length) yield { label: this.sheets[si].name || `Лист ${si + 1}`, items }
        }
    }
    clearSearch() { this.body?.querySelectorAll('.ur-cell-hit').forEach(td => td.classList.remove('ur-cell-hit')) }
    goToResult(t) {
        if (t.sheet !== this.cur || t.row >= (this.limit ?? 3000)) this.show(t.sheet, Math.max(3000, t.row + 200))
        this.clearSearch()
        const td = this.body.querySelector(`tbody tr:nth-child(${t.row + 1}) td:nth-child(${t.col + 2})`)
        if (td) { td.classList.add('ur-cell-hit'); td.scrollIntoView({ block: 'center', inline: 'center' }) }
    }
}

// CSV/TSV: свой разбор с определением разделителя
export const parseCsv = (text, ext) => {
    // .ssv, .prn — столбцы разделены пробелами (кавычки сохраняют пробелы внутри)
    if (ext === 'ssv' || ext === 'prn') return text.split(/\r?\n/).filter(l => l.trim()).map(l => (l.trim().match(/"[^"]*"|\S+/g) ?? []).map(f => f.replace(/^"|"$/g, '')))
    const first = text.slice(0, 5000)
    const delim = ext === 'tsv' ? '\t' : ext === 'psv' ? '|' : ext === 'dsv' && /^[^,;\t|\n]*:[^\n]*$/m.test(first.split('\n')[0]) ? ':' : [',', ';', '\t', '|'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0]
    const rows = []; let row = []; let field = ''; let q = false
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (q) {
            if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else q = false }
            else field += ch
        } else if (ch === '"' && field === '') q = true
        else if (ch === delim) { row.push(field); field = '' }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++
            row.push(field); rows.push(row); row = []; field = ''
        } else field += ch
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row) }
    return rows
}

// ---------- Веб: отрисованный вид + исходный код ----------
export class WebRenderer {
    caps = { toc: false, search: true, modes: true, scripts: false, pages: false }
    // kind: 'html' | 'svg' | 'mhtml'
    constructor(ctx, { kind, text, url, srcdoc }) {
        this.ctx = ctx; this.kind = kind; this.text = text; this.url = url; this.srcdoc = srcdoc
        this.caps.scripts = kind === 'html'
        this.caps.source = kind !== 'mhtml'
        this.mode = 'rendered'
        this.scripts = false
        this.el = document.createElement('div')
        this.el.className = 'ur-web'
    }
    async open() { await this.render() }
    async render() {
        this.el.empty?.(); this.el.innerHTML = ''
        this.code = null; this.iframe = null
        if (this.mode === 'source') {
            this.code = new CodeRenderer(this.ctx, this.text, this.kind === 'svg' ? 'svg' : 'html')
            await this.code.open()
            this.el.append(this.code.el)
            return
        }
        if (this.kind === 'svg') {
            const wrap = document.createElement('div')
            wrap.className = 'ur-svg-wrap'
            const img = document.createElement('img')
            img.src = this.url
            wrap.append(img)
            this.el.append(wrap)
            return
        }
        const f = document.createElement('iframe')
        f.className = 'ur-web-frame'
        f.setAttribute('referrerpolicy', 'no-referrer')
        // без скриптов разрешаем same-origin (для поиска); со скриптами — только скрипты
        f.setAttribute('sandbox', this.scripts ? 'allow-scripts' : 'allow-same-origin')
        if (this.srcdoc != null) f.srcdoc = this.srcdoc
        else f.src = this.url + (this.url.includes('?') ? '&' : '?') + 'ur=' + Date.now()
        this.iframe = f
        this.el.append(f)
    }
    setMode(m) { this.mode = m; return this.render() }
    setScripts(v) { this.scripts = v; return this.render() }
    get frameDoc() { try { return this.iframe?.contentDocument?.body ? this.iframe.contentDocument : null } catch { return null } }
    async start() { this.ctx.onRelocate({ fraction: 0, page: null, pages: null, label: '' }) }
    getPosition() { return null }
    getToc() { return [] }
    next() { (this.code?.el ?? this.frameDoc?.defaultView)?.scrollBy?.({ top: 400 }) }
    prev() { (this.code?.el ?? this.frameDoc?.defaultView)?.scrollBy?.({ top: -400 }) }
    async *search(query) {
        if (this.code) { yield* this.code.search(query); return }
        const d = this.frameDoc
        if (!d) { yield { label: 'Поиск недоступен в этом режиме — переключитесь на «Код»', items: [] }; return }
        const items = domSearch(d.body, query)
        if (items.length) yield { label: `Найдено: ${items.length}`, items }
    }
    clearSearch() { if (this.code) this.code.clearSearch(); else if (this.frameDoc) clearDomSearch(this.frameDoc.body) }
    goToResult(mark) { if (this.code) this.code.goToResult(mark); else if (this.frameDoc) focusHit(this.frameDoc.body, mark) }
    applySettings() {}
    destroy() { this.el.remove() }
}

// ---------- Документ из HTML (adoc, org) с переключением на исходник ----------
export class ArticleRenderer extends ScrollRenderer {
    constructor(ctx, { html, text, ext, sanitize = true }) {
        super(ctx); this.html = html; this.text = text; this.ext = ext; this.sanitize = sanitize
        this.caps = { ...this.caps, modes: !!text, toc: true, source: !!text }
        this.mode = 'rendered'
        this.el.classList.add('ur-article-view')
    }
    async open() { await this.render() }
    async render() {
        this.el.innerHTML = ''
        if (this.mode === 'source') {
            const box = document.createElement('div')
            this.el.append(box)
            await renderCode(this.ctx, box, this.text, this.ext)
            return
        }
        const art = document.createElement('div')
        art.className = 'ur-article markdown-rendered'
        if (this.sanitize) art.append(this.ctx.sanitize(this.html))
        else if (this.html instanceof Node) art.append(this.html)
        else art.innerHTML = this.html
        this.el.append(art)
    }
    setMode(m) { this.mode = m; return this.render() }
}

// ---------- Несколько видов одного текстового файла (контакты, календарь, субтитры и т. п.) ----------
export class MultiViewRenderer extends ScrollRenderer {
    // views: [[ключ, подпись, async () => Node | строка HTML (уже экранированная)]]
    constructor(ctx, { views, text, ext, cls = '' }) {
        super(ctx)
        this.views = views; this.text = text; this.ext = ext; this.cls = cls
        this.modeOptions = views.map(([k, l]) => [k, l])
        if (text != null) this.modeOptions.push(['source', 'Код'])
        this.caps = { ...this.caps, modes: this.modeOptions.length > 1, toc: true }
        this.mode = views[0][0]
        this.el.classList.add('ur-article-view')
    }
    async open() { await this.render() }
    async render() {
        this.el.innerHTML = ''
        if (this.mode === 'source') {
            const box = document.createElement('div')
            this.el.append(box)
            await renderCode(this.ctx, box, this.text, this.ext)
            return
        }
        const art = document.createElement('div')
        art.className = 'ur-article ur-' + this.cls
        const out = await this.views.find(v => v[0] === this.mode)[2]()
        if (out instanceof Node) art.append(out); else art.innerHTML = out
        this.el.append(art)
    }
    setMode(m) { this.mode = m; return this.render() }
    // ищем и в основном тексте, и внутри встроенных рамок (тело письма)
    #frames() { return Array.from(this.el.querySelectorAll('iframe')).map(f => { try { return f.contentDocument?.body } catch { return null } }).filter(Boolean) }
    async *search(query) {
        const items = [...domSearch(this.el, query), ...this.#frames().flatMap(b => domSearch(b, query))]
        if (items.length) yield { label: `Найдено: ${items.length}`, items: items.slice(0, 1000) }
    }
    clearSearch() { clearDomSearch(this.el); this.#frames().forEach(clearDomSearch) }
    goToResult(mark) {
        const root = mark.ownerDocument === document ? this.el : mark.ownerDocument.body
        if (mark.ownerDocument !== document) mark.ownerDocument.defaultView.frameElement?.scrollIntoView({ block: 'start' })
        focusHit(root, mark)
    }
}

// ---------- Архивы: список файлов и предпросмотр ----------
export class ArchiveRenderer extends ScrollRenderer {
    caps = { toc: false, search: true, pages: false }
    constructor(ctx, arc, { list, preview }) { super(ctx); this.arc = arc; this.list = list; this.preview = preview; this.el.classList.add('ur-article-view') }
    async open() { if (this.arc.single) await this.showEntry(this.arc.entries[0]); else this.showList() }
    showList() {
        this.el.innerHTML = ''
        const art = document.createElement('div')
        art.className = 'ur-article ur-archive'
        art.append(this.list(this.arc, e => this.showEntry(e)))
        this.el.append(art)
        this.el.scrollTop = this.listScroll ?? 0
    }
    async showEntry(e) {
        if (!this.arc.single) this.listScroll = this.el.scrollTop
        this.el.innerHTML = ''
        const art = document.createElement('div')
        art.className = 'ur-article ur-archive'
        const head = document.createElement('div')
        head.className = 'ur-arc-head ur-nosearch'
        if (!this.arc.single) { const back = document.createElement('button'); back.textContent = '← К списку файлов'; back.onclick = () => this.showList(); head.append(back) }
        head.append(Object.assign(document.createElement('b'), { textContent: ' ' + e.name }))
        art.append(head)
        art.append(Object.assign(document.createElement('div'), { className: 'ur-meta', textContent: 'Распаковываю…' }))
        this.el.append(art)
        const box = await this.preview(this.arc, e)
        art.lastChild.remove()
        art.append(box)
        this.el.scrollTop = 0
    }
}

// ---------- Jupyter Notebook ----------
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
const joinSrc = s => Array.isArray(s) ? s.join('') : (s ?? '')
export class NotebookRenderer extends ScrollRenderer {
    caps = { toc: true, search: true, pages: false }
    constructor(ctx, nb) { super(ctx); this.nb = nb; this.el.classList.add('ur-notebook-view') }
    async open() {
        const lang = this.nb.metadata?.kernelspec?.language || this.nb.metadata?.language_info?.name || 'python'
        const art = document.createElement('div')
        art.className = 'ur-article ur-notebook markdown-rendered'
        this.el.append(art)
        const cells = this.nb.cells ?? this.nb.worksheets?.[0]?.cells ?? []
        for (const cell of cells) {
            const c = document.createElement('div')
            c.className = 'ur-cell ur-cell-' + cell.cell_type
            art.append(c)
            const src = joinSrc(cell.source ?? cell.input)
            if (cell.cell_type === 'markdown') { await this.ctx.renderMarkdown(src, c, this.ctx.file?.path ?? ''); continue }
            if (cell.cell_type === 'raw') { const pre = document.createElement('pre'); pre.textContent = src; c.append(pre); continue }
            const head = document.createElement('div')
            head.className = 'ur-cell-prompt ur-nosearch'
            head.textContent = `In [${cell.execution_count ?? ' '}]:`
            c.append(head)
            const code = document.createElement('div')
            c.append(code)
            await renderCode(this.ctx, code, src, lang === 'python' ? 'python' : lang)
            for (const out of cell.outputs ?? []) {
                const o = document.createElement('div')
                o.className = 'ur-output'
                c.append(o)
                if (out.output_type === 'stream') { const pre = document.createElement('pre'); pre.textContent = stripAnsi(joinSrc(out.text)); o.append(pre); continue }
                if (out.output_type === 'error') { const pre = document.createElement('pre'); pre.className = 'is-error'; pre.textContent = stripAnsi((out.traceback || [out.ename + ': ' + out.evalue]).join('\n')); o.append(pre); continue }
                const data = out.data ?? {}
                if (data['image/png'] || data['image/jpeg']) {
                    const t = data['image/png'] ? 'png' : 'jpeg'
                    const img = document.createElement('img'); img.src = `data:image/${t};base64,${joinSrc(data['image/' + t]).replace(/\s/g, '')}`; o.append(img)
                } else if (data['image/svg+xml']) {
                    const img = document.createElement('img'); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(joinSrc(data['image/svg+xml'])); o.append(img)
                } else if (data['text/html']) o.append(this.ctx.sanitize(joinSrc(data['text/html'])))
                else if (data['text/markdown']) await this.ctx.renderMarkdown(joinSrc(data['text/markdown']), o, '')
                else if (data['text/plain'] || out.text) { const pre = document.createElement('pre'); pre.textContent = stripAnsi(joinSrc(data['text/plain'] ?? out.text)); o.append(pre) }
            }
        }
    }
}

// ---------- Презентации ----------
export class SlidesRenderer extends ScrollRenderer {
    caps = { toc: false, search: true, pages: false }
    constructor(ctx, render) { super(ctx); this.renderFn = render; this.el.classList.add('ur-slides-view') }
    async open() {
        const box = document.createElement('div')
        box.className = 'ur-slides'
        this.el.append(box)
        await this.renderFn(box, this.el)
    }
}
