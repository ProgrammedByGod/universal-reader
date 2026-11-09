// Загрузка «текучих» книг и документов в формат книги foliate-js
import JSZip from 'jszip'
import { EPUB } from '../../vendor/foliate-js/epub.js'
import { makeFB2 } from '../../vendor/foliate-js/fb2.js'
import { isMOBI, MOBI } from '../../vendor/foliate-js/mobi.js'
import { unzlibSync } from '../../vendor/foliate-js/vendor/fflate.js'
import { configure, ZipReader, BlobReader, TextWriter, BlobWriter } from '../../vendor/foliate-js/vendor/zip.js'
import { makeHtmlBook, splitHtml, textToSections } from './htmlbook.js'
import * as OLD from './legacy.js'

// старые форматы возвращают { title, html } или { title, text }
const makeLegacyBook = async res => {
    const r = await res
    const sections = r.html != null ? splitHtml(r.html, { title: r.title }) : textToSections(r.text, r.title)
    return makeHtmlBook({ title: r.title, sections, urls: r.urls || [] })
}
import { decodeText, escapeHtml, extOf, MIME, ReaderError } from '../util.js'

configure({ useWebWorkers: false })

const makeZipLoader = async blob => {
    const reader = new ZipReader(new BlobReader(blob))
    const entries = await reader.getEntries()
    const map = new Map(entries.map(e => [e.filename, e]))
    const load = f => (name, ...args) => map.has(name) ? f(map.get(name), ...args) : null
    return {
        entries,
        loadText: load(e => e.getData(new TextWriter())),
        loadBlob: load((e, type) => e.getData(new BlobWriter(type))),
        getSize: name => map.get(name)?.uncompressedSize ?? 0,
    }
}

const baseName = name => name.replace(/\.[^.]+$/, '')

// ---------- форматы, которые foliate-js понимает сам ----------
const openEpub = async blob => new EPUB(await makeZipLoader(blob)).init()

// PalmDOC (.pdb/.prc с типом TEXtREAd): простой текст со сжатием LZ77
const openPalmDoc = (buf, title) => {
    const u8 = new Uint8Array(buf)
    const dv = new DataView(buf)
    const n = dv.getUint16(76)
    const offs = Array.from({ length: n }, (_, i) => dv.getUint32(78 + i * 8))
    offs.push(u8.length)
    const r0 = offs[0]
    const compression = dv.getUint16(r0)
    const count = dv.getUint16(r0 + 8)
    if (compression !== 1 && compression !== 2) throw new ReaderError('Этот вариант PalmDOC (сжатие HUFF/CDIC) не поддерживается.')
    const out = []
    for (let r = 1; r <= count && r < n; r++) {
        const rec = u8.subarray(offs[r], offs[r + 1])
        if (compression === 1) { for (const b of rec) out.push(b); continue }
        for (let i = 0; i < rec.length;) {
            const c = rec[i++]
            if (c === 0 || (c >= 9 && c <= 0x7f)) out.push(c)
            else if (c >= 1 && c <= 8) { for (let k = 0; k < c && i < rec.length; k++) out.push(rec[i++]) }
            else if (c >= 0xC0) out.push(32, c ^ 0x80)
            else {
                const c2 = rec[i++]
                const pair = (c << 8) | c2
                const dist = (pair >> 3) & 0x7FF, len = (pair & 7) + 3
                for (let k = 0; k < len; k++) out.push(out[out.length - dist])
            }
        }
    }
    const name = new TextDecoder('latin1').decode(u8.subarray(0, 32)).replace(/\0.*$/s, '').replace(/_/g, ' ')
    return makeHtmlBook({ title: name || title, sections: textToSections(decodeText(new Uint8Array(out)), name || title) })
}
const palmType = buf => buf.byteLength > 68 ? new TextDecoder('latin1').decode(new Uint8Array(buf, 60, 8)) : ''

const openMobi = async file => {
    if (!(await isMOBI(file))) throw new ReaderError('Этот файл не является книгой Mobipocket/Kindle (возможно, другой формат Palm или книга с защитой DRM).')
    return new MOBI({ unzlib: unzlibSync }).open(file)
}

const openFb2Blob = blob => makeFB2(blob)

// .zip: смотрим, что внутри
export const sniffZipBook = async buf => {
    const zip = await JSZip.loadAsync(buf)
    const names = Object.keys(zip.files)
    const mimetype = zip.file('mimetype') && (await zip.file('mimetype').async('string')).trim()
    if (mimetype === 'application/epub+zip' || names.some(n => /META-INF\/container\.xml$/i.test(n))) return 'epub'
    if (names.some(n => /\.fb2$/i.test(n))) return 'fbz'
    if (names.some(n => /^fb3\//i.test(n))) return 'fb3'
    // комикс — только если почти все файлы в архиве картинки (служебные ComicInfo.xml и т. п. не считаем)
    const files = names.filter(n => !zip.files[n].dir && !/(^|\/)(__MACOSX|\.)|ComicInfo\.xml$|\.(nfo|sfv|txt|db)$/i.test(n))
    const imgs = files.filter(n => /\.(jpe?g|png|gif|webp|bmp|avif|jxl)$/i.test(n))
    if (imgs.length && imgs.length / files.length >= 0.8) return 'comic'
    return null
}

// ---------- свои адаптеры ----------
const openTxt = (buf, title) => makeHtmlBook({ title, sections: textToSections(decodeText(buf), title) })

const openTxtz = async (buf, title) => {
    const zip = await JSZip.loadAsync(buf)
    const name = Object.keys(zip.files).find(n => /\.(txt|md|markdown|textile)$/i.test(n))
    if (!name) throw new ReaderError('В архиве .txtz не найден текстовый файл.')
    const text = decodeText(await zip.file(name).async('uint8array'))
    return makeHtmlBook({ title, sections: textToSections(text, title) })
}

// Ресурсы из zip -> blob URL, переписываем ссылки в HTML
const rewriteResources = async (zip, html, baseDir, urls) => {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const resolve = rel => {
        if (!rel || /^(\w+:|#)/.test(rel)) return null
        const parts = (baseDir + rel.split('#')[0].split('?')[0]).split('/')
        const out = []
        for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p) }
        return decodeURIComponent(out.join('/'))
    }
    const toUrl = async path => {
        const f = path && (zip.file(path) || zip.file(decodeURI(path)))
        if (!f) return null
        const blob = new Blob([await f.async('uint8array')], { type: MIME[extOf(path)] || '' })
        const u = URL.createObjectURL(blob); urls.push(u); return u
    }
    for (const el of doc.querySelectorAll('img[src], image, source[src]')) {
        const attr = el.hasAttribute('src') ? 'src' : (el.hasAttribute('href') ? 'href' : 'xlink:href')
        const u = await toUrl(resolve(el.getAttribute(attr)))
        if (u) el.setAttribute(attr, u)
    }
    let css = ''
    for (const link of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
        const path = resolve(link.getAttribute('href'))
        const f = path && zip.file(path)
        if (f) css += await f.async('string')
        link.remove()
    }
    for (const st of doc.querySelectorAll('style')) { css += st.textContent; st.remove() }
    return { body: doc.body.innerHTML, css, title: doc.title }
}

const openHtmlz = async (buf, title) => {
    const zip = await JSZip.loadAsync(buf)
    const name = Object.keys(zip.files).find(n => /(^|\/)index\.x?html?$/i.test(n))
        || Object.keys(zip.files).find(n => /\.x?html?$/i.test(n))
    if (!name) throw new ReaderError('В архиве .htmlz не найден HTML-файл.')
    const urls = []
    const baseDir = name.includes('/') ? name.replace(/[^/]+$/, '') : ''
    const html = decodeText(await zip.file(name).async('uint8array'))
    const { body, css, title: t } = await rewriteResources(zip, html, baseDir, urls)
    const bookTitle = t || title
    return makeHtmlBook({ title: bookTitle, sections: splitHtml(body, { title: bookTitle }), css, urls })
}

// ---------- FB3 (zip + XML, похож на FB2) ----------
const openFb3 = async (buf, title) => {
    const zip = await JSZip.loadAsync(buf)
    const names = Object.keys(zip.files)
    const bodyName = names.find(n => /fb3\/body\.xml$/i.test(n)) || names.find(n => /body\.xml$/i.test(n))
    if (!bodyName) throw new ReaderError('В архиве .fb3 не найден body.xml.')
    const xml = new DOMParser().parseFromString(await zip.file(bodyName).async('string'), 'application/xml')
    const relsName = bodyName.replace(/[^/]+$/, '_rels/') + bodyName.split('/').pop() + '.rels'
    const rels = new Map()
    if (zip.file(relsName)) {
        const r = new DOMParser().parseFromString(await zip.file(relsName).async('string'), 'application/xml')
        for (const rel of r.getElementsByTagName('Relationship'))
            rels.set(rel.getAttribute('Id'), rel.getAttribute('Target'))
    }
    const dir = bodyName.replace(/[^/]+$/, '')
    const urls = []
    const imgUrl = async id => {
        let target = rels.get(id)
        if (!target) return null
        target = target.startsWith('/') ? target.slice(1) : dir + target
        const parts = []; for (const p of target.split('/')) { if (p === '..') parts.pop(); else parts.push(p) }
        const f = zip.file(parts.join('/'))
        if (!f) return null
        const u = URL.createObjectURL(new Blob([await f.async('uint8array')], { type: MIME[extOf(target)] || '' }))
        urls.push(u); return u
    }
    const TAG = { p: 'p', strong: 'strong', em: 'em', underline: 'u', strikethrough: 'del', sub: 'sub', sup: 'sup',
        code: 'code', epigraph: 'blockquote', blockquote: 'blockquote', poem: 'div', stanza: 'div', ol: 'ol', ul: 'ul', li: 'li',
        table: 'table', tr: 'tr', td: 'td', th: 'th', subtitle: 'h4', 'text-author': 'p', annotation: 'div', br: 'br', spacing: 'span' }
    const conv = async (node, depth) => {
        if (node.nodeType === 3) return escapeHtml(node.nodeValue)
        if (node.nodeType !== 1) return ''
        const name = node.localName
        const inner = async d => (await Promise.all(Array.from(node.childNodes, c => conv(c, d)))).join('')
        if (name === 'section') return `<section>${await inner(depth + 1)}</section>`
        if (name === 'title') { const n = Math.min(depth + 1, 6); return `<h${n}>${await inner(depth)}</h${n}>` }
        if (name === 'a') {
            const href = node.getAttribute('xlink:href') || node.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || ''
            return `<a href="${escapeHtml(href)}">${await inner(depth)}</a>`
        }
        if (name === 'img') { const u = await imgUrl(node.getAttribute('src')); return u ? `<img src="${u}">` : '' }
        if (name === 'note' || name === 'notes') return `<div class="ur-note">${await inner(depth)}</div>`
        const tag = TAG[name]
        const idAttr = node.getAttribute('id') ? ` id="${escapeHtml(node.getAttribute('id'))}"` : ''
        if (tag === 'br') return '<br>'
        return tag ? `<${tag}${idAttr}>${await inner(depth)}</${tag}>` : await inner(depth)
    }
    const root = xml.documentElement
    const sections = []
    for (const child of root.children) {
        const html = await conv(child, 1)
        const t = child.localName === 'section'
            ? (child.querySelector('title')?.textContent ?? '').replace(/\s+/g, ' ').trim() : ''
        if (html.trim()) sections.push({ title: t, html })
    }
    let bookTitle = title
    const descName = names.find(n => /description\.xml$/i.test(n))
    if (descName) {
        const d = new DOMParser().parseFromString(await zip.file(descName).async('string'), 'application/xml')
        bookTitle = d.querySelector('title main, title')?.textContent?.trim() || title
    }
    return makeHtmlBook({ title: bookTitle, sections: sections.length ? sections : [{ title: bookTitle, html: '' }], urls })
}

// ---------- ODT ----------
// flat = true: «плоский» .fodt — один XML-файл без zip, картинки внутри в base64
const openOdt = async (buf, title, flat = false) => {
    let zip = null, xml
    if (flat) {
        xml = new DOMParser().parseFromString(decodeText(buf), 'application/xml')
        if (xml.querySelector('parsererror')) throw new ReaderError('Файл .fodt повреждён (ошибка XML).')
    } else {
        zip = await JSZip.loadAsync(buf)
        const content = zip.file('content.xml')
        if (!content) throw new ReaderError('В файле .odt не найден content.xml.')
        xml = new DOMParser().parseFromString(await content.async('string'), 'application/xml')
    }
    const styles = new Map()
    const readStyles = doc => {
        for (const st of doc.getElementsByTagName('style:style')) {
            const tp = st.getElementsByTagName('style:text-properties')[0]
            if (!tp) continue
            styles.set(st.getAttribute('style:name'), {
                b: tp.getAttribute('fo:font-weight') === 'bold',
                i: tp.getAttribute('fo:font-style') === 'italic',
                u: !!tp.getAttribute('style:text-underline-style') && tp.getAttribute('style:text-underline-style') !== 'none',
                s: !!tp.getAttribute('style:text-line-through-style') && tp.getAttribute('style:text-line-through-style') !== 'none',
                bg: tp.getAttribute('fo:background-color'),
            })
        }
    }
    readStyles(xml)
    if (zip?.file('styles.xml')) readStyles(new DOMParser().parseFromString(await zip.file('styles.xml').async('string'), 'application/xml'))
    const urls = []
    let noteN = 0
    const notes = []
    const wrap = (html, st) => {
        if (!st) return html
        if (st.b) html = `<b>${html}</b>`
        if (st.i) html = `<i>${html}</i>`
        if (st.u) html = `<u>${html}</u>`
        if (st.s) html = `<s>${html}</s>`
        if (st.bg && st.bg !== 'transparent') html = `<span style="background:${escapeHtml(st.bg)}">${html}</span>`
        return html
    }
    const conv = async node => {
        if (node.nodeType === 3) return escapeHtml(node.nodeValue)
        if (node.nodeType !== 1) return ''
        const inner = async () => (await Promise.all(Array.from(node.childNodes, conv))).join('')
        const st = styles.get(node.getAttribute('text:style-name'))
        switch (node.nodeName) {
            case 'text:h': {
                const l = Math.min(Number(node.getAttribute('text:outline-level') || node.getAttribute('text:level') || 1), 6)
                return `<h${l}>${await inner()}</h${l}>`
            }
            case 'text:p': return `<p>${wrap(await inner(), st)}</p>`
            case 'text:span': return wrap(await inner(), st)
            case 'text:s': return '&nbsp;'.repeat(Number(node.getAttribute('text:c') || 1))
            case 'text:tab': return '&emsp;'
            case 'text:line-break': return '<br>'
            case 'text:a': return `<a href="${escapeHtml(node.getAttribute('xlink:href') || '')}">${await inner()}</a>`
            case 'text:list': case 'text:unordered-list': return `<ul>${await inner()}</ul>`
            case 'text:ordered-list': return `<ol>${await inner()}</ol>`
            case 'text:list-item': return `<li>${await inner()}</li>`
            case 'table:table': return `<table>${await inner()}</table>`
            case 'table:table-row': return `<tr>${await inner()}</tr>`
            case 'table:table-cell': return `<td>${await inner()}</td>`
            case 'text:note': {
                const n = ++noteN
                const body = node.getElementsByTagName('text:note-body')[0]
                notes.push(`<p id="ur-note-${n}"><a href="#ur-ref-${n}">${n}.</a> ${body ? (await Promise.all(Array.from(body.childNodes, conv))).join('') : ''}</p>`)
                return `<sup id="ur-ref-${n}"><a href="#ur-note-${n}">${n}</a></sup>`
            }
            case 'draw:image': {
                const bin = node.getElementsByTagName('office:binary-data')[0]
                if (bin) {
                    const b64 = bin.textContent.replace(/\s/g, '')
                    const type = b64.startsWith('iVBOR') ? 'image/png' : b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('R0lG') ? 'image/gif' : 'image/png'
                    return `<img src="data:${type};base64,${b64}">`
                }
                const href = node.getAttribute('xlink:href')
                const f = href && zip?.file(href)
                if (!f) return ''
                const u = URL.createObjectURL(new Blob([await f.async('uint8array')], { type: MIME[extOf(href)] || '' }))
                urls.push(u); return `<img src="${u}">`
            }
            case 'text:sequence-decls': case 'office:forms': case 'text:tracked-changes': return ''
            default: return inner()
        }
    }
    const body = xml.getElementsByTagName('office:text')[0] || xml.documentElement
    let html = await conv(body)
    if (notes.length) html += `<div class="ur-note"><h3>Примечания</h3>${notes.join('')}</div>`
    return makeHtmlBook({ title, sections: splitHtml(html, { title }), urls })
}

// ---------- DOCX (mammoth) и RTF (rtf.js) — подгружаются отдельно ----------
const openDocx = async (ctx, buf, title) => {
    const mammoth = await ctx.loadLib('mammoth')
    const res = await mammoth.convertToHtml({ arrayBuffer: buf })
    return makeHtmlBook({ title, sections: splitHtml(res.value, { title }) })
}

const openRtf = async (ctx, buf, title) => {
    const { RTFJS } = await ctx.loadLib('rtf')
    RTFJS.loggingEnabled(false)
    let html
    try {
        const doc = new RTFJS.Document(buf)
        const els = await doc.render()
        const div = document.createElement('div')
        div.append(...els)
        html = div.innerHTML
    } catch (e) {
        console.warn('rtf.js failed, fallback to plain text', e)
        const text = decodeText(buf)
            .replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^{}]*\}/g, '')
            .replace(/\\'([0-9a-f]{2})/gi, (_, h) => new TextDecoder('windows-1251').decode(new Uint8Array([parseInt(h, 16)])))
            .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode(n < 0 ? 65536 + Number(n) : Number(n)))
            .replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '')
        return makeHtmlBook({ title, sections: textToSections(text, title) })
    }
    return makeHtmlBook({ title, sections: splitHtml(html, { title }) })
}

// ---------- .md как книга ----------
export const openMarkdownAsBook = async (ctx, file) => {
    const md = await ctx.app.vault.cachedRead(file)
    const div = document.createElement('div')
    await ctx.renderMarkdown(md, div, file.path)
    for (const el of div.querySelectorAll('.copy-code-button, .collapse-indicator, .heading-collapse-indicator')) el.remove()
    return makeHtmlBook({ title: file.basename, sections: splitHtml(div.innerHTML, { title: file.basename }) })
}

// Главная точка входа
export const openFlowBook = async (ctx, file, ext, buf) => {
    const title = baseName(file.name)
    const asFile = () => new File([buf], file.name)
    switch (ext) {
        case 'epub': case 'kepub': return openEpub(asFile())
        case 'mobi': case 'azw3': case 'azw': case 'prc': case 'pdb': {
            if (ext === 'azw' && palmType(buf) === '') throw new ReaderError('Файл .azw повреждён или не является книгой Kindle.')
            const kind = palmType(buf)
            if (kind === 'TEXtREAd') return openPalmDoc(buf, title)
            if (kind === 'zTXTGPlm' || kind.startsWith('zTXT')) return makeLegacyBook(OLD.openZtxt(buf, title))
            if (kind === 'PNRdPPrs' || kind === 'PNPdPPrs') return makeLegacyBook(OLD.openEreader(buf, title))
        }
            return openMobi(asFile())
        case 'fb2': return openFb2Blob(asFile())
        case 'fbz': {
            const loader = await makeZipLoader(asFile())
            const entry = loader.entries.find(e => /\.fb2$/i.test(e.filename)) ?? loader.entries[0]
            return openFb2Blob(await loader.loadBlob(entry.filename))
        }
        case 'zip': {
            const kind = await sniffZipBook(buf)
            if (kind === 'epub') return openEpub(asFile())
            if (kind === 'fbz') return openFlowBook(ctx, file, 'fbz', buf)
            if (kind === 'fb3') return openFb3(buf, title)
            throw new ReaderError('Этот zip-архив не похож на книгу.')
        }
        case 'fb3': return openFb3(buf, title)
        case 'txt': return openTxt(buf, title)
        case 'txtz': return openTxtz(buf, title)
        case 'htmlz': return openHtmlz(buf, title)
        case 'odt': case 'ott': case 'sxw': case 'stw': return openOdt(buf, title)
        case 'fodt': return openOdt(buf, title, true)
        case 'tcr': return makeLegacyBook(OLD.openTcr(buf, title))
        case 'pml': return makeLegacyBook(OLD.openPml(buf, title))
        case 'snb': return makeLegacyBook(await OLD.openSnb(ctx, buf, title))
        case 'lrf': return makeLegacyBook(OLD.openLrf(buf, title))
        case 'docx': case 'docm': case 'dotx': case 'dotm': return openDocx(ctx, buf, title)
        case 'rtf': return openRtf(ctx, buf, title)
    }
    throw new ReaderError('Формат не поддерживается: ' + ext)
}
