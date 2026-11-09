// Форматы версии 0.5.0 («одна звёздочка»): книги Xteink, превью из zip, палитры, XMP,
// ярлыки Google Диска, MathML, старые телефоны, TaskPaper, Tomboy, TiddlyWiki, KityMinder,
// QIF, LTSV, FASTA, треки (TCX, IGC, OziExplorer, NMEA, LOC, TomTom, WKT), пульс (PWX, HRM),
// MuseScore, Reaper, MPEG-DASH, закодированные файлы (UUE, XXE, Base64, BinHex), метрики шрифтов
import JSZip from 'jszip'
import { escapeHtml as esc, decodeText, ReaderError, MIME, extOf, isImageName } from '../util.js'
import { rgbaToPage, pagesOf, blobPage } from './images2.js'

const latin = new TextDecoder('latin1')
const utf8 = new TextDecoder()
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e }
const xmlDoc = (text, what) => {
    const d = new DOMParser().parseFromString(text, 'application/xml')
    if (d.querySelector('parsererror')) throw new ReaderError(`Не удалось прочитать ${what} (ошибка XML).`)
    return d
}
const kids = (e, name) => Array.from(e?.children ?? []).filter(c => c.localName === name)
const kid = (e, name) => kids(e, name)[0]
const txt = (e, name) => kid(e, name)?.textContent?.trim() ?? ''
const cstr = (u8, off, len) => { const s = u8.subarray(off, off + len); const z = s.indexOf(0); return utf8.decode(z < 0 ? s : s.subarray(0, z)).trim() }
const factsTable = rows => `<table class="ur-font-facts">${rows.filter(r => r[1] != null && r[1] !== '').map(([k, v]) => `<tr><td class="ur-muted">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`
const isZip = u8 => u8[0] === 0x50 && u8[1] === 0x4B

// ================= Xteink XTC / XTCH =================
export const openXtc = async buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const mark = latin.decode(u8.subarray(0, 4))
    if (mark !== 'XTC\0' && mark !== 'XTCH') {
        if (/^XT[GH]\0$/.test(mark)) return pagesOf([await xtPage(u8, 0)])
        throw new ReaderError('Это не книга Xteink (нет подписи XTC). Файлы .xtc программы GROMACS (траектории молекул) читалка не открывает.')
    }
    const count = dv.getUint16(6, true)
    const big = o => Number(dv.getBigUint64(o, true))
    const hasMeta = u8[9], hasChapters = u8[11]
    const metaOff = big(0x10), indexOff = big(0x18), chapOff = big(0x30)
    let title = '', author = '', chapterCount = 0
    if (hasMeta && metaOff + 256 <= u8.length) {
        title = cstr(u8, metaOff, 128); author = cstr(u8, metaOff + 128, 64)
        chapterCount = dv.getUint16(metaOff + 0xF6, true)
    }
    const toc = []
    if (hasChapters && chapOff) {
        const max = chapterCount || (indexOff > chapOff ? Math.floor((indexOff - chapOff) / 96) : 0)
        for (let i = 0; i < max && chapOff + i * 96 + 96 <= u8.length; i++) {
            const o = chapOff + i * 96
            const name = cstr(u8, o, 80)
            if (!name && !chapterCount) break
            toc.push({ label: name || `Глава ${i + 1}`, target: Math.min(count - 1, dv.getUint16(o + 0x50, true)) })
        }
    }
    const pages = []
    for (let i = 0; i < count; i++) {
        const e = indexOff + i * 16
        if (e + 16 > u8.length) break
        const off = big(e)
        pages.push(() => xtPage(u8, off))
    }
    if (!pages.length) throw new ReaderError('В книге Xteink нет страниц.')
    const label = [title, author].filter(Boolean).join(' — ')
    return pagesOf(pages, toc.length ? toc : label ? [{ label, target: 0 }] : undefined)
}
const xtPage = async (u8, off) => {
    const dv = new DataView(u8.buffer, u8.byteOffset + off)
    const mark = latin.decode(u8.subarray(off, off + 4))
    const w = dv.getUint16(4, true), h = dv.getUint16(6, true)
    if (u8[off + 9] !== 0) throw new ReaderError('Страница сжата неизвестным способом.')
    const data = u8.subarray(off + 22)
    const rgba = new Uint8ClampedArray(w * h * 4)
    if (mark === 'XTG\0') {
        const stride = (w + 7) >> 3
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const v = (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0
            const p = (y * w + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = v; rgba[p + 3] = 255
        }
    } else if (mark === 'XTH\0') {
        const plane = (w * h + 7) >> 3
        const LEVEL = [255, 85, 170, 0] // 0 — белый, 1 — тёмно-серый, 2 — светло-серый, 3 — чёрный
        for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
            const n = (w - 1 - x) * h + y, byte = n >> 3, bit = 7 - (n & 7)
            const v = LEVEL[(((data[byte] >> bit) & 1) << 1) | ((data[plane + byte] >> bit) & 1)]
            const p = (y * w + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = v; rgba[p + 3] = 255
        }
    } else throw new ReaderError('Повреждённая страница книги Xteink.')
    return rgbaToPage(w, h, rgba)
}

// ================= Превью из zip (Procreate, Sketch, Adobe XD, CorelDRAW, FreeCAD, MuseScore) =================
const PREVIEW_NAMES = ['QuickLook/Thumbnail.png', 'previews/preview.png', 'preview.png', 'thumbnail.png', 'Thumbnails/thumbnail.png', 'thumbnails/Thumbnail.png', 'previews/thumbnail.png', 'metadata/thumbnails/thumbnail.png', 'metadata/thumbnails/thumbnail.bmp']
const APP_NAME = { procreate: 'Procreate', sketch: 'Sketch', xd: 'Adobe XD', cdr: 'CorelDRAW', fcstd: 'FreeCAD', mscz: 'MuseScore' }
export const zipPreview = async (buf, ext) => {
    const u8 = new Uint8Array(buf)
    if (!isZip(u8)) {
        if (ext === 'cdr') throw new ReaderError('Это старый файл CorelDRAW (до версии X4) — в нём нет готовой картинки-превью.')
        if (ext === 'sketch') throw new ReaderError('Это старый файл Sketch (до версии 43) — его прочитать нельзя.')
        throw new ReaderError(`Файл ${APP_NAME[ext] ?? ''} повреждён (ожидался zip-архив).`)
    }
    const zip = await JSZip.loadAsync(buf)
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir)
    let name = PREVIEW_NAMES.find(n => zip.file(n)) ?? names.find(n => /(^|\/)(quicklook|thumbnails?|previews?)\b/i.test(n) && /\.(png|jpe?g|bmp)$/i.test(n))
    if (!name) {
        // запасной путь: самая большая картинка в архиве
        const imgs = names.filter(n => isImageName(n) || /\.bmp$/i.test(n))
        const sizes = imgs.map(n => [n, zip.files[n]._data?.uncompressedSize ?? 0]).sort((a, b) => b[1] - a[1])
        name = sizes[0]?.[0]
    }
    if (!name) throw new ReaderError(`В файле ${APP_NAME[ext] ?? ''} нет картинки-превью.`)
    const bytes = await zip.file(name).async('uint8array')
    const page = await blobPage(bytes, MIME[extOf(name)] || 'image/png')
    return { page, zip, names }
}

// MuseScore: превью первой страницы + название, автор, инструменты
export const msczView = async (ctx, buf) => {
    const wrap = el('div', 'ur-preview-card')
    let page = null, zip
    try { ({ page, zip } = await zipPreview(buf, 'mscz')) } catch (e) { if (!isZip(new Uint8Array(buf))) throw e; zip = await JSZip.loadAsync(buf) }
    const mscx = Object.keys(zip.files).find(n => /\.mscx$/i.test(n))
    if (mscx) {
        const d = new DOMParser().parseFromString(await zip.file(mscx).async('string'), 'application/xml')
        const meta = n => d.querySelector(`metaTag[name="${n}"]`)?.textContent?.trim()
        const parts = Array.from(d.querySelectorAll('Part > trackName, Part > Instrument > longName')).map(x => x.textContent.trim()).filter(Boolean)
        const uniq = [...new Set(parts)]
        wrap.append(el('div', '', `<h2>${esc(meta('workTitle') || meta('movementTitle') || 'Ноты MuseScore')}</h2>` + factsTable([
            ['Композитор', meta('composer')], ['Автор слов', meta('lyricist')], ['Аранжировка', meta('arranger')],
            ['Инструменты', uniq.join(', ')], ['Версия MuseScore', d.documentElement.getAttribute('version')], ['Авторские права', meta('copyright')]])))
    }
    if (page) { ctx.urls.push(page.url); const img = el('img', 'ur-preview-img'); img.src = page.url; wrap.append(el('div', 'ur-muted', 'Первая страница (картинка, сохранённая MuseScore):'), img) }
    if (!wrap.childNodes.length) throw new ReaderError('В файле MuseScore нет ни превью, ни нот.')
    return wrap
}

// Paint.NET: миниатюра в заголовке (PNG в base64)
export const openPdn = async buf => {
    const u8 = new Uint8Array(buf)
    if (latin.decode(u8.subarray(0, 4)) !== 'PDN3') throw new ReaderError('Это не файл Paint.NET.')
    const len = u8[4] | u8[5] << 8 | u8[6] << 16
    const head = utf8.decode(u8.subarray(7, 7 + len))
    const m = /<thumb png="([^"]+)"/.exec(head)
    if (!m) throw new ReaderError('В файле Paint.NET нет миниатюры.')
    const bin = atob(m[1]); const png = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) png[i] = bin.charCodeAt(i)
    const page = await blobPage(png, 'image/png')
    const w = /width="(\d+)"/.exec(head)?.[1], h = /height="(\d+)"/.exec(head)?.[1]
    const layers = (head.match(/<layer /g) || []).length
    return pagesOf([page], [{ label: `Миниатюра${w ? ` (оригинал ${w}×${h}${layers ? `, слоёв: ${layers}` : ''})` : ''}`, target: 0 }])
}

// ================= Палитры =================
const hex2 = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
const rgbHex = (r, g, b) => '#' + hex2(r) + hex2(g) + hex2(b)
const cmyk = (c, m, y, k) => rgbHex(255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k))
const hsb = (h, s, v) => { const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)) }; return rgbHex(f(5) * 255, f(3) * 255, f(1) * 255) }
const lab = (L, a, b) => {
    let y = (L + 16) / 116, x = a / 500 + y, z = y - b / 200
    const f = t => t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787
    x = 0.95047 * f(x); y = f(y); z = 1.08883 * f(z)
    const g = c => 255 * (c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c)
    return rgbHex(g(x * 3.2406 + y * -1.5372 + z * -0.4986), g(x * -0.9689 + y * 1.8758 + z * 0.0415), g(x * 0.0557 + y * -0.2040 + z * 1.0570))
}
export const parsePalette = (buf, ext) => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const head = latin.decode(u8.subarray(0, 12))
    const out = []
    if (head.startsWith('GIMP Palette') || ext === 'gpl') {
        for (const l of decodeText(buf).split(/\r?\n/)) {
            const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/.exec(l)
            if (m) out.push({ color: rgbHex(+m[1], +m[2], +m[3]), name: m[4].trim() })
        }
    } else if (head.startsWith('JASC-PAL')) {
        const lines = decodeText(buf).split(/\r?\n/).slice(3)
        for (const l of lines) { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(l); if (m) out.push({ color: rgbHex(+m[1], +m[2], +m[3]) }) }
    } else if (head.startsWith('RIFF') && head.slice(8, 12) === 'PAL ') {
        const i = latin.decode(u8).indexOf('data')
        const n = dv.getUint16(i + 10, true)
        for (let k = 0; k < n; k++) { const o = i + 12 + k * 4; out.push({ color: rgbHex(u8[o], u8[o + 1], u8[o + 2]) }) }
    } else if (head.startsWith('ASEF')) {
        const blocks = dv.getUint32(8)
        let p = 12
        for (let b = 0; b < blocks && p + 6 <= u8.length; b++) {
            const type = dv.getUint16(p), len = dv.getUint32(p + 2), body = p + 6
            p = body + len
            if (type === 0xC001) { const nl = dv.getUint16(body); const name = new TextDecoder('utf-16be').decode(u8.subarray(body + 2, body + 2 + nl * 2)).replace(/\0+$/, ''); out.push({ group: name }); continue }
            if (type !== 0x0001) continue
            const nl = dv.getUint16(body)
            const name = new TextDecoder('utf-16be').decode(u8.subarray(body + 2, body + 2 + nl * 2)).replace(/\0+$/, '')
            let q = body + 2 + nl * 2
            const model = latin.decode(u8.subarray(q, q + 4)).trim(); q += 4
            const fl = n => dv.getFloat32(q + n * 4)
            const color = model === 'RGB' ? rgbHex(fl(0) * 255, fl(1) * 255, fl(2) * 255) : model === 'CMYK' ? cmyk(fl(0), fl(1), fl(2), fl(3))
                : model === 'LAB' ? lab(fl(0) * 100, fl(1), fl(2)) : rgbHex(fl(0) * 255, fl(0) * 255, fl(0) * 255)
            out.push({ color, name, model })
        }
    } else if (ext === 'aco') {
        let p = 0
        const read = (withNames) => {
            const n = dv.getUint16(p + 2); p += 4
            const res = []
            for (let k = 0; k < n && p + 10 <= u8.length; k++) {
                const sp = dv.getUint16(p), w = dv.getUint16(p + 2), x = dv.getUint16(p + 4), y = dv.getUint16(p + 6), z = dv.getUint16(p + 8); p += 10
                let name = ''
                if (withNames) { const len = dv.getUint32(p); name = new TextDecoder('utf-16be').decode(u8.subarray(p + 4, p + 4 + len * 2)).replace(/\0+$/, ''); p += 4 + len * 2 }
                const color = sp === 0 ? rgbHex(w / 257, x / 257, y / 257) : sp === 1 ? hsb(w / 182.04, x / 65535, y / 65535) : sp === 2 ? cmyk(1 - w / 65535, 1 - x / 65535, 1 - y / 65535, 1 - z / 65535)
                    : sp === 7 ? lab(w / 100, ((x << 16) >> 16) / 100, ((y << 16) >> 16) / 100) : sp === 8 ? rgbHex(255 - w / 39.2, 255 - w / 39.2, 255 - w / 39.2) : '#888888'
                res.push({ color, name })
            }
            return res
        }
        const v1 = read(false)
        out.push(...(p + 4 <= u8.length && dv.getUint16(p) === 2 ? read(true) : v1))
    } else if (ext === 'act' || u8.length === 768 || u8.length === 772) {
        let n = 256
        if (u8.length >= 772) n = dv.getUint16(768) || 256
        for (let k = 0; k < n; k++) out.push({ color: rgbHex(u8[k * 3], u8[k * 3 + 1], u8[k * 3 + 2]) })
    }
    if (!out.some(c => c.color)) throw new ReaderError('Не удалось прочитать палитру.')
    return out
}
export const paletteView = list => {
    const wrap = el('div', 'ur-palette')
    const n = list.filter(c => c.color).length
    wrap.append(el('div', 'ur-meta', `Цветов: ${n}. Нажмите на образец, чтобы скопировать код цвета.`))
    let grid = el('div', 'ur-swatches'); wrap.append(grid)
    for (const c of list) {
        if (c.group != null) { wrap.append(el('h3', '', esc(c.group || 'Группа'))); grid = el('div', 'ur-swatches'); wrap.append(grid); continue }
        const s = el('div', 'ur-swatch', `<div class="ur-swatch-color" style="background:${c.color}"></div><div class="ur-swatch-label">${esc(c.name || '')}<br><code>${c.color}</code></div>`)
        s.title = 'Скопировать ' + c.color
        s.onclick = () => navigator.clipboard?.writeText(c.color)
        grid.append(s)
    }
    return wrap
}

// ================= XMP (метаданные фото рядом со снимком) =================
const XMP_NAMES = { Rating: 'Рейтинг', Label: 'Цветная метка', title: 'Название', description: 'Описание', subject: 'Ключевые слова', creator: 'Автор', rights: 'Права',
    CreateDate: 'Создан', ModifyDate: 'Изменён', DateTimeOriginal: 'Дата съёмки', Make: 'Камера (марка)', Model: 'Камера (модель)', Lens: 'Объектив', LensModel: 'Объектив',
    ExposureTime: 'Выдержка', FNumber: 'Диафрагма', ISOSpeedRatings: 'ISO', FocalLength: 'Фокусное расстояние', GPSLatitude: 'Широта', GPSLongitude: 'Долгота',
    CreatorTool: 'Программа', Exposure2012: 'Экспозиция', Contrast2012: 'Контраст', Highlights2012: 'Света', Shadows2012: 'Тени', Temperature: 'Температура', Tint: 'Оттенок', Vibrance: 'Красочность', Saturation: 'Насыщенность', Clarity2012: 'Чёткость', Dehaze: 'Удаление дымки', CropTop: 'Кадрирование (верх)', HasCrop: 'Кадрирование' }
export const xmpView = text => {
    const start = text.indexOf('<x:xmpmeta'), end = text.lastIndexOf('</x:xmpmeta>')
    const body = start >= 0 && end > start ? text.slice(start, end + 12) : text
    const d = xmlDoc(body, 'метаданные XMP')
    const rows = []
    const valueOf = e => {
        const items = e.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'li')
        if (items.length) return Array.from(items).map(i => i.textContent.trim()).filter(Boolean).join(', ')
        return e.children.length ? null : e.textContent.trim()
    }
    for (const desc of d.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'Description')) {
        for (const a of desc.attributes) if (a.prefix && !['rdf', 'xmlns', 'x'].includes(a.prefix)) rows.push([a.prefix, a.localName, a.value])
        for (const c of desc.children) { const v = valueOf(c); if (v != null && v !== '') rows.push([c.prefix, c.localName, v]) }
    }
    if (!rows.length) throw new ReaderError('В файле XMP нет метаданных.')
    const known = rows.filter(r => XMP_NAMES[r[1]]), other = rows.filter(r => !XMP_NAMES[r[1]])
    const tr = r => `<tr><td class="ur-muted">${esc(XMP_NAMES[r[1]] ?? r[1])}</td><td>${r[1] === 'Rating' ? '★'.repeat(Math.max(0, +r[2] || 0)) + ` (${esc(r[2])})` : esc(r[2])}</td><td class="ur-muted"><code>${esc(r[0])}:${esc(r[1])}</code></td></tr>`
    return el('div', '', (known.length ? `<h2>Главное</h2><table class="ur-font-facts">${known.map(tr).join('')}</table>` : '') +
        (other.length ? `<h2>Все поля (${other.length})</h2><table class="ur-font-facts">${other.map(tr).join('')}</table>` : ''))
}

// ================= Ярлыки Google Диска (.gdoc и др.) =================
const GKIND = { gdoc: ['document', 'Google Документ'], gsheet: ['spreadsheets', 'Google Таблица'], gslides: ['presentation', 'Google Презентация'], gdraw: ['drawings', 'Google Рисунок'], gform: ['forms', 'Google Форма'] }
export const gdocView = (text, ext) => {
    let j
    try { j = JSON.parse(text) } catch { throw new ReaderError('Ярлык Google Диска повреждён.') }
    const [path, kind] = GKIND[ext] ?? ['document', 'Документ Google']
    const url = j.url || (j.doc_id ? `https://docs.google.com/${path}/d/${encodeURIComponent(j.doc_id)}/edit` + (j.resource_key ? `?resourcekey=${encodeURIComponent(j.resource_key)}` : '') : '')
    if (!url || !/^https:\/\//.test(url)) throw new ReaderError('В ярлыке Google Диска нет адреса документа.')
    return `<div class="ur-shortcut"><div class="ur-shortcut-icon">📄</div><h2>${esc(kind)}</h2>
        <p class="ur-muted">Это не сам документ, а ярлык: документ хранится на Google Диске${j.email ? ` (аккаунт ${esc(j.email)})` : ''}.</p>
        <p><code>${esc(url)}</code></p><p><a class="ur-btn-link external-link" href="${esc(url)}" target="_blank" rel="noopener">Открыть в Google</a></p></div>`
}

// ================= MathML =================
const MATHNS = 'http://www.w3.org/1998/Math/MathML'
export const mathmlView = text => {
    const d = new DOMParser().parseFromString(text.replace(/^\s*<\?xml[^>]*>/, '').replace(/<!DOCTYPE[^>]*>/i, ''), 'application/xml')
    if (d.querySelector('parsererror')) throw new ReaderError('Формула MathML повреждена (ошибка XML).')
    const maths = d.documentElement.localName === 'math' ? [d.documentElement] : Array.from(d.getElementsByTagNameNS(MATHNS, 'math'))
    if (!maths.length) throw new ReaderError('В файле нет формул MathML.')
    const wrap = el('div', 'ur-mathml')
    for (const m of maths) {
        const node = document.importNode(m, true)
        // оставляем только элементы MathML и безопасные атрибуты
        const walk = n => {
            for (const c of Array.from(n.children)) {
                if (c.namespaceURI !== MATHNS) { c.remove(); continue }
                for (const a of Array.from(c.attributes)) if (/^on|href|src|xlink/i.test(a.name)) c.removeAttribute(a.name)
                walk(c)
            }
        }
        if (node.namespaceURI !== MATHNS) continue
        for (const a of Array.from(node.attributes)) if (/^on|href|src|xlink/i.test(a.name)) node.removeAttribute(a.name)
        walk(node)
        node.setAttribute('display', 'block')
        wrap.append(el('div', 'ur-mathml-item'))
        wrap.lastChild.append(node)
    }
    return wrap
}

// ================= Оглавление EPUB 2 (.ncx) =================
export const ncxView = text => {
    const d = xmlDoc(text, 'оглавление NCX')
    const title = d.querySelector('docTitle text')?.textContent?.trim()
    const author = d.querySelector('docAuthor text')?.textContent?.trim()
    const list = e => {
        const pts = kids(e, 'navPoint')
        if (!pts.length) return ''
        return '<ol>' + pts.map(p => `<li>${esc(kid(kid(p, 'navLabel'), 'text')?.textContent?.trim() || '—')} <span class="ur-muted">${esc(kid(p, 'content')?.getAttribute('src') ?? '')}</span>${list(p)}</li>`).join('') + '</ol>'
    }
    const map = d.querySelector('navMap')
    if (!map) throw new ReaderError('В файле NCX нет оглавления.')
    return el('div', 'ur-ncx', `<h2>${esc(title || 'Оглавление книги')}</h2>${author ? `<p class="ur-muted">${esc(author)}</p>` : ''}
        <p class="ur-muted">Это оглавление распакованной книги EPUB. Всю книгу целиком откроет файл .opf из той же папки.</p>${list(map)}`)
}

// ================= Заметки Tomboy / Gnote =================
export const tomboyView = text => {
    const d = xmlDoc(text, 'заметку Tomboy')
    const title = d.querySelector('note > title')?.textContent ?? 'Заметка'
    const content = d.getElementsByTagName('note-content')[0]
    if (!content) throw new ReaderError('В заметке Tomboy нет текста.')
    const conv = n => {
        if (n.nodeType === 3) return esc(n.textContent)
        if (n.nodeType !== 1) return ''
        const inner = Array.from(n.childNodes).map(conv).join('')
        switch (n.localName) {
            case 'bold': return `<b>${inner}</b>`
            case 'italic': return `<i>${inner}</i>`
            case 'strikethrough': return `<s>${inner}</s>`
            case 'highlight': return `<mark>${inner}</mark>`
            case 'monospace': return `<code>${inner}</code>`
            case 'underline': return `<u>${inner}</u>`
            case 'large': return `<span style="font-size:1.25em">${inner}</span>`
            case 'huge': return `<span style="font-size:1.5em">${inner}</span>`
            case 'small': return `<small>${inner}</small>`
            case 'list': return `<ul>${inner}</ul>`
            case 'list-item': return `<li>${inner}</li>`
            case 'internal': case 'broken': return `<span class="ur-link-like">${inner}</span>`
            case 'url': return /^https?:\/\//.test(n.textContent) ? `<a href="${esc(n.textContent)}" class="external-link" target="_blank" rel="noopener">${inner}</a>` : inner
            default: return inner
        }
    }
    const body = Array.from(content.childNodes).map(conv).join('').replace(/^\s*[^\n]*\n?/, '') // первая строка — заголовок
    const dt = s => { const t = Date.parse(s); return isNaN(t) ? '' : new Date(t).toLocaleString('ru-RU') }
    const tags = Array.from(d.getElementsByTagName('tag')).map(t => t.textContent.replace(/^system:notebook:/, 'блокнот: '))
    return el('div', 'ur-note', `<h1>${esc(title)}</h1><div class="ur-meta">${[dt(d.querySelector('last-change-date')?.textContent) && 'Изменена ' + dt(d.querySelector('last-change-date').textContent), tags.join(', ')].filter(Boolean).map(esc).join(' · ')}</div>
        <div style="white-space:pre-wrap">${body}</div>`)
}

// ================= TiddlyWiki (.tid) =================
const twInline = s => esc(s)
    .replace(/''(.+?)''/g, '<b>$1</b>').replace(/\/\/(.+?)\/\//g, '<i>$1</i>').replace(/__(.+?)__/g, '<u>$1</u>').replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[\[([^\]|]+)\|(https?:[^\]]+)\]\]/g, '<a href="$2" class="external-link" target="_blank" rel="noopener">$1</a>')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<span class="ur-link-like">$1</span>').replace(/\[\[([^\]]+)\]\]/g, '<span class="ur-link-like">$1</span>')
export const tidView = text => {
    const [head, ...rest] = text.replace(/\r/g, '').split(/\n\n/)
    const fields = head.split('\n').map(l => /^([\w.-]+):\s?(.*)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2]])
    const get = k => fields.find(f => f[0] === k)?.[1]
    const body = fields.length ? rest.join('\n\n') : text
    const out = []
    let list = null, code = false
    for (const l of body.split('\n')) {
        if (/^```/.test(l)) { out.push(code ? '</pre>' : '<pre>'); code = !code; continue }
        if (code) { out.push(esc(l)); continue }
        const lm = /^([*#]+)\s*(.*)$/.exec(l)
        if (lm) { const tag = lm[1][0] === '#' ? 'ol' : 'ul'; if (!list) { out.push(`<${tag}>`); list = tag } out.push(`<li>${twInline(lm[2])}</li>`); continue }
        if (list) { out.push(`</${list}>`); list = null }
        const hm = /^(!{1,6})\s*(.*)$/.exec(l)
        if (hm) out.push(`<h${hm[1].length + 1}>${twInline(hm[2])}</h${hm[1].length + 1}>`)
        else if (l.trim()) out.push(`<p>${twInline(l)}</p>`)
    }
    if (list) out.push(`</${list}>`)
    if (code) out.push('</pre>')
    const date = s => s && /^\d{14}/.test(s) ? new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12))).toLocaleString('ru-RU') : ''
    return el('div', 'ur-note', `<h1>${esc(get('title') || 'Запись TiddlyWiki')}</h1><div class="ur-meta">${[get('tags') && 'Метки: ' + get('tags'), date(get('modified')) && 'Изменена ' + date(get('modified'))].filter(Boolean).map(esc).join(' · ')}</div>${out.join('\n')}`)
}

// ================= TaskPaper =================
export const taskpaperView = text => {
    const wrap = el('div', 'ur-taskpaper')
    let total = 0, done = 0
    const html = text.replace(/\r/g, '').split('\n').map(l => {
        const depth = (/^\t*/.exec(l)[0].length) + (/^ */.exec(l.replace(/^\t*/, ''))[0].length >> 2)
        const s = l.trim()
        if (!s) return ''
        const tags = s.match(/(^|\s)@[\w-]+(\([^)]*\))?/g) ?? []
        const isDone = tags.some(t => /@done\b/.test(t))
        const clean = s.replace(/(^|\s)@[\w-]+(\([^)]*\))?/g, '').trim()
        const tagHtml = tags.map(t => `<span class="ur-tp-tag">${esc(t.trim())}</span>`).join(' ')
        const pad = `style="margin-left:${depth * 1.5}em"`
        if (s.startsWith('- ')) { total++; if (isDone) done++; return `<div class="ur-tp-task${isDone ? ' ur-tp-done' : ''}" ${pad}>${isDone ? '☑' : '☐'} ${esc(clean.slice(2))} ${tagHtml}</div>` }
        if (/:$/.test(clean) && !/\s-\s/.test(clean)) return `<div class="ur-tp-project" ${pad}>${esc(clean.slice(0, -1))} ${tagHtml}</div>`
        return `<div class="ur-tp-note" ${pad}>${esc(clean)} ${tagHtml}</div>`
    }).join('')
    wrap.innerHTML = `<div class="ur-meta">Задач: ${total}, выполнено: ${done}</div>` + html
    return wrap
}

// ================= KityMinder (.km) → дерево карты мыслей =================
export const parseKm = text => {
    let j
    try { j = JSON.parse(text) } catch { throw new ReaderError('Карта KityMinder повреждена.') }
    const node = n => ({ text: n?.data?.text ?? '', note: n?.data?.note, link: n?.data?.hyperlink, children: (n?.children ?? []).map(node) })
    if (!j.root) throw new ReaderError('В карте KityMinder нет узлов.')
    return [{ title: '', root: node(j.root) }]
}

// ================= vNote (.vnt) и vMessage (.vmg) =================
const qp = s => { const b = []; s = s.replace(/=\r?\n/g, ''); for (let i = 0; i < s.length; i++) { if (s[i] === '=' && /^[0-9A-F]{2}$/i.test(s.slice(i + 1, i + 3))) { b.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2 } else b.push(...new TextEncoder().encode(s[i])) } return utf8.decode(new Uint8Array(b)) }
export const vnoteView = (text, ext) => {
    const items = []
    if (ext === 'vnt') {
        for (const block of text.split(/BEGIN:VNOTE/i).slice(1)) {
            const un = block.replace(/\r?\n[ \t]/g, '')
            const bodyLine = /^BODY([^:\n]*):([\s\S]*?)(?=\r?\n[A-Z-]+[;:]|\r?\nEND:VNOTE)/mi.exec(un)
            let body = bodyLine?.[2] ?? ''
            if (/QUOTED-PRINTABLE/i.test(bodyLine?.[1] ?? '')) body = qp(body)
            const dt = /^(?:LAST-MODIFIED|DCREATED):(\S+)/mi.exec(un)?.[1]
            items.push({ text: body.replace(/\\n/gi, '\n').replace(/\\;/g, ';').replace(/\\,/g, ','), date: dt })
        }
    } else {
        for (const block of text.split(/BEGIN:VMSG/i).slice(1)) {
            const tel = /^TEL[^:\n]*:(.+)$/mi.exec(block)?.[1]?.trim()
            const name = /^(?:FN|N)[^:\n]*:(.+)$/mi.exec(block)?.[1]?.replace(/;+/g, ' ').trim()
            const box = /^X-(?:NOKIA-)?(?:BOX|MESSAGE-BOX)[^:\n]*:(.+)$/mi.exec(block)?.[1]?.trim() || /^X-IRMC-BOX:(.+)$/mi.exec(block)?.[1]?.trim()
            const body = /BEGIN:VBODY\r?\n([\s\S]*?)\r?\nEND:VBODY/i.exec(block)?.[1] ?? ''
            const date = /^Date:(.*)$/mi.exec(body)?.[1]?.trim()
            items.push({ who: [name, tel].filter(Boolean).join(' · '), box, date, text: body.replace(/^Date:.*\r?\n?/mi, '').trim() })
        }
    }
    if (!items.length) throw new ReaderError(ext === 'vnt' ? 'В файле нет заметок vNote.' : 'В файле нет сообщений vMessage.')
    return el('div', 'ur-vnotes', items.map(i => `<div class="ur-vnote">${i.who || i.box || i.date ? `<div class="ur-meta">${esc([i.who, i.box && ({ INBOX: 'входящее', SENDBOX: 'отправленное', OUTBOX: 'исходящее', DRAFT: 'черновик' }[i.box.toUpperCase()] ?? i.box), i.date].filter(Boolean).join(' · '))}</div>` : ''}<div style="white-space:pre-wrap">${esc(i.text)}</div></div>`).join(''))
}

// ================= QIF (финансы) =================
const QIF_FIELDS = { D: 'Дата', T: 'Сумма', U: 'Сумма', P: 'Получатель', M: 'Комментарий', L: 'Категория', N: 'Номер', C: 'Сверено', A: 'Адрес' }
export const readQif = (text, title) => {
    const sheets = []
    let cur = null, rec = {}
    const flush = () => { if (Object.keys(rec).length && cur) cur.recs.push(rec); rec = {} }
    for (const raw of text.replace(/\r/g, '').split('\n')) {
        const l = raw.trimEnd()
        if (!l) continue
        if (l.startsWith('!')) {
            flush()
            if (/^!Type:/i.test(l) || /^!Account/i.test(l)) { cur = { name: l.replace(/^!(Type:)?/i, ''), recs: [] }; sheets.push(cur) }
            continue
        }
        if (!cur) { cur = { name: title, recs: [] }; sheets.push(cur) }
        if (l === '^') { flush(); continue }
        const k = l[0], v = l.slice(1)
        if (k === 'S' || k === 'E' || k === '$') { (rec._split ??= []).push(v); continue }
        rec[k] = rec[k] ? rec[k] + '; ' + v : v
    }
    flush()
    const out = sheets.filter(s => s.recs.length).map(s => {
        const keys = [...new Set(s.recs.flatMap(r => Object.keys(r)))].filter(k => k !== '_split' && k !== 'U')
        keys.sort((a, b) => 'DTPMLNCA'.indexOf(a) - 'DTPMLNCA'.indexOf(b))
        const rows = [keys.map(k => QIF_FIELDS[k] ?? k)]
        for (const r of s.recs) rows.push(keys.map(k => r[k] ?? ''))
        return { name: s.name, rows }
    })
    if (!out.length) throw new ReaderError('В файле QIF нет операций.')
    return out
}

// ================= LTSV =================
export const readLtsv = (text, title) => {
    const recs = text.replace(/\r/g, '').split('\n').filter(l => l.trim()).map(l => Object.fromEntries(l.split('\t').map(p => { const i = p.indexOf(':'); return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)] })))
    const keys = [...new Set(recs.flatMap(r => Object.keys(r)))]
    if (!keys.length) throw new ReaderError('Файл пустой.')
    return [{ name: title, rows: [keys, ...recs.map(r => keys.map(k => r[k] ?? ''))] }]
}

// ================= FASTA / FASTQ =================
const BASE_CLS = { A: 'a', T: 't', U: 't', G: 'g', C: 'c' }
export const fastaView = (text, ext) => {
    const recs = []
    const lines = text.replace(/\r/g, '').split('\n')
    if (ext === 'fastq' || lines[0]?.startsWith('@')) {
        for (let i = 0; i + 1 < lines.length; i += 4) if (lines[i].startsWith('@')) recs.push({ name: lines[i].slice(1), seq: lines[i + 1] ?? '', qual: lines[i + 3] ?? '' })
    } else {
        let cur = null
        for (const l of lines) { if (l.startsWith('>') || l.startsWith(';')) { if (l.startsWith('>')) { cur = { name: l.slice(1), seq: '' }; recs.push(cur) } } else if (cur) cur.seq += l.trim() }
    }
    if (!recs.length) throw new ReaderError('В файле нет последовательностей.')
    const isNuc = s => /^[ACGTUN\-]*$/i.test(s.slice(0, 2000))
    const wrap = el('div', 'ur-fasta')
    wrap.append(el('div', 'ur-meta', `Последовательностей: ${recs.length.toLocaleString('ru-RU')}${recs.length > 500 ? ' (показаны первые 500)' : ''}`))
    let chars = 0
    for (const r of recs.slice(0, 500)) {
        const nuc = isNuc(r.seq)
        const shown = r.seq.slice(0, 20000)
        chars += shown.length
        const gc = nuc && r.seq.length ? Math.round((r.seq.match(/[GC]/gi)?.length ?? 0) / r.seq.length * 1000) / 10 : null
        const body = nuc ? shown.replace(/[ACGTU]/gi, ch => `<span class="ur-nt-${BASE_CLS[ch.toUpperCase()]}">${ch}</span>`) : esc(shown)
        wrap.append(el('section', '', `<h3>${esc(r.name)}</h3><div class="ur-meta">Длина: ${r.seq.length.toLocaleString('ru-RU')}${nuc ? ` · GC: ${gc}%` : ' · белок'}${r.qual ? ' · есть качество прочтения' : ''}</div><pre class="ur-seq">${body}${r.seq.length > shown.length ? '…' : ''}</pre>`))
        if (chars > 2_000_000) break
    }
    return wrap
}

// ================= Треки: TCX, IGC, OziExplorer, NMEA, LOC, TomTom, WKT =================
export const parseTcx = text => {
    const d = xmlDoc(text, 'тренировку TCX')
    const feats = [], hr = []
    for (const lap of d.getElementsByTagName('Track')) {
        const coords = []
        for (const tp of kids(lap, 'Trackpoint')) {
            const pos = kid(tp, 'Position')
            const t = Date.parse(txt(tp, 'Time'))
            const h = +kid(kid(tp, 'HeartRateBpm'), 'Value')?.textContent
            if (h && Number.isFinite(t)) hr.push([t, h])
            if (!pos) continue
            const alt = txt(tp, 'AltitudeMeters')
            coords.push([+txt(pos, 'LongitudeDegrees'), +txt(pos, 'LatitudeDegrees'), alt ? +alt : undefined, Number.isFinite(t) ? t : undefined])
        }
        if (coords.length) feats.push({ kind: 'line', coords, track: true, name: '' })
    }
    for (const c of d.getElementsByTagName('CoursePoint')) { const p = kid(c, 'Position'); if (p) feats.push({ kind: 'point', coords: [[+txt(p, 'LongitudeDegrees'), +txt(p, 'LatitudeDegrees')]], name: txt(c, 'Name'), desc: txt(c, 'Notes') }) }
    const sport = d.querySelector('Activity')?.getAttribute('Sport')
    const SPORT = { Running: 'Бег', Biking: 'Велосипед', Other: 'Тренировка' }
    const name = d.querySelector('Course > Name')?.textContent ?? (sport ? SPORT[sport] ?? sport : '')
    feats.filter(f => f.kind === 'line').forEach((f, i, a) => { f.name = name + (a.length > 1 ? ` (круг ${i + 1})` : '') })
    return { feats, title: name, hr }
}
export const parseIgc = text => {
    const lines = text.replace(/\r/g, '').split('\n')
    let date = null, pilot = '', glider = ''
    const coords = []
    for (const l of lines) {
        if (/^HFDTE/i.test(l)) { const m = /(\d{2})(\d{2})(\d{2})/.exec(l.slice(5)); if (m) date = Date.UTC(2000 + +m[3] - (+m[3] > 80 ? 100 : 0), +m[2] - 1, +m[1]) }
        else if (/^HFPLT/i.test(l)) pilot = l.split(':').slice(1).join(':').trim()
        else if (/^HFGTY/i.test(l)) glider = l.split(':').slice(1).join(':').trim()
        else if (l[0] === 'B' && l.length >= 35) {
            const t = (+l.slice(1, 3) * 3600 + +l.slice(3, 5) * 60 + +l.slice(5, 7)) * 1000
            let lat = +l.slice(7, 9) + +l.slice(9, 14) / 60000; if (l[14] === 'S') lat = -lat
            let lon = +l.slice(15, 18) + +l.slice(18, 23) / 60000; if (l[23] === 'W') lon = -lon
            const gps = +l.slice(30, 35), baro = +l.slice(25, 30)
            coords.push([lon, lat, gps || baro || undefined, date != null ? date + t : undefined])
        }
    }
    if (!coords.length) throw new ReaderError('В файле IGC нет точек полёта.')
    return { feats: [{ kind: 'line', coords, track: true, name: [pilot, glider].filter(Boolean).join(', ') || 'Полёт' }], title: pilot ? 'Пилот: ' + pilot : '' }
}
const oziDate = d => Number.isFinite(d) && d > 1 ? Math.round((d - 25569) * 86400000) : undefined
export const parseOzi = (text, ext) => {
    const lines = text.replace(/\r/g, '').split('\n')
    if (!/^OziExplorer/i.test(lines[0] ?? '')) throw new ReaderError(ext === 'plt' ? 'Это не трек OziExplorer (файлы .plt бывают и чертежами для плоттера — такие читалка не открывает).' : 'Это не файл точек OziExplorer.')
    if (ext === 'plt') {
        const segs = []; let cur = []
        for (const l of lines.slice(6)) {
            const f = l.split(','); if (f.length < 4) continue
            const lat = +f[0], lon = +f[1], brk = +f[2], alt = +f[3], days = +f[4]
            if (brk === 1 && cur.length) { segs.push(cur); cur = [] }
            cur.push([lon, lat, alt !== -777 && Number.isFinite(alt) ? alt * 0.3048 : undefined, oziDate(days)])
        }
        if (cur.length) segs.push(cur)
        const name = lines[4]?.split(',')[3]?.trim()
        return { feats: segs.map((s, i) => ({ kind: 'line', coords: s, track: true, name: (name || 'Трек') + (segs.length > 1 ? ` (часть ${i + 1})` : '') })), title: name ?? '' }
    }
    const feats = []
    for (const l of lines.slice(4)) {
        const f = l.split(','); if (f.length < 4) continue
        feats.push({ kind: 'point', coords: [[+f[3], +f[2], f[14] && +f[14] !== -777 ? +f[14] * 0.3048 : undefined]], name: f[1]?.trim(), desc: f[10]?.trim() })
    }
    return { feats, title: '' }
}
export const parseNmea = text => {
    const coords = []
    let date = null
    const deg = (v, h) => { if (!v) return NaN; const i = v.indexOf('.') - 2; const d = +v.slice(0, i) + +v.slice(i) / 60; return h === 'S' || h === 'W' ? -d : d }
    let alt
    for (const l of text.split(/\r?\n/)) {
        const f = l.trim().replace(/\*[0-9A-F]{2}$/i, '').split(',')
        const type = f[0].slice(3)
        if (type === 'GGA' && f[6] !== '0') { alt = f[9] ? +f[9] : undefined; continue }
        if (type === 'RMC' && f[2] === 'A') {
            const d = f[9]; if (d) date = Date.UTC(2000 + +d.slice(4, 6), +d.slice(2, 4) - 1, +d.slice(0, 2))
            const t = f[1] ? (+f[1].slice(0, 2) * 3600 + +f[1].slice(2, 4) * 60 + +f[1].slice(4)) * 1000 : 0
            const lat = deg(f[3], f[4]), lon = deg(f[5], f[6])
            if (Number.isFinite(lat) && Number.isFinite(lon)) coords.push([lon, lat, alt, date != null ? date + t : undefined])
        }
    }
    if (!coords.length) {
        // только GGA без RMC
        for (const l of text.split(/\r?\n/)) {
            const f = l.trim().split(','); if (f[0]?.slice(3) !== 'GGA' || f[6] === '0') continue
            const lat = deg(f[2], f[3]), lon = deg(f[4], f[5]); if (Number.isFinite(lat) && Number.isFinite(lon)) coords.push([lon, lat, f[9] ? +f[9] : undefined])
        }
    }
    if (!coords.length) throw new ReaderError('В записи NMEA нет координат (нет строк GGA или RMC с данными).')
    return { feats: [{ kind: 'line', coords, track: true, name: 'Запись GPS' }], title: '' }
}
export const parseLoc = text => {
    const d = xmlDoc(text, 'файл LOC')
    const feats = Array.from(d.getElementsByTagName('waypoint')).map(w => {
        const c = kid(w, 'coord'), n = kid(w, 'name')
        return { kind: 'point', coords: [[+c?.getAttribute('lon'), +c?.getAttribute('lat')]], name: n?.getAttribute('id') || n?.textContent?.trim(), desc: n?.getAttribute('id') ? n.textContent.trim() : txt(w, 'type') }
    }).filter(f => Number.isFinite(f.coords[0][0]))
    return { feats, title: '' }
}
export const parseOv2 = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const feats = []
    let p = 0
    while (p + 5 <= u8.length) {
        const type = u8[p]
        const len = type === 1 ? 21 : dv.getUint32(p + 1, true)
        if (len < 5 || p + len > u8.length) break
        if (type === 2 || type === 3) {
            const lon = dv.getInt32(p + 5, true) / 100000, lat = dv.getInt32(p + 9, true) / 100000
            const raw = u8.subarray(p + 13, p + len); const z = raw.indexOf(0)
            const name = decodeText(raw.subarray(0, z < 0 ? raw.length : z))
            const [title, ...extra] = name.split('>')
            feats.push({ kind: 'point', coords: [[lon, lat]], name: title.trim(), desc: extra.join(' ').trim() })
        }
        p += len
    }
    if (!feats.length) throw new ReaderError('В файле TomTom нет точек.')
    return { feats, title: '' }
}
export const parseItn = text => {
    const pts = text.replace(/\r/g, '').split('\n').map(l => l.split('|')).filter(f => f.length >= 3 && /^-?\d+$/.test(f[0].trim()))
        .map(f => [+f[0] / 100000, +f[1] / 100000, f[2]])
    if (!pts.length) throw new ReaderError('В маршруте TomTom нет точек.')
    return { feats: [{ kind: 'line', coords: pts.map(p => [p[0], p[1]]), name: 'Маршрут' }, ...pts.map(p => ({ kind: 'point', coords: [[p[0], p[1]]], name: p[2] }))], title: '' }
}
// WKT: POINT (30 10), LINESTRING (...), POLYGON ((...)), MULTI*, GEOMETRYCOLLECTION
export const parseWkt = text => {
    const feats = []
    const src = text.replace(/^\s*SRID=\d+;/gim, '')
    let i = 0
    const ws = () => { while (/[\s,]/.test(src[i] ?? '')) i++ }
    const word = () => { ws(); const m = /^[A-Za-z]+/.exec(src.slice(i)); if (!m) return null; i += m[0].length; return m[0].toUpperCase() }
    const nums = () => { // "x y [z [m]]"
        const m = /^\s*(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)(?:\s+(-?[\d.eE+-]+))?(?:\s+(-?[\d.eE+-]+))?/.exec(src.slice(i))
        if (!m) throw new ReaderError('Ошибка в WKT около: ' + src.slice(i, i + 30))
        i += m[0].length
        return [+m[1], +m[2], m[3] != null ? +m[3] : undefined]
    }
    const open = () => { ws(); if (src[i] !== '(') throw new ReaderError('Ошибка в WKT: ожидалась скобка.'); i++ }
    const close = () => { ws(); if (src[i] === ')') i++ }
    const list = item => { open(); const out = []; ws(); while (src[i] && src[i] !== ')') { out.push(item()); ws() } close(); return out }
    const pointList = () => list(() => { ws(); if (src[i] === '(') { open(); const p = nums(); close(); return p } return nums() })
    const geom = type => {
        ws()
        if (/^EMPTY/i.test(src.slice(i))) { i += 5; return }
        while (/^[ZM]{1,2}\b/i.test(src.slice(i).trim()) && src[i] !== '(') { ws(); i += /^[ZM]+/i.exec(src.slice(i))[0].length }
        switch (type) {
            case 'POINT': { open(); feats.push({ kind: 'point', coords: [nums()] }); close(); break }
            case 'LINESTRING': feats.push({ kind: 'line', coords: pointList() }); break
            case 'POLYGON': feats.push({ kind: 'poly', coords: list(pointList) }); break
            case 'MULTIPOINT': for (const p of pointList()) feats.push({ kind: 'point', coords: [p] }); break
            case 'MULTILINESTRING': for (const l of list(pointList)) feats.push({ kind: 'line', coords: l }); break
            case 'MULTIPOLYGON': for (const pl of list(() => list(pointList))) feats.push({ kind: 'poly', coords: pl }); break
            case 'GEOMETRYCOLLECTION': { open(); let t; while ((t = word())) geom(t); close(); break }
            default: throw new ReaderError('Неизвестный тип геометрии WKT: ' + type)
        }
    }
    let t
    while ((t = word())) geom(t)
    if (!feats.length) throw new ReaderError('В файле нет геометрии WKT.')
    feats.forEach((f, k) => { f.name = feats.length > 1 ? `Объект ${k + 1}` : '' })
    return { feats, title: '' }
}

// ================= Графики пульса: PWX, HRM, а также пульс из TCX =================
export const chartView = (ctx, series, { title = '' } = {}) => {
    const wrap = el('div', 'ur-chart-wrap')
    if (title) wrap.append(el('h2', '', esc(title)))
    const fg = ctx.themeColors().text
    for (const s of series) {
        const pts = s.points.filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))
        if (pts.length < 2) continue
        const x0 = pts[0][0], x1 = pts[pts.length - 1][0]
        let y0 = Infinity, y1 = -Infinity, sum = 0
        for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); sum += p[1] }
        const W = 800, H = 220, padL = 44, padB = 24
        const sx = x => padL + (x - x0) / ((x1 - x0) || 1) * (W - padL - 8), sy = y => 8 + (1 - (y - y0) / ((y1 - y0) || 1)) * (H - padB - 8)
        const step = Math.max(1, Math.floor(pts.length / 2000))
        let d = ''
        for (let k = 0; k < pts.length; k += step) d += (d ? 'L' : 'M') + sx(pts[k][0]).toFixed(1) + ' ' + sy(pts[k][1]).toFixed(1)
        const long = x1 - x0 >= 3600_000
        const fmtX = s.time ? v => { const sec = Math.round((v - x0) / 1000); return long ? `${Math.floor(sec / 3600)}:${String(Math.floor(sec % 3600 / 60)).padStart(2, '0')}` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` } : v => String(Math.round(v))
        const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => x0 + f * (x1 - x0))
        const svg = `<svg viewBox="0 0 ${W} ${H}" class="ur-chart" role="img"><g fill="${fg}" font-size="11" opacity="0.7">
            <text x="${padL - 6}" y="14" text-anchor="end">${Math.round(y1)}</text><text x="${padL - 6}" y="${H - padB}" text-anchor="end">${Math.round(y0)}</text>
            ${ticks.map(v => `<text x="${sx(v)}" y="${H - 6}" text-anchor="middle">${fmtX(v)}</text>`).join('')}</g>
            <line x1="${padL}" x2="${W}" y1="${H - padB}" y2="${H - padB}" stroke="${fg}" opacity="0.2"/>
            <path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.5"/></svg>`
        wrap.append(el('section', '', `<h3>${esc(s.name)}</h3><div class="ur-meta">Среднее: ${Math.round(sum / pts.length)} ${esc(s.unit)} · минимум ${Math.round(y0)} · максимум ${Math.round(y1)}</div>${svg}`))
    }
    if (!wrap.querySelector('svg')) throw new ReaderError('В файле нет данных для графика.')
    return wrap
}
export const parsePwx = text => {
    const d = xmlDoc(text, 'тренировку PWX')
    const start = Date.parse(d.querySelector('workout > time')?.textContent ?? '') || 0
    const S = { hr: [], spd: [], pwr: [], cad: [], alt: [] }
    const coords = []
    for (const s of d.getElementsByTagName('sample')) {
        const t = start + +txt(s, 'timeoffset') * 1000
        for (const k of Object.keys(S)) { const v = txt(s, k); if (v !== '') S[k].push([t, +v]) }
        const lat = txt(s, 'lat'), lon = txt(s, 'lon')
        if (lat && lon) coords.push([+lon, +lat, txt(s, 'alt') ? +txt(s, 'alt') : undefined, t])
    }
    const series = [['hr', 'Пульс', 'уд/мин', '#e6194b'], ['pwr', 'Мощность', 'Вт', '#f58231'], ['spd', 'Скорость', 'км/ч', '#4363d8', 3.6], ['cad', 'Каденс', 'об/мин', '#3cb44b'], ['alt', 'Высота', 'м', '#911eb4']]
        .filter(([k]) => S[k].length > 1).map(([k, name, unit, color, mul = 1]) => ({ name, unit, color, time: true, points: S[k].map(p => [p[0], p[1] * mul]) }))
    return { series, title: d.querySelector('workout > title')?.textContent ?? d.querySelector('sportType')?.textContent ?? '', feats: coords.length > 1 ? [{ kind: 'line', coords, track: true, name: 'Тренировка' }] : [] }
}
export const parseHrm = text => {
    const sec = {}
    let cur = ''
    for (const l of text.replace(/\r/g, '').split('\n')) { const m = /^\[(\w+)\]/.exec(l.trim()); if (m) { cur = m[1]; sec[cur] = []; continue } if (cur) sec[cur].push(l) }
    if (!sec.HRData) throw new ReaderError('В файле Polar нет записи пульса.')
    const params = Object.fromEntries((sec.Params ?? []).map(l => l.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]))
    const step = (+params.Interval || 1) * 1000
    const [y, mo, d] = /^(\d{4})(\d{2})(\d{2})/.exec(params.Date ?? '')?.slice(1) ?? []
    const [h, mi, s] = (params.StartTime ?? '0:0:0').split(':').map(parseFloat)
    const t0 = y ? Date.UTC(+y, +mo - 1, +d, h || 0, mi || 0, s || 0) : 0
    const smode = params.SMode ?? ''
    const cols = sec.HRData.map(l => l.trim()).filter(Boolean).map(l => l.split(/\s+/).map(Number))
    const series = [{ name: 'Пульс', unit: 'уд/мин', color: '#e6194b', time: true, points: cols.map((c, i) => [t0 + i * step, c[0]]) }]
    // SMode: скорость, каденс, высота, мощность… (по флагам)
    let k = 1
    if (smode[0] === '1') { series.push({ name: 'Скорость', unit: 'км/ч', color: '#4363d8', time: true, points: cols.map((c, i) => [t0 + i * step, c[k] / 10]) }); k++ }
    if (smode[1] === '1') { series.push({ name: 'Каденс', unit: 'об/мин', color: '#3cb44b', time: true, points: cols.map((c, i) => [t0 + i * step, c[k]]) }); k++ }
    if (smode[2] === '1') { series.push({ name: 'Высота', unit: 'м', color: '#911eb4', time: true, points: cols.map((c, i) => [t0 + i * step, c[k]]) }); k++ }
    if (smode[3] === '1') { series.push({ name: 'Мощность', unit: 'Вт', color: '#f58231', time: true, points: cols.map((c, i) => [t0 + i * step, c[k]]) }); k++ }
    return { series: series.filter(s => s.points.some(p => p[1] > 0)), title: params.Date ? `Тренировка ${d}.${mo}.${y}` : '' }
}

// ================= Плейлисты ASX, WPL, ZPL =================
export const parseXmlPlaylist = (text, ext) => {
    const tracks = []
    let title = ''
    if (ext === 'asx') {
        const d = new DOMParser().parseFromString(text, 'text/html') // ASX часто «грязный» XML, теги в любом регистре
        title = d.querySelector('asx > title')?.textContent?.trim() ?? ''
        for (const e of d.querySelectorAll('entry')) tracks.push({ title: e.querySelector('title')?.textContent?.trim(), artist: e.querySelector('author')?.textContent?.trim(), file: e.querySelector('ref')?.getAttribute('href') })
    } else {
        const d = xmlDoc(text, 'плейлист')
        title = d.querySelector('head > title')?.textContent?.trim() ?? ''
        for (const m of d.getElementsByTagName('media')) {
            const src = m.getAttribute('src') ?? ''
            tracks.push({ title: m.getAttribute('trackTitle') || decodeURIComponent(src.split(/[\\/]/).pop() || src), artist: m.getAttribute('trackArtist') ?? '', album: m.getAttribute('albumTitle') ?? '', dur: m.getAttribute('duration') ? +m.getAttribute('duration') / 1000 : null, file: src })
        }
    }
    return { title, tracks }
}

// ================= Проекты Reaper (.rpp) =================
export const rppView = text => {
    if (!/^\s*<REAPER_PROJECT/.test(text)) throw new ReaderError('Это не проект Reaper.')
    const tracks = []
    let cur = null, item = null, depth = 0
    for (const raw of text.split(/\r?\n/)) {
        const l = raw.trim()
        if (l.startsWith('<')) {
            depth++
            const tag = l.slice(1).split(/\s/)[0]
            if (tag === 'TRACK') { cur = { name: '', items: [], depth }; tracks.push(cur) }
            else if (tag === 'ITEM' && cur) { item = { name: '', file: '', pos: 0, len: 0 }; cur.items.push(item) }
            continue
        }
        if (l === '>') { if (item && depth === cur?.depth + 1) item = null; if (cur && depth === cur.depth) cur = null; depth--; continue }
        const m = /^(\w+)\s+(.*)$/.exec(l); if (!m) continue
        const val = m[2].replace(/^"(.*)"$/, '$1')
        if (item) { if (m[1] === 'NAME') item.name = val; else if (m[1] === 'FILE') item.file = val; else if (m[1] === 'POSITION') item.pos = +val; else if (m[1] === 'LENGTH') item.len = +val }
        else if (cur && m[1] === 'NAME') cur.name = val
    }
    const tempo = /^\s*TEMPO\s+([\d.]+)\s+(\d+)\s+(\d+)/m.exec(text)
    const t = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
    const files = [...new Set(tracks.flatMap(tr => tr.items.map(i => i.file)).filter(Boolean))]
    return el('div', 'ur-rpp', `<h2>Проект Reaper</h2><div class="ur-meta">${tempo ? `Темп ${+tempo[1]} BPM, размер ${tempo[2]}/${tempo[3]} · ` : ''}Дорожек: ${tracks.length} · звуковых файлов: ${files.length}</div>
        ${tracks.map((tr, i) => `<h3>${i + 1}. ${esc(tr.name || 'Без названия')}</h3>${tr.items.length ? `<table class="ur-font-facts">${tr.items.map(it => `<tr><td>${t(it.pos)}–${t(it.pos + it.len)}</td><td>${esc(it.name)}</td><td class="ur-muted">${esc(it.file.split(/[\\/]/).pop())}</td></tr>`).join('')}</table>` : '<p class="ur-muted">Пустая дорожка</p>'}`).join('')}
        ${files.length ? `<h3>Файлы проекта</h3><ul>${files.map(f => `<li><code>${esc(f)}</code></li>`).join('')}</ul>` : ''}`)
}

// ================= MPEG-DASH (.mpd) =================
export const mpdView = text => {
    const d = xmlDoc(text, 'описание потока MPEG-DASH')
    const mpd = d.documentElement
    if (mpd.localName !== 'MPD') throw new ReaderError('Это не описание потока MPEG-DASH.')
    const dur = mpd.getAttribute('mediaPresentationDuration')
    const iso = s => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/.exec(s ?? ''); return m ? `${m[1] ? m[1] + ' ч ' : ''}${m[2] ? m[2] + ' мин ' : ''}${m[3] ? Math.round(+m[3]) + ' с' : ''}` : '' }
    const rows = []
    for (const as of d.getElementsByTagName('AdaptationSet')) {
        const kind = (as.getAttribute('mimeType') || as.getAttribute('contentType') || '').split('/')[0]
        for (const r of kids(as, 'Representation')) {
            const mime = r.getAttribute('mimeType') || as.getAttribute('mimeType') || ''
            const k = (mime.split('/')[0] || kind)
            rows.push([k === 'video' ? 'Видео' : k === 'audio' ? 'Звук' : k === 'text' ? 'Субтитры' : k || '—', r.getAttribute('width') ? `${r.getAttribute('width')}×${r.getAttribute('height')}` : '', r.getAttribute('bandwidth') ? `${Math.round(+r.getAttribute('bandwidth') / 1000)} кбит/с` : '', r.getAttribute('codecs') || as.getAttribute('codecs') || '', as.getAttribute('lang') || ''])
        }
    }
    return el('div', '', `<h2>Поток MPEG-DASH</h2><div class="ur-meta">${mpd.getAttribute('type') === 'dynamic' ? 'Прямая трансляция' : 'Запись'}${dur ? ' · длительность ' + iso(dur) : ''} · вариантов: ${rows.length}</div>
        <p class="ur-muted">Это не само видео, а описание потока: какие качества и дорожки есть на сервере.</p>
        <table class="ur-font-facts"><tr><th>Дорожка</th><th>Размер</th><th>Поток</th><th>Кодек</th><th>Язык</th></tr>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`)
}

// ================= Закодированные файлы: UUE, XXE, Base64, BinHex =================
const UU = c => (c - 32) & 63
const XX = (() => { const t = new Int8Array(128).fill(-1); '+-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('').forEach((ch, i) => { t[ch.charCodeAt(0)] = i }); return c => t[c] & 63 })()
const uuDecode = (lines, map) => {
    const out = []
    for (const l of lines) {
        if (!l.length) continue
        const n = map(l.charCodeAt(0))
        if (n === 0) break
        const b = []
        for (let i = 1; i + 3 < l.length + 3; i += 4) {
            const c = [0, 1, 2, 3].map(k => map((l.charCodeAt(i + k) || 32)))
            b.push((c[0] << 2) | (c[1] >> 4), ((c[1] & 15) << 4) | (c[2] >> 2), ((c[2] & 3) << 6) | c[3])
        }
        out.push(...b.slice(0, n))
    }
    return new Uint8Array(out)
}
const binhex = text => {
    const start = text.indexOf(':', text.indexOf('(This file must be converted with BinHex'))
    const s0 = start >= 0 ? start : text.indexOf(':')
    const end = text.indexOf(':', s0 + 1)
    const body = text.slice(s0 + 1, end).replace(/\s/g, '')
    const A = '!"#$%&\'()*+,-012345689@ABCDEFGHIJKLMNPQRSTUVXYZ[`abcdefhijklmpqr'
    const bits = []
    let acc = 0, n = 0
    for (const ch of body) { const v = A.indexOf(ch); if (v < 0) continue; acc = (acc << 6) | v; n += 6; if (n >= 8) { n -= 8; bits.push((acc >> n) & 255) } }
    // RLE: 0x90 n — повтор предыдущего байта
    const raw = []
    for (let i = 0; i < bits.length; i++) {
        if (bits[i] === 0x90) { const cnt = bits[++i]; if (cnt === 0) raw.push(0x90); else for (let k = 1; k < cnt; k++) raw.push(raw[raw.length - 1]) }
        else raw.push(bits[i])
    }
    const u = new Uint8Array(raw), dv = new DataView(u.buffer)
    const nl = u[0], name = latin.decode(u.subarray(1, 1 + nl))
    let p = 1 + nl + 1 + 4 + 4 + 2
    const dlen = dv.getUint32(p), rlen = dv.getUint32(p + 4); p += 10
    const data = u.slice(p, p + dlen)
    const rsrc = u.slice(p + dlen + 2, p + dlen + 2 + rlen)
    return { name, data, rsrc }
}
export const openEncoded = (buf, ext, fileName) => {
    const text = latin.decode(new Uint8Array(buf))
    const files = []
    if (ext === 'hqx' || /\(This file must be converted with BinHex/.test(text)) {
        const r = binhex(text)
        files.push({ name: r.name || 'файл', bytes: r.data })
        if (r.rsrc.length) files.push({ name: (r.name || 'файл') + ' [ресурсы Mac]', bytes: r.rsrc })
    } else if (/^begin(-base64)? [0-7]{3,4} /m.test(text)) {
        const re = /^begin(-base64)? [0-7]{3,4} (.+)\r?\n([\s\S]*?)^end/gm
        let m
        while ((m = re.exec(text))) {
            const lines = m[3].split(/\r?\n/)
            if (m[1]) { const bin = atob(lines.filter(l => l !== '====').join('')); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); files.push({ name: m[2].trim(), bytes: u }) }
            else {
                const isXX = ext === 'xxe' || lines.some(l => /^h/.test(l) && l.length === 61)
                files.push({ name: m[2].trim(), bytes: uuDecode(lines, isXX ? XX : UU) })
            }
        }
    } else {
        // просто Base64 (возможно, с заголовком data:… или строками PEM)
        const body = text.replace(/^data:[^,]*,/, '').replace(/-----[^-]+-----/g, '').replace(/[^A-Za-z0-9+/=_-]/g, '').replace(/-/g, '+').replace(/_/g, '/')
        let bin
        try { bin = atob(body + '==='.slice((body.length + 3) % 4)) } catch { throw new ReaderError('Это не данные Base64.') }
        const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
        files.push({ name: fileName.replace(/\.(b64|base64)$/i, '') || 'файл', bytes: u })
    }
    if (!files.length) throw new ReaderError('В файле не найдено закодированных данных.')
    const map = new Map(files.map(f => [f.name, f.bytes]))
    return { entries: files.map(f => ({ name: f.name, size: f.bytes.length })), getBytes: async n => map.get(n), info: `<p class="ur-muted">Файл закодирован текстом (${ext === 'hqx' ? 'BinHex' : ext === 'xxe' ? 'XXEncode' : ext === 'b64' ? 'Base64' : 'UUEncode'}) — так раньше пересылали файлы по почте. Внутри:</p>` }
}

// ================= Метрики шрифтов: AFM, PFM =================
export const fontMetricsView = (buf, ext) => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const facts = [], widths = []
    if (ext === 'afm' || latin.decode(u8.subarray(0, 16)).startsWith('StartFontMetrics')) {
        const t = decodeText(buf)
        const g = k => new RegExp(`^${k}\\s+(.+)$`, 'm').exec(t)?.[1]?.trim()
        facts.push(['Шрифт', g('FullName') || g('FontName')], ['Семейство', g('FamilyName')], ['Насыщенность', g('Weight')], ['Наклон', g('ItalicAngle')], ['Высота прописных', g('CapHeight')], ['Высота строчных', g('XHeight')], ['Подъём / спуск', [g('Ascender'), g('Descender')].filter(Boolean).join(' / ')], ['Моноширинный', g('IsFixedPitch') === 'true' ? 'да' : g('IsFixedPitch') ? 'нет' : ''], ['Кодировка', g('EncodingScheme')], ['Авторские права', g('Notice')], ['Версия', g('Version')])
        for (const m of t.matchAll(/^C\s+(-?\d+)\s*;\s*WX\s+(\d+)\s*;\s*N\s+([\w.]+)/gm)) widths.push([+m[1], m[3], +m[2]])
        const kern = (/StartKernPairs\s+(\d+)/.exec(t) ?? [])[1]
        if (kern) facts.push(['Кернинговых пар', kern])
    } else {
        if (dv.getUint16(0, true) !== 0x100 && dv.getUint16(0, true) !== 0x200) throw new ReaderError('Это не файл метрик PFM.')
        const cstrAt = o => { const z = u8.indexOf(0, o); return latin.decode(u8.subarray(o, z < 0 ? o + 60 : z)) }
        const face = dv.getUint32(105, true), devName = dv.getUint32(101, true)
        facts.push(['Шрифт', face ? cstrAt(face) : ''], ['Авторские права', latin.decode(u8.subarray(6, 66)).replace(/\0.*$/s, '')], ['Размер (пунктов)', dv.getUint16(68, true)], ['Насыщенность', dv.getUint16(83, true)], ['Курсив', u8[80] ? 'да' : 'нет'], ['Устройство', devName ? cstrAt(devName) : ''])
        const first = u8[95], last = u8[96]
        const ext2 = dv.getUint16(117, true) // dfSizeFields
        const extTable = ext2 >= 30 && u8.length > 147 + 4 ? dv.getUint32(123, true) : 0
        if (extTable && extTable + (last - first + 1) * 2 <= u8.length) for (let c = first; c <= last; c++) widths.push([c, '', dv.getUint16(extTable + (c - first) * 2, true)])
    }
    const wrap = el('div', '', `<h2>Метрики шрифта ${ext.toUpperCase()}</h2><p class="ur-muted">Это не сам шрифт, а его размеры: ширины знаков, высоты, кернинг. Сам шрифт обычно лежит рядом (.pfb).</p>${factsTable(facts)}`)
    if (widths.length) {
        wrap.append(el('h3', '', `Ширины знаков (${widths.length})`))
        wrap.append(el('div', 'ur-afm-grid', widths.slice(0, 600).map(([c, n, w]) => `<span title="${esc(n)}"><b>${c >= 32 && c < 127 ? esc(String.fromCharCode(c)) : c >= 0 ? '#' + c : esc(n)}</b> ${w}</span>`).join('')))
    }
    return wrap
}

// ================= Видео и звук, которые играет браузер =================
export const mediaPlayerView = (url, ext) => {
    const audio = ext === 'aac'
    const m = document.createElement(audio ? 'audio' : 'video')
    m.controls = true; m.src = url; m.preload = 'metadata'; m.className = 'ur-media'
    const wrap = el('div', 'ur-media-wrap'); wrap.append(m)
    const note = el('p', 'ur-muted', '')
    m.addEventListener('error', () => { note.textContent = 'Встроенный проигрыватель не умеет кодек этого файла (так бывает со старыми видео с телефонов).' })
    m.addEventListener('loadedmetadata', () => { const d = m.duration; if (isFinite(d)) note.textContent = `Длительность: ${Math.floor(d / 60)} мин ${Math.round(d % 60)} с${m.videoWidth ? ` · ${m.videoWidth}×${m.videoHeight}` : ''}` })
    wrap.append(note)
    return wrap
}

// ================= Обрезки текста macOS (.textClipping) =================
export const textClippingText = obj => {
    const d = obj?.['UTI-Data'] ?? obj
    const pick = k => d?.[k]
    const u8 = pick('public.utf8-plain-text'), u16 = pick('public.utf16-plain-text'), url = pick('public.url')
    if (u8 instanceof Uint8Array) return utf8.decode(u8)
    if (typeof u8 === 'string') return u8
    if (u16 instanceof Uint8Array) return new TextDecoder('utf-16le').decode(u16)
    if (url instanceof Uint8Array) return utf8.decode(url)
    if (typeof url === 'string') return url
    throw new ReaderError('В обрезке нет текста.')
}
