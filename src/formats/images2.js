// Редкие картинки: Netpbm, QOI, TGA, PCX, WBMP, XBM, XPM, курсоры и анимированные курсоры, значки macOS,
// HDR/EXR (с экспозицией), DDS, FITS, EMF/WMF, превью RAW, Krita/OpenRaster, JPEG XL
import JSZip from 'jszip'
import { escapeHtml as esc, ReaderError, canvasToUrl, MIME, extOf } from '../util.js'

const latin = new TextDecoder('latin1')

// RGBA -> страница для PagesRenderer
export const rgbaToPage = async (w, h, rgba, png = true) => {
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    c.getContext('2d').putImageData(new ImageData(rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0)
    return { url: await canvasToUrl(c, png ? 'image/png' : 'image/jpeg'), width: w, height: h }
}
export const pagesOf = (pages, toc) => ({
    count: pages.length,
    toc,
    getPage: async i => (typeof pages[i] === 'function' ? (pages[i] = await pages[i]()) : pages[i]),
    destroy() { for (const p of pages) if (p?.url) URL.revokeObjectURL(p.url) },
})
export const blobPage = (bytes, type) => new Promise((res, rej) => {
    const url = URL.createObjectURL(new Blob([bytes], { type }))
    const img = new Image()
    img.onload = () => res({ url, width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => { URL.revokeObjectURL(url); rej(new ReaderError('Браузер не смог показать эту картинку.')) }
    img.src = url
})

// ---------- Netpbm: PBM, PGM, PPM, PNM, PAM ----------
const decodeNetpbm = u8 => {
    const magic = latin.decode(u8.subarray(0, 2))
    let p = 2
    const tok = () => {
        while (p < u8.length) {
            const c = u8[p]
            if (c === 35) { while (p < u8.length && u8[p] !== 10) p++ } else if (c <= 32) p++
            else break
        }
        const s = p
        while (p < u8.length && u8[p] > 32) p++
        return latin.decode(u8.subarray(s, p))
    }
    let w, h, max = 1, ch = 1, tuple = ''
    if (magic === 'P7') {
        const head = {}
        while (true) {
            let e = u8.indexOf(10, p); const line = latin.decode(u8.subarray(p, e)).trim(); p = e + 1
            if (line === 'ENDHDR') break
            const [k, ...v] = line.split(/\s+/); if (k && !k.startsWith('#')) head[k] = v.join(' ')
        }
        w = +head.WIDTH; h = +head.HEIGHT; ch = +head.DEPTH; max = +head.MAXVAL; tuple = head.TUPLTYPE || ''
    } else {
        w = +tok(); h = +tok()
        if (!['P1', 'P4'].includes(magic)) max = +tok()
        ch = ['P3', 'P6'].includes(magic) ? 3 : 1
        p++
    }
    if (!w || !h) throw new ReaderError('Повреждённый файл Netpbm.')
    const out = new Uint8ClampedArray(w * h * 4)
    const ascii = ['P1', 'P2', 'P3'].includes(magic)
    const wide = max > 255
    const scale = v => Math.round(v * 255 / max)
    let q = p
    const next = () => { if (ascii) return +tok(); if (wide) { const v = (u8[q] << 8) | u8[q + 1]; q += 2; return v } return u8[q++] }
    if (ascii) p = q
    for (let i = 0; i < w * h; i++) {
        const o = i * 4
        if (magic === 'P1') { const v = +tok(); out[o] = out[o + 1] = out[o + 2] = v ? 0 : 255; out[o + 3] = 255; continue }
        if (magic === 'P4') {
            const rowBytes = Math.ceil(w / 8), x = i % w, y = Math.floor(i / w)
            const bit = (u8[p + y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1
            out[o] = out[o + 1] = out[o + 2] = bit ? 0 : 255; out[o + 3] = 255; continue
        }
        if (ch === 1 || ch === 2) { const v = scale(next()); out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = ch === 2 ? scale(next()) : 255 }
        else { out[o] = scale(next()); out[o + 1] = scale(next()); out[o + 2] = scale(next()); out[o + 3] = ch === 4 ? scale(next()) : 255 }
        if (ascii) q = p
    }
    if (tuple === 'BLACKANDWHITE') for (let i = 0; i < w * h; i++) { const v = out[i * 4] ? 255 : 0; out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v }
    return { w, h, rgba: out }
}

// ---------- QOI ----------
const decodeQoi = u8 => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    if (latin.decode(u8.subarray(0, 4)) !== 'qoif') throw new ReaderError('Это не картинка QOI.')
    const w = dv.getUint32(4), h = dv.getUint32(8)
    const out = new Uint8ClampedArray(w * h * 4)
    const idx = new Uint8Array(256)
    let r = 0, g = 0, b = 0, a = 255, run = 0, p = 14
    for (let o = 0; o < out.length; o += 4) {
        if (run > 0) run--
        else {
            const b1 = u8[p++]
            if (b1 === 0xFE) { r = u8[p++]; g = u8[p++]; b = u8[p++] }
            else if (b1 === 0xFF) { r = u8[p++]; g = u8[p++]; b = u8[p++]; a = u8[p++] }
            else if ((b1 & 0xC0) === 0x00) { const i = b1 * 4; r = idx[i]; g = idx[i + 1]; b = idx[i + 2]; a = idx[i + 3] }
            else if ((b1 & 0xC0) === 0x40) { r = (r + ((b1 >> 4) & 3) - 2) & 255; g = (g + ((b1 >> 2) & 3) - 2) & 255; b = (b + (b1 & 3) - 2) & 255 }
            else if ((b1 & 0xC0) === 0x80) { const b2 = u8[p++]; const vg = (b1 & 0x3F) - 32; r = (r + vg - 8 + ((b2 >> 4) & 15)) & 255; g = (g + vg) & 255; b = (b + vg - 8 + (b2 & 15)) & 255 }
            else run = b1 & 0x3F
            const i = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4
            idx[i] = r; idx[i + 1] = g; idx[i + 2] = b; idx[i + 3] = a
        }
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a
    }
    return { w, h, rgba: out }
}

// ---------- TGA ----------
const decodeTga = u8 => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    const idLen = u8[0], cmType = u8[1], type = u8[2]
    const cmFirst = dv.getUint16(3, true), cmLen = dv.getUint16(5, true), cmBits = u8[7]
    const w = dv.getUint16(12, true), h = dv.getUint16(14, true), bpp = u8[16], desc = u8[17]
    if (![1, 2, 3, 9, 10, 11].includes(type) || !w || !h) throw new ReaderError('Неподдерживаемый вариант TGA.')
    let p = 18 + idLen
    const cmap = []
    const readColor = (bits, at) => {
        if (bits === 8) return [u8[at], u8[at], u8[at], 255]
        if (bits === 15 || bits === 16) { const v = u8[at] | (u8[at + 1] << 8); return [((v >> 10) & 31) * 255 / 31, ((v >> 5) & 31) * 255 / 31, (v & 31) * 255 / 31, bits === 16 && !(v & 0x8000) && false ? 0 : 255] }
        if (bits === 24) return [u8[at + 2], u8[at + 1], u8[at], 255]
        return [u8[at + 2], u8[at + 1], u8[at], u8[at + 3]]
    }
    if (cmType === 1) { const sz = Math.ceil(cmBits / 8); for (let i = 0; i < cmLen; i++) cmap[cmFirst + i] = readColor(cmBits, p + i * sz); p += cmLen * sz }
    const bytes = Math.ceil(bpp / 8)
    const px = n => {
        if (type === 1 || type === 9) { const i = bytes === 2 ? u8[n] | (u8[n + 1] << 8) : u8[n]; return cmap[i] ?? [0, 0, 0, 255] }
        return readColor(type === 3 || type === 11 ? 8 : bpp, n)
    }
    const pixels = new Array(w * h)
    if (type < 9) for (let i = 0; i < w * h; i++) pixels[i] = px(p + i * bytes)
    else {
        let i = 0
        while (i < w * h && p < u8.length) {
            const c = u8[p++], n = (c & 0x7F) + 1
            if (c & 0x80) { const v = px(p); p += bytes; for (let k = 0; k < n; k++) pixels[i++] = v }
            else for (let k = 0; k < n; k++) { pixels[i++] = px(p); p += bytes }
        }
    }
    const out = new Uint8ClampedArray(w * h * 4)
    const top = (desc & 0x20) !== 0, right = (desc & 0x10) !== 0
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const s = pixels[y * w + x] ?? [0, 0, 0, 0]
        const ty = top ? y : h - 1 - y, tx = right ? w - 1 - x : x
        out.set(s, (ty * w + tx) * 4)
    }
    // если альфа везде нулевая — считаем картинку непрозрачной
    if (bpp === 32 && !out.some((v, i) => i % 4 === 3 && v)) for (let i = 3; i < out.length; i += 4) out[i] = 255
    return { w, h, rgba: out }
}

// ---------- PCX ----------
const decodePcx = u8 => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    if (u8[0] !== 0x0A) throw new ReaderError('Это не картинка PCX.')
    const bpp = u8[3], x0 = dv.getUint16(4, true), y0 = dv.getUint16(6, true), x1 = dv.getUint16(8, true), y1 = dv.getUint16(10, true)
    const planes = u8[65], bpl = dv.getUint16(66, true)
    const w = x1 - x0 + 1, h = y1 - y0 + 1
    const lineLen = planes * bpl
    const raw = new Uint8Array(lineLen * h)
    let p = 128, o = 0
    while (o < raw.length && p < u8.length) {
        const c = u8[p++]
        if ((c & 0xC0) === 0xC0) { const n = c & 0x3F, v = u8[p++]; for (let k = 0; k < n && o < raw.length; k++) raw[o++] = v }
        else raw[o++] = c
    }
    const out = new Uint8ClampedArray(w * h * 4)
    let pal = null
    if (bpp === 8 && planes === 1 && u8[u8.length - 769] === 0x0C) pal = u8.subarray(u8.length - 768)
    const ega = u8.subarray(16, 64)
    for (let y = 0; y < h; y++) {
        const line = raw.subarray(y * lineLen, (y + 1) * lineLen)
        for (let x = 0; x < w; x++) {
            const q = (y * w + x) * 4
            if (bpp === 8 && planes === 1) { const i = line[x]; if (pal) { out[q] = pal[i * 3]; out[q + 1] = pal[i * 3 + 1]; out[q + 2] = pal[i * 3 + 2] } else out[q] = out[q + 1] = out[q + 2] = i }
            else if (bpp === 8 && planes >= 3) { out[q] = line[x]; out[q + 1] = line[bpl + x]; out[q + 2] = line[2 * bpl + x] }
            else if (bpp === 1) {
                let i = 0
                for (let pl = 0; pl < planes; pl++) i |= ((line[pl * bpl + (x >> 3)] >> (7 - (x & 7))) & 1) << pl
                if (planes === 1) out[q] = out[q + 1] = out[q + 2] = i ? 255 : 0
                else { out[q] = ega[i * 3]; out[q + 1] = ega[i * 3 + 1]; out[q + 2] = ega[i * 3 + 2] }
            } else throw new ReaderError('Этот вариант PCX не поддерживается.')
            out[q + 3] = 255
        }
    }
    return { w, h, rgba: out }
}

// ---------- WBMP ----------
const decodeWbmp = u8 => {
    let p = 2
    const mb = () => { let v = 0, c; do { c = u8[p++]; v = (v << 7) | (c & 0x7F) } while (c & 0x80); return v }
    const w = mb(), h = mb()
    const rowBytes = Math.ceil(w / 8)
    const out = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = (u8[p + y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0
        const q = (y * w + x) * 4; out[q] = out[q + 1] = out[q + 2] = v; out[q + 3] = 255
    }
    return { w, h, rgba: out }
}

// ---------- XBM и XPM (картинки X11 в виде кода на C) ----------
const decodeXbm = text => {
    const w = +/_width\s+(\d+)/.exec(text)?.[1], h = +/_height\s+(\d+)/.exec(text)?.[1]
    if (!w || !h) throw new ReaderError('Это не картинка XBM.')
    const bytes = (text.slice(text.indexOf('{')).match(/0x[0-9a-f]+/gi) || []).map(x => parseInt(x, 16))
    const rowBytes = Math.ceil(w / 8)
    const out = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const bit = (bytes[y * rowBytes + (x >> 3)] >> (x & 7)) & 1
        const q = (y * w + x) * 4; out[q] = out[q + 1] = out[q + 2] = bit ? 0 : 255; out[q + 3] = 255
    }
    return { w, h, rgba: out }
}
const cssColor = (() => {
    let c2d
    return name => {
        c2d ??= document.createElement('canvas').getContext('2d')
        c2d.fillStyle = '#000'; c2d.fillStyle = name.replace(/\s+/g, '')
        const v = c2d.fillStyle
        return v.startsWith('#') ? [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 255] : [0, 0, 0, 255]
    }
})()
const decodeXpm = text => {
    const strs = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1])
    if (!strs.length) throw new ReaderError('Это не картинка XPM.')
    const [w, h, n, cpp] = strs[0].trim().split(/\s+/).map(Number)
    const colors = new Map()
    for (let i = 1; i <= n; i++) {
        const s = strs[i], key = s.slice(0, cpp)
        const m = /(?:^|\s)c\s+([^\t]+?)(?:\s+(?:m|g4|g|s)\s|$)/.exec(s.slice(cpp))
        const val = (m?.[1] ?? s.slice(cpp).trim().split(/\s+/).pop()).trim()
        colors.set(key, /^none$/i.test(val) ? [0, 0, 0, 0] : val.startsWith('#') && val.length === 13 ? [parseInt(val.slice(1, 3), 16), parseInt(val.slice(5, 7), 16), parseInt(val.slice(9, 11), 16), 255] : cssColor(val))
    }
    const out = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
        const row = strs[1 + n + y] ?? ''
        for (let x = 0; x < w; x++) out.set(colors.get(row.substr(x * cpp, cpp)) ?? [0, 0, 0, 0], (y * w + x) * 4)
    }
    return { w, h, rgba: out }
}

// ---------- Простые картинки: общий вход ----------
// farbfeld: «farbfeld», ширина и высота (big-endian), затем RGBA по 16 бит на канал
const decodeFarbfeld = u8 => {
    if (latin.decode(u8.subarray(0, 8)) !== 'farbfeld') throw new ReaderError('Это не картинка farbfeld.')
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    const w = dv.getUint32(8), h = dv.getUint32(12)
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h * 4 && 16 + i * 2 < u8.length; i++) rgba[i] = u8[16 + i * 2]
    return { w, h, rgba }
}
export const openSimpleImage = async (ext, buf) => {
    const u8 = new Uint8Array(buf)
    if (ext === 'jfif' || ext === 'jpe') return pagesOf([await blobPage(u8, 'image/jpeg')])
    const dec = { qoi: decodeQoi, tga: decodeTga, pcx: decodePcx, wbmp: decodeWbmp, ff: decodeFarbfeld }[ext]
        ?? (['pbm', 'pgm', 'ppm', 'pnm', 'pam'].includes(ext) ? decodeNetpbm : null)
        ?? (ext === 'xbm' ? b => decodeXbm(latin.decode(b)) : ext === 'xpm' ? b => decodeXpm(latin.decode(b)) : null)
    if (!dec) throw new ReaderError('Неизвестный формат картинки.')
    const { w, h, rgba } = dec(u8)
    return pagesOf([await rgbaToPage(w, h, rgba)])
}

// ---------- Курсоры .cur и анимированные .ani ----------
const icoFrames = u8 => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    const count = dv.getUint16(4, true)
    const res = []
    for (let i = 0; i < count; i++) {
        const e = 6 + i * 16
        const w = u8[e] || 256, h = u8[e + 1] || 256
        const size = dv.getUint32(e + 8, true), off = dv.getUint32(e + 12, true)
        const data = u8.subarray(off, off + size)
        let blob
        if (data[0] === 0x89 && data[1] === 0x50) blob = new Blob([data], { type: 'image/png' })
        else {
            const one = new Uint8Array(22 + size)
            one.set([0, 0, 1, 0, 1, 0]); one.set(u8.subarray(e, e + 12), 6)
            const d1 = new DataView(one.buffer); d1.setUint16(10, 1, true); d1.setUint16(12, 32, true); d1.setUint32(18, 22, true)
            one.set(data, 22)
            blob = new Blob([one], { type: 'image/x-icon' })
        }
        res.push({ w, h, blob })
    }
    return res
}
export const curView = buf => {
    const u8 = new Uint8Array(buf)
    const frames = icoFrames(u8)
    const wrap = document.createElement('div')
    wrap.innerHTML = `<div class="ur-meta">Курсор, размеров: ${frames.length}</div>`
    const grid = document.createElement('div'); grid.className = 'ur-ico-grid'
    for (const f of frames) {
        const fig = document.createElement('figure')
        const img = new Image(); img.src = URL.createObjectURL(f.blob); img.style.width = f.w * 2 + 'px'; img.style.imageRendering = 'pixelated'
        fig.append(img); fig.insertAdjacentHTML('beforeend', `<figcaption>${f.w}×${f.h}</figcaption>`)
        grid.append(fig)
    }
    wrap.append(grid)
    return wrap
}
export const aniView = (buf, cleanups) => {
    const u8 = new Uint8Array(buf)
    const dv = new DataView(buf)
    if (latin.decode(u8.subarray(0, 4)) !== 'RIFF' || latin.decode(u8.subarray(8, 12)) !== 'ACON') throw new ReaderError('Это не анимированный курсор.')
    const icons = []; let rate = 10, rates = null, seq = null, name = ''
    const walk = (s, e) => {
        let p = s
        while (p + 8 <= e) {
            const id = latin.decode(u8.subarray(p, p + 4)), len = dv.getUint32(p + 4, true)
            const d = p + 8
            if (id === 'LIST') walk(d + 4, d + len)
            else if (id === 'icon') icons.push(u8.slice(d, d + len))
            else if (id === 'anih') rate = dv.getUint32(d + 28, true) || 10
            else if (id === 'rate') rates = Array.from({ length: len / 4 }, (_, i) => dv.getUint32(d + i * 4, true))
            else if (id === 'seq ') seq = Array.from({ length: len / 4 }, (_, i) => dv.getUint32(d + i * 4, true))
            else if (id === 'INAM') name = latin.decode(u8.subarray(d, d + len)).replace(/\0.*/, '')
            p = d + len + (len & 1)
        }
    }
    walk(12, u8.length)
    if (!icons.length) throw new ReaderError('В курсоре нет кадров.')
    const urls = icons.map(ic => { const f = icoFrames(ic); const best = f.sort((a, b) => b.w - a.w)[0]; return { url: URL.createObjectURL(best.blob), w: best.w } })
    const order = seq ?? urls.map((_, i) => i)
    const wrap = document.createElement('div')
    wrap.innerHTML = `<h2>${esc(name || 'Анимированный курсор')}</h2><div class="ur-meta">Кадров: ${icons.length}</div>`
    const anim = new Image(); anim.style.width = urls[0].w * 3 + 'px'; anim.style.imageRendering = 'pixelated'; anim.className = 'ur-ani-preview'
    wrap.append(anim)
    let k = 0, timer
    const step = () => { anim.src = urls[order[k % order.length]].url; const r = rates?.[k % order.length] ?? rate; k++; timer = setTimeout(step, r * 1000 / 60) }
    step()
    cleanups.push(() => clearTimeout(timer))
    const grid = document.createElement('div'); grid.className = 'ur-ico-grid'
    urls.forEach((u, i) => { const fig = document.createElement('figure'); const im = new Image(); im.src = u.url; im.style.width = u.w * 2 + 'px'; im.style.imageRendering = 'pixelated'; fig.append(im); fig.insertAdjacentHTML('beforeend', `<figcaption>${i + 1}</figcaption>`); grid.append(fig) })
    wrap.append(grid)
    return wrap
}

// ---------- Значки macOS .icns ----------
const packbits = (src, n) => {
    const out = new Uint8Array(n); let p = 0, o = 0
    while (o < n && p < src.length) {
        const c = src[p++]
        if (c < 128) { for (let k = 0; k <= c && o < n; k++) out[o++] = src[p++] }
        else { const v = src[p++]; for (let k = 0; k < c - 125 && o < n; k++) out[o++] = v }
    }
    return out
}
const ICNS_RGB = { is32: [16, 's8mk'], il32: [32, 'l8mk'], ih32: [48, 'h8mk'], it32: [128, 't8mk'] }
export const openIcns = async buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (latin.decode(u8.subarray(0, 4)) !== 'icns') throw new ReaderError('Это не значок macOS.')
    const chunks = new Map()
    for (let p = 8; p + 8 <= u8.length;) { const t = latin.decode(u8.subarray(p, p + 4)), len = dv.getUint32(p + 4); if (len < 8) break; chunks.set(t, u8.subarray(p + 8, p + len)); p += len }
    const pages = [], toc = []
    for (const [t, d] of chunks) {
        let page = null
        if (d[0] === 0x89 && d[1] === 0x50) page = async () => blobPage(d, 'image/png')
        else if (latin.decode(d.subarray(0, 4)) === 'ARGB') {
            const size = { ic04: 16, ic05: 32, icsb: 18 }[t]; if (!size) continue
            const raw = packbits(d.subarray(4), size * size * 4)
            const rgba = new Uint8ClampedArray(size * size * 4)
            for (let i = 0; i < size * size; i++) { rgba[i * 4 + 3] = raw[i]; rgba[i * 4] = raw[size * size + i]; rgba[i * 4 + 1] = raw[2 * size * size + i]; rgba[i * 4 + 2] = raw[3 * size * size + i] }
            page = () => rgbaToPage(size, size, rgba)
        } else if (ICNS_RGB[t]) {
            const [size, maskT] = ICNS_RGB[t], n = size * size
            const src = t === 'it32' ? d.subarray(4) : d
            const raw = src.length === n * 4 ? src : packbits(src, n * 3)
            const mask = chunks.get(maskT)
            const rgba = new Uint8ClampedArray(n * 4)
            for (let i = 0; i < n; i++) {
                if (src.length === n * 4) { rgba[i * 4] = raw[i * 4 + 1]; rgba[i * 4 + 1] = raw[i * 4 + 2]; rgba[i * 4 + 2] = raw[i * 4 + 3] }
                else { rgba[i * 4] = raw[i]; rgba[i * 4 + 1] = raw[n + i]; rgba[i * 4 + 2] = raw[2 * n + i] }
                rgba[i * 4 + 3] = mask ? mask[i] : 255
            }
            page = () => rgbaToPage(size, size, rgba)
        }
        if (page) { toc.push({ label: t, target: pages.length, subitems: [] }); pages.push(page) }
    }
    if (!pages.length) throw new ReaderError('В значке нет поддерживаемых картинок (возможно, только JPEG 2000).')
    // крупные сначала
    return pagesOf(pages, [{ label: `Размеры (${pages.length})`, target: 0, subitems: toc }])
}

// ---------- HDR (Radiance) и EXR: просмотр с ползунком экспозиции ----------
const decodeHdr = u8 => {
    let p = 0
    const line = () => { const e = u8.indexOf(10, p); const s = latin.decode(u8.subarray(p, e)); p = e + 1; return s }
    if (!line().startsWith('#?')) throw new ReaderError('Это не картинка HDR.')
    while (line().trim() !== '') { /* заголовок */ }
    const res = line().trim().split(/\s+/)
    const h = +res[1], w = +res[3]
    const data = new Float32Array(w * h * 4)
    const scan = new Uint8Array(w * 4)
    for (let y = 0; y < h; y++) {
        if (w >= 8 && w < 32768 && u8[p] === 2 && u8[p + 1] === 2 && !(u8[p + 2] & 0x80)) {
            p += 4
            for (let c = 0; c < 4; c++) {
                let x = 0
                while (x < w) {
                    let n = u8[p++]
                    if (n > 128) { n -= 128; const v = u8[p++]; while (n--) scan[(x++) * 4 + c] = v }
                    else while (n--) scan[(x++) * 4 + c] = u8[p++]
                }
            }
        } else { scan.set(u8.subarray(p, p + w * 4)); p += w * 4 }
        for (let x = 0; x < w; x++) {
            const e = scan[x * 4 + 3], f = e ? Math.pow(2, e - 136) : 0, o = (y * w + x) * 4
            data[o] = scan[x * 4] * f; data[o + 1] = scan[x * 4 + 1] * f; data[o + 2] = scan[x * 4 + 2] * f; data[o + 3] = 1
        }
    }
    return { w, h, data }
}
export const hdrView = async (ctx, buf, ext) => {
    let img
    if (ext === 'exr') {
        const { parseExr } = await ctx.loadLib('three')
        const r = parseExr(buf)
        const n = r.width * r.height, d = r.data, ch = d.length / n
        const data = new Float32Array(n * 4)
        for (let i = 0; i < n; i++) { data[i * 4] = d[i * ch]; data[i * 4 + 1] = d[i * ch + (ch > 1 ? 1 : 0)]; data[i * 4 + 2] = d[i * ch + (ch > 2 ? 2 : 0)]; data[i * 4 + 3] = ch > 3 ? d[i * ch + 3] : 1 }
        // EXR хранится снизу вверх в three.js
        img = { w: r.width, h: r.height, data, flip: true }
    } else img = decodeHdr(new Uint8Array(buf))
    const wrap = document.createElement('div')
    const bar = document.createElement('div'); bar.className = 'ur-hdr-bar ur-nosearch'
    bar.innerHTML = `<label>Экспозиция <input type="range" min="-8" max="8" step="0.1" value="0"></label> <span class="ur-muted">${img.w}×${img.h}</span>`
    const canvas = document.createElement('canvas'); canvas.width = img.w; canvas.height = img.h; canvas.className = 'ur-hdr-canvas'
    wrap.append(bar, canvas)
    if (Math.max(img.w, img.h) < 200) { canvas.style.width = img.w * Math.floor(400 / Math.max(img.w, img.h)) + 'px'; canvas.style.imageRendering = 'pixelated' }
    const out = new ImageData(img.w, img.h)
    const draw = ev => {
        const k = Math.pow(2, ev)
        const g = v => 255 * Math.pow(Math.max(0, v * k) / (1 + Math.max(0, v * k)), 1 / 2.2)
        for (let y = 0; y < img.h; y++) {
            const sy = img.flip ? img.h - 1 - y : y
            for (let x = 0; x < img.w; x++) {
                const s = (sy * img.w + x) * 4, o = (y * img.w + x) * 4
                out.data[o] = g(img.data[s]); out.data[o + 1] = g(img.data[s + 1]); out.data[o + 2] = g(img.data[s + 2]); out.data[o + 3] = 255 * Math.min(1, img.data[s + 3])
            }
        }
        canvas.getContext('2d').putImageData(out, 0, 0)
    }
    // начальная экспозиция по средней яркости
    let sum = 0, cnt = 0
    for (let i = 0; i < img.data.length; i += 4 * 37) { const l = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]; if (l > 0) { sum += Math.log(l); cnt++ } }
    const ev0 = cnt ? Math.max(-8, Math.min(8, Math.round(-Math.log2(Math.exp(sum / cnt) / 0.18) * 10) / 10)) : 0
    const input = bar.querySelector('input'); input.value = ev0
    input.oninput = () => draw(+input.value)
    draw(ev0)
    return wrap
}

// ---------- DDS (текстуры) ----------
const rgb565 = v => [((v >> 11) & 31) * 255 / 31 | 0, ((v >> 5) & 63) * 255 / 63 | 0, (v & 31) * 255 / 31 | 0]
export const decodeDxt = (u8, p, w, h, kind) => {
    const out = new Uint8ClampedArray(w * h * 4)
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4) {
        let alpha = null
        if (kind === 3) { alpha = []; for (let i = 0; i < 16; i++) alpha.push(((u8[p + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17); p += 8 }
        else if (kind === 5) {
            const a0 = u8[p], a1 = u8[p + 1], tbl = [a0, a1]
            if (a0 > a1) for (let i = 1; i < 7; i++) tbl.push(((7 - i) * a0 + i * a1) / 7 | 0)
            else { for (let i = 1; i < 5; i++) tbl.push(((5 - i) * a0 + i * a1) / 5 | 0); tbl.push(0, 255) }
            let bits = 0n; for (let i = 0; i < 6; i++) bits |= BigInt(u8[p + 2 + i]) << BigInt(8 * i)
            alpha = []; for (let i = 0; i < 16; i++) alpha.push(tbl[Number((bits >> BigInt(3 * i)) & 7n)])
            p += 8
        }
        const c0 = dv.getUint16(p, true), c1 = dv.getUint16(p + 2, true)
        const cols = [rgb565(c0), rgb565(c1)]
        if (c0 > c1 || kind !== 1) { cols.push(cols[0].map((v, i) => (2 * v + cols[1][i]) / 3 | 0), cols[0].map((v, i) => (v + 2 * cols[1][i]) / 3 | 0)) }
        else { cols.push(cols[0].map((v, i) => (v + cols[1][i]) / 2 | 0), [0, 0, 0]) }
        const idx = dv.getUint32(p + 4, true)
        for (let i = 0; i < 16; i++) {
            const x = bx + (i & 3), y = by + (i >> 2)
            if (x >= w || y >= h) continue
            const ci = (idx >> (2 * i)) & 3, o = (y * w + x) * 4
            out[o] = cols[ci][0]; out[o + 1] = cols[ci][1]; out[o + 2] = cols[ci][2]
            out[o + 3] = alpha ? alpha[i] : (kind === 1 && c0 <= c1 && ci === 3 ? 0 : 255)
        }
        p += 8
    }
    return out
}
export const openDds = async buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (latin.decode(u8.subarray(0, 4)) !== 'DDS ') throw new ReaderError('Это не текстура DDS.')
    const h = dv.getUint32(12, true), w = dv.getUint32(16, true)
    const pfFlags = dv.getUint32(80, true), four = latin.decode(u8.subarray(84, 88))
    let p = 128, kind = 0
    if (pfFlags & 4) {
        if (four === 'DXT1') kind = 1; else if (four === 'DXT2' || four === 'DXT3') kind = 3; else if (four === 'DXT4' || four === 'DXT5') kind = 5
        else if (four === 'DX10') { const f = dv.getUint32(128, true); p = 148; kind = [71, 72].includes(f) ? 1 : [74, 75].includes(f) ? 3 : [77, 78].includes(f) ? 5 : 0; if (!kind) throw new ReaderError(`Сжатие DXGI ${f} (например, BC7) пока не поддерживается.`) }
        else throw new ReaderError(`Сжатие ${four} не поддерживается.`)
        return pagesOf([await rgbaToPage(w, h, decodeDxt(u8, p, w, h, kind))])
    }
    const bits = dv.getUint32(88, true), masks = [92, 96, 100, 104].map(o => dv.getUint32(o, true))
    const bytes = bits / 8, out = new Uint8ClampedArray(w * h * 4)
    const ch = m => { if (!m) return null; let s = 0; while (!((m >> s) & 1)) s++; let l = 0; while ((m >> (s + l)) & 1) l++; return [s, (1 << l) - 1] }
    const cs = masks.map(ch)
    for (let i = 0; i < w * h; i++) {
        let v = 0; for (let k = 0; k < bytes; k++) v |= u8[p + i * bytes + k] << (8 * k)
        v >>>= 0
        for (let c = 0; c < 4; c++) out[i * 4 + c] = cs[c] ? ((v >>> cs[c][0]) & cs[c][1]) * 255 / cs[c][1] : (c === 3 ? 255 : 0)
        if (pfFlags & 0x20000) out[i * 4 + 1] = out[i * 4 + 2] = out[i * 4] // яркость
    }
    return pagesOf([await rgbaToPage(w, h, out)])
}

// ---------- FITS (астрономия) ----------
export const fitsView = async buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const hdus = []
    let p = 0
    while (p + 2880 <= u8.length && hdus.length < 20) {
        const cards = []
        let end = false
        while (!end && p + 2880 <= u8.length) {
            for (let i = 0; i < 36; i++) {
                const c = latin.decode(u8.subarray(p + i * 80, p + i * 80 + 80))
                if (c.startsWith('END') && c.slice(3).trim() === '') { end = true; break }
                cards.push(c)
            }
            p += 2880
        }
        const kv = {}
        for (const c of cards) { const k = c.slice(0, 8).trim(); if (c[8] === '=') { let v = c.slice(10).split(/(?<!')\/(?=(?:[^']*'[^']*')*[^']*$)/)[0].trim(); if (v.startsWith("'")) v = v.slice(1, v.lastIndexOf("'")).trim(); kv[k] = v } }
        const bitpix = +kv.BITPIX, naxis = +kv.NAXIS || 0
        const dims = Array.from({ length: naxis }, (_, i) => +kv['NAXIS' + (i + 1)])
        const n = naxis ? dims.reduce((a, b) => a * b, 1) : 0
        const size = (Math.abs(bitpix) / 8) * n * (+kv.GCOUNT || 1) + (+kv.PCOUNT || 0)
        hdus.push({ cards, kv, bitpix, dims, data: p })
        p += Math.ceil(size / 2880) * 2880
        if (!size && hdus.length > 1) break
    }
    if (!hdus.length) throw new ReaderError('Это не файл FITS.')
    const wrap = document.createElement('div')
    const img = hdus.find(h => h.dims.length >= 2 && h.dims[0] > 1 && h.dims[1] > 1 && !h.kv.XTENSION?.includes('TABLE'))
    if (img) {
        const [w, h] = img.dims
        const bz = +img.kv.BZERO || 0, bs = +img.kv.BSCALE || 1
        const n = w * h, vals = new Float64Array(n), b = img.bitpix, by = Math.abs(b) / 8
        for (let i = 0; i < n; i++) {
            const o = img.data + i * by
            const v = b === 8 ? u8[o] : b === 16 ? dv.getInt16(o) : b === 32 ? dv.getInt32(o) : b === 64 ? Number(dv.getBigInt64(o)) : b === -32 ? dv.getFloat32(o) : dv.getFloat64(o)
            vals[i] = v * bs + bz
        }
        const sample = Array.from({ length: Math.min(n, 20000) }, (_, i) => vals[Math.floor(i * n / Math.min(n, 20000))]).filter(Number.isFinite).sort((a, b) => a - b)
        const lo = sample[Math.floor(sample.length * 0.005)] ?? 0, hi = sample[Math.floor(sample.length * 0.995)] ?? 1
        const c = document.createElement('canvas'); c.width = w; c.height = h; c.className = 'ur-hdr-canvas'
        if (Math.max(w, h) < 300) { c.style.width = w * Math.floor(500 / Math.max(w, h)) + 'px'; c.style.imageRendering = 'pixelated' }
        const out = new ImageData(w, h)
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const v = vals[(h - 1 - y) * w + x]
            const t = Number.isFinite(v) ? Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1))) : 0
            const g = Math.sqrt(t) * 255, o = (y * w + x) * 4
            out.data[o] = out.data[o + 1] = out.data[o + 2] = g; out.data[o + 3] = 255
        }
        c.getContext('2d').putImageData(out, 0, 0)
        wrap.innerHTML = `<h2>${esc(img.kv.OBJECT || 'Снимок FITS')}</h2><div class="ur-meta">${w}×${h}${img.dims[2] > 1 ? ` (показан первый из ${img.dims[2]} слоёв)` : ''}${img.kv.TELESCOP ? ' · ' + esc(img.kv.TELESCOP) : ''}${img.kv.INSTRUME ? ' · ' + esc(img.kv.INSTRUME) : ''}${img.kv['DATE-OBS'] ? ' · ' + esc(img.kv['DATE-OBS']) : ''}</div>`
        wrap.append(c)
    } else wrap.innerHTML = '<p class="ur-muted">В файле нет изображения — только таблицы или заголовок.</p>'
    const det = document.createElement('details')
    det.innerHTML = `<summary>Заголовок (${hdus.length} ${hdus.length === 1 ? 'блок' : 'блоков'})</summary>` + hdus.map((h, i) => `<h4>Блок ${i + 1}${h.kv.XTENSION ? ' — ' + esc(h.kv.XTENSION) : ''}</h4><pre class="ur-plain-code">${esc(h.cards.join('\n'))}</pre>`).join('')
    wrap.append(det)
    return wrap
}

// ---------- EMF и WMF ----------
export const emfView = async (ctx, buf, ext) => {
    const { EMFJS, WMFJS } = await ctx.loadLib('emf')
    const dv = new DataView(buf)
    const wrap = document.createElement('div'); wrap.className = 'ur-svg-wrap'
    let el
    if (ext === 'emf') {
        EMFJS.loggingEnabled?.(false)
        const l = dv.getInt32(8, true), t = dv.getInt32(12, true), r = dv.getInt32(16, true), b = dv.getInt32(20, true)
        const w = Math.max(1, r - l), h = Math.max(1, b - t)
        el = new EMFJS.Renderer(buf).render({ width: w + 'px', height: h + 'px', wExt: w, hExt: h, xExt: w, yExt: h, mapMode: 8 })
    } else {
        WMFJS.loggingEnabled?.(false)
        let w = 800, h = 600
        if (dv.getUint32(0, true) === 0x9AC6CDD7) {
            const l = dv.getInt16(6, true), t = dv.getInt16(8, true), r = dv.getInt16(10, true), b = dv.getInt16(12, true), inch = dv.getUint16(14, true) || 1440
            w = Math.round((r - l) / inch * 96); h = Math.round((b - t) / inch * 96)
        }
        el = new WMFJS.Renderer(buf).render({ width: w + 'px', height: h + 'px', xExt: w, yExt: h, mapMode: 8 })
    }
    wrap.append(el)
    return wrap
}

// ---------- RAW: ищем самое большое встроенное превью JPEG ----------
const jpegEnd = (u8, s) => {
    let p = s + 2
    while (p + 4 < u8.length) {
        if (u8[p] !== 0xFF) return -1
        const m = u8[p + 1]
        if (m === 0xD9) return p + 2
        if (m === 0xDA) {
            p += 2 + ((u8[p + 2] << 8) | u8[p + 3])
            while (p + 1 < u8.length) { if (u8[p] === 0xFF && u8[p + 1] !== 0 && !(u8[p + 1] >= 0xD0 && u8[p + 1] <= 0xD7)) break; p++ }
            continue
        }
        if (m === 0xFF) { p++; continue }
        if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { p += 2; continue }
        p += 2 + ((u8[p + 2] << 8) | u8[p + 3])
    }
    return -1
}
export const openRaw = async buf => {
    const u8 = new Uint8Array(buf)
    const found = []
    for (let i = 0; i < u8.length - 3; i++) {
        if (u8[i] === 0xFF && u8[i + 1] === 0xD8 && u8[i + 2] === 0xFF) {
            const e = jpegEnd(u8, i)
            if (e > 0 && e - i > 400) { found.push([i, e]); i = e - 1 }
        }
    }
    found.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))
    for (const [s, e] of found.slice(0, 4)) {
        try { const page = await blobPage(u8.subarray(s, e), 'image/jpeg'); if (page.width >= 100) return pagesOf([page]) } catch { /* следующий кандидат */ }
    }
    throw new ReaderError('Во RAW-файле не нашлось встроенного превью. Сам RAW проявить здесь нельзя.')
}

// ---------- Krita, OpenRaster ----------
export const openOra = async buf => {
    const zip = await JSZip.loadAsync(buf)
    const f = zip.file('mergedimage.png') ?? zip.file('preview.png') ?? zip.file('Thumbnails/thumbnail.png')
    if (!f) throw new ReaderError('В файле нет готовой итоговой картинки.')
    const page = await blobPage(await f.async('uint8array'), 'image/png')
    let toc
    const stack = zip.file('stack.xml') ?? zip.file('maindoc.xml')
    if (stack) {
        const x = new DOMParser().parseFromString(await stack.async('string'), 'application/xml')
        const walk = el => Array.from(el.children).filter(c => ['layer', 'stack'].includes(c.localName)).map(c => ({ label: (c.getAttribute('name') || (c.localName === 'stack' ? 'Группа' : 'Слой')) + (c.getAttribute('visibility') === 'hidden' || c.getAttribute('visible') === '0' ? ' (скрыт)' : ''), target: 0, subitems: walk(c.querySelector(':scope > layers') ?? c) }))
        const root = x.querySelector('stack') ?? x.querySelector('layers')
        const items = root ? walk(root) : []
        if (items.length) toc = [{ label: `Слои (${page.width}×${page.height})`, target: 0, subitems: items }]
    }
    return pagesOf([page], toc)
}

// ---------- JPEG XL ----------
export const openJxl = async (ctx, buf) => {
    const { decode } = await ctx.loadLib('jxl')
    const im = await decode(buf)
    return pagesOf([await rgbaToPage(im.width, im.height, im.data)])
}

export const bytesPage = (bytes, name) => blobPage(bytes, MIME[extOf(name)] || 'image/png')
