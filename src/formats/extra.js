// Архивы, шрифты, иконки, HEIC, PSD, SQLite, ноты ABC, Mermaid, двоичный plist
import JSZip from 'jszip'
import { escapeHtml as esc, decodeText, parseTar, sniffArchive, isImageName, extOf, MIME, imageDataToUrl, canvasToUrl, ReaderError, naturalCompare } from '../util.js'

import { fmtSize } from './archives.js'

export { openArchive, archiveList, archivePreview } from './archives.js'

// ================= Шрифты =================
const SAMPLE = 'Съешь же ещё этих мягких французских булок, да выпей чаю. The quick brown fox jumps over the lazy dog. 0123456789'
export const fontView = async (ctx, buf, ext, fileName) => {
    const family = 'ur-font-' + Math.random().toString(36).slice(2)
    const face = new FontFace(family, buf)
    await face.load()
    document.fonts.add(face)
    ctx.cleanups.push(() => document.fonts.delete(face))
    let info = null
    if (ext !== 'woff2') { try { const { parse } = await ctx.loadLib('opentype'); info = parse(buf) } catch (e) { console.warn('[Читалка] opentype', e) } }
    // в opentype.js 2.x названия лежат по платформам (windows, macintosh, unicode)
    const nm = k => {
        const n = info?.names
        const v = n?.[k] ?? n?.windows?.[k] ?? n?.macintosh?.[k] ?? n?.unicode?.[k]
        return v ? (v.ru || v.en || Object.values(v)[0]) : ''
    }
    const wrap = document.createElement('div')
    const title = nm('fullName') || nm('fontFamily') || fileName
    const facts = [['Семейство', nm('fontFamily')], ['Начертание', nm('fontSubfamily')], ['Версия', nm('version')], ['Автор', nm('designer') || nm('manufacturer')], ['Лицензия', nm('license')], ['Символов', info ? String(info.glyphs.length) : '']].filter(x => x[1])
    wrap.innerHTML = `<h2>${esc(title)}</h2>${facts.length ? `<table class="ur-font-facts">${facts.map(([k, v]) => `<tr><td class="ur-muted">${k}</td><td>${esc(String(v).slice(0, 300))}</td></tr>`).join('')}</table>` : ''}`
    const samples = document.createElement('div')
    samples.className = 'ur-font-samples'
    for (const size of [12, 16, 20, 28, 40, 64]) {
        const row = document.createElement('div')
        row.innerHTML = `<span class="ur-muted">${size}</span>`
        const t = document.createElement('div')
        t.style.fontFamily = `"${family}"`; t.style.fontSize = size + 'px'
        t.textContent = SAMPLE
        row.append(t)
        samples.append(row)
    }
    wrap.append(samples)
    // таблица символов
    let chars = []
    if (info) {
        const set = new Set()
        for (let i = 0; i < info.glyphs.length && set.size < 3000; i++) { const g = info.glyphs.get(i); for (const u of g.unicodes ?? (g.unicode != null ? [g.unicode] : [])) if (u > 32) set.add(u) }
        chars = [...set].sort((a, b) => a - b)
    } else {
        for (const [a, b] of [[0x21, 0x7E], [0xA0, 0xFF], [0x400, 0x45F], [0x2010, 0x203A]]) for (let c = a; c <= b; c++) chars.push(c)
    }
    const grid = document.createElement('div')
    grid.className = 'ur-glyphs'
    grid.style.fontFamily = `"${family}"`
    grid.innerHTML = `<h3 style="font-family: var(--font-interface)">Символы${info ? '' : ' (основные наборы, проверка наличия недоступна для WOFF2)'}</h3>` + chars.map(c => `<span title="U+${c.toString(16).toUpperCase().padStart(4, '0')}">${esc(String.fromCodePoint(c))}</span>`).join('')
    wrap.append(grid)
    return wrap
}

// ================= Иконки .ico =================
export const icoView = buf => {
    const dv = new DataView(buf)
    const u8 = new Uint8Array(buf)
    if (dv.getUint16(0, true) !== 0 || ![1, 2].includes(dv.getUint16(2, true))) throw new ReaderError('Это не файл иконки ICO.')
    const count = dv.getUint16(4, true)
    const wrap = document.createElement('div')
    wrap.innerHTML = `<div class="ur-meta">Размеров в файле: ${count}</div>`
    const grid = document.createElement('div')
    grid.className = 'ur-ico-grid'
    for (let i = 0; i < count; i++) {
        const e = 6 + i * 16
        const w = u8[e] || 256, h = u8[e + 1] || 256, bpp = dv.getUint16(e + 6, true)
        const size = dv.getUint32(e + 8, true), off = dv.getUint32(e + 12, true)
        const data = u8.subarray(off, off + size)
        let blob
        if (data[0] === 0x89 && data[1] === 0x50) blob = new Blob([data], { type: 'image/png' })
        else {
            // собираем отдельный .ico из одной картинки — браузер его покажет
            const one = new Uint8Array(22 + size)
            one.set(u8.subarray(0, 6)); new DataView(one.buffer).setUint16(4, 1, true)
            one.set(u8.subarray(e, e + 12), 6); new DataView(one.buffer).setUint32(18, 22, true)
            one.set(data, 22)
            blob = new Blob([one], { type: 'image/x-icon' })
        }
        const cell = document.createElement('figure')
        const img = document.createElement('img')
        img.src = URL.createObjectURL(blob)
        img.style.width = w + 'px'; img.style.height = h + 'px'
        cell.append(img)
        cell.insertAdjacentHTML('beforeend', `<figcaption>${w}×${h}${bpp ? `, ${bpp} бит` : ''}</figcaption>`)
        grid.append(cell)
    }
    wrap.append(grid)
    return wrap
}

// ================= HEIC/HEIF (фото iPhone) =================
export const openHeic = async (ctx, buf) => {
    const { get } = await ctx.loadLib('heic')
    const libheif = await get()
    const decoder = new libheif.HeifDecoder()
    const images = decoder.decode(new Uint8Array(buf))
    if (!images?.length) throw new ReaderError('Не удалось прочитать фото HEIC.')
    const cache = new Map()
    return {
        count: images.length,
        async getPage(i) {
            if (cache.has(i)) return cache.get(i)
            const img = images[i]
            const width = img.get_width(), height = img.get_height()
            const p = new Promise((res, rej) => img.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, d => d ? res(imageDataToUrl(new ImageData(d.data, width, height))) : rej(new Error('HEIC: ошибка декодирования'))))
            cache.set(i, p)
            return p
        },
        destroy() { for (const p of cache.values()) p.then(x => URL.revokeObjectURL(x.url)).catch(() => {}); try { images.forEach(im => im.free?.()) } catch { /* ignore */ } },
    }
}

// ================= PSD =================
export const openPsd = async (ctx, buf) => {
    const { readPsd } = await ctx.loadLib('psd')
    const psd = readPsd(buf, { skipLayerImageData: true, skipThumbnail: true })
    if (!psd.canvas) throw new ReaderError('В файле PSD нет готового изображения (его сохранили без «максимальной совместимости»).')
    const url = await canvasToUrl(psd.canvas, 'image/png')
    const layers = items => (items || []).slice().reverse().map(l => ({ label: (l.name || 'Слой') + (l.hidden ? ' (скрыт)' : ''), target: 0, subitems: layers(l.children) }))
    return {
        count: 1,
        toc: [{ label: `Слои (${psd.width}×${psd.height})`, target: 0, subitems: layers(psd.children) }],
        getPage: async () => ({ url, width: psd.width, height: psd.height }),
        destroy() { URL.revokeObjectURL(url) },
    }
}

// ================= SQLite =================
export const readSqlite = async (ctx, buf) => {
    const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, 16))
    if (head !== 'SQLite format 3\0') throw new ReaderError('Это не база данных SQLite (например, служебный файл Windows Thumbs.db).')
    const { initSqlJs } = await ctx.loadLib('sqlite')
    const SQL = await initSqlJs()
    const db = new SQL.Database(new Uint8Array(buf))
    try {
        const LIMIT = 5000
        const tables = db.exec("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name")[0]?.values ?? []
        if (!tables.length) throw new ReaderError('В базе нет таблиц.')
        return tables.map(([name, type]) => {
            const q = `"${String(name).replace(/"/g, '""')}"`
            let total = 0
            try { total = db.exec(`SELECT COUNT(*) FROM ${q}`)[0].values[0][0] } catch { /* представление может не считаться */ }
            const res = db.exec(`SELECT * FROM ${q} LIMIT ${LIMIT}`)[0]
            const cols = res?.columns ?? (db.exec(`PRAGMA table_info(${q})`)[0]?.values ?? []).map(r => r[1])
            const fmt = v => v == null ? '' : v instanceof Uint8Array ? `[данные, ${fmtSize(v.length)}]` : String(v)
            const rows = [cols, ...(res?.values ?? []).map(r => r.map(fmt))]
            return { name: `${type === 'view' ? '👁 ' : ''}${name} (${total > LIMIT ? `первые ${LIMIT} из ${total}` : total})`, rows }
        })
    } finally { db.close() }
}

// ================= Ноты ABC =================
export const abcView = async (ctx, text) => {
    const abcjs = await ctx.loadLib('abc')
    const wrap = document.createElement('div')
    const tunes = Math.max(1, (text.match(/^X:/gm) || []).length)
    const divs = Array.from({ length: tunes }, () => { const d = document.createElement('div'); d.className = 'ur-abc-tune'; wrap.append(d); return d })
    // abcjs измеряет текст, поэтому рисуем после попадания в документ
    requestAnimationFrame(() => {
        try { abcjs.renderAbc(divs, text, { responsive: 'resize', foregroundColor: ctx.themeColors().text, add_classes: true }) }
        catch (e) { wrap.textContent = 'Ошибка в нотах: ' + (e?.message || e) }
    })
    return wrap
}

// ================= Mermaid и Markdown =================
export const mermaidView = async (ctx, text) => {
    const div = document.createElement('div')
    await ctx.renderMarkdown('```mermaid\n' + text + '\n```', div, ctx.file?.path ?? '')
    return div
}
export const markdownView = async (ctx, text, assets) => {
    const div = document.createElement('div')
    div.className = 'markdown-rendered'
    await ctx.renderMarkdown(text, div, ctx.file?.path ?? '')
    if (assets?.size) for (const img of div.querySelectorAll('img')) { const u = assets.get(img.getAttribute('src')); if (u) img.src = u }
    return div
}

// ================= Двоичный plist (macOS) -> JSON =================
export const parseBplistObj = buf => {
    const u8 = new Uint8Array(buf)
    const dv = new DataView(buf)
    const t = u8.length - 32
    const offSize = u8[t + 6], refSize = u8[t + 7]
    const num = Number(dv.getBigUint64(t + 8)), top = Number(dv.getBigUint64(t + 16)), tableOff = Number(dv.getBigUint64(t + 24))
    const readN = (p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + u8[p + i]; return v }
    const offsets = Array.from({ length: num }, (_, i) => readN(tableOff + i * offSize, offSize))
    const obj = (idx, depth = 0) => {
        if (depth > 100) return null
        let p = offsets[idx]
        const m = u8[p], hi = m >> 4, lo = m & 0xF
        const count = () => { if (lo !== 0xF) { p += 1; return lo } const ib = u8[p + 1] & 0xF; const n = readN(p + 2, 1 << ib); p += 2 + (1 << ib); return n }
        switch (hi) {
            case 0x0: return lo === 0x8 ? false : lo === 0x9 ? true : null
            case 0x1: { const n = 1 << lo; return n === 8 ? Number(dv.getBigInt64(p + 1)) : readN(p + 1, n) }
            case 0x2: return lo === 2 ? dv.getFloat32(p + 1) : dv.getFloat64(p + 1)
            case 0x3: return new Date(Date.UTC(2001, 0, 1) + dv.getFloat64(p + 1) * 1000).toISOString()
            case 0x4: { const n = count(); return u8.slice(p, p + n) }
            case 0x5: { const n = count(); return new TextDecoder('latin1').decode(u8.subarray(p, p + n)) }
            case 0x6: { const n = count(); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(p + i * 2)); return s }
            case 0x8: return { UID: readN(p + 1, lo + 1) }
            case 0xA: case 0xC: { const n = count(); return Array.from({ length: n }, (_, i) => obj(readN(p + i * refSize, refSize), depth + 1)) }
            case 0xD: { const n = count(); const o = {}; for (let i = 0; i < n; i++) o[String(obj(readN(p + i * refSize, refSize), depth + 1))] = obj(readN(p + (n + i) * refSize, refSize), depth + 1); return o }
        }
        return null
    }
    return obj(top)
}
export const parseBplist = buf => JSON.stringify(parseBplistObj(buf), (k, v) => v instanceof Uint8Array ? `<данные, ${v.length} байт>` : v, 2)
