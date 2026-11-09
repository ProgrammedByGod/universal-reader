// Документы версии 0.6: Word 97–2003 (.doc), Write (.wri), Works (.wps), PowerPoint 97–2003 (.ppt),
// справка CHM, DocBook, TEI, JATS, GNU Info и Texinfo, KWord, Scribus, HWPX, OFD, Celtx, формулы .odf,
// XPS, Visio (.vsdx), InDesign (.idml)
import JSZip from 'jszip'
import { escapeHtml as esc, decodeText, ReaderError, MIME, extOf } from '../util.js'
import { readCfb, isCfb } from './cfb.js'
import { makeHtmlBook, splitHtml, textToSections } from './htmlbook.js'

const latin = new TextDecoder('latin1')
const utf16 = new TextDecoder('utf-16le')
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e }
const xmlDoc = (text, what) => { const d = new DOMParser().parseFromString(text, 'application/xml'); if (d.querySelector('parsererror')) throw new ReaderError(`Не удалось прочитать ${what} (ошибка XML).`); return d }
const blobUrl = (urls, bytes, name) => { const u = URL.createObjectURL(new Blob([bytes], { type: MIME[extOf(name)] || '' })); urls.push(u); return u }

// ================= Word 97–2003 (.doc, .dot) =================
// Текст собираем по «таблице кусков» (piece table); таблицы Word — по меткам ячеек
const CP1252_80 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ'
const decode8 = bytes => { let s = ''; for (const b of bytes) s += b >= 0x80 && b < 0xA0 ? CP1252_80[b - 0x80] : String.fromCharCode(b); return s }
export const docText = cfb => {
    const wd = cfb.get('WordDocument')
    if (!wd) throw new ReaderError('В документе нет основного текста Word.')
    const dv = new DataView(wd.buffer, wd.byteOffset, wd.byteLength)
    if (dv.getUint16(0, true) !== 0xA5EC && dv.getUint16(0, true) !== 0xA5DC) throw new ReaderError('Это не документ Word 97–2003.')
    const nFib = dv.getUint16(2, true), flags = dv.getUint16(10, true)
    if (flags & 0x0100) throw new ReaderError('Документ защищён паролем — прочитать его нельзя.')
    if (nFib <= 105 || dv.getUint16(0, true) === 0xA5DC) {
        // Word 6/95: текст лежит подряд, однобайтовый (кодировку определяем сами)
        const fcMin = dv.getUint32(24, true), fcMac = dv.getUint32(28, true)
        return decodeText(wd.subarray(fcMin, fcMac))
    }
    const csw = dv.getUint16(32, true)
    const lwStart = 34 + csw * 2, cslw = dv.getUint16(lwStart, true)
    const ccpText = dv.getInt32(lwStart + 2 + 3 * 4, true)
    const fcStart = lwStart + 2 + cslw * 4 + 2
    const fcClx = dv.getUint32(fcStart + 33 * 8, true), lcbClx = dv.getUint32(fcStart + 33 * 8 + 4, true)
    const table = cfb.get(flags & 0x0200 ? '1Table' : '0Table')
    if (!table || !lcbClx) throw new ReaderError('В документе Word не найдена таблица текста.')
    const clx = table.subarray(fcClx, fcClx + lcbClx)
    const cdv = new DataView(clx.buffer, clx.byteOffset, clx.byteLength)
    let p = 0
    while (clx[p] === 0x01) p += 3 + cdv.getUint16(p + 1, true)
    if (clx[p] !== 0x02) throw new ReaderError('Таблица текста Word повреждена.')
    const lcb = cdv.getUint32(p + 1, true); p += 5
    const n = (lcb - 4) / 12
    const cps = [], pcds = []
    for (let i = 0; i <= n; i++) cps.push(cdv.getUint32(p + i * 4, true))
    for (let i = 0; i < n; i++) pcds.push(cdv.getUint32(p + (n + 1) * 4 + i * 8 + 2, true))
    let out = ''
    for (let i = 0; i < n && cps[i] < ccpText; i++) {
        const len = Math.min(cps[i + 1], ccpText) - cps[i]
        const fc = pcds[i]
        if (fc & 0x40000000) { const off = (fc & 0x3FFFFFFF) / 2; out += decode8(wd.subarray(off, off + len)) }
        else out += utf16.decode(wd.subarray(fc, fc + len * 2))
    }
    return out
}
// Специальные символы Word: \r — абзац, \x07 — конец ячейки/строки таблицы, \x0b — перенос строки,
// \x0c — разрыв страницы, \x13…\x14…\x15 — поле (оставляем видимую часть), \x01 и \x08 — картинки
export const wordTextToHtml = text => {
    // поля: убираем код поля, оставляем результат
    let s = ''
    const stack = []
    for (const ch of text) {
        if (ch === '\x13') { stack.push(true); continue }
        if (ch === '\x14') { if (stack.length) stack[stack.length - 1] = false; continue }
        if (ch === '\x15') { stack.pop(); continue }
        if (stack.length && stack[stack.length - 1]) continue
        s += ch
    }
    const html = []
    let row = [], cell = [], para = '', inTable = false, lastWasCellEnd = false
    const endPara = () => { const t = para.replace(/[\x00-\x08\x0e-\x1f]/g, '').trim(); para = ''; return t }
    for (const ch of s) {
        if (ch === '\x07') {
            const t = endPara()
            if (lastWasCellEnd && !t && !cell.length) { // конец строки таблицы
                if (!inTable) { html.push('<table>'); inTable = true }
                html.push('<tr>' + row.map(c => `<td>${c.map(esc).join('<br>')}</td>`).join('') + '</tr>')
                row = []; lastWasCellEnd = false
                continue
            }
            if (t) cell.push(t)
            row.push(cell); cell = []; lastWasCellEnd = true
            continue
        }
        if (ch === '\r') {
            const t = endPara()
            if (row.length || cell.length) { if (t) cell.push(t); lastWasCellEnd = false; continue }
            if (inTable) { html.push('</table>'); inTable = false }
            if (t) html.push(`<p>${esc(t)}</p>`)
            lastWasCellEnd = false
            continue
        }
        if (ch === '\x0b') { para += '\n'; continue }
        if (ch === '\x0c') { const t = endPara(); if (t) html.push(`<p>${esc(t)}</p>`); html.push('<hr>'); continue }
        para += ch
        lastWasCellEnd = false
    }
    const t = endPara(); if (t) html.push(`<p>${esc(t)}</p>`)
    if (inTable) html.push('</table>')
    return html.join('\n').replace(/\n(?=[^<]*<\/p>)/g, '<br>')
}
// Похоже на заголовок: короткий абзац без точки в конце, «Глава…», «1. Введение», ВСЕ ЗАГЛАВНЫЕ
const promoteHeadings = html => html.replace(/<p>([^<]{2,90})<\/p>/g, (m, t) => {
    const x = t.trim()
    if (/[.,;:!?…]$/.test(x) && !/^(глава|часть|раздел|chapter|part|section)(?=[\s.:\d]|$)/i.test(x)) return m
    if (/^(глава|часть|раздел|книга|пролог|эпилог|предисловие|заключение|введение|приложение|chapter|part|section|appendix|prologue|epilogue|introduction|conclusion)(?=[\s.:\d]|$)/i.test(x)) return `<h2>${t}</h2>`
    if (/^\d+(\.\d+)*\.?\s+\S/.test(x) && x.length < 70) return `<h3>${t}</h3>`
    if (x.length >= 4 && x === x.toUpperCase() && /[A-ZА-ЯЁ]{3}/.test(x)) return `<h2>${t}</h2>`
    return m
})
export const openDoc = (buf, title) => {
    const cfb = readCfb(buf)
    const text = docText(cfb)
    const html = promoteHeadings(wordTextToHtml(text))
    const book = makeHtmlBook({ title, sections: splitHtml(html, { title }) })
    return book
}

// ================= Windows Write (.wri) =================
export const openWri = (buf, title) => {
    const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    const id = dv.getUint16(0, true)
    if (id !== 0xBE31 && id !== 0xBE32) {
        if (isCfb(u8)) return openWorks(buf, title) // иногда .wri — это документ Word
        throw new ReaderError('Это не документ Windows Write.')
    }
    const fcMac = dv.getUint32(14, true)
    const text = decodeText(u8.subarray(128, Math.min(fcMac, u8.length))).replace(/\r\n/g, '\n')
    return makeHtmlBook({ title, sections: textToSections(text, title) })
}

// ================= Microsoft Works (.wps) =================
// Works 4–9 хранит текст в потоке CONTENTS; Works 9 и новее — это просто документ Word
export const openWorks = (buf, title) => {
    const cfb = readCfb(buf)
    if (cfb.has('WordDocument')) return openDoc(buf, title)
    const cont = cfb.get('CONTENTS') ?? cfb.get(cfb.find(/contents/i) ?? '')
    if (!cont) throw new ReaderError('В документе Works не найден текст.')
    // текст в Works 4+: блок с подписью «TEXT»; ищем самые длинные участки UTF-16 или однобайтового текста
    const runs = []
    let cur = ''
    for (let i = 0; i + 1 < cont.length; i += 2) {
        const c = cont[i] | cont[i + 1] << 8
        if ((c >= 0x20 && c < 0xD800 && c !== 0xFFFF) || c === 0x0D || c === 0x0A || c === 0x09) cur += String.fromCharCode(c)
        else { if (cur.length > 20) runs.push(cur); cur = '' }
    }
    if (cur.length > 20) runs.push(cur)
    let text = runs.filter(r => /[A-Za-zА-Яа-яЁё]{3}/.test(r) && (r.match(/[Ā-ϿԀ-῿Ⰰ-￿]/g)?.length ?? 0) < r.length * 0.1).join('\n\n')
    if (text.length < 20) text = (decodeText(cont).match(/[^\x00-\x08\x0e-\x1f]{20,}/g) ?? []).join('\n\n')
    if (!text.trim()) throw new ReaderError('Не удалось достать текст из документа Works.')
    const book = makeHtmlBook({ title, sections: textToSections(text.replace(/\r\n?/g, '\n'), title) })
    book.notice = 'Документ Works: показан только текст, без оформления.'
    return book
}

// ================= PowerPoint 97–2003 (.ppt, .pps, .pot) =================
export const pptView = (ctx, buf) => {
    const cfb = readCfb(buf)
    const doc = cfb.get('PowerPoint Document')
    if (!doc) throw new ReaderError('Это не презентация PowerPoint 97–2003.')
    const dv = new DataView(doc.buffer, doc.byteOffset, doc.byteLength)
    const slides = []
    // обходим записи: контейнеры (recVer = 0xF) содержат вложенные; текст — в TextCharsAtom и TextBytesAtom
    const walk = (start, end, ctxSlide) => {
        let p = start
        while (p + 8 <= end) {
            const verInst = dv.getUint16(p, true), type = dv.getUint16(p + 2, true), len = dv.getUint32(p + 4, true)
            const body = p + 8
            if (body + len > end || len > doc.length) break
            if ((verInst & 0xF) === 0xF) {
                // SlideListWithText (0x0FF0): тексты слайдов и заметок по порядку; Slide (0x03EE) — слайд целиком
                if (type === 0x0FF0) walk(body, body + len, { slw: (verInst >> 4) })
                else if (type === 0x03EE) { const s = { texts: [], kind: 'slide' }; walk(body, body + len, { slide: s }); if (s.texts.length) slides.push(s) }
                else walk(body, body + len, ctxSlide)
            } else if (type === 0x03F3 && ctxSlide?.slw != null) {
                // SlidePersistAtom — начало нового слайда в списке
                ctxSlide.cur = { texts: [], kind: ctxSlide.slw === 0 ? 'slide' : ctxSlide.slw === 2 ? 'notes' : 'master' }
                if (ctxSlide.slw === 0 || ctxSlide.slw === 2) slides.push(ctxSlide.cur)
            } else if (type === 0x0FA0 || type === 0x0FA8) {
                const t = (type === 0x0FA0 ? utf16.decode(doc.subarray(body, body + len)) : decode8(doc.subarray(body, body + len))).replace(/\r/g, '\n').replace(/\x0b/g, '\n').trim()
                const target = ctxSlide?.cur ?? ctxSlide?.slide
                if (t && target) target.texts.push(t)
            }
            p = body + len
        }
    }
    walk(0, doc.length, null)
    // если в списке слайдов текста нет — берём тексты из самих слайдов
    let list = slides.filter(s => s.kind === 'slide' && s.texts.length)
    const notes = slides.filter(s => s.kind === 'notes' && s.texts.length)
    // картинки: поток Pictures — подряд лежат PNG, JPEG и т. п.
    const pics = []
    const pictures = cfb.get('Pictures')
    if (pictures) {
        for (let i = 0; i + 8 < pictures.length; i++) {
            if (pictures[i] === 0x89 && pictures[i + 1] === 0x50 && pictures[i + 2] === 0x4E && pictures[i + 3] === 0x47) {
                const e = latin.decode(pictures.subarray(i, Math.min(pictures.length, i + 50_000_000))).indexOf('IEND')
                if (e > 0) { pics.push(blobUrl(ctx.urls, pictures.slice(i, i + e + 8), 'a.png')); i += e }
            } else if (pictures[i] === 0xFF && pictures[i + 1] === 0xD8 && pictures[i + 2] === 0xFF) {
                let e = i + 2; while (e + 1 < pictures.length && !(pictures[e] === 0xFF && pictures[e + 1] === 0xD9)) e++
                if (e - i > 200) { pics.push(blobUrl(ctx.urls, pictures.slice(i, e + 2), 'a.jpg')); i = e }
            }
        }
    }
    if (!list.length && !pics.length) throw new ReaderError('В презентации не найдено текста.')
    const wrap = el('div', 'ur-ppt')
    wrap.append(el('div', 'ur-meta', `Слайдов с текстом: ${list.length}${pics.length ? ` · картинок: ${pics.length}` : ''}. Старый формат PowerPoint: показываем текст слайдов и картинки отдельно, без раскладки.`))
    list.forEach((s, i) => {
        const [first, ...rest] = s.texts
        wrap.append(el('section', 'ur-ppt-slide', `<div class="ur-slide-num ur-nosearch">${i + 1}</div><h3>${esc(first ?? '')}</h3>${rest.map(t => `<p>${esc(t).replace(/\n/g, '<br>')}</p>`).join('')}`))
    })
    if (notes.length) wrap.append(el('section', '', `<h3>Заметки докладчика</h3>${notes.map(n => `<p>${esc(n.texts.join('\n')).replace(/\n/g, '<br>')}</p>`).join('')}`))
    if (pics.length) { wrap.append(el('h3', '', 'Картинки из презентации')); const g = el('div', 'ur-thumbs-grid'); for (const u of pics) g.append(el('figure', '', `<img src="${u}" loading="lazy" style="max-width:280px;max-height:220px">`)); wrap.append(g) }
    return wrap
}

// ================= Справка CHM (через 7-Zip) =================
const parseSitemap = html => {
    // .hhc: вложенные <UL><LI><OBJECT type="text/sitemap"><param name="Name" value=..><param name="Local" value=..>
    const d = new DOMParser().parseFromString(html, 'text/html')
    const walk = ul => Array.from(ul?.children ?? []).flatMap(li => {
        if (li.tagName !== 'LI') return li.tagName === 'UL' ? walk(li) : []
        const obj = li.querySelector(':scope > object')
        const p = n => obj?.querySelector(`param[name="${n}" i]`)?.getAttribute('value')
        const sub = li.querySelector(':scope > ul') ?? (li.nextElementSibling?.tagName === 'UL' ? li.nextElementSibling : null)
        return [{ label: p('Name') ?? '', local: p('Local') ?? '', subitems: sub ? walk(sub) : [] }]
    })
    return walk(d.querySelector('body > ul') ?? d.querySelector('ul'))
}
export const openChm = async (ctx, buf, title) => {
    const { SevenZip, wasmBinary } = await ctx.loadLib('sevenzip')
    const sz = await SevenZip({ wasmBinary, print: () => {}, printErr: () => {} })
    sz.FS.writeFile('/a.chm', new Uint8Array(buf)); sz.FS.mkdir('/out')
    sz.callMain(['x', '/a.chm', '-o/out', '-y'])
    const files = new Map()
    const walk = dir => { for (const n of sz.FS.readdir(dir)) { if (n === '.' || n === '..') continue; const p = dir + '/' + n; const st = sz.FS.stat(p); if (sz.FS.isDir(st.mode)) walk(p); else if (!n.startsWith('#') && !n.startsWith('$')) files.set(p.slice(5).toLowerCase(), () => sz.FS.readFile(p)) } }
    walk('/out')
    if (!files.size) throw new ReaderError('Не удалось распаковать справку CHM.')
    const pages = [...files.keys()].filter(k => /\.html?$/.test(k))
    const hhcKey = [...files.keys()].find(k => k.endsWith('.hhc'))
    const dec = b => { const t = latin.decode(b.subarray(0, 2000)); const cs = /charset=["']?([\w-]+)/i.exec(t)?.[1]; try { return cs ? new TextDecoder(cs).decode(b) : decodeText(b) } catch { return decodeText(b) } }
    let toc = hhcKey ? parseSitemap(dec(files.get(hhcKey)())) : []
    // порядок страниц: как в оглавлении, затем остальные
    const order = []
    const norm = l => decodeURIComponent((l || '').split('#')[0]).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
    const addFrom = items => { for (const it of items) { const k = norm(it.local); if (k && files.has(k) && !order.includes(k)) order.push(k); addFrom(it.subitems) } }
    addFrom(toc)
    for (const k of pages.sort()) if (!order.includes(k)) order.push(k)
    if (!order.length) throw new ReaderError('В справке нет страниц.')
    const index = new Map(order.map((k, i) => [k, i]))
    const res = new Map()
    const urlOf = key => { if (res.has(key)) return res.get(key); const f = files.get(key); const u = f ? blobUrl(ctx.urls, f(), key) : null; res.set(key, u); return u }
    const resolve = (base, href) => { try { return decodeURIComponent(new URL(href, 'http://x/' + base).pathname.slice(1)).toLowerCase() } catch { return '' } }
    const sections = order.map(key => {
        const d = new DOMParser().parseFromString(dec(files.get(key)()), 'text/html')
        d.querySelectorAll('script, object, embed, iframe, link').forEach(x => x.remove())
        for (const img of d.querySelectorAll('img[src]')) { const k = resolve(key, img.getAttribute('src')); const u = k && urlOf(k); if (u) img.setAttribute('src', u); else img.remove() }
        for (const a of d.querySelectorAll('a[href]')) {
            const h = a.getAttribute('href'); if (/^(https?|mailto):/i.test(h)) continue
            const [p, frag] = h.split('#'); const k = p ? resolve(key, p) : key
            if (index.has(k)) a.setAttribute('href', `${index.get(k)}${frag ? '#' + frag : ''}`); else a.removeAttribute('href')
        }
        const t = d.querySelector('title')?.textContent?.trim() || d.querySelector('h1, h2')?.textContent?.trim() || key.split('/').pop()
        return { title: t, html: d.body?.innerHTML ?? '' }
    })
    const book = makeHtmlBook({ title, sections })
    // оглавление из .hhc (с вложенностью), если есть
    if (toc.length) {
        const conv = items => items.filter(it => it.label).map(it => { const k = norm(it.local); const frag = (it.local || '').split('#')[1]; return { label: it.label, href: index.has(k) ? `${index.get(k)}${frag ? '#' + frag : ''}` : `${index.get(order[0])}`, subitems: it.subitems?.length ? conv(it.subitems) : null } })
        book.toc = conv(toc)
    }
    return book
}

// ================= DocBook, TEI, JATS (XML → книга) =================
const XML_MAP = {
    // заголовки
    title: 'H', head: 'H', 'article-title': 'H', 'book-title': 'H',
    // абзацы и блоки
    para: 'p', simpara: 'p', p: 'p', ab: 'p', l: 'div', lg: 'blockquote', note: 'aside', abstract: 'blockquote', blockquote: 'blockquote', epigraph: 'blockquote', quote: 'q', q: 'q',
    programlisting: 'pre', screen: 'pre', literallayout: 'pre', 'preformat': 'pre', code: 'code', literal: 'code', command: 'code', filename: 'code', 'monospace': 'code',
    itemizedlist: 'ul', orderedlist: 'ol', listitem: 'li', list: 'ul', item: 'li', 'list-item': 'li', variablelist: 'dl', varlistentry: 'div', term: 'dt',
    emphasis: 'em', hi: 'em', italic: 'em', bold: 'strong', strong: 'strong', foreignphrase: 'em', citetitle: 'em', sup: 'sup', sub: 'sub', superscript: 'sup', subscript: 'sub',
    table: 'table', informaltable: 'table', row: 'tr', entry: 'td', td: 'td', th: 'th', tr: 'tr', cell: 'td', thead: 'thead', tbody: 'tbody',
    figure: 'figure', caption: 'figcaption', 'fig': 'figure', footnote: 'aside', fn: 'aside', 'ref-list': 'ol', ref: 'li', 'mixed-citation': 'span', 'element-citation': 'span',
}
const SECTION_TAGS = new Set(['chapter', 'section', 'sect1', 'sect2', 'sect3', 'sect4', 'appendix', 'preface', 'part', 'div', 'div1', 'div2', 'div3', 'sec', 'refsect1', 'simplesect', 'article', 'back', 'front', 'body'])
const SKIP_TAGS = new Set(['teiHeader', 'info', 'bookinfo', 'articleinfo', 'indexterm', 'remark', 'processing-meta', 'journal-meta', 'counts', 'permissions', 'kwd-group', 'history', 'pub-date', 'funding-group'])
export const xmlBookToHtml = (root, urlOf) => {
    const conv = (n, depth) => {
        if (n.nodeType === 3) return esc(n.textContent)
        if (n.nodeType !== 1) return ''
        const t = n.localName
        if (SKIP_TAGS.has(t)) return ''
        const inner = d => Array.from(n.childNodes).map(c => conv(c, d)).join('')
        if (SECTION_TAGS.has(t)) return `<section>${inner(depth + 1)}</section>`
        if (t === 'title' || t === 'head' || t === 'article-title') { const lvl = Math.min(6, Math.max(1, depth)); return `<h${lvl}>${inner(depth)}</h${lvl}>` }
        if (t === 'link' || t === 'ulink' || t === 'ref' && n.getAttribute('target') || t === 'ext-link' || t === 'uri') {
            const href = n.getAttribute('url') || n.getAttribute('xlink:href') || n.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || n.getAttribute('target') || n.getAttribute('linkend')
            return href && /^https?:/.test(href) ? `<a href="${esc(href)}">${inner(depth) || esc(href)}</a>` : inner(depth)
        }
        if (t === 'imagedata' || t === 'graphic' || t === 'inline-graphic') {
            const src = n.getAttribute('fileref') || n.getAttribute('url') || n.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
            const u = src && urlOf?.(src)
            return u ? `<img src="${u}" alt="">` : ''
        }
        if (t === 'lb') return '<br>'
        if (t === 'pb') return '<hr>'
        if (t === 'listitem' && n.parentElement?.localName === 'varlistentry') return `<dd>${inner(depth)}</dd>`
        const tag = XML_MAP[t]
        if (!tag) return inner(depth)
        return `<${tag}>${inner(depth)}</${tag}>`
    }
    return conv(root, 0)
}
export const openXmlBook = (text, title, kind) => {
    const d = xmlDoc(text.replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?>/i, ''), kind === 'tei' ? 'документ TEI' : kind === 'jats' ? 'статью JATS' : 'документ DocBook')
    const root = kind === 'tei' ? (d.getElementsByTagName('text')[0] ?? d.documentElement) : kind === 'jats' ? d.documentElement : d.documentElement
    const docTitle = kind === 'tei' ? d.querySelector('titleStmt > title')?.textContent : kind === 'jats' ? d.querySelector('article-title')?.textContent : (d.querySelector('info > title, bookinfo > title, articleinfo > title')?.textContent ?? d.documentElement.querySelector(':scope > title')?.textContent)
    const author = kind === 'tei' ? d.querySelector('titleStmt > author')?.textContent : kind === 'jats' ? Array.from(d.querySelectorAll('contrib[contrib-type="author"] name')).map(n => `${n.querySelector('given-names')?.textContent ?? ''} ${n.querySelector('surname')?.textContent ?? ''}`.trim()).join(', ') : d.querySelector('author personname, author')?.textContent
    let html = xmlBookToHtml(root)
    if (kind === 'jats') {
        const abs = d.querySelector('abstract')
        html = (docTitle ? `<h1>${esc(docTitle)}</h1>` : '') + (author ? `<p><em>${esc(author)}</em></p>` : '') + (abs ? `<blockquote>${xmlBookToHtml(abs)}</blockquote>` : '') + xmlBookToHtml(d.querySelector('body') ?? root) + (d.querySelector('back') ? xmlBookToHtml(d.querySelector('back')) : '')
    }
    // разделы: по <section> верхнего уровня
    const body = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body
    let secs = Array.from(body.querySelectorAll(':scope > section > section, :scope > section > section > section')).filter(s => s.querySelector(':scope > h1, :scope > h2, :scope > h3') && !s.parentElement.closest('section > section > section'))
    const top = body.querySelector(':scope > section')
    if (top && top.querySelectorAll(':scope > section').length > 1) secs = Array.from(top.querySelectorAll(':scope > section'))
    const sections = secs.length > 1 ? secs.map(s => ({ title: s.querySelector('h1, h2, h3')?.textContent?.trim() ?? '', html: s.innerHTML })) : splitHtml(body.innerHTML, { title })
    if (secs.length > 1 && top) { const rest = top.cloneNode(true); rest.querySelectorAll(':scope > section').forEach(s => s.remove()); if (rest.textContent.trim()) sections.unshift({ title: docTitle?.trim() || title, html: rest.innerHTML }) }
    return makeHtmlBook({ title: docTitle?.trim() || title, author: author?.trim() ?? '', sections })
}

// ================= GNU Info (.info) =================
export const openInfo = (text, title) => {
    const nodes = text.split('\x1f').map(s => s.replace(/^\n/, '')).filter(s => /^File: [^,]+,\s+Node: /.test(s))
    if (!nodes.length) throw new ReaderError('Это не справка GNU Info.')
    const names = nodes.map(n => /Node: ([^,\n]+)/.exec(n)[1].trim())
    const idx = new Map(names.map((n, i) => [n.toLowerCase(), i]))
    const sections = nodes.map((n, i) => {
        const body = n.split('\n').slice(1).join('\n')
        let html = esc(body)
        // пункты меню и ссылки *note: «* Название::» и «* Метка: Узел.»
        html = html.replace(/\*(note)?\s+([^:\n]+?)::/gi, (m, note, name) => idx.has(name.trim().toLowerCase()) ? `${note ? 'см. ' : '• '}<a href="${idx.get(name.trim().toLowerCase())}">${name}</a>` : m)
            .replace(/\*(note)?\s+([^:\n]+?):\s+([^.,\n]+)[.,]/gi, (m, note, label, name) => idx.has(name.trim().toLowerCase()) ? `${note ? 'см. ' : '• '}<a href="${idx.get(name.trim().toLowerCase())}">${label}</a>.` : m)
        html = html.replace(/^(.+)\n(\*{3,}|={3,}|-{3,}|\.{3,})$/gm, (m, h, u) => `<h${u[0] === '*' ? 1 : u[0] === '=' ? 2 : 3}>${h}</h${u[0] === '*' ? 1 : u[0] === '=' ? 2 : 3}>`)
        return { title: names[i], html: `<pre style="white-space:pre-wrap;font-family:inherit">${html}</pre>` }
    })
    return makeHtmlBook({ title, sections })
}

// ================= Texinfo (.texi, .texinfo) =================
export const openTexinfo = (text, title) => {
    const out = []
    let env = [], docTitle = ''
    const inline = s => esc(s)
        .replace(/@(code|samp|file|command|option|env|kbd|key|var|verb\{\S)\{([^{}]*)\}/g, (m, c, a) => c === 'var' ? `<var>${a}</var>` : `<code>${a}</code>`)
        .replace(/@(emph|i|dfn|cite|slanted)\{([^{}]*)\}/g, '<em>$2</em>').replace(/@(strong|b)\{([^{}]*)\}/g, '<strong>$2</strong>')
        .replace(/@(uref|url)\{([^,{}]*)(?:,\s*([^{}]*))?\}/g, (m, c, u, t) => `<a href="${u}">${t || u}</a>`).replace(/@email\{([^,{}]*)[^}]*\}/g, '$1')
        .replace(/@(x|p|px)?ref\{([^,{}]*)[^}]*\}/g, 'см. «$2»').replace(/@(r|t|sc|w|asis|math)\{([^{}]*)\}/g, '$2')
        .replace(/@dots\{\}/g, '…').replace(/@copyright\{\}/g, '©').replace(/@TeX\{\}/g, 'TeX').replace(/@LaTeX\{\}/g, 'LaTeX').replace(/@result\{\}/g, '⇒').replace(/@expansion\{\}/g, '↦').replace(/@equiv\{\}/g, '≡').replace(/@error\{\}/g, 'error→').replace(/@bullet\{\}/g, '•').replace(/@minus\{\}/g, '−')
        .replace(/@([@{}])/g, '$1').replace(/@\*/g, '<br>')
    let para = []
    const flush = () => { if (para.length) { out.push(env.at(-1) === 'example' ? `<pre>${para.map(esc).join('\n')}</pre>` : `<p>${inline(para.join(' '))}</p>`); para = [] } }
    const HEAD = { chapter: 1, unnumbered: 1, appendix: 1, majorheading: 1, chapheading: 1, section: 2, unnumberedsec: 2, appendixsec: 2, heading: 2, subsection: 3, unnumberedsubsec: 3, subheading: 3, subsubsection: 4 }
    for (const raw of text.replace(/\r/g, '').split('\n')) {
        const l = raw
        if (l.startsWith('\\input')) continue
        const m = /^@(\w+)\s*(.*)$/.exec(l)
        if (env.at(-1) === 'example' && !(m && m[1] === 'end')) { para.push(l); continue }
        if (!m) { if (!l.trim()) flush(); else if (env.at(-1) === 'ignore' || env.at(-1) === 'tex' || env.at(-1) === 'iftex' || env.at(-1) === 'titlepage') { /* пропускаем */ } else para.push(l); continue }
        const [, cmd, arg] = m
        if (env.some(e => ['ignore', 'tex', 'iftex', 'ifhtml', 'html', 'macro'].includes(e)) && cmd !== 'end') continue
        if (cmd === 'c' || cmd === 'comment' || cmd === 'node' || cmd === 'cindex' || cmd === 'findex' || cmd === 'vindex' || cmd === 'kindex' || cmd === 'setfilename' || cmd === 'set' || cmd === 'include' || cmd === 'printindex' || cmd === 'contents' || cmd === 'bye') continue
        if (cmd === 'settitle') { docTitle = arg; continue }
        if (HEAD[cmd]) { flush(); out.push(`<h${HEAD[cmd]}>${inline(arg)}</h${HEAD[cmd]}>`); continue }
        if (cmd === 'title' || cmd === 'top') { flush(); out.push(`<h1>${inline(arg)}</h1>`); continue }
        if (['itemize', 'enumerate', 'table', 'ftable', 'vtable', 'multitable'].includes(cmd)) { flush(); env.push(cmd === 'enumerate' ? 'ol' : 'ul'); out.push(cmd === 'enumerate' ? '<ol>' : '<ul>'); continue }
        if (['example', 'smallexample', 'lisp', 'smalllisp', 'display', 'format', 'verbatim'].includes(cmd)) { flush(); env.push('example'); continue }
        if (['quotation', 'cartouche', 'indentedblock'].includes(cmd)) { flush(); env.push('quote'); out.push('<blockquote>'); continue }
        if (['ignore', 'tex', 'iftex', 'ifhtml', 'html', 'titlepage', 'macro', 'menu', 'detailmenu', 'direntry', 'copying'].includes(cmd)) { flush(); env.push(cmd === 'menu' || cmd === 'detailmenu' || cmd === 'direntry' ? 'ignore' : cmd); continue }
        if (cmd === 'item' || cmd === 'itemx' || cmd === 'tab') { flush(); out.push(`<li>${arg ? `<strong>${inline(arg)}</strong> ` : ''}`); continue }
        if (cmd === 'end') { flush(); const e = env.pop(); if (e === 'ol') out.push('</ol>'); else if (e === 'ul') out.push('</ul>'); else if (e === 'quote') out.push('</blockquote>'); continue }
        if (cmd === 'sp' || cmd === 'page') { flush(); continue }
        para.push(l)
    }
    flush()
    return makeHtmlBook({ title: docTitle || title, sections: splitHtml(out.join('\n'), { title: docTitle || title }) })
}

// ================= KWord (.kwd), Scribus (.sla), HWPX, Celtx, InDesign (.idml) =================
export const openTextPackage = async (buf, ext, title) => {
    const u8 = new Uint8Array(buf)
    const isZip = u8[0] === 0x50 && u8[1] === 0x4B
    const paras = []
    if (ext === 'sla') {
        const d = xmlDoc(decodeText(u8), 'документ Scribus')
        for (const st of d.querySelectorAll('StoryText')) {
            let cur = ''
            for (const n of st.children) { if (n.localName === 'ITEXT') cur += n.getAttribute('CH') ?? ''; else if (n.localName === 'para' || n.localName === 'breakline') { paras.push(cur); cur = '' } }
            if (cur) paras.push(cur)
            paras.push('')
        }
        // старые версии: ITEXT прямо внутри PAGEOBJECT
        if (!paras.some(Boolean)) for (const o of d.querySelectorAll('PAGEOBJECT')) { const t = Array.from(o.getElementsByTagName('ITEXT')).map(i => i.getAttribute('CH')).join(''); if (t) paras.push(...t.split('\n'), '') }
    } else {
        if (!isZip) throw new ReaderError('Файл повреждён (ожидался zip-архив).')
        const zip = await JSZip.loadAsync(buf)
        const read = async n => zip.file(n) ? zip.file(n).async('string') : null
        if (ext === 'kwd') {
            const x = await read('maindoc.xml')
            if (!x) throw new ReaderError('В документе KWord нет текста.')
            const d = xmlDoc(x, 'документ KWord')
            for (const fs of d.querySelectorAll('FRAMESET')) { for (const p of fs.querySelectorAll('PARAGRAPH > TEXT')) paras.push(p.textContent); paras.push('') }
        } else if (ext === 'hwpx') {
            const secs = Object.keys(zip.files).filter(n => /Contents\/section\d+\.xml$/i.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            if (!secs.length) throw new ReaderError('В документе HWPX нет текста.')
            for (const s of secs) { const d = xmlDoc(await read(s), 'документ HWPX'); for (const p of d.getElementsByTagNameNS('*', 'p')) paras.push(Array.from(p.getElementsByTagNameNS('*', 't')).map(t => t.textContent).join('')) }
        } else if (ext === 'idml') {
            const map = await read('designmap.xml')
            const order = map ? [...map.matchAll(/<idPkg:Story src="([^"]+)"/g)].map(m => m[1]) : Object.keys(zip.files).filter(n => /^Stories\//.test(n))
            for (const s of order) {
                const x = await read(s); if (!x) continue
                const d = xmlDoc(x, 'статью InDesign')
                for (const psr of d.getElementsByTagName('ParagraphStyleRange')) {
                    let t = ''
                    for (const n of psr.getElementsByTagName('*')) { if (n.localName === 'Content') t += n.textContent; else if (n.localName === 'Br') { paras.push(t); t = '' } }
                    if (t) paras.push(t)
                }
                paras.push('')
            }
        } else if (ext === 'celtx') {
            const scripts = Object.keys(zip.files).filter(n => /^script.*\.html?$/i.test(n))
            if (!scripts.length) throw new ReaderError('В проекте Celtx нет сценария.')
            const sections = []
            for (const s of scripts) {
                const d = new DOMParser().parseFromString(await read(s), 'text/html')
                d.querySelectorAll('script, style').forEach(x => x.remove())
                for (const p of d.querySelectorAll('p')) { const c = p.className; p.setAttribute('class', 'sp-' + (c || 'action').replace(/[^\w-]/g, '')) }
                sections.push({ title: d.title || s, html: d.body.innerHTML })
            }
            return makeHtmlBook({ title, sections, css: '.sp-sceneheading{font-weight:bold;text-transform:uppercase;margin-top:1.5em}.sp-character{margin-left:40%;text-transform:uppercase;margin-bottom:0}.sp-dialog{margin:0 20% 1em 25%}.sp-parenthetical{margin:0 30% 0 32%;font-style:italic}.sp-transition{text-align:right;text-transform:uppercase}body{font-family:"Courier New",monospace}' })
        }
    }
    const html = paras.map(p => p.trim() ? `<p>${esc(p)}</p>` : '').join('\n')
    if (!html.trim()) throw new ReaderError('В документе не найден текст.')
    return makeHtmlBook({ title, sections: splitHtml(html, { title }) })
}

// ================= Формулы LibreOffice Math (.odf) =================
export const odfMath = async buf => {
    const zip = await JSZip.loadAsync(buf)
    const c = await zip.file('content.xml')?.async('string')
    if (!c) throw new ReaderError('В файле формулы нет содержимого.')
    return c
}

// ================= OFD (китайский «неизменяемый» формат) =================
const ofdBox = s => (s ?? '0 0 0 0').trim().split(/\s+/).map(Number)
export const ofdView = async (ctx, buf) => {
    const zip = await JSZip.loadAsync(buf)
    const read = async n => { const f = zip.file(n.replace(/^\//, '')); return f ? f.async('string') : null }
    const root = xmlDoc(await read('OFD.xml') ?? '', 'документ OFD')
    const docPath = root.querySelector('DocRoot')?.textContent?.trim()
    if (!docPath) throw new ReaderError('В документе OFD нет страниц.')
    const base = docPath.replace(/[^/]*$/, '')
    const doc = xmlDoc(await read(docPath), 'документ OFD')
    const pageBox = ofdBox(doc.querySelector('PhysicalBox')?.textContent || '0 0 210 297')
    // ресурсы: картинки
    const res = new Map()
    for (const rl of [doc.querySelector('PublicRes')?.textContent, doc.querySelector('DocumentRes')?.textContent].filter(Boolean)) {
        const rx = await read(base + rl.trim()); if (!rx) continue
        const r = xmlDoc(rx, 'ресурсы OFD'); const bl = r.documentElement.getAttribute('BaseLoc') ?? ''
        for (const mm of r.getElementsByTagNameNS('*', 'MultiMedia')) {
            const loc = mm.getElementsByTagNameNS('*', 'MediaFile')[0]?.textContent?.trim(); if (!loc) continue
            const path = (base + (bl ? bl.replace(/\/?$/, '/') : '') + loc).replace(/\/+/g, '/')
            const f = zip.file(path) ?? zip.file(Object.keys(zip.files).find(k => k.endsWith('/' + loc)) ?? '')
            if (f) res.set(mm.getAttribute('ID'), blobUrl(ctx.urls, await f.async('uint8array'), loc))
        }
    }
    const wrap = el('div', 'ur-ofd')
    const pages = Array.from(doc.getElementsByTagNameNS('*', 'Page'))
    if (!pages.length) throw new ReaderError('В документе OFD нет страниц.')
    for (const pg of pages) {
        const x = await read(base + pg.getAttribute('BaseLoc')); if (!x) continue
        const p = xmlDoc(x, 'страницу OFD')
        const box = ofdBox(p.querySelector('PhysicalBox')?.textContent) ; const [, , W, H] = box[2] ? box : pageBox
        let svg = ''
        for (const o of p.getElementsByTagNameNS('*', 'ImageObject')) { const b = ofdBox(o.getAttribute('Boundary')); const u = res.get(o.getAttribute('ResourceID')); if (u) svg += `<image href="${u}" x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" preserveAspectRatio="none"/>` }
        for (const o of p.getElementsByTagNameNS('*', 'PathObject')) {
            const b = ofdBox(o.getAttribute('Boundary')); const d = o.getElementsByTagNameNS('*', 'AbbreviatedData')[0]?.textContent ?? ''
            const path = d.replace(/\bB\b/g, 'C').replace(/\bQ\b/g, 'Q').replace(/\bS\b/g, 'M')
            svg += `<path transform="translate(${b[0]},${b[1]})" d="${esc(path)}" fill="none" stroke="#000" stroke-width="${+(o.getAttribute('LineWidth') || 0.25)}"/>`
        }
        for (const t of p.getElementsByTagNameNS('*', 'TextObject')) {
            const b = ofdBox(t.getAttribute('Boundary')); const size = +(t.getAttribute('Size') || 3.5)
            for (const tc of t.getElementsByTagNameNS('*', 'TextCode')) svg += `<text x="${b[0] + (+tc.getAttribute('X') || 0)}" y="${b[1] + (+tc.getAttribute('Y') || 0)}" font-size="${size}">${esc(tc.textContent)}</text>`
        }
        wrap.append(el('div', 'ur-ofd-page', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;background:#fff;color:#000">${svg}</svg>`))
    }
    return wrap
}

// ================= XPS / OpenXPS =================
const xpsColor = c => { if (!c) return 'none'; if (/^#[0-9a-f]{8}$/i.test(c)) return `rgba(${parseInt(c.slice(3, 5), 16)},${parseInt(c.slice(5, 7), 16)},${parseInt(c.slice(7, 9), 16)},${(parseInt(c.slice(1, 3), 16) / 255).toFixed(3)})`; if (/^#[0-9a-f]{6}$/i.test(c)) return c; if (/^sc#/i.test(c)) { const v = c.slice(3).split(',').map(Number); const [a, r, g, b] = v.length === 4 ? v : [1, ...v]; return `rgba(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0},${a})` } return c }
// шрифты внутри XPS «перемешаны»: первые 32 байта XOR с GUID из имени файла
const deobfuscate = (bytes, name) => {
    const guid = /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})/i.exec(name)
    if (!guid) return bytes
    const hex = guid.slice(1).join('')
    const key = []
    // порядок байтов как в .NET Guid.ToByteArray, затем ключ — в обратном порядке
    const g = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)]
    const bytesOf = h => h.match(/../g).map(x => parseInt(x, 16))
    const gb = [...bytesOf(g[0]).reverse(), ...bytesOf(g[1]).reverse(), ...bytesOf(g[2]).reverse(), ...bytesOf(g[3]), ...bytesOf(g[4])]
    for (let i = 0; i < 16; i++) key.push(gb[15 - i])
    const out = bytes.slice()
    for (let i = 0; i < 32 && i < out.length; i++) out[i] ^= key[i % 16]
    return out
}
export const xpsView = async (ctx, buf) => {
    const zip = await JSZip.loadAsync(buf)
    const files = Object.keys(zip.files)
    const find = p => { const k = decodeURIComponent(p.replace(/^\//, '')); return zip.file(k) ?? zip.file(files.find(f => f.toLowerCase() === k.toLowerCase()) ?? '') }
    const rel = (base, p) => { if (!p) return ''; if (p.startsWith('/')) return p.slice(1); return (base.replace(/[^/]*$/, '') + p).replace(/[^/]+\/\.\.\//g, '') }
    // порядок страниц: FixedDocumentSequence → FixedDocument → PageContent
    let pages = []
    const seqName = files.find(f => /\.fdseq$/i.test(f))
    if (seqName) {
        const seq = xmlDoc(await zip.file(seqName).async('string'), 'XPS')
        for (const dr of seq.getElementsByTagNameNS('*', 'DocumentReference')) {
            const dn = rel(seqName, dr.getAttribute('Source')); const df = find(dn); if (!df) continue
            const fd = xmlDoc(await df.async('string'), 'XPS')
            for (const pc of fd.getElementsByTagNameNS('*', 'PageContent')) pages.push(rel(dn, pc.getAttribute('Source')))
        }
    }
    if (!pages.length) pages = files.filter(f => /\.fpage$/i.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    if (!pages.length) throw new ReaderError('В документе XPS нет страниц.')
    const fonts = new Map()
    const fontFamily = async uri => {
        if (fonts.has(uri)) return fonts.get(uri)
        const f = find(uri); let fam = null
        if (f) {
            try {
                const bytes = /\.odttf$/i.test(uri) ? deobfuscate(await f.async('uint8array'), uri) : await f.async('uint8array')
                fam = 'xps' + Math.random().toString(36).slice(2)
                const ff = new FontFace(fam, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
                await ff.load(); document.fonts.add(ff); ctx.cleanups.push(() => document.fonts.delete(ff))
            } catch { fam = null }
        }
        fonts.set(uri, fam)
        return fam
    }
    const wrap = el('div', 'ur-xps')
    wrap.append(el('div', 'ur-meta', `Страниц: ${pages.length}`))
    for (const pn of pages.slice(0, 500)) {
        const pf = find(pn); if (!pf) continue
        const d = xmlDoc(await pf.async('string'), 'страницу XPS')
        const page = d.documentElement
        const W = +page.getAttribute('Width') || 816, H = +page.getAttribute('Height') || 1056
        const conv = async node => {
            let s = ''
            for (const n of node.children) {
                const t = n.localName
                const tr = n.getAttribute('RenderTransform')
                const transform = tr && /^[-\d.,\s]+$/.test(tr) ? ` transform="matrix(${tr.split(',').join(' ')})"` : ''
                const op = n.getAttribute('Opacity') ? ` opacity="${n.getAttribute('Opacity')}"` : ''
                if (t === 'Canvas') s += `<g${transform}${op}>${await conv(n)}</g>`
                else if (t === 'Path') {
                    let data = n.getAttribute('Data')
                    if (!data || data.startsWith('{')) { const pg = n.getElementsByTagNameNS('*', 'PathGeometry')[0]; data = pg ? Array.from(pg.getElementsByTagNameNS('*', 'PathFigure')).map(f => `M ${f.getAttribute('StartPoint')} ` + Array.from(f.children).map(seg => (seg.localName === 'PolyLineSegment' ? 'L ' : seg.localName === 'PolyBezierSegment' ? 'C ' : seg.localName === 'PolyQuadraticBezierSegment' ? 'Q ' : seg.localName === 'ArcSegment' ? 'L ' : '') + (seg.getAttribute('Points') ?? seg.getAttribute('Point') ?? '')).join(' ') + (f.getAttribute('IsClosed') === 'true' ? ' Z' : '')).join(' ') : '' }
                    if (!data) continue
                    data = data.replace(/^F\s*[01]\s*/i, '')
                    let fill = xpsColor(n.getAttribute('Fill'))
                    const ib = n.getElementsByTagNameNS('*', 'ImageBrush')[0]
                    if (ib) {
                        const f = find(rel(pn, ib.getAttribute('ImageSource')))
                        const vp = (ib.getAttribute('Viewport') ?? '0,0,0,0').split(',').map(Number)
                        if (f) { const u = blobUrl(ctx.urls, await f.async('uint8array'), ib.getAttribute('ImageSource')); const tr2 = ib.getAttribute('Transform'); s += `<image href="${u}" x="${vp[0]}" y="${vp[1]}" width="${vp[2]}" height="${vp[3]}" preserveAspectRatio="none"${tr2 && /^[-\d.,\s]+$/.test(tr2) ? ` transform="matrix(${tr2.split(',').join(' ')})"` : ''}${transform}/>`; continue }
                    }
                    const sb = n.getElementsByTagNameNS('*', 'SolidColorBrush')[0]
                    if (sb && !n.getAttribute('Fill')) fill = xpsColor(sb.getAttribute('Color'))
                    s += `<path d="${esc(data)}" fill="${fill}" stroke="${xpsColor(n.getAttribute('Stroke'))}" stroke-width="${n.getAttribute('StrokeThickness') ?? 1}"${transform}${op}/>`
                } else if (t === 'Glyphs') {
                    const text = n.getAttribute('UnicodeString') ?? ''
                    if (!text || text.startsWith('{}')) continue
                    const fam = await fontFamily(rel(pn, n.getAttribute('FontUri')))
                    const sz = +n.getAttribute('FontRenderingEmSize') || 12
                    s += `<text x="${n.getAttribute('OriginX')}" y="${n.getAttribute('OriginY')}" font-size="${sz}" fill="${xpsColor(n.getAttribute('Fill')) || '#000'}" style="font-family:${fam ? `'${fam}',` : ''}sans-serif;white-space:pre"${transform}${op}>${esc(text.replace(/^\{\}/, ''))}</text>`
                }
            }
            return s
        }
        wrap.append(el('div', 'ur-ofd-page', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;background:#fff">${await conv(page)}</svg>`))
    }
    return wrap
}

// ================= Visio (.vsdx) =================
export const vsdxView = async (ctx, buf) => {
    const zip = await JSZip.loadAsync(buf)
    const read = async n => zip.file(n)?.async('string')
    const pagesXml = await read('visio/pages/pages.xml')
    if (!pagesXml) throw new ReaderError('Это не схема Visio (нет страниц).')
    const pd = xmlDoc(pagesXml, 'схему Visio')
    const relsXml = await read('visio/pages/_rels/pages.xml.rels')
    const rels = new Map(relsXml ? [...relsXml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map(m => [m[1], m[2]]) : [])
    // мастер-фигуры (их геометрия и текст по умолчанию)
    const masters = new Map()
    const mastersXml = await read('visio/masters/masters.xml')
    if (mastersXml) {
        const md = xmlDoc(mastersXml, 'Visio'); const mrels = await read('visio/masters/_rels/masters.xml.rels')
        const mr = new Map(mrels ? [...mrels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map(m => [m[1], m[2]]) : [])
        for (const m of md.getElementsByTagNameNS('*', 'Master')) {
            const rid = m.getElementsByTagNameNS('*', 'Rel')[0]?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
            const x = rid && await read('visio/masters/' + mr.get(rid))
            if (x) masters.set(m.getAttribute('ID'), { name: m.getAttribute('NameU'), doc: xmlDoc(x, 'Visio') })
        }
    }
    const cell = (shape, n) => { for (const c of shape.children) if (c.localName === 'Cell' && c.getAttribute('N') === n) return c.getAttribute('V'); return null }
    const geomOf = shape => Array.from(shape.children).filter(c => c.localName === 'Section' && c.getAttribute('N') === 'Geometry')
    const wrap = el('div', 'ur-vsdx')
    const pageEls = Array.from(pd.getElementsByTagNameNS('*', 'Page'))
    for (const pe of pageEls) {
        const rid = pe.getElementsByTagNameNS('*', 'Rel')[0]?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
        const target = rels.get(rid); if (!target) continue
        const x = await read('visio/pages/' + target); if (!x) continue
        const d = xmlDoc(x, 'страницу Visio')
        const ps = pe.getElementsByTagNameNS('*', 'PageSheet')[0]
        const PW = +(ps && cell(ps, 'PageWidth')) || 11, PH = +(ps && cell(ps, 'PageHeight')) || 8.5
        let svg = ''
        const draw = (shape, ox, oy, masterShape) => {
            const get = n => cell(shape, n) ?? (masterShape ? cell(masterShape, n) : null)
            const pinX = +get('PinX') || 0, pinY = +get('PinY') || 0, w = +get('Width') || 0, h = +get('Height') || 0
            const locX = +(get('LocPinX') ?? w / 2), locY = +(get('LocPinY') ?? h / 2)
            const bx = ox + pinX - locX, by = oy + pinY - locY // левый нижний угол
            const fill = get('FillForegnd'); const line = get('LineColor')
            const isLine = get('BeginX') != null && get('EndX') != null
            const text = Array.from(shape.children).find(c => c.localName === 'Text')?.textContent?.trim() ?? (masterShape ? Array.from(masterShape.children).find(c => c.localName === 'Text')?.textContent?.trim() : '') ?? ''
            const Y = v => PH - v
            if (isLine) {
                svg += `<line x1="${ox + +get('BeginX')}" y1="${Y(oy + +get('BeginY'))}" x2="${ox + +get('EndX')}" y2="${Y(oy + +get('EndY'))}" stroke="${line && line.startsWith('#') ? line : '#333'}" stroke-width="0.015" marker-end="url(#ur-arrow)"/>`
            } else {
                const geoms = geomOf(shape).length ? geomOf(shape) : masterShape ? geomOf(masterShape) : []
                let drawn = false
                for (const g of geoms) {
                    if (Array.from(g.children).some(c => c.localName === 'Cell' && c.getAttribute('N') === 'NoShow' && c.getAttribute('V') === '1')) continue
                    let dpath = '', px = 0, py = 0
                    for (const r of g.getElementsByTagNameNS('*', 'Row')) {
                        const t = r.getAttribute('T'), rc = n => { const c = Array.from(r.children).find(c => c.getAttribute('N') === n); return c ? +c.getAttribute('V') : 0 }
                        const X = v => (bx + v).toFixed(4), YY = v => Y(by + v).toFixed(4)
                        const rel = t.startsWith('Rel'), ex = rel ? rc('X') * w : rc('X'), ey = rel ? rc('Y') * h : rc('Y')
                        if (t === 'MoveTo' || t === 'RelMoveTo') dpath += `M${X(ex)} ${YY(ey)}`
                        else if (t === 'ArcTo') {
                            // дуга по «прогибу» A от середины хорды
                            const bow = rc('A'), c = Math.hypot(ex - px, ey - py)
                            if (Math.abs(bow) < 1e-9 || !c) dpath += `L${X(ex)} ${YY(ey)}`
                            else { const rr = (c * c / 4 + bow * bow) / (2 * Math.abs(bow)); dpath += `A${rr} ${rr} 0 ${Math.abs(bow) > c / 2 ? 1 : 0} ${bow > 0 ? 1 : 0} ${X(ex)} ${YY(ey)}` }
                        } else if (t === 'EllipticalArcTo' || t === 'RelEllipticalArcTo') {
                            // дуга эллипса через три точки: начало, контрольная (A, B), конец; C — наклон оси, D — отношение осей
                            const ax = rel ? rc('A') * w : rc('A'), ay = rel ? rc('B') * h : rc('B'), ang = rc('C'), ratio = rc('D') || 1
                            const cos = Math.cos(-ang), sin = Math.sin(-ang)
                            const tf = (x, y) => [x * cos - y * sin, (x * sin + y * cos) * ratio]
                            const [x1, y1] = tf(px, py), [x2, y2] = tf(ax, ay), [x3, y3] = tf(ex, ey)
                            const dd = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2))
                            if (Math.abs(dd) < 1e-12) dpath += `L${X(ex)} ${YY(ey)}`
                            else {
                                const ux = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / dd
                                const uy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / dd
                                const rr = Math.hypot(x1 - ux, y1 - uy)
                                const a1 = Math.atan2(y1 - uy, x1 - ux), a2 = Math.atan2(y2 - uy, x2 - ux), a3 = Math.atan2(y3 - uy, x3 - ux)
                                const norm = a => (a % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
                                const ccw = norm(a2 - a1) < norm(a3 - a1) // контрольная точка лежит по пути против часовой
                                const sweepAngle = ccw ? norm(a3 - a1) : 2 * Math.PI - norm(a3 - a1)
                                // в SVG ось Y смотрит вниз: направление меняется
                                dpath += `A${rr} ${rr / ratio} ${(-ang * 180 / Math.PI).toFixed(3)} ${sweepAngle > Math.PI ? 1 : 0} ${ccw ? 0 : 1} ${X(ex)} ${YY(ey)}`
                            }
                        }
                        else if (t === 'LineTo' || t === 'RelLineTo' || t === 'RelCubBezTo' || t === 'NURBSTo' || t === 'PolylineTo' || t === 'SplineKnot' || t === 'SplineStart') dpath += `L${X(ex)} ${YY(ey)}`
                        if (t !== 'Ellipse' && t !== 'InfiniteLine') { px = ex; py = ey }
                        else if (t === 'Ellipse') { const cx = rc('X'), cy = rc('Y'), rx = Math.abs(rc('A') - cx), ry = Math.abs(rc('D') - cy); svg += `<ellipse cx="${X(cx)}" cy="${YY(cy)}" rx="${rx}" ry="${ry || rx}" fill="${fill && fill.startsWith('#') ? fill : 'none'}" stroke="#333" stroke-width="0.012"/>`; drawn = true }
                    }
                    if (dpath) { svg += `<path d="${dpath}" fill="${fill && fill.startsWith('#') ? fill : 'none'}" stroke="${line && line.startsWith('#') ? line : '#333'}" stroke-width="0.012"/>`; drawn = true }
                }
                if (!drawn && w && h && text) svg += `<rect x="${bx}" y="${Y(by + h)}" width="${w}" height="${h}" fill="${fill && fill.startsWith('#') ? fill : 'none'}" stroke="#333" stroke-width="0.012"/>`
                // вложенные фигуры (группы)
                for (const sub of shape.getElementsByTagNameNS('*', 'Shapes')[0]?.children ?? []) if (sub.localName === 'Shape') draw(sub, bx, by, null)
            }
            if (text) {
                const lines = text.split('\n').slice(0, 6)
                const size = Math.min(0.14, (h || 0.3) / (lines.length + 1))
                const cx = isLine ? ox + (+get('BeginX') + +get('EndX')) / 2 : bx + w / 2, cy = isLine ? oy + (+get('BeginY') + +get('EndY')) / 2 : by + h / 2
                svg += `<text x="${cx}" y="${Y(cy) - (lines.length - 1) * size * 0.6}" font-size="${size}" text-anchor="middle" dominant-baseline="middle" fill="#111">${lines.map((l, i) => `<tspan x="${cx}" dy="${i ? size * 1.2 : 0}">${esc(l)}</tspan>`).join('')}</text>`
            }
        }
        const shapes = d.getElementsByTagNameNS('*', 'Shapes')[0]
        for (const s of shapes?.children ?? []) {
            if (s.localName !== 'Shape') continue
            const m = masters.get(s.getAttribute('Master'))
            const ms = m ? (m.doc.getElementsByTagNameNS('*', 'Shape')[0] ?? null) : null
            draw(s, 0, 0, ms)
        }
        wrap.append(el('section', '', `<h3>${esc(pe.getAttribute('NameU') || pe.getAttribute('Name') || 'Страница')}</h3><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PW} ${PH}" style="width:100%;background:#fff;border:1px solid var(--background-modifier-border)"><defs><marker id="ur-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#333"/></marker></defs>${svg}</svg>`))
    }
    if (!wrap.childNodes.length) throw new ReaderError('В схеме Visio нет страниц.')
    wrap.prepend(el('div', 'ur-meta', 'Упрощённая отрисовка: фигуры, линии и подписи; заливки, тени и сложные стили Visio не переносятся.'))
    return wrap
}
