// Превращает HTML-разделы в «книгу» для движка foliate-js.
// Через этот адаптер читаются txt, docx, odt, rtf, fb3, htmlz, txtz и .md как книга.
import { escapeHtml } from '../util.js'

const BASE_CSS = `
img, svg, video { max-width: 100%; height: auto; }
table { border-collapse: collapse; max-width: 100%; }
td, th { border: 1px solid rgba(128,128,128,.4); padding: 2px 6px; vertical-align: top; }
pre { white-space: pre-wrap; }
.ur-note { font-size: .85em; opacity: .85; border-top: 1px solid rgba(128,128,128,.4); margin-top: 2em; padding-top: .5em; }
`

const headingText = el => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)

// Делит один большой HTML на разделы по заголовкам h1/h2 (или по размеру)
export const splitHtml = (html, { title = '', maxSize = 250_000 } = {}) => {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
    const kids = Array.from(doc.body.childNodes)
    const hasH1 = !!doc.body.querySelector(':scope > h1')
    const splitTag = hasH1 ? 'H1' : (doc.body.querySelector(':scope > h2') ? 'H2' : null)
    const sections = []
    let cur = { title: '', parts: [], size: 0 }
    const push = () => {
        if (cur.parts.length && cur.parts.some(p => p.trim())) sections.push(cur)
        cur = { title: '', parts: [], size: 0 }
    }
    for (const node of kids) {
        const isSplit = node.nodeType === 1 && node.tagName === splitTag
        const s = node.nodeType === 1 ? node.outerHTML : escapeHtml(node.textContent)
        if ((isSplit && cur.size > 0) || cur.size > maxSize) push()
        if (isSplit && !cur.title) cur.title = headingText(node)
        cur.parts.push(s); cur.size += s.length
    }
    push()
    if (!sections.length) sections.push({ title, parts: [html], size: html.length })
    return sections.map((s, i) => ({
        title: s.title || (sections.length === 1 ? title : `Часть ${i + 1}`),
        html: s.parts.join(''),
    }))
}

// Текст -> разделы (главы определяются по строкам «Глава…», «Часть…», «Chapter…»)
const CHAPTER_RE = /^\s*((глава|часть|книга|пролог|эпилог|предисловие|послесловие|chapter|part|book|prologue|epilogue)(\s|$|[.:\dIVXLC])|[IVXLC]{1,7}\.?\s*$|\*\s*\*\s*\*\s*$)/i
export const textToSections = (text, title = '') => {
    text = text.replace(/\r\n?/g, '\n')
    const hasBlank = /\n[ \t]*\n/.test(text)
    const paras = hasBlank ? text.split(/\n[ \t]*\n+/) : text.split('\n')
    const sections = []
    let cur = { title: '', parts: [], size: 0 }
    const push = () => { if (cur.parts.length) sections.push(cur); cur = { title: '', parts: [], size: 0 } }
    for (const raw of paras) {
        const p = raw.replace(/^\n+|\n+$/g, '')
        if (!p.trim()) continue
        const oneLine = !p.includes('\n') && p.trim().length < 80
        if (oneLine && CHAPTER_RE.test(p) && !/^\s*\*/.test(p)) {
            if (cur.size > 0) push()
            cur.title = p.trim()
            cur.parts.push(`<h2>${escapeHtml(p.trim())}</h2>`)
            continue
        }
        if (cur.size > 120_000) push()
        const h = `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`
        cur.parts.push(h); cur.size += h.length
    }
    push()
    if (!sections.length) sections.push({ title, parts: ['<p></p>'] })
    return sections.map((s, i) => ({
        title: s.title || (i === 0 ? (title || 'Начало') : `Часть ${i + 1}`),
        html: s.parts.join('\n'),
    }))
}

export const makeHtmlBook = ({ title = '', author = '', sections, css = '', lang = '', urls = [] }) => {
    const book = {}
    const blobUrls = [...urls]
    const idMap = new Map()
    const prepared = sections.map((sec, index) => {
        const doc = new DOMParser().parseFromString(
            `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${sec.html}</body></html>`, 'text/html')
        let n = 0
        const subs = []
        for (const h of doc.body.querySelectorAll('h1, h2, h3')) {
            if (!h.id) h.id = `ur-h-${index}-${n++}`
            const label = headingText(h)
            if (label && label !== sec.title) subs.push({ label, href: `${index}#${h.id}` })
        }
        for (const el of doc.body.querySelectorAll('[id]')) idMap.set(el.id, index)
        const style = doc.createElement('style')
        style.textContent = BASE_CSS + css
        doc.head.append(style)
        if (lang) doc.documentElement.lang = lang
        const str = '<!DOCTYPE html>' + doc.documentElement.outerHTML
        const blob = new Blob([str], { type: 'text/html' })
        const url = URL.createObjectURL(blob)
        blobUrls.push(url)
        return { str, url, size: blob.size, subs: subs.length > 1 ? subs.slice(0, 200) : null }
    })
    book.metadata = { title, author, language: lang }
    book.sections = prepared.map((p, index) => ({
        id: index,
        load: () => p.url,
        createDocument: () => new DOMParser().parseFromString(p.str, 'text/html'),
        size: p.size,
    }))
    book.toc = sections.map((s, i) => ({ label: s.title || `Часть ${i + 1}`, href: `${i}`, subitems: prepared[i].subs }))
    book.resolveHref = href => {
        const [a, b] = String(href).split('#')
        if (a !== '' && !isNaN(Number(a)))
            return { index: Number(a), anchor: b ? doc => doc.getElementById(b) : undefined }
        if (b && idMap.has(b)) return { index: idMap.get(b), anchor: doc => doc.getElementById(b) }
        return null
    }
    book.splitTOCHref = href => {
        const [a, b] = String(href ?? '').split('#')
        return [Number(a), b ?? null]
    }
    book.getTOCFragment = (doc, id) => doc.getElementById(id)
    book.isExternal = uri => /^(?!blob:)\w+:/i.test(uri)
    book.destroy = () => blobUrls.forEach(u => URL.revokeObjectURL(u))
    return book
}
