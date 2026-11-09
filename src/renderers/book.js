// Читалка «текучих» книг на движке foliate-js
import '../../vendor/foliate-js/view.js'
import { Overlayer } from '../../vendor/foliate-js/overlayer.js'

const WIDTHS = { narrow: 560, medium: 760, wide: 1100, full: 4000 }
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()))
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Число экранов в разделе и номер текущего экрана для движка-пагинатора
const measure = p => {
    if (p.scrolled) {
        const size = p.size || 1
        return { count: Math.max(1, Math.ceil((p.viewSize - 2) / size)), page: Math.floor(p.start / size) + 1 }
    }
    return { count: Math.max(1, p.pages - 2), page: Math.max(1, p.page) }
}

export class BookRenderer {
    caps = { toc: true, search: true, flow: true, fontSize: true, width: true, history: true, pages: true }
    // Реальные страницы (экраны): counts[i] — измеренное число экранов в разделе i
    #counts = []
    #measureToken = null
    #measuring = false
    #layoutKey = ''
    constructor(ctx) {
        this.ctx = ctx
        this.el = document.createElement('div')
        this.el.className = 'ur-book'
    }
    async open(book) {
        this.book = book
        // Сноски и прочие «вспомогательные» разделы (тело примечаний fb2, linear="no" в epub)
        // делаем частью книги: они входят в нумерацию и до них можно долистать, как в бумажной книге.
        // Пустые служебные разделы (без содержимого) не трогаем.
        for (const s of book.sections) if (s.linear === 'no' && typeof s.load === 'function') s.linear = 'yes'
        this.view = document.createElement('foliate-view')
        this.el.append(this.view)
        await this.view.open(book)
        this.view.addEventListener('relocate', e => this.#onRelocate(e.detail))
        this.view.addEventListener('load', e => this.#onLoad(e.detail))
        this.view.addEventListener('external-link', e => {
            e.preventDefault()
            window.open(e.detail.href_, '_blank')
        })
        this.view.history.addEventListener('index-change', () => this.ctx.onHistory?.())
        this.applySettings(this.ctx.settings)
        // при изменении размера окна раскладка меняется — пересчитываем страницы
        let lastSize = ''
        this.resizeObserver = new ResizeObserver(() => {
            const r = this.el.getBoundingClientRect()
            const key = `${Math.round(r.width)}x${Math.round(r.height)}`
            if (key === lastSize) return
            lastSize = key
            this.#scheduleMeasure()
        })
        this.resizeObserver.observe(this.el)
    }
    async start(position) {
        await this.view.init({ lastLocation: position?.cfi ?? null, showTextStart: false })
        this.#scheduleMeasure()
    }
    #onLoad({ doc }) {
        doc.addEventListener('keydown', e => this.ctx.onKey?.(e))
        doc.addEventListener('wheel', e => {
            if (e.ctrlKey) { e.preventDefault(); this.ctx.onZoomWheel?.(e.deltaY) }
        }, { passive: false })
    }

    // ---------- реальные номера страниц ----------
    get #sections() { return this.book.sections }
    #isLinear(i) { return this.#sections[i]?.linear !== 'no' }
    #estimate(i, cur) {
        const known = this.#counts[i]
        if (known != null) return known
        // оценка по размеру раздела и «плотности» уже измеренных разделов (или текущего)
        let pages = 0, bytes = 0
        this.#counts.forEach((c, k) => { if (c != null) { pages += c; bytes += this.#sections[k].size || 0 } })
        if (!bytes && cur) { pages = cur.count; bytes = this.#sections[cur.index].size || 0 }
        const ratio = bytes > 0 ? pages / bytes : 1 / 2500
        return Math.max(1, Math.round((this.#sections[i].size || 0) * ratio))
    }
    #pageInfo() {
        const r = this.view?.renderer
        const index = this.last?.section?.current ?? this.#currentIndex()
        if (!r || index == null || !r.size) return null
        const { count, page } = measure(r)
        if (this.#layoutKey && this.#layoutKey === this.#currentLayoutKey()) this.#counts[index] = count
        const cur = { index, count }
        const est = i => i === index ? count : this.#estimate(i, cur)
        const total = this.#sections.reduce((sum, _, i) => sum + (this.#isLinear(i) ? est(i) : 0), 0)
        if (!this.#isLinear(index)) return { page: null, pages: total, local: `${Math.min(page, count)} / ${count}` }
        let before = 0
        for (let i = 0; i < index; i++) if (this.#isLinear(i)) before += est(i)
        return { page: before + Math.min(page, count), pages: total }
    }
    // текущая глава как DOM — для «Скопировать как Markdown»
    currentDoc() { try { return this.view.renderer.getContents()?.[0]?.doc?.body ?? null } catch { return null } }
    #currentIndex() {
        try { return this.view.renderer.getContents()?.[0]?.index ?? null } catch { return null }
    }
    #currentLayoutKey() {
        const r = this.el.getBoundingClientRect()
        const s = this.ctx.settings
        return [Math.round(r.width), Math.round(r.height), s.flow, s.width, s.fontSize].join('|')
    }
    #scheduleMeasure() {
        // раскладка изменилась: старые замеры недействительны до пересчёта
        if (this.#layoutKey && this.#layoutKey !== this.#currentLayoutKey()) {
            this.#measureToken = null
            this.#layoutKey = ''
            this.#counts = []
            this.#measuring = true
            this.#emit()
        }
        clearTimeout(this.measureTimer)
        this.measureTimer = setTimeout(() => this.#measureAll(), 400)
    }
    // Раскладываем все разделы в скрытом движке с теми же размерами и стилями
    async #measureAll() {
        if (!this.view?.renderer || !this.el.isConnected) return
        const key = this.#currentLayoutKey()
        if (key === this.#layoutKey && !this.#counts.some((c, i) => c == null && this.#isLinear(i))) return
        const token = Symbol()
        this.#measureToken = token
        this.#layoutKey = key
        this.#counts = []
        this.#measuring = true
        this.#emit()
        const host = document.createElement('div')
        host.className = 'ur-measure-host'
        this.el.append(host)
        const p = document.createElement('foliate-paginator')
        this.#configure(p, this.ctx.settings)
        host.append(p)
        try {
            p.open(this.book)
            p.setStyles?.(this.#css(this.ctx.settings))
            for (let i = 0; i < this.#sections.length; i++) {
                if (this.#measureToken !== token) return
                if (!this.#isLinear(i) || this.#counts[i] != null) continue
                await p.goTo({ index: i })
                await nextFrame(); await nextFrame()
                if (this.#measureToken !== token) return
                this.#counts[i] = measure(p).count
                if (i % 5 === 4) this.#emit()
                await sleep(15)
            }
            if (this.#measureToken === token) { this.#measuring = false; this.#emit() }
        } catch (e) {
            console.warn('[Читалка] подсчёт страниц прерван', e)
        } finally {
            try { p.destroy?.() } catch { /* ignore */ }
            host.remove()
        }
    }
    #emit() { if (this.last) this.#onRelocate(this.last) }
    get debugPages() { return { measuring: this.#measuring, counts: [...this.#counts], key: this.#layoutKey, sections: this.#sections.length, linear: this.#sections.map((_, i) => this.#isLinear(i)) } }

    #onRelocate(d) {
        this.last = d
        const info = this.#pageInfo()
        this.ctx.onRelocate({
            fraction: d.fraction ?? 0,
            page: info?.page ?? null,
            pages: info?.pages ?? null,
            approx: this.#measuring,
            local: info?.local,
            label: d.tocItem?.label ?? '',
            tocHref: d.tocItem?.href,
        })
    }
    getPosition() { return this.last?.cfi ? { cfi: this.last.cfi, fraction: this.last.fraction } : null }
    getToc() {
        const map = items => (items || []).map(i => ({ label: i.label?.trim?.() || '—', target: i.href, subitems: map(i.subitems) }))
        return map(this.book.toc)
    }
    goTo(target) { return this.view.goTo(target) }
    // Переход на страницу n: находим раздел и экран внутри него
    async goToPage(n) {
        let left = n
        let target = null
        for (let i = 0; i < this.#sections.length; i++) {
            if (!this.#isLinear(i)) continue
            const c = this.#estimate(i)
            if (left <= c) { target = { index: i, page: left, count: c }; break }
            left -= c
            target = { index: i, page: c, count: c }
        }
        if (!target) return
        const anchor = target.count > 1 ? (target.page - 1) / (target.count - 1) : 0
        await this.view.renderer.goTo({ index: target.index, anchor: Math.min(1, Math.max(0, anchor)) })
    }
    goToFraction(f) { return this.view.goToFraction(f) }
    next() { return this.view.next() }
    prev() { return this.view.prev() }
    back() { this.view.history.back() }
    forward() { this.view.history.forward() }
    get canGoBack() { return this.view.history.canGoBack }
    get canGoForward() { return this.view.history.canGoForward }
    async *search(query) {
        for await (const r of this.view.search({ query, matchCase: false, matchDiacritics: false, matchWholeWords: false })) {
            if (r === 'done') return
            if (r.subitems) yield { label: r.label, items: r.subitems.map(s => ({ excerpt: s.excerpt, target: s.cfi })) }
        }
    }
    clearSearch() { this.view.clearSearch() }
    goToResult(target) { return this.view.goTo(target) }
    #configure(r, s) {
        r.setAttribute('flow', s.flow === 'scrolled' ? 'scrolled' : 'paginated')
        r.setAttribute('max-inline-size', (s.width === 'spread' ? 720 : (WIDTHS[s.width] ?? 760)) + 'px')
        r.setAttribute('max-column-count', s.width === 'spread' ? '2' : '1')
        r.setAttribute('margin', '40px')
        r.setAttribute('gap', '6%')
    }
    applySettings(s) {
        const r = this.view?.renderer
        if (!r) return
        this.#configure(r, s)
        r.setStyles?.(this.#css(s))
        this.#scheduleMeasure()
    }
    #css(s) {
        const c = this.ctx.themeColors()
        const size = Math.round(16 * (s.fontSize ?? 100) / 100)
        return `@namespace epub "http://www.idpf.org/2007/ops";
        html { color: ${c.text} !important; background: ${c.bg} !important; font-size: ${size}px !important; }
        body { color: inherit !important; background: transparent !important; font-size: 1rem !important; }
        body * { color: inherit; }
        a:any-link { color: ${c.accent} !important; }
        p, li, blockquote, dd { line-height: 1.5; }
        img, svg { max-width: 100%; }
        pre { white-space: pre-wrap !important; }
        ::selection { background: ${c.selection}; }
        aside[epub|type~="footnote"], aside[epub|type~="endnote"] { display: none; }`
    }
    destroy() {
        this.#measureToken = null
        clearTimeout(this.measureTimer)
        this.resizeObserver?.disconnect()
        try { this.view?.close() } catch { /* ignore */ }
        this.book?.destroy?.()
        this.el.remove()
    }
}
export { Overlayer }
