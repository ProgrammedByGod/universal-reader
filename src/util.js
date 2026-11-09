// Общие утилиты читалки

export const escapeHtml = s => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export const debounce = (fn, ms) => {
    let t
    const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
    d.flush = (...a) => { clearTimeout(t); fn(...a) }
    d.cancel = () => clearTimeout(t)
    return d
}

// Определение кодировки текста: BOM, затем строгий UTF-8, иначе windows-1251
export const decodeText = buf => {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF)
        return new TextDecoder('utf-8').decode(u8.subarray(3))
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8.subarray(2))
    if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8.subarray(2))
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8) }
    catch { return new TextDecoder('windows-1251').decode(u8) }
}

export const naturalCompare = new Intl.Collator([], { numeric: true, sensitivity: 'base' }).compare

export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'avif', 'jxl']
export const MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
    jxl: 'image/jxl', css: 'text/css', html: 'text/html', htm: 'text/html',
    xhtml: 'application/xhtml+xml', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff',
    woff2: 'font/woff2',
}
export const extOf = name => (name.match(/\.([^./\\]+)$/)?.[1] ?? '').toLowerCase()
export const isImageName = name => IMAGE_EXTS.includes(extOf(name)) && !/(^|\/)(__MACOSX|\.)/.test(name)

// Тип архива по сигнатуре
export const sniffArchive = buf => {
    const u = new Uint8Array(buf.slice ? buf.slice(0, 300) : buf)
    if (u[0] === 0x50 && u[1] === 0x4B) return 'zip'
    if (u[0] === 0x52 && u[1] === 0x61 && u[2] === 0x72 && u[3] === 0x21) return 'rar'
    if (u[0] === 0x37 && u[1] === 0x7A && u[2] === 0xBC && u[3] === 0xAF) return '7z'
    if (u[257] === 0x75 && u[258] === 0x73 && u[259] === 0x74 && u[260] === 0x61 && u[261] === 0x72) return 'tar'
    return null
}

// Простейший разбор tar (ustar / gnu)
export const parseTar = buf => {
    const u8 = new Uint8Array(buf)
    const dec = new TextDecoder()
    const entries = []
    let off = 0
    let longName = null
    const str = (o, l) => dec.decode(u8.subarray(o, o + l)).replace(/\0.*$/s, '')
    while (off + 512 <= u8.length) {
        if (u8[off] === 0) break
        let name = str(off, 100)
        const size = parseInt(str(off + 124, 12).trim() || '0', 8)
        const type = String.fromCharCode(u8[off + 156] || 48)
        const prefix = str(off + 345, 155)
        if (prefix && !longName) name = prefix + '/' + name
        const dataOff = off + 512
        if (type === 'L') longName = str(dataOff, size)
        else if (type === 'x') { const m = /\d+ path=([^\n]*)\n/.exec(dec.decode(u8.subarray(dataOff, dataOff + size))); if (m) longName = m[1] }
        else if (type === 'g') { /* глобальные PAX-заголовки пропускаем */ }
        else {
            if (longName) { name = longName; longName = null }
            if (type === '0' || type === '\0' || type === '7')
                entries.push({ name, offset: dataOff, size })
        }
        off = dataOff + Math.ceil(size / 512) * 512
    }
    return { entries, data: u8 }
}

// Подсветка совпадений в обычном DOM (для кода, таблиц, документов)
export const domSearch = (root, query) => {
    clearDomSearch(root)
    const q = query.trim().toLowerCase()
    if (!q) return []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: n => n.parentElement?.closest('script,style,.ur-nosearch')
            ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    })
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    const marks = []
    for (const node of nodes) {
        const text = node.nodeValue
        const lower = text.toLowerCase()
        let idx = lower.indexOf(q)
        if (idx < 0) continue
        const frag = document.createDocumentFragment()
        let last = 0
        while (idx >= 0) {
            frag.append(text.slice(last, idx))
            const m = document.createElement('mark')
            m.className = 'ur-hit'
            m.textContent = text.slice(idx, idx + q.length)
            frag.append(m)
            marks.push({ mark: m, text, idx })
            last = idx + q.length
            idx = lower.indexOf(q, last)
        }
        frag.append(text.slice(last))
        node.replaceWith(frag)
    }
    return marks.map(({ mark, text, idx }) => ({
        target: mark,
        excerpt: {
            pre: text.slice(Math.max(0, idx - 40), idx),
            match: mark.textContent,
            post: text.slice(idx + q.length, idx + q.length + 40),
        },
    }))
}
export const clearDomSearch = root => {
    for (const m of root.querySelectorAll('mark.ur-hit')) m.replaceWith(m.textContent)
    root.normalize()
}
export const focusHit = (root, mark) => {
    for (const m of root.querySelectorAll('mark.ur-hit.is-active')) m.classList.remove('is-active')
    mark.classList.add('is-active')
    mark.scrollIntoView({ block: 'center' })
}

// Холст -> blob URL
export const canvasToUrl = (canvas, type = 'image/jpeg', q = 0.92) => new Promise(res =>
    canvas.toBlob(b => res(URL.createObjectURL(b)), type, q))
export const imageDataToUrl = async imageData => {
    const c = document.createElement('canvas')
    c.width = imageData.width; c.height = imageData.height
    c.getContext('2d').putImageData(imageData, 0, 0)
    return { url: await canvasToUrl(c), width: c.width, height: c.height }
}

export class ReaderError extends Error {}
