// Документы и книги: сценарии Final Draft / Highland, AbiWord, комиксы ACBF, распакованный EPUB (.opf), UMD,
// PDF внутри других файлов (Kindle Print Replica, Illustrator, iWork), превью iWork
import JSZip from 'jszip'
import { EPUB } from '../../vendor/foliate-js/epub.js'
import { escapeHtml as esc, decodeText, ReaderError, MIME, extOf } from '../util.js'
import { makeHtmlBook, splitHtml, textToSections } from './htmlbook.js'
import { fountainToHtml, FOUNTAIN_CSS } from './textual.js'
import { gunzip, inflateZlib } from './compress.js'
import { pagesOf, blobPage } from './images2.js'

const latin = new TextDecoder('latin1')
const kids = (el, name) => Array.from(el?.children ?? []).filter(c => c.localName === name)
const kid = (el, name) => kids(el, name)[0]
const xml = (text, what) => { const d = new DOMParser().parseFromString(text, 'application/xml'); if (d.querySelector('parsererror')) throw new ReaderError(`Не удалось прочитать ${what}: ошибка XML.`); return d }

// ================= Final Draft (.fdx) =================
export const fdxToHtml = text => {
    const d = xml(text, 'сценарий Final Draft')
    const para = p => {
        const t = kids(p, 'Text').map(x => esc(x.textContent)).join('').replace(/\n/g, '<br>')
        switch (p.getAttribute('Type')) {
            case 'Scene Heading': return `<h3 class="ft-scene">${t}</h3>`
            case 'Character': return `<p class="ft-character">${t}</p>`
            case 'Dialogue': return `<p class="ft-line">${t}</p>`
            case 'Parenthetical': return `<p class="ft-paren">${t}</p>`
            case 'Transition': return `<p class="ft-transition">${t}</p>`
            case 'Shot': return `<p class="ft-action"><b>${t}</b></p>`
            case 'Cast List': case 'General': default: return t ? `<p class="ft-action">${t}</p>` : ''
        }
    }
    // реплики собираем в блоки, как в Fountain
    const body = kid(d.documentElement, 'Content')
    let html = '', open = false
    for (const p of kids(body, 'Paragraph')) {
        const type = p.getAttribute('Type')
        const inDialog = ['Character', 'Dialogue', 'Parenthetical'].includes(type)
        if (type === 'Character' && open) { html += '</div>'; open = false }
        if (inDialog && !open) { html += '<div class="ft-dialogue">'; open = true }
        if (!inDialog && open) { html += '</div>'; open = false }
        html += para(p)
    }
    if (open) html += '</div>'
    let title = ''
    const tp = d.querySelector('TitlePage > Content')
    if (tp) {
        const lines = kids(tp, 'Paragraph').map(p => kids(p, 'Text').map(x => x.textContent).join('').trim()).filter(Boolean)
        title = lines[0] ?? ''
        if (lines.length) html = `<div class="ft-title-page"><h1>${esc(lines[0])}</h1>${lines.slice(1).map(l => `<p>${esc(l)}</p>`).join('')}</div>` + html
    }
    return { title, html }
}
export const highlandText = async buf => {
    const u8 = new Uint8Array(buf)
    if (!(u8[0] === 0x50 && u8[1] === 0x4B)) return decodeText(u8)
    const zip = await JSZip.loadAsync(buf)
    const names = Object.keys(zip.files)
    const f = names.find(n => /\.fountain$/i.test(n)) ?? names.find(n => /text\.(md|markdown|txt)$/i.test(n)) ?? names.find(n => /\.(md|txt)$/i.test(n))
    if (!f) throw new ReaderError('В файле Highland не найден текст сценария.')
    return decodeText(await zip.file(f).async('uint8array'))
}
export const screenplayBook = ({ title, html }, name) => {
    const sections = splitHtml(html, { title: title || name })
    if (sections[0]?.html.includes('ft-title-page') && /^Часть 1$/.test(sections[0].title)) sections[0].title = 'Титульный лист'
    return makeHtmlBook({ title: title || name, sections, css: FOUNTAIN_CSS })
}
export { fountainToHtml }

// ================= AbiWord (.abw, .zabw) =================
export const openAbw = async (buf, title, ext) => {
    let u8 = new Uint8Array(buf)
    if (u8[0] === 0x1F && u8[1] === 0x8B) u8 = await gunzip(u8)
    const d = xml(decodeText(u8), 'документ AbiWord')
    const urls = []
    const data = new Map()
    for (const dd of d.getElementsByTagName('d')) {
        const mime = dd.getAttribute('mime-type') || 'image/png'
        let bytes
        if (dd.getAttribute('base64') === 'yes') { const bin = atob(dd.textContent.replace(/\s/g, '')); bytes = Uint8Array.from(bin, c => c.charCodeAt(0)) }
        else bytes = new TextEncoder().encode(dd.textContent)
        const u = URL.createObjectURL(new Blob([bytes], { type: mime })); urls.push(u)
        data.set(dd.getAttribute('name'), u)
    }
    const props = s => Object.fromEntries((s || '').split(';').map(x => x.split(':').map(y => y.trim())).filter(x => x[0]))
    const styleOf = p => {
        const st = []
        if (p['font-weight'] === 'bold') st.push('font-weight:bold')
        if (p['font-style'] === 'italic') st.push('font-style:italic')
        if (/underline/.test(p['text-decoration'] || '')) st.push('text-decoration:underline')
        if (/line-through/.test(p['text-decoration'] || '')) st.push('text-decoration:line-through')
        if (p.color && /^[0-9a-f]{6}$/i.test(p.color)) st.push('color:#' + p.color)
        if (p['text-align']) st.push('text-align:' + p['text-align'])
        return st.join(';')
    }
    let noteN = 0
    const notes = []
    const conv = node => {
        if (node.nodeType === 3) return esc(node.nodeValue)
        if (node.nodeType !== 1) return ''
        const inner = () => Array.from(node.childNodes, conv).join('')
        const p = props(node.getAttribute('props'))
        const st = styleOf(p)
        switch (node.localName) {
            case 'section': return inner()
            case 'p': {
                const s = node.getAttribute('style') || ''
                const h = /^Heading (\d)/.exec(s)
                if (h) return `<h${h[1]}${st ? ` style="${st}"` : ''}>${inner()}</h${h[1]}>`
                if (node.getAttribute('listid') && node.getAttribute('listid') !== '0') return `<li${st ? ` style="${st}"` : ''}>${inner()}</li>`
                return `<p${st ? ` style="${st}"` : ''}>${inner()}</p>`
            }
            case 'c': return st ? `<span style="${st}">${inner()}</span>` : inner()
            case 'br': case 'cbr': case 'pbr': return '<br>'
            case 'a': return `<a href="${esc(node.getAttribute('xlink:href') || '')}">${inner()}</a>`
            case 'image': { const u = data.get(node.getAttribute('dataid')); return u ? `<img src="${u}">` : '' }
            case 'table': return `<table>${inner()}</table>`
            case 'cell': return `<td>${inner()}</td>`
            case 'foot': case 'endnote': { const n = ++noteN; notes.push(`<p id="ur-note-${n}"><a href="#ur-ref-${n}">${n}.</a> ${inner()}</p>`); return `<sup id="ur-ref-${n}"><a href="#ur-note-${n}">${n}</a></sup>` }
            case 'metadata': case 'styles': case 'lists': case 'pagesize': case 'data': case 'history': case 'revisions': case 'ignoredwords': case 'rdf': return ''
            default: return inner()
        }
    }
    // строки таблицы AbiWord задаются свойствами ячеек; упрощённо собираем по top-attach
    let html = Array.from(d.documentElement.childNodes, conv).join('').replace(/(<li[\s\S]*?<\/li>)(?!\s*<li)/g, '$1</ul>').replace(/(?<!<\/li>\s*)<li/g, '<ul><li')
    html = html.replace(/<table>([\s\S]*?)<\/table>/g, (m, inner) => '<table><tr>' + inner + '</tr></table>')
    if (notes.length) html += `<div class="ur-note"><h3>Примечания</h3>${notes.join('')}</div>`
    const t = d.querySelector('metadata m[key="dc.title"]')?.textContent || title
    return makeHtmlBook({ title: t, sections: splitHtml(html, { title: t }), urls })
}

// ================= Комиксы ACBF =================
export const openAcbf = (buf, urls) => {
    const d = xml(decodeText(buf), 'комикс ACBF')
    const bin = new Map()
    for (const b of d.getElementsByTagName('binary')) bin.set(b.getAttribute('id'), { type: b.getAttribute('content-type') || 'image/jpeg', b64: b.textContent })
    const imgOf = el => {
        const href = (el?.getAttribute('href') || el?.getAttribute('xlink:href') || '').replace(/^#/, '')
        const b = bin.get(href)
        if (!b) return null
        return () => { const bytes = Uint8Array.from(atob(b.b64.replace(/\s/g, '')), c => c.charCodeAt(0)); return blobPage(bytes, b.type) }
    }
    const pages = [], texts = [], toc = []
    const cover = d.querySelector('coverpage image')
    if (cover && imgOf(cover)) { pages.push(imgOf(cover)); texts.push(''); toc.push({ label: 'Обложка', target: 0, subitems: [] }) }
    const lang = d.querySelector('book-info languages text-layer')?.getAttribute('lang')
    for (const pg of d.querySelectorAll('body > page')) {
        const im = imgOf(kid(pg, 'image')); if (!im) continue
        const t = kid(pg, 'title')?.textContent?.trim()
        if (t) toc.push({ label: t, target: pages.length, subitems: [] })
        const layer = kids(pg, 'text-layer').find(l => !lang || l.getAttribute('lang') === lang) ?? kid(pg, 'text-layer')
        texts.push(layer ? kids(layer, 'text-area').map(a => a.textContent.replace(/\s+/g, ' ').trim()).join('\n') : '')
        pages.push(im)
    }
    if (!pages.length) throw new ReaderError('В комиксе нет страниц с картинками.')
    const src = pagesOf(pages, toc.length > 1 ? toc : undefined)
    if (texts.some(Boolean)) src.getText = async i => texts[i] ?? ''
    return src
}

// ================= Распакованный EPUB: открываем по файлу .opf из хранилища =================
export const openOpf = async (ctx, file) => {
    const adapter = ctx.app.vault.adapter
    const opfPath = file.path
    // корень книги — папка, где лежит META-INF/container.xml (ищем вверх)
    let root = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''
    let container = null
    for (let dir = root, k = 0; k < 4; k++) {
        const p = (dir ? dir + '/' : '') + 'META-INF/container.xml'
        if (await adapter.exists(p)) { root = dir; container = await adapter.read(p); break }
        if (!dir) break
        dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
    }
    const rel = root ? opfPath.slice(root.length + 1) : opfPath
    if (!container || !container.includes(rel)) container = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${esc(rel)}" media-type="application/oebps-package+xml"/></rootfiles></container>`
    const full = name => (root ? root + '/' : '') + decodeURI(name)
    const loader = {
        loadText: async name => { if (name === 'META-INF/container.xml') return container; try { return await adapter.read(full(name)) } catch { return null } },
        loadBlob: async (name, type) => { try { return new Blob([await adapter.readBinary(full(name))], { type: type || MIME[extOf(name)] || '' }) } catch { return null } },
        // размеры неизвестны без чтения файлов — считаем разделы одинаковыми
        getSize: () => 1000,
    }
    return new EPUB(loader).init()
}

// ================= UMD (китайские книги для телефонов) =================
export const openUmd = async (buf, title) => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (dv.getUint32(0, true) !== 0xDE9A9B89) throw new ReaderError('Это не книга UMD.')
    const u16 = new TextDecoder('utf-16le')
    let p = 4, last = 0
    const meta = {}, chunks = []
    let offsets = [], titles = [], cover = null, kind = 1
    while (p < u8.length) {
        const c = u8[p]
        if (c === 0x23) {
            const type = dv.getUint16(p + 1, true), len = u8[p + 4]
            const data = u8.subarray(p + 5, p + len)
            if (type === 1) kind = data[0]
            else if (type >= 2 && type <= 8) meta[type] = u16.decode(data)
            last = type
            p += len
        } else if (c === 0x24) {
            const len = dv.getUint32(p + 5, true)
            const data = u8.subarray(p + 9, p + len)
            const zl = data[0] === 0x78 && [0x01, 0x5E, 0x9C, 0xDA].includes(data[1])
            if (zl) { try { chunks.push(await inflateZlib(data)) } catch { /* не текст */ } }
            else if (last === 0x83) for (let i = 0; i + 4 <= data.length; i += 4) offsets.push(dv.getUint32(data.byteOffset + i, true))
            else if (last === 0x84) { let q = 0; while (q < data.length) { const l = data[q]; titles.push(u16.decode(data.subarray(q + 1, q + 1 + l))); q += 1 + l } }
            else if (last === 0x82 || last === 0x81 && data[0] === 0xFF && data[1] === 0xD8) cover = data
            p += len
        } else break
    }
    if (kind !== 1) throw new ReaderError('Это UMD-комикс — такие пока не поддерживаются.')
    const total = chunks.reduce((s, x) => s + x.length, 0)
    const all = new Uint8Array(total); let o = 0
    for (const x of chunks) { all.set(x, o); o += x.length }
    const text = u16.decode(all).replace(/\u2029/g, '\n')
    const name = meta[2] || title
    const urls = []
    const sections = []
    if (cover) { const u = URL.createObjectURL(new Blob([cover], { type: 'image/jpeg' })); urls.push(u); sections.push({ title: 'Обложка', html: `<p style="text-align:center"><img src="${u}"></p>` }) }
    if (offsets.length && titles.length) {
        offsets.forEach((off, i) => {
            const end = offsets[i + 1] ?? all.length
            const part = u16.decode(all.subarray(off, end)).replace(/\u2029/g, '\n')
            sections.push({ title: titles[i] || `Глава ${i + 1}`, html: `<h2>${esc(titles[i] || '')}</h2>` + part.split('\n').filter(l => l.trim()).map(l => `<p>${esc(l)}</p>`).join('') })
        })
    } else sections.push(...textToSections(text, name))
    return makeHtmlBook({ title: name, author: meta[3] || '', sections, urls, lang: 'zh' })
}

// ================= PDF внутри файла (Kindle Print Replica, Illustrator, превью iWork) =================
export const findPdf = u8 => {
    const s = latin.decode(u8.subarray(0, Math.min(u8.length, 64)))
    let start = s.startsWith('%PDF') ? 0 : -1
    if (start < 0) { const all = latin.decode(u8); start = all.indexOf('%PDF-'); if (start < 0) return null; const end = all.lastIndexOf('%%EOF'); return u8.subarray(start, end > start ? end + 5 : u8.length) }
    return u8
}
export const pdfOfferView = (ctx, file, pdf, note) => {
    const wrap = document.createElement('div')
    wrap.className = 'ur-shortcut'
    wrap.innerHTML = `<div class="ur-shortcut-icon">📄</div><h2>${esc(file.basename)}</h2><p>${note}</p><p class="ur-muted">PDF внутри: ${(pdf.length / 1048576).toFixed(1)} МБ</p>`
    const btn = document.createElement('button')
    btn.className = 'mod-cta'
    btn.textContent = 'Сохранить как PDF рядом и открыть'
    btn.onclick = async () => {
        btn.disabled = true
        try {
            const vault = ctx.app.vault
            const dir = file.parent?.path && file.parent.path !== '/' ? file.parent.path + '/' : ''
            let path = dir + file.basename + '.pdf', n = 1
            while (vault.getAbstractFileByPath(path)) path = dir + `${file.basename} (${n++}).pdf`
            const f = await vault.createBinary(path, pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength))
            btn.textContent = 'Сохранено: ' + path.split('/').pop()
            await ctx.app.workspace.getLeaf(true).openFile?.(f)
        } catch (e) { btn.textContent = 'Ошибка: ' + (e?.message || e) }
    }
    wrap.append(btn)
    return wrap
}

// ================= Apple iWork: показываем картинку-превью =================
export const openIwork = async buf => {
    const zip = await JSZip.loadAsync(buf)
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir)
    const imgs = names.filter(n => /(^|\/)(preview(-web)?|Thumbnail|thumbnail)\.(jpe?g|png|tiff?)$/i.test(n) || /^QuickLook\/Thumbnail\.(jpg|png)$/i.test(n) || /^Data\/preview.*\.(jpe?g|png)$/i.test(n))
    const sized = await Promise.all(imgs.map(async n => [n, (await zip.file(n).async('uint8array')).length]))
    sized.sort((a, b) => b[1] - a[1])
    const pdfName = names.find(n => /QuickLook\/Preview\.pdf$/i.test(n))
    if (sized.length) return { pages: pagesOf([await blobPage(await zip.file(sized[0][0]).async('uint8array'), MIME[extOf(sized[0][0])] || 'image/jpeg')]) }
    if (pdfName) return { pdf: await zip.file(pdfName).async('uint8array') }
    throw new ReaderError('В файле нет сохранённого превью. Сохраните документ в Pages/Numbers/Keynote с включённым «Включить превью».')
}
