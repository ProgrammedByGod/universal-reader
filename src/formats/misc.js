// MHTML, ODP, PPTX, электронные таблицы, adoc/org
import JSZip from 'jszip'
import { decodeText, escapeHtml, extOf, MIME, ReaderError } from '../util.js'

// ---------- MHTML: собираем страницу с ресурсами ----------
const decodeQP = s => {
    const bytes = []
    s = s.replace(/=\r?\n/g, '')
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '=' && /^[0-9A-F]{2}$/i.test(s.substr(i + 1, 2))) { bytes.push(parseInt(s.substr(i + 1, 2), 16)); i += 2 }
        else bytes.push(s.charCodeAt(i) & 0xff)
    }
    return new Uint8Array(bytes)
}
const latin1 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return s }

export const parseMhtml = (buf, urls) => {
    const raw = latin1(new Uint8Array(buf))
    const headEnd = raw.search(/\r?\n\r?\n/)
    const head = raw.slice(0, headEnd)
    const boundary = /boundary="?([^";\r\n]+)"?/i.exec(head)?.[1]
    if (!boundary) throw new ReaderError('Не найден разделитель частей в MHTML.')
    const parts = raw.split('--' + boundary).slice(1).filter(p => !p.startsWith('--'))
    const res = []
    for (const p of parts) {
        const i = p.search(/\r?\n\r?\n/)
        if (i < 0) continue
        const h = p.slice(0, i)
        let body = p.slice(i).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '')
        const get = name => new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t].+)*)`, 'im').exec(h)?.[1]?.replace(/\r?\n[ \t]+/g, ' ').trim()
        const type = (get('Content-Type') || 'application/octet-stream').split(';')[0].trim().toLowerCase()
        const charset = /charset="?([^";]+)"?/i.exec(get('Content-Type') || '')?.[1]
        const enc = (get('Content-Transfer-Encoding') || '').toLowerCase()
        let bytes
        if (enc === 'base64') { const bin = atob(body.replace(/\s/g, '')); bytes = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k) }
        else if (enc === 'quoted-printable') bytes = decodeQP(body)
        else bytes = Uint8Array.from(body, c => c.charCodeAt(0) & 0xff)
        res.push({ type, charset, bytes, location: get('Content-Location'), cid: get('Content-ID')?.replace(/[<>]/g, '') })
    }
    const main = res.find(r => r.type === 'text/html')
    if (!main) throw new ReaderError('В MHTML не найдена HTML-страница.')
    const textOf = r => { try { return new TextDecoder(r.charset || 'utf-8').decode(r.bytes) } catch { return decodeText(r.bytes) } }
    const map = new Map()
    for (const r of res) {
        if (r === main) continue
        let content = r.bytes
        if (r.type === 'text/css') content = textOf(r)
        const u = URL.createObjectURL(new Blob([content], { type: r.type }))
        urls.push(u)
        if (r.location) map.set(r.location, u)
        if (r.cid) map.set('cid:' + r.cid, u)
    }
    let html = textOf(main)
    // сначала длинные адреса, чтобы не заменить части
    for (const key of [...map.keys()].sort((a, b) => b.length - a.length))
        html = html.split(key).join(map.get(key)).split(escapeHtml(key)).join(map.get(key))
    return html
}

// ---------- Таблицы через SheetJS ----------
export const readSheets = async (ctx, buf, asText = false) => {
    const XLSX = await ctx.loadLib('xlsx')
    // SYLK, DIF, EtherCalc — текст; кодировку (UTF-8 или Windows-1251) определяем сами (в ESM-сборке SheetJS готовую строку принимает только type: 'binary')
    const wb = asText ? XLSX.read(decodeText(buf), { type: 'binary', cellDates: true, dense: true }) : XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true, dense: true })
    return wb.SheetNames.map(name => ({
        name,
        rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: true }),
    }))
}

// ---------- PPTX через pptx-preview ----------
export const renderPptx = ctx => async (box, scroller) => {
    const { init } = await ctx.loadLib('pptx')
    const width = Math.min(Math.max(scroller.clientWidth - 40, 480), 1400)
    const viewer = init(box, { width, height: Math.round(width * 9 / 16), mode: 'list' })
    await viewer.preview(ctx.buffer)
}

// ---------- ODP: приблизительный разбор слайдов ----------
const cm = v => {
    if (!v) return 0
    const n = parseFloat(v)
    if (v.endsWith('mm')) return n / 10
    if (v.endsWith('in')) return n * 2.54
    if (v.endsWith('pt')) return n / 28.35
    return n
}
export const renderOdp = ctx => async box => {
    const head = new Uint8Array(ctx.buffer, 0, 2)
    // «плоские» .fodp/.fodg — один XML без zip, картинки внутри в base64
    const flat = !(head[0] === 0x50 && head[1] === 0x4B)
    const flatDoc = flat ? new DOMParser().parseFromString(new TextDecoder().decode(ctx.buffer), 'application/xml') : null
    if (flatDoc?.querySelector('parsererror')) throw new ReaderError('Файл повреждён (ошибка XML).')
    const zip = flat ? { file: () => null } : await JSZip.loadAsync(ctx.buffer)
    if (!flat && !zip.file('content.xml')) throw new ReaderError('В файле не найден content.xml.')
    const content = flat ? flatDoc : new DOMParser().parseFromString(await zip.file('content.xml').async('string'), 'application/xml')
    let pw = 28, ph = 15.75
    if (flat || zip.file('styles.xml')) {
        const st = flat ? flatDoc : new DOMParser().parseFromString(await zip.file('styles.xml').async('string'), 'application/xml')
        const pl = st.getElementsByTagName('style:page-layout-properties')[0]
        if (pl) { pw = cm(pl.getAttribute('fo:page-width')) || pw; ph = cm(pl.getAttribute('fo:page-height')) || ph }
    }
    const urls = ctx.urls
    const pages = content.getElementsByTagName('draw:page')
    let n = 0
    for (const page of pages) {
        const slide = document.createElement('div')
        slide.className = 'ur-odp-slide'
        slide.style.aspectRatio = `${pw} / ${ph}`
        const num = document.createElement('div'); num.className = 'ur-slide-num ur-nosearch'; num.textContent = String(++n)
        slide.append(num)
        for (const frame of page.children) {
            const x = cm(frame.getAttribute('svg:x')), y = cm(frame.getAttribute('svg:y'))
            const w = cm(frame.getAttribute('svg:width')), h = cm(frame.getAttribute('svg:height'))
            const div = document.createElement('div')
            div.className = 'ur-odp-frame'
            Object.assign(div.style, { left: `${x / pw * 100}%`, top: `${y / ph * 100}%`, width: `${w / pw * 100}%`, minHeight: `${h / ph * 100}%` })
            const img = frame.getElementsByTagName('draw:image')[0]
            const href = img?.getAttribute('xlink:href')
            const bin = img?.getElementsByTagName('office:binary-data')[0]
            if (bin) {
                const raw = atob(bin.textContent.replace(/\s/g, '')); const b = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) b[i] = raw.charCodeAt(i)
                if (!(b[0] === 0xD7 && b[1] === 0xCD) && !(b[0] === 1 && b[1] === 0 && b[2] === 0 && b[3] === 0) && latin1(b.subarray(0, 5)) !== 'VCLMT') {
                    const u = URL.createObjectURL(new Blob([b])); urls.push(u)
                    const im = document.createElement('img'); im.src = u; div.append(im)
                }
            } else if (href && zip.file(href) && !/\.(svm|wmf|emf)$/i.test(href)) {
                const u = URL.createObjectURL(new Blob([await zip.file(href).async('uint8array')], { type: MIME[extOf(href)] || '' }))
                urls.push(u)
                const im = document.createElement('img'); im.src = u; div.append(im)
            }
            for (const p of frame.getElementsByTagName('text:p')) {
                const pe = document.createElement('p'); pe.textContent = p.textContent; div.append(pe)
            }
            if (div.childNodes.length) slide.append(div)
        }
        // в рисунках фигуры не рисуем — если на странице пусто, показываем сохранённую миниатюру
        if (n === 1 && slide.children.length === 1) {
            const th = zip.file('Thumbnails/thumbnail.png')
            if (th) { const u = URL.createObjectURL(new Blob([await th.async('uint8array')], { type: 'image/png' })); urls.push(u); const im = document.createElement('img'); im.src = u; im.className = 'ur-odp-thumb'; slide.append(im) }
        }
        box.append(slide)
    }
    if (!n) throw new ReaderError('В презентации не найдено слайдов.')
}

// ---------- AsciiDoc и Org ----------
export const adocToHtml = async (ctx, text) => {
    const { convert } = await ctx.loadLib('asciidoctor')
    return String(await convert(text, { safe: 'secure', standalone: false, attributes: { showtitle: true } }))
}
export const orgToHtml = async (ctx, text) => {
    const org = await ctx.loadLib('org')
    return org.toHtml(text)
}
