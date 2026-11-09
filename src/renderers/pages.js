// Просмотр готовых страниц: комиксы, TIFF, DjVu.
// Режимы: лента (прокрутка), постранично, разворот. Масштаб: по ширине, по странице, проценты.
export class PagesRenderer {
    caps = { toc: false, search: false, flow: true, spread: true, zoom: true, invert: true, pages: true }
    constructor(ctx, source, { invertByDefault = false } = {}) {
        this.ctx = ctx
        this.src = source
        this.caps.toc = !!source.toc
        this.caps.search = !!source.getText
        this.index = 0
        this.inverted = invertByDefault && ctx.isDark()
        this.el = document.createElement('div')
        this.el.className = 'ur-pages'
        this.el.tabIndex = 0
        this.el.addEventListener('keydown', e => this.ctx.onKey?.(e))
        this.el.addEventListener('wheel', e => {
            if (e.ctrlKey) { e.preventDefault(); this.ctx.onZoomWheel?.(e.deltaY) }
        }, { passive: false })
        this.#setupTouch()
    }
    async open() { this.applySettings(this.ctx.settings) }
    async start(position) {
        const i = Number(position?.page ?? 0)
        await this.goTo(Number.isFinite(i) ? i : 0)
    }
    get mode() {
        const s = this.ctx.settings
        if (s.flow === 'scrolled') return 'scroll'
        return s.spread ? 'spread' : 'single'
    }
    applySettings(s) {
        this.el.classList.toggle('is-inverted', !!this.inverted)
        const keep = this.index
        this.#build()
        this.goTo(keep, true)
    }
    setInverted(v) { this.inverted = v; this.el.classList.toggle('is-inverted', v) }
    #zoomStyle(img, natural) {
        const z = this.ctx.settings.zoom ?? 'fit-width'
        img.style.width = ''; img.style.height = ''; img.style.maxWidth = ''; img.style.maxHeight = ''
        if (this.mode === 'scroll') {
            if (z === 'fit-page') { img.style.maxHeight = 'calc(100% - 8px)'; img.style.maxWidth = '100%' }
            else if (typeof z === 'number') img.style.width = `${z}%`
            else img.style.width = '100%'
        } else {
            if (typeof z === 'number') img.style.width = `${z}%`
            else if (z === 'fit-width') img.style.width = '100%'
            else { img.style.maxWidth = '100%'; img.style.maxHeight = '100%' }
        }
        if (natural) img.dataset.natural = '1'
    }
    #build() {
        this.observer?.disconnect()
        this.el.empty?.() ?? (this.el.innerHTML = '')
        this.el.className = 'ur-pages ur-pages-' + this.mode + (this.inverted ? ' is-inverted' : '')
        const z = this.ctx.settings.zoom
        this.el.classList.toggle('is-fit-page', z === 'fit-page')
        if (this.mode === 'scroll') {
            this.strip = document.createElement('div')
            this.strip.className = 'ur-strip'
            this.slots = []
            for (let i = 0; i < this.src.count; i++) {
                const slot = document.createElement('div')
                slot.className = 'ur-slot'
                slot.dataset.index = i
                const ph = document.createElement('div')
                ph.className = 'ur-placeholder'
                ph.textContent = String(i + 1)
                slot.append(ph)
                this.strip.append(slot)
                this.slots.push(slot)
            }
            this.el.append(this.strip)
            this.observer = new IntersectionObserver(entries => {
                for (const en of entries) {
                    const i = Number(en.target.dataset.index)
                    if (en.isIntersecting) this.#fill(i)
                    else if (Math.abs(i - this.index) > 6) this.#unfill(i)
                }
            }, { root: this.el, rootMargin: '150% 0px' })
            for (const s of this.slots) this.observer.observe(s)
            this.el.onscroll = () => this.#onScroll()
        } else {
            this.el.onscroll = null
            this.frame = document.createElement('div')
            this.frame.className = 'ur-frame'
            this.el.append(this.frame)
            this.frame.addEventListener('click', e => {
                if (window.getSelection()?.toString()) return
                const r = this.el.getBoundingClientRect()
                const x = (e.clientX - r.left) / r.width
                if (x < 0.3) this.prev(); else if (x > 0.7) this.next()
            })
        }
    }
    async #fill(i) {
        const slot = this.slots?.[i]
        if (!slot || slot.dataset.filled) return
        slot.dataset.filled = '1'
        try {
            const p = await this.src.getPage(i)
            if (!slot.isConnected || !slot.dataset.filled) return
            const img = document.createElement('img')
            img.src = p.url
            img.draggable = false
            this.#zoomStyle(img)
            img.onload = () => slot.classList.add('is-loaded')
            slot.replaceChildren(img)
        } catch (e) {
            slot.replaceChildren(Object.assign(document.createElement('div'), { className: 'ur-placeholder is-error', textContent: `Стр. ${i + 1}: ошибка` }))
            console.error(e)
        }
    }
    #unfill(i) {
        const slot = this.slots?.[i]
        if (!slot?.dataset.filled || !this.src.releasePage) return
        const img = slot.querySelector('img')
        if (img) slot.style.minHeight = slot.offsetHeight + 'px'
        delete slot.dataset.filled
        slot.replaceChildren(Object.assign(document.createElement('div'), { className: 'ur-placeholder', textContent: String(i + 1) }))
        this.src.releasePage(i)
    }
    #onScroll() {
        const top = this.el.scrollTop + this.el.clientHeight * 0.3
        let idx = 0
        for (const s of this.slots) { if (s.offsetTop <= top) idx = Number(s.dataset.index); else break }
        if (idx !== this.index) { this.index = idx; this.#emit() }
    }
    async #renderPaged() {
        const i = this.index
        const idxs = this.mode === 'spread' && i > 0 ? [i, i + 1].filter(x => x < this.src.count) : [i]
        const token = Symbol(); this.token = token
        const pages = await Promise.all(idxs.map(x => this.src.getPage(x)))
        if (this.token !== token) return
        this.frame.replaceChildren(...pages.map(p => {
            const img = document.createElement('img')
            img.src = p.url; img.draggable = false
            this.#zoomStyle(img)
            // крошечные картинки (значки, курсоры) увеличиваем без размытия
            const z = this.ctx.settings.zoom
            if (p.width && p.height && Math.max(p.width, p.height) < 160 && typeof z !== 'number') {
                const k = Math.max(2, Math.floor(320 / Math.max(p.width, p.height)))
                img.style.width = p.width * k + 'px'; img.style.maxWidth = '100%'; img.style.imageRendering = 'pixelated'
            }
            return img
        }))
        this.frame.classList.toggle('is-spread', idxs.length > 1)
        this.el.scrollTop = 0
        // освобождаем далёкие страницы
        if (this.src.releasePage) for (const k of this.loaded ?? []) if (Math.abs(k - i) > 4) this.src.releasePage(k)
        this.loaded = new Set([...(this.loaded ?? []), ...idxs].filter(k => Math.abs(k - i) <= 4))
        // предзагрузка соседних
        for (const k of [i + idxs.length, i + idxs.length + 1, i - 1]) if (k >= 0 && k < this.src.count) this.src.getPage(k).catch(() => {})
    }
    #emit() {
        this.ctx.onRelocate({ fraction: this.src.count > 1 ? this.index / (this.src.count - 1) : 1, page: this.index + 1, pages: this.src.count, label: '' })
    }
    async goTo(i, keepScroll) {
        i = Math.max(0, Math.min(this.src.count - 1, Number(i) || 0))
        if (this.mode === 'spread' && i > 0 && i % 2 === 0) i -= 1
        this.index = i
        if (this.mode === 'scroll') {
            const slot = this.slots[i]
            if (slot) { this.#fill(i); slot.scrollIntoView({ block: 'start' }) }
        } else await this.#renderPaged()
        this.#emit()
    }
    goToPage(n) { return this.goTo(n - 1) }
    goToFraction(f) { return this.goTo(Math.round(f * (this.src.count - 1))) }
    step() { return this.mode === 'spread' ? (this.index === 0 ? 1 : 2) : 1 }
    next() {
        if (this.mode === 'scroll') { this.el.scrollBy({ top: this.el.clientHeight * 0.9 }); return }
        return this.goTo(this.index + this.step())
    }
    prev() {
        if (this.mode === 'scroll') { this.el.scrollBy({ top: -this.el.clientHeight * 0.9 }); return }
        return this.goTo(this.index - (this.mode === 'spread' ? 2 : 1))
    }
    getPosition() { return { page: this.index, fraction: this.src.count > 1 ? this.index / (this.src.count - 1) : 1 } }
    getToc() { return this.src.toc ?? [] }
    async *search(query) {
        const q = query.toLowerCase()
        for (let i = 0; i < this.src.count; i++) {
            const text = await this.src.getText(i)
            const lower = text.toLowerCase()
            const items = []
            let idx = lower.indexOf(q)
            while (idx >= 0 && items.length < 50) {
                items.push({ excerpt: { pre: text.slice(Math.max(0, idx - 40), idx), match: text.slice(idx, idx + q.length), post: text.slice(idx + q.length, idx + q.length + 40) }, target: i })
                idx = lower.indexOf(q, idx + q.length)
            }
            if (items.length) yield { label: `Страница ${i + 1}`, items }
            if (i % 10 === 9) yield { progress: (i + 1) / this.src.count }
        }
    }
    clearSearch() {}
    goToResult(target) { return this.goTo(target) }
    #setupTouch() {
        let sx = 0, sy = 0, t = 0
        this.el.addEventListener('touchstart', e => { const p = e.touches[0]; sx = p.clientX; sy = p.clientY; t = Date.now() }, { passive: true })
        this.el.addEventListener('touchend', e => {
            if (this.mode === 'scroll' || e.changedTouches.length !== 1) return
            const p = e.changedTouches[0]
            const dx = p.clientX - sx, dy = p.clientY - sy
            if (Date.now() - t < 600 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                if (dx < 0) this.next(); else this.prev()
            }
        }, { passive: true })
    }
    destroy() {
        this.observer?.disconnect()
        this.src.destroy?.()
        this.el.remove()
    }
}
