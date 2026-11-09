// Картинки версии 0.6: Silicon Graphics (.sgi, .rgb), Sun Raster (.ras), Amiga IFF/ILBM, игровые текстуры
// (.ktx, .ktx2, .vtf, .blp, .pvr), анимированный MNG, Apple PICT, GIMP (.xcf), JPEG 2000, EPS с превью,
// превью из файлов редакторов (Clip Studio, InDesign, Affinity, OmniGraffle, MediBang), цветовые профили ICC, LUT
import JSZip from 'jszip'
import { escapeHtml as esc, ReaderError } from '../util.js'
import { rgbaToPage, pagesOf, blobPage, decodeDxt } from './images2.js'
import { gunzip, inflateSync } from './compress.js'
import { unzlibSync } from 'fflate'

const latin = new TextDecoder('latin1')
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e }
const page = (w, h, rgba) => rgbaToPage(w, h, rgba)

// ================= SGI =================
export const decodeSgi = u8 => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    if (dv.getUint16(0) !== 474) throw new ReaderError('Это не картинка SGI.')
    const rle = u8[2] === 1, bpc = u8[3] || 1
    const w = dv.getUint16(6), h = dv.getUint16(8), zs = Math.max(1, dv.getUint16(10))
    const ch = new Array(zs)
    for (let z = 0; z < zs; z++) {
        const plane = new Float32Array(w * h)
        for (let y = 0; y < h; y++) {
            if (!rle) { const o = 512 + (z * h + y) * w * bpc; for (let x = 0; x < w; x++) plane[y * w + x] = bpc === 2 ? dv.getUint16(o + x * 2) / 257 : u8[o + x] }
            else {
                let o = dv.getUint32(512 + (z * h + y) * 4), x = 0
                const get = () => { const v = bpc === 2 ? dv.getUint16(o) : u8[o]; o += bpc; return v }
                while (x < w) {
                    const c = get(); const n = c & 0x7F; if (!n) break
                    if (c & 0x80) for (let i = 0; i < n && x < w; i++) plane[y * w + x++] = bpc === 2 ? get() / 257 : get()
                    else { const v = get(); for (let i = 0; i < n && x < w; i++) plane[y * w + x++] = bpc === 2 ? v / 257 : v }
                }
            }
        }
        ch[z] = plane
    }
    const out = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const s = y * w + x, d = ((h - 1 - y) * w + x) * 4 // строки идут снизу вверх
        out[d] = ch[0][s]; out[d + 1] = ch[zs >= 3 ? 1 : 0][s]; out[d + 2] = ch[zs >= 3 ? 2 : 0][s]; out[d + 3] = zs === 4 ? ch[3][s] : zs === 2 ? ch[1][s] : 255
    }
    return { w, h, rgba: out }
}

// ================= Sun Raster =================
export const decodeSun = u8 => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    if (dv.getUint32(0) !== 0x59A66A95) throw new ReaderError('Это не картинка Sun Raster.')
    const w = dv.getUint32(4), h = dv.getUint32(8), depth = dv.getUint32(12), type = dv.getUint32(20), mapLen = dv.getUint32(28)
    const map = u8.subarray(32, 32 + mapLen), nCol = mapLen / 3
    let data = u8.subarray(32 + mapLen)
    if (type === 2) { // RLE: 0x80 n v — повтор, 0x80 0 — сам байт 0x80
        const out = []; let i = 0
        while (i < data.length) { const b = data[i++]; if (b !== 0x80) out.push(b); else { const n = data[i++]; if (n === 0) out.push(0x80); else { const v = data[i++]; for (let k = 0; k <= n; k++) out.push(v) } } }
        data = Uint8Array.from(out)
    }
    const row = Math.ceil(w * depth / 16) * 2
    const out = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = y * row, d = (y * w + x) * 4
        let r, g, b
        if (depth === 1) { const bit = data[o + (x >> 3)] >> (7 - (x & 7)) & 1; r = g = b = mapLen ? map[bit] : bit ? 0 : 255 }
        else if (depth === 8) { const v = data[o + x]; if (mapLen) { r = map[v]; g = map[nCol + v]; b = map[2 * nCol + v] } else r = g = b = v }
        else { const bpp = depth / 8, p = o + x * bpp + (depth === 32 ? 1 : 0); if (type === 3) { r = data[p]; g = data[p + 1]; b = data[p + 2] } else { b = data[p]; g = data[p + 1]; r = data[p + 2] } }
        out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = 255
    }
    return { w, h, rgba: out }
}

// ================= Amiga IFF: ILBM и PBM (Deluxe Paint) =================
const byteRun1 = (src, p, n) => { const out = new Uint8Array(n); let o = 0; while (o < n && p < src.length) { const c = (src[p++] << 24) >> 24; if (c >= 0) { for (let i = 0; i <= c && o < n; i++) out[o++] = src[p++] } else if (c !== -128) { const v = src[p++]; for (let i = 0; i < 1 - c && o < n; i++) out[o++] = v } } return { out, p } }
export const decodeIlbm = u8 => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    if (latin.decode(u8.subarray(0, 4)) !== 'FORM') throw new ReaderError('Это не картинка IFF.')
    const kind = latin.decode(u8.subarray(8, 12))
    if (kind !== 'ILBM' && kind !== 'PBM ') throw new ReaderError(`Это файл IFF вида «${kind.trim()}», а не картинка.`)
    let p = 12, bm = null, cmap = null, camg = 0, body = null
    while (p + 8 <= u8.length) {
        const id = latin.decode(u8.subarray(p, p + 4)), len = dv.getUint32(p + 4), d = p + 8
        if (id === 'BMHD') bm = { w: dv.getUint16(d), h: dv.getUint16(d + 2), planes: u8[d + 8], mask: u8[d + 9], comp: u8[d + 10], trans: dv.getUint16(d + 12) }
        else if (id === 'CMAP') cmap = u8.subarray(d, d + len)
        else if (id === 'CAMG') camg = dv.getUint32(d)
        else if (id === 'BODY') body = u8.subarray(d, d + len)
        p = d + len + (len & 1)
    }
    if (!bm || !body) throw new ReaderError('В картинке IFF нет изображения.')
    const { w, h, planes } = bm
    const out = new Uint8ClampedArray(w * h * 4)
    let pal = []
    if (cmap) for (let i = 0; i + 2 < cmap.length; i += 3) pal.push([cmap[i], cmap[i + 1], cmap[i + 2]])
    if (camg & 0x80 && pal.length && planes === 6) pal = pal.concat(pal.map(c => c.map(v => v >> 1))) // Extra Half-Brite
    const ham = !!(camg & 0x800)
    let src = 0
    const line = n => { if (bm.comp === 1) { const r = byteRun1(body, src, n); src = r.p; return r.out } const r = body.subarray(src, src + n); src += n; return r }
    const rowBytes = Math.ceil(w / 16) * 2
    for (let y = 0; y < h; y++) {
        const idx = new Uint32Array(w)
        if (kind === 'PBM ') { const r = line(w + (w & 1)); for (let x = 0; x < w; x++) idx[x] = r[x] }
        else {
            for (let pl = 0; pl < planes; pl++) { const r = line(rowBytes); for (let x = 0; x < w; x++) if (r[x >> 3] >> (7 - (x & 7)) & 1) idx[x] |= 1 << pl }
            if (bm.mask === 1) line(rowBytes)
        }
        let prev = pal[0] ?? [0, 0, 0]
        for (let x = 0; x < w; x++) {
            let c
            if (planes === 24) c = [idx[x] & 255, idx[x] >> 8 & 255, idx[x] >> 16 & 255]
            else if (ham) {
                const bits = planes - 2, ctl = idx[x] >> bits, v = idx[x] & ((1 << bits) - 1), sc = v << (8 - bits) | v >> (2 * bits - 8)
                c = ctl === 0 ? (pal[v] ?? [0, 0, 0]) : ctl === 1 ? [prev[0], prev[1], sc] : ctl === 2 ? [sc, prev[1], prev[2]] : [prev[0], sc, prev[2]]
            } else c = pal[idx[x]] ?? (pal.length ? [0, 0, 0] : [idx[x] * 255 / ((1 << planes) - 1), idx[x] * 255 / ((1 << planes) - 1), idx[x] * 255 / ((1 << planes) - 1)])
            prev = c
            const d = (y * w + x) * 4
            out[d] = c[0]; out[d + 1] = c[1]; out[d + 2] = c[2]; out[d + 3] = bm.mask === 2 && idx[x] === bm.trans ? 0 : 255
        }
    }
    return { w, h, rgba: out }
}

// ================= Текстуры: KTX, KTX2, VTF, BLP, PVR =================
const rawToRgba = (u8, p, w, h, order) => { // order — порядок каналов, например 'rgba', 'bgra', 'rgb', 'l', 'la'
    const out = new Uint8ClampedArray(w * h * 4), n = order.length
    for (let i = 0; i < w * h; i++) {
        const s = p + i * n, d = i * 4
        if (order === 'l' || order === 'la') { out[d] = out[d + 1] = out[d + 2] = u8[s]; out[d + 3] = order === 'la' ? u8[s + 1] : 255; continue }
        if (order === 'a') { out[d] = out[d + 1] = out[d + 2] = 255; out[d + 3] = u8[s]; continue }
        for (let k = 0; k < n; k++) { const c = 'rgbax'.indexOf(order[k]); if (c < 4) out[d + c] = u8[s + k] }
        if (!order.includes('a')) out[d + 3] = 255
    }
    return out
}
const unsupported = what => { throw new ReaderError(`Сжатие «${what}» пока не поддерживается — такие текстуры читалка не распаковывает.`) }
export const openKtx = async (ctx, buf) => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const id = latin.decode(u8.subarray(1, 7))
    if (id === 'KTX 20') {
        const vk = dv.getUint32(12, true), w = dv.getUint32(20, true), h = Math.max(1, dv.getUint32(24, true)), scheme = dv.getUint32(44, true)
        const off = Number(dv.getBigUint64(80, true)), len = Number(dv.getBigUint64(88, true))
        let data = u8.subarray(off, off + len)
        if (vk === 0 || scheme === 1) unsupported('Basis Universal')
        if (scheme === 2) { const z = await ctx.loadLib('zstd'); data = z.decompress(data) } else if (scheme === 3) data = await zlibOrRaw(data)
        const fmt = { 37: 'rgba', 43: 'rgba', 23: 'rgb', 29: 'rgb', 44: 'bgra', 50: 'bgra', 9: 'l', 16: 'la' }[vk]
        if (fmt) return pagesOf([await page(w, h, rawToRgba(data, 0, w, h, fmt))])
        const bc = { 131: 1, 132: 1, 133: 1, 134: 1, 135: 3, 136: 3, 137: 5, 138: 5 }[vk]
        if (bc) return pagesOf([await page(w, h, decodeDxt(data, 0, w, h, bc))])
        unsupported(`VkFormat ${vk}`)
    }
    if (id !== 'KTX 11') throw new ReaderError('Это не текстура KTX.')
    const le = dv.getUint32(12, true) === 0x04030201
    const g = o => dv.getUint32(o, le)
    const glType = g(16), glFormat = g(24), glInternal = g(28), w = g(36), h = Math.max(1, g(40)), kv = g(60)
    const p = 64 + kv + 4
    const bc = { 0x83F0: 1, 0x83F1: 1, 0x83F2: 3, 0x83F3: 5, 0x8C4C: 1, 0x8C4D: 1, 0x8C4E: 3, 0x8C4F: 5 }[glInternal]
    if (bc) return pagesOf([await page(w, h, decodeDxt(u8, p, w, h, bc))])
    if (glType === 0x1401) { const fmt = { 0x1908: 'rgba', 0x1907: 'rgb', 0x80E1: 'bgra', 0x80E0: 'bgr', 0x1909: 'l', 0x190A: 'la', 0x1906: 'a', 0x1903: 'l' }[glFormat]; if (fmt) return pagesOf([await page(w, h, rawToRgba(u8, p, w, h, fmt.replace('bgr', 'bgr')))]) }
    unsupported({ 0x8D64: 'ETC1', 0x9274: 'ETC2', 0x9278: 'ETC2', 0x93B0: 'ASTC', 0x8C00: 'PVRTC', 0x8E8C: 'BC7' }[glInternal] ?? `GL 0x${glInternal.toString(16)}`)
}
const zlibOrRaw = async d => { try { return unzlibSync(d) } catch { return inflateSync(d) } }
const VTF_FMT = { 0: ['raw', 'rgba'], 1: ['raw', 'abgr'], 2: ['raw', 'rgb'], 3: ['raw', 'bgr'], 5: ['raw', 'l'], 6: ['raw', 'la'], 8: ['raw', 'a'], 9: ['raw', 'rgb'], 10: ['raw', 'bgr'], 11: ['raw', 'argb'], 12: ['raw', 'bgra'], 13: ['bc', 1], 14: ['bc', 3], 15: ['bc', 5], 16: ['raw', 'bgrx'], 20: ['bc', 1] }
const fmtSize = (f, w, h) => f[0] === 'bc' ? Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * (f[1] === 1 ? 8 : 16) : w * h * f[1].length
export const openVtf = async buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (latin.decode(u8.subarray(0, 4)) !== 'VTF\0') throw new ReaderError('Это не текстура Valve (VTF).')
    const minor = dv.getUint32(8, true), hs = dv.getUint32(12, true)
    const w = dv.getUint16(16, true), h = dv.getUint16(18, true), frames = Math.max(1, dv.getUint16(24, true))
    const hf = dv.getInt32(52, true), mips = u8[56], lf = dv.getInt32(57, true), lw = u8[61], lh = u8[62]
    const depth = minor >= 2 ? Math.max(1, dv.getUint16(63, true)) : 1
    const faces = dv.getUint32(20, true) & 0x4000 ? (minor < 5 ? 7 : 6) : 1
    const f = VTF_FMT[hf]
    if (!f) unsupported(`VTF ${hf}`)
    let p
    if (minor >= 3) { // ресурсы: ищем блок с картинкой (тег 0x30)
        const n = dv.getUint32(68, true)
        for (let i = 0; i < n; i++) { const o = 80 + i * 8; if (u8[o] === 0x30 && u8[o + 1] === 0 && u8[o + 2] === 0) p = dv.getUint32(o + 4, true) }
        if (p == null) throw new ReaderError('В текстуре VTF нет изображения.')
    } else p = hs + (VTF_FMT[lf] && lf >= 0 ? fmtSize(VTF_FMT[lf], lw, lh) : 0)
    for (let m = mips - 1; m >= 1; m--) p += fmtSize(f, Math.max(1, w >> m), Math.max(1, h >> m)) * frames * faces * Math.max(1, depth >> m)
    const pages = []
    const sz = fmtSize(f, w, h)
    for (let fr = 0; fr < Math.min(frames, 64); fr++) {
        const o = p + fr * faces * depth * sz
        const rgba = f[0] === 'bc' ? decodeDxt(u8, o, w, h, f[1]) : rawToRgba(u8, o, w, h, f[1])
        pages.push(() => page(w, h, rgba))
    }
    return pagesOf(pages)
}
export const openBlp = async buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const magic = latin.decode(u8.subarray(0, 4))
    if (magic !== 'BLP1' && magic !== 'BLP2') throw new ReaderError('Это не текстура Blizzard (BLP).')
    let type, enc, alphaDepth, alphaEnc, w, h, offs, sizes, pal
    if (magic === 'BLP2') { type = dv.getUint32(4, true); enc = u8[8]; alphaDepth = u8[9]; alphaEnc = u8[10]; w = dv.getUint32(12, true); h = dv.getUint32(16, true); offs = 20; sizes = 84; pal = 148 }
    else { type = dv.getUint32(4, true) === 0 ? 0 : 1; enc = 1; alphaDepth = dv.getUint32(8, true); w = dv.getUint32(12, true); h = dv.getUint32(16, true); offs = 28; sizes = 92; pal = 156 }
    const off0 = dv.getUint32(offs, true), size0 = dv.getUint32(sizes, true)
    if (type === 0) { // JPEG с общим заголовком
        const hl = dv.getUint32(pal, true)
        const jpeg = new Uint8Array(hl + size0); jpeg.set(u8.subarray(pal + 4, pal + 4 + hl)); jpeg.set(u8.subarray(off0, off0 + size0), hl)
        const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }))
        const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d'); g.drawImage(bmp, 0, 0)
        const im = g.getImageData(0, 0, bmp.width, bmp.height)
        for (let i = 0; i < im.data.length; i += 4) { const t = im.data[i]; im.data[i] = im.data[i + 2]; im.data[i + 2] = t; if (!alphaDepth) im.data[i + 3] = 255 } // в BLP каналы JPEG идут как BGR
        return pagesOf([await page(bmp.width, bmp.height, im.data)])
    }
    if (enc === 2) return pagesOf([await page(w, h, decodeDxt(u8, off0, w, h, alphaEnc === 7 ? 5 : alphaEnc === 1 ? 3 : 1))])
    if (enc === 3) return pagesOf([await page(w, h, rawToRgba(u8, off0, w, h, 'bgra'))])
    const out = new Uint8ClampedArray(w * h * 4), n = w * h
    for (let i = 0; i < n; i++) {
        const c = u8[off0 + i] * 4
        out[i * 4] = u8[pal + c + 2]; out[i * 4 + 1] = u8[pal + c + 1]; out[i * 4 + 2] = u8[pal + c]
        let a = 255
        if (alphaDepth === 8) a = u8[off0 + n + i]
        else if (alphaDepth === 4) a = (u8[off0 + n + (i >> 1)] >> ((i & 1) * 4) & 15) * 17
        else if (alphaDepth === 1) a = u8[off0 + n + (i >> 3)] >> (i & 7) & 1 ? 255 : 0
        out[i * 4 + 3] = a
    }
    return pagesOf([await page(w, h, out)])
}
export const openPvr = async buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (dv.getUint32(0, true) !== 0x03525650) {
        if (latin.decode(u8.subarray(44, 48)) === 'PVR!') unsupported('PVR версии 2')
        throw new ReaderError('Это не текстура PowerVR (PVR).')
    }
    const pfLo = dv.getUint32(8, true), pfHi = dv.getUint32(12, true)
    const h = dv.getUint32(24, true), w = dv.getUint32(28, true), meta = dv.getUint32(48, true)
    const p = 52 + meta
    if (pfHi) {
        const names = latin.decode(u8.subarray(8, 12)), bits = [...u8.subarray(12, 16)]
        if (bits.every(b => b === 8 || b === 0)) { const order = [...names].filter((c, i) => bits[i]).join(''); if (/^[rgbal]+$/.test(order)) return pagesOf([await page(w, h, rawToRgba(u8, p, w, h, order))]) }
        unsupported(`PVR ${names} ${bits.join('')}`)
    }
    const bc = { 7: 1, 8: 1, 9: 3, 10: 3, 11: 5, 12: 5 }[pfLo]
    if (bc) return pagesOf([await page(w, h, decodeDxt(u8, p, w, h, bc))])
    unsupported({ 0: 'PVRTC', 1: 'PVRTC', 2: 'PVRTC', 3: 'PVRTC', 6: 'ETC1', 22: 'ETC2', 23: 'ETC2' }[pfLo] ?? `PVR ${pfLo}`)
}

// ================= MNG: кадры из встроенных PNG =================
export const mngView = async (ctx, buf) => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (!(u8[0] === 0x8A && latin.decode(u8.subarray(1, 4)) === 'MNG')) throw new ReaderError('Это не анимация MNG.')
    const W = dv.getUint32(16), H = dv.getUint32(20), ticks = dv.getUint32(24) || 1000
    const SIG = Uint8Array.of(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
    const frames = []
    let p = 8, cur = null, delay = 100, dx = 0, dy = 0, globalPlte = null
    while (p + 12 <= u8.length) {
        const len = dv.getUint32(p), id = latin.decode(u8.subarray(p + 4, p + 8)), chunk = u8.subarray(p, p + 12 + len)
        if (id === 'IHDR') cur = [chunk]
        else if (cur) { cur.push(chunk); if (id === 'IEND') { if (globalPlte && !cur.some(c => latin.decode(c.subarray(4, 8)) === 'PLTE')) cur.splice(1, 0, globalPlte); const total = 8 + cur.reduce((s, c) => s + c.length, 0); const png = new Uint8Array(total); png.set(SIG); let o = 8; for (const c of cur) { png.set(c, o); o += c.length } frames.push({ png, delay, x: dx, y: dy }); cur = null } }
        else if (id === 'PLTE') globalPlte = chunk
        else if (id === 'DEFI' && len >= 12) { dx = dv.getInt32(p + 12); dy = dv.getInt32(p + 16) }
        else if (id === 'FRAM' && len > 1) { let q = p + 9; while (q < p + 8 + len && u8[q]) q++; q++; if (q + 4 <= p + 8 + len && u8[q] === 2) { delay = dv.getUint32(q + 4) * 1000 / ticks } }
        else if (id === 'JHDR') throw new ReaderError('В анимации есть кадры JNG — такие пока не поддерживаются.')
        else if (id === 'MEND') break
        p += 12 + len
    }
    if (!frames.length) throw new ReaderError('В анимации MNG нет кадров PNG.')
    const bmps = await Promise.all(frames.map(f => createImageBitmap(new Blob([f.png], { type: 'image/png' }))))
    const canvas = el('canvas', 'ur-mng-canvas'); canvas.width = W || bmps[0].width; canvas.height = H || bmps[0].height
    const g = canvas.getContext('2d')
    const wrap = el('div', 'ur-mng', `<div class="ur-meta">${canvas.width}×${canvas.height} · кадров: ${frames.length}</div>`)
    const ctl = el('div', 'ur-sci-controls ur-nosearch')
    const play = el('button', '', '⏸ Пауза'), info = el('span', 'ur-muted', '')
    ctl.append(play, info); wrap.append(ctl, canvas)
    let i = 0, timer = null, playing = frames.length > 1
    const show = () => { const f = frames[i]; if (i === 0) g.clearRect(0, 0, canvas.width, canvas.height); g.drawImage(bmps[i], f.x, f.y); info.textContent = ` кадр ${i + 1} из ${frames.length}` }
    const step = () => { show(); i = (i + 1) % frames.length; if (playing) timer = setTimeout(step, Math.max(20, frames[i].delay || 100)) }
    play.onclick = () => { playing = !playing; play.textContent = playing ? '⏸ Пауза' : '▶ Играть'; clearTimeout(timer); if (playing) step() }
    if (frames.length < 2) play.remove()
    step()
    ctx.cleanups?.push(() => clearTimeout(timer))
    return wrap
}

// ================= Apple PICT (QuickDraw) =================
export const openPict = async buf => {
    let u8 = new Uint8Array(buf)
    // у файла есть 512-байтовый заголовок; у PICT из ресурсов его нет
    const tryAt = off => { const v = latin.decode(u8.subarray(off + 10, off + 14)); return v === '\x00\x11\x02\xFF' || v.startsWith('\x11\x01') }
    let base = tryAt(512) ? 512 : tryAt(0) ? 0 : -1
    if (base < 0) { const j = jpegInside(u8); if (j) return pagesOf([await blobPage(j, 'image/jpeg')]); throw new ReaderError('Это не картинка PICT.') }
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    const fTop = dv.getInt16(base + 2), fLeft = dv.getInt16(base + 4), fBot = dv.getInt16(base + 6), fRight = dv.getInt16(base + 8)
    let W = fRight - fLeft, H = fBot - fTop
    let p = base + 10
    const v2 = u8[p] === 0 && u8[p + 1] === 0x11
    let out = null, scale = 1
    const ensure = () => { if (!out) out = new Uint8ClampedArray(W * H * 4).fill(255) }
    const rect = o => [dv.getInt16(o), dv.getInt16(o + 2), dv.getInt16(o + 4), dv.getInt16(o + 6)]
    const blit = (pix, pw, ph, src, dst) => {
        ensure()
        const sx = (dst[3] - dst[1]) / (src[3] - src[1] || 1), sy = (dst[2] - dst[0]) / (src[2] - src[0] || 1)
        for (let y = 0; y < dst[2] - dst[0]; y++) for (let x = 0; x < dst[3] - dst[1]; x++) {
            const X = dst[1] + x - fLeft, Y = dst[0] + y - fTop; if (X < 0 || Y < 0 || X >= W || Y >= H) continue
            const s = Math.floor(src[0] + y / sy) * pw + Math.floor(src[1] + x / sx); if (s < 0 || s >= pw * ph) continue
            out.set(pix.subarray(s * 4, s * 4 + 4), (Y * W + X) * 4)
        }
    }
    const readPix = (op) => {
        let q = p
        if (op === 0x9A || op === 0x9B) q += 4 // baseAddr
        const rowBytesRaw = dv.getUint16(q), isPix = !!(rowBytesRaw & 0x8000), rowBytes = rowBytesRaw & 0x3FFF
        const b = rect(q + 2); q += 10
        let pixelSize = 1, cmpCount = 1, packType = 0, ct = null
        if (isPix) {
            packType = dv.getUint16(q + 2); pixelSize = dv.getUint16(q + 18); cmpCount = dv.getUint16(q + 20); q += 36
            if (op !== 0x9A && op !== 0x9B) { const fl = dv.getUint16(q + 4), n = dv.getUint16(q + 6) + 1; ct = []; q += 8; for (let i = 0; i < n; i++) { ct[fl & 0x8000 ? i : dv.getUint16(q) & 0xFF] = [u8[q + 2], u8[q + 4], u8[q + 6]]; q += 8 } }
            if (packType === 0 && pixelSize === 32) packType = 4
            if (packType === 0 && pixelSize === 16) packType = 3
        }
        const src = rect(q), dst = rect(q + 8); q += 18
        if (op & 1) q += dv.getUint16(q) // регион
        const pw = b[3] - b[1], ph = b[2] - b[0]
        const pix = new Uint8ClampedArray(pw * ph * 4)
        let wordCount = false
        const bytesPerRow = pixelSize === 32 && packType === 4 ? pw * cmpCount : pixelSize === 32 && packType === 2 ? pw * 3 : rowBytes
        for (let y = 0; y < ph; y++) {
            let row
            if (rowBytes < 8 || packType === 1) { row = u8.subarray(q, q + rowBytes); q += rowBytes }
            else {
                if (y === 0) wordCount = rowBytes > 250 || u8[q] === 0 // некоторые программы пишут длину словом и для коротких строк
                const n = wordCount ? dv.getUint16(q) : u8[q]; q += wordCount ? 2 : 1
                if (pixelSize === 16 && packType === 3) { // упаковка по 16-битным словам
                    const o = []; let i = q; const e = q + n
                    while (i < e) { const c = (u8[i++] << 24) >> 24; if (c >= 0) { for (let k = 0; k <= c; k++) { o.push(u8[i], u8[i + 1]); i += 2 } } else { for (let k = 0; k < 1 - c; k++) o.push(u8[i], u8[i + 1]); i += 2 } }
                    row = Uint8Array.from(o)
                } else row = byteRun1(u8.subarray(q, q + n), 0, bytesPerRow).out
                q += n
            }
            for (let x = 0; x < pw; x++) {
                const d = (y * pw + x) * 4
                let c
                if (pixelSize === 32 || pixelSize === 24) {
                    if (packType === 4) { const k = cmpCount; c = k === 4 ? [row[pw + x], row[2 * pw + x], row[3 * pw + x]] : [row[x], row[pw + x], row[2 * pw + x]] }
                    else if (packType === 2) c = [row[x * 3], row[x * 3 + 1], row[x * 3 + 2]]
                    else c = [row[x * 4 + 1], row[x * 4 + 2], row[x * 4 + 3]]
                } else if (pixelSize === 16) { const v = row[x * 2] << 8 | row[x * 2 + 1]; c = [(v >> 10 & 31) * 255 / 31, (v >> 5 & 31) * 255 / 31, (v & 31) * 255 / 31] }
                else { const bits = pixelSize, per = 8 / bits, v = row[Math.floor(x / per)] >> ((per - 1 - x % per) * bits) & ((1 << bits) - 1); c = ct ? ct[v] ?? [0, 0, 0] : isPix ? [v, v, v].map(t => 255 - t * 255 / ((1 << bits) - 1)) : v ? [0, 0, 0] : [255, 255, 255] }
                pix[d] = c[0]; pix[d + 1] = c[1]; pix[d + 2] = c[2]; pix[d + 3] = 255
            }
        }
        blit(pix, pw, ph, [src[0] - b[0], src[1] - b[1], src[2] - b[0], src[3] - b[1]], dst)
        return q
    }
    let jpeg = null
    if (!v2) throw new ReaderError('Старая картинка PICT версии 1 пока не поддерживается.')
    p += 4
    for (let guard = 0; guard < 1e6 && p + 2 <= u8.length; guard++) {
        const op = dv.getUint16(p); p += 2
        if (op === 0xFF) break
        if (op === 0x0C00) { const hRes = dv.getInt32(p + 4); if (dv.getInt16(p) === -2) { const r = rect(p + 12); W = r[3] - r[1]; H = r[2] - r[0]; void hRes } p += 24; continue }
        if (op === 0x01) { p += dv.getUint16(p); continue }
        if (op >= 0x90 && op <= 0x9B) { p = readPix(op); if (p & 1) p++; continue }
        if (op === 0x8200 || op === 0x8201) { const len = dv.getUint32(p); const j = jpegInside(u8.subarray(p + 4, p + 4 + len)); if (j) jpeg = j; p += 4 + len; continue }
        if (op === 0xA1) { p += 4 + dv.getUint16(p + 2); continue }
        if (op === 0x28) { p += 5 + u8[p + 4]; if (p & 1) p++; continue }
        if (op === 0x29 || op === 0x2A) { p += 2 + u8[p + 1]; if (p & 1) p++; continue }
        if (op === 0x2B) { p += 3 + u8[p + 2]; if (p & 1) p++; continue }
        if (op === 0x2C || op === 0x2E || (op >= 0x24 && op <= 0x27) || op === 0x2F || (op >= 0x70 && op <= 0x77) || (op >= 0x80 && op <= 0x87) || (op >= 0x92 && op <= 0x97) || (op >= 0x9C && op <= 0x9F) || (op >= 0xA2 && op <= 0xAF)) { p += 2 + dv.getUint16(p); continue }
        const fixed = { 0x00: 0, 0x02: 8, 0x03: 2, 0x04: 2, 0x05: 2, 0x06: 4, 0x07: 4, 0x08: 2, 0x09: 8, 0x0A: 8, 0x0B: 4, 0x0C: 4, 0x0D: 2, 0x0E: 4, 0x0F: 4, 0x10: 8, 0x11: 2, 0x12: 0, 0x13: 0, 0x14: 0, 0x15: 2, 0x16: 2, 0x17: 0, 0x18: 0, 0x19: 0, 0x1A: 6, 0x1B: 6, 0x1C: 0, 0x1D: 6, 0x1E: 0, 0x1F: 6, 0x20: 8, 0x21: 4, 0x22: 6, 0x23: 2, 0xA0: 2 }
        if (op in fixed) { p += fixed[op]; continue }
        if (op >= 0x30 && op <= 0x37 || op >= 0x40 && op <= 0x47 || op >= 0x50 && op <= 0x57) { p += 8; continue }
        if (op >= 0x38 && op <= 0x3F || op >= 0x48 && op <= 0x4F || op >= 0x58 && op <= 0x5F || op >= 0x78 && op <= 0x7F || op >= 0x88 && op <= 0x8F) continue
        if (op >= 0x60 && op <= 0x67) { p += 12; continue }
        if (op >= 0x68 && op <= 0x6F) { p += 4; continue }
        if (op >= 0x100 && op <= 0x7FFF) { p += (op >> 8) * 2; continue }
        if (op >= 0x8000 && op <= 0x80FF) continue
        if (op >= 0x8100) { p += 4 + dv.getUint32(p); continue }
        break
    }
    void scale
    if (jpeg && !out) return pagesOf([await blobPage(jpeg, 'image/jpeg')])
    if (!out) throw new ReaderError('В картинке PICT только векторные команды — их отрисовка пока не поддерживается.')
    return pagesOf([await page(W, H, out)])
}
const jpegInside = u8 => { for (let i = 0; i + 3 < u8.length; i++) if (u8[i] === 0xFF && u8[i + 1] === 0xD8 && u8[i + 2] === 0xFF) { let e = u8.length; for (let k = u8.length - 2; k > i; k--) if (u8[k] === 0xFF && u8[k + 1] === 0xD9) { e = k + 2; break } return u8.subarray(i, e) } return null }

// ================= GIMP (.xcf) =================
const halfToFloat = h => { const s = h >> 15 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023; return e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15) }
const linToSrgb = v => v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
export const openXcf = async buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (latin.decode(u8.subarray(0, 9)) !== 'gimp xcf ') throw new ReaderError('Это не файл GIMP (.xcf).')
    const vs = latin.decode(u8.subarray(9, 13))
    const ver = vs === 'file' ? 0 : +vs.slice(1)
    let p = 14
    const u32 = () => { const v = dv.getUint32(p); p += 4; return v }
    const ptr = () => { if (ver >= 11) { const v = Number(dv.getBigUint64(p)); p += 8; return v } return u32() }
    const W = u32(), H = u32(), base = u32()
    let precision = 150
    if (ver >= 4) { const pr = u32(); precision = ver >= 7 ? pr : [150, 250, 350, 550, 650][pr] ?? 150 }
    const bytesPer = { 1: 1, 2: 2, 3: 4, 5: 2, 6: 4, 7: 8 }[Math.floor(precision / 100)] ?? 1
    const isFloat = precision >= 500, linear = Math.floor(precision / 50) % 2 === 0
    let compression = 0, colormap = null
    const props = () => { const out = {}; for (let g = 0; g < 1000; g++) { const t = u32(), n = u32(); const s = p; if (t === 0) break; out[t] = s; if (t === 17) compression = u8[s]; if (t === 1) { const k = dv.getUint32(s); colormap = u8.subarray(s + 4, s + 4 + k * 3) } p = s + n } return out }
    props()
    const layerPtrs = []; for (let v; (v = ptr());) layerPtrs.push(v)
    const comp = (v) => { // значение канала → 0..1
        if (isFloat) return bytesPer === 2 ? halfToFloat(v) : v
        return v / (2 ** (bytesPer * 8) - 1)
    }
    const readComp = (bytes, o) => bytesPer === 1 ? bytes[o] : bytesPer === 2 ? (bytes[o] << 8 | bytes[o + 1]) : bytesPer === 4 ? (isFloat ? new DataView(bytes.buffer, bytes.byteOffset + o, 4).getFloat32(0) : new DataView(bytes.buffer, bytes.byteOffset + o, 4).getUint32(0)) : new DataView(bytes.buffer, bytes.byteOffset + o, 8).getFloat64(0)
    const out = new Float32Array(W * H * 4) // итоговое RGBA 0..1 (премультипликации нет)
    const layers = []
    for (const lp of layerPtrs) {
        p = lp
        const lw = u32(), lh = u32(), type = u32(); const nl = u32(); const name = new TextDecoder().decode(u8.subarray(p, p + nl - 1)); p += nl
        const pr = props()
        const visible = pr[8] != null ? dv.getUint32(pr[8]) !== 0 : true
        const opacity = pr[33] != null ? dv.getFloat32(pr[33]) : pr[6] != null ? dv.getUint32(pr[6]) / 255 : 1
        const ox = pr[15] != null ? dv.getInt32(pr[15]) : 0, oy = pr[15] != null ? dv.getInt32(pr[15] + 4) : 0
        const isGroup = pr[29] != null
        const mode = pr[7] != null ? dv.getUint32(pr[7]) : 0
        const hp = ptr(); ptr() // маска не применяется
        layers.push({ name, visible, opacity, isGroup, w: lw, h: lh, type, ox, oy, hp, mode })
    }
    // рисуем снизу вверх (в файле первый слой — верхний)
    for (const L of [...layers].reverse()) {
        if (!L.visible || L.isGroup || !L.hp) continue
        p = L.hp
        const hw = u32(), hh = u32(), bpp = u32(); const lev = ptr()
        p = lev; u32(); u32()
        const tiles = []; for (let v; (v = ptr());) tiles.push(v)
        const ch = bpp / bytesPer
        const tw = Math.ceil(hw / 64)
        tiles.forEach((tp, ti) => {
            const tx = (ti % tw) * 64, ty = Math.floor(ti / tw) * 64
            const w = Math.min(64, hw - tx), h = Math.min(64, hh - ty), n = w * h
            let px
            if (compression === 0) px = u8.subarray(tp, tp + n * bpp)
            else if (compression === 2) { const end = tiles[ti + 1] ?? u8.length; try { px = unzlibSync(u8.subarray(tp, end)) } catch { px = inflateSync(u8.subarray(tp + 2, end)) } }
            else { // RLE отдельно по каждому байту пикселя
                px = new Uint8Array(n * bpp); let q = tp
                for (let b = 0; b < bpp; b++) {
                    let i = 0
                    while (i < n) {
                        let c = u8[q++]
                        if (c >= 128) { let len = 256 - c; if (c === 128) { len = u8[q] << 8 | u8[q + 1]; q += 2 } for (let k = 0; k < len && i < n; k++) px[(i++) * bpp + b] = u8[q++] }
                        else { let len = c + 1; if (c === 127) { len = u8[q] << 8 | u8[q + 1]; q += 2 } const v = u8[q++]; for (let k = 0; k < len && i < n; k++) px[(i++) * bpp + b] = v }
                    }
                }
            }
            for (let k = 0; k < n; k++) {
                const X = L.ox + tx + k % w, Y = L.oy + ty + Math.floor(k / w)
                if (X < 0 || Y < 0 || X >= W || Y >= H) continue
                const v = c => comp(readComp(px, k * bpp + c * bytesPer))
                let r, g, b, a = 1
                if (L.type <= 1) { r = v(0); g = v(1); b = v(2); if (ch >= 4) a = v(3) }
                else if (L.type <= 3) { r = g = b = v(0); if (ch >= 2) a = v(1) }
                else { const i = px[k * bpp]; r = (colormap?.[i * 3] ?? 0) / 255; g = (colormap?.[i * 3 + 1] ?? 0) / 255; b = (colormap?.[i * 3 + 2] ?? 0) / 255; if (ch >= 2) a = px[k * bpp + 1] / 255; if (linear) { /* палитра всегда в sRGB */ } }
                if (linear && L.type <= 3) { r = linToSrgb(r); g = linToSrgb(g); b = linToSrgb(b) }
                a *= L.opacity
                const d = (Y * W + X) * 4, da = out[d + 3], oa = a + da * (1 - a)
                if (oa <= 0) continue
                out[d] = (r * a + out[d] * da * (1 - a)) / oa; out[d + 1] = (g * a + out[d + 1] * da * (1 - a)) / oa; out[d + 2] = (b * a + out[d + 2] * da * (1 - a)) / oa; out[d + 3] = oa
            }
        })
    }
    const rgba = new Uint8ClampedArray(W * H * 4)
    for (let i = 0; i < rgba.length; i++) rgba[i] = out[i] * 255 + 0.5
    const pg = await page(W, H, rgba)
    return { pages: pagesOf([pg]), layers, info: { W, H, base, precision, ver } }
}
export const xcfLayersHtml = r => `<div class="ur-meta">${r.info.W}×${r.info.H} · слоёв: ${r.layers.length}</div><ol class="ur-layer-list">${r.layers.map(l => `<li${l.visible ? '' : ' class="is-hidden"'}>${l.isGroup ? '📁 ' : ''}${esc(l.name)}${l.visible ? '' : ' <span class="ur-muted">(скрыт)</span>'}${l.opacity < 1 ? ` <span class="ur-muted">${Math.round(l.opacity * 100)}%</span>` : ''}${l.mode > 0 && l.mode !== 28 ? ' <span class="ur-muted">(режим наложения не учитывается)</span>' : ''}</li>`).join('')}</ol>`

// ================= JPEG 2000 =================
export const openJp2 = async (ctx, buf) => {
    const u8 = new Uint8Array(buf)
    let cs = u8
    if (latin.decode(u8.subarray(4, 8)) === 'jP  ') { // коробки JP2: ищем поток jp2c
        const dv = new DataView(buf); let p = 0; cs = null
        while (p + 8 <= u8.length) { let len = dv.getUint32(p); const t = latin.decode(u8.subarray(p + 4, p + 8)); let h = 8; if (len === 1) { len = Number(dv.getBigUint64(p + 8)); h = 16 } else if (len === 0) len = u8.length - p; if (t === 'jp2c') { cs = u8.subarray(p + h, p + len); break } p += len }
        if (!cs) throw new ReaderError('В файле JPEG 2000 нет изображения.')
    }
    const { decode } = await ctx.loadLib('openjpeg')
    const r = await decode(cs)
    return pagesOf([await page(r.width, r.height, j2kToRgba(r))])
}
export const j2kToRgba = r => {
    const n = r.width * r.height, out = new Uint8ClampedArray(n * 4)
    const b2 = r.bits > 8, dv = new DataView(r.data.buffer)
    const max = 2 ** r.bits - 1
    const get = (i) => b2 ? (r.signed ? dv.getInt16(i * 2, true) : dv.getUint16(i * 2, true)) * 255 / max : r.data[i]
    for (let i = 0; i < n; i++) {
        if (r.comps >= 3) { out[i * 4] = get(i * r.comps); out[i * 4 + 1] = get(i * r.comps + 1); out[i * 4 + 2] = get(i * r.comps + 2); out[i * 4 + 3] = r.comps === 4 ? get(i * 4 + 3) : 255 }
        else { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = get(i * r.comps); out[i * 4 + 3] = r.comps === 2 ? get(i * 2 + 1) : 255 }
    }
    return out
}

// ================= Превью внутри файлов редакторов =================
// 1) миниатюра в XMP (InDesign, Illustrator), 2) самая большая встроенная PNG/JPEG
export const xmpThumb = u8 => {
    const t = latin.decode(u8.length > 64e6 ? u8.subarray(0, 64e6) : u8)
    let best = null
    for (const m of t.matchAll(/<xmpGImg:image>([\s\S]*?)<\/xmpGImg:image>|xmpGImg:image="([^"]+)"/g)) {
        const b64 = (m[1] ?? m[2]).replace(/&#xA;|&#10;|\s/g, '')
        if (!best || b64.length > best.length) best = b64
    }
    if (!best) return null
    const bin = atob(best); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
}
export const embeddedImages = u8 => {
    const found = []
    for (let i = 0; i + 8 < u8.length && found.length < 200; i++) {
        if (u8[i] === 0x89 && u8[i + 1] === 0x50 && u8[i + 2] === 0x4E && u8[i + 3] === 0x47 && u8[i + 4] === 0x0D) {
            let p = i + 8; const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
            while (p + 12 <= u8.length) { const len = dv.getUint32(p); const t = latin.decode(u8.subarray(p + 4, p + 8)); if (!/^[A-Za-z]{4}$/.test(t)) break; p += 12 + len; if (t === 'IEND') { found.push({ type: 'image/png', bytes: u8.subarray(i, p) }); break } }
            i = Math.max(i, p - 1)
        } else if (u8[i] === 0xFF && u8[i + 1] === 0xD8 && u8[i + 2] === 0xFF && (u8[i + 3] & 0xF0) === 0xE0) {
            let p = i + 2; const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
            while (p + 4 <= u8.length && u8[p] === 0xFF) { const m = u8[p + 1]; if (m === 0xD9) { p += 2; break } if (m === 0xDA) { p += 2 + dv.getUint16(p + 2); while (p + 1 < u8.length && !(u8[p] === 0xFF && u8[p + 1] === 0xD9)) p++; p += 2; break } p += 2 + dv.getUint16(p + 2) }
            if (p - i > 200) found.push({ type: 'image/jpeg', bytes: u8.subarray(i, p) })
            i = p - 1
        }
    }
    return found.sort((a, b) => b.bytes.length - a.bytes.length)
}
export const previewOf = async (ctx, buf, ext) => {
    const u8 = new Uint8Array(buf)
    const tries = []
    if (ext === 'clip') { // Clip Studio: внутри — база SQLite с превью холста
        const at = latin.decode(u8.subarray(0, Math.min(u8.length, 256e6))).indexOf('SQLite format 3\0')
        if (at >= 0) {
            try {
                const { initSqlJs } = await ctx.loadLib('sqlite'); const SQL = await initSqlJs(); const db = new SQL.Database(u8.subarray(at))
                try { const r = db.exec('SELECT ImageData FROM CanvasPreview LIMIT 1')[0]?.values?.[0]?.[0]; if (r) tries.push({ type: 'image/png', bytes: r }) } finally { db.close() }
            } catch { /* база без превью */ }
        }
    }
    if (ext === 'graffle' && u8[0] === 0x50 && u8[1] === 0x4B) {
        const zip = await JSZip.loadAsync(buf)
        const n = Object.keys(zip.files).find(k => /(preview|thumbnail)\.(jpe?g|png)$/i.test(k)) ?? Object.keys(zip.files).find(k => /\.(png|jpe?g)$/i.test(k))
        if (n) tries.push({ type: /png$/i.test(n) ? 'image/png' : 'image/jpeg', bytes: await zip.file(n).async('uint8array') })
    }
    if (ext === 'graffle' && u8[0] === 0x1F && u8[1] === 0x8B && !tries.length) {
        const xml = new TextDecoder().decode(await gunzip(u8))
        const texts = [...xml.matchAll(/<key>Text<\/key>\s*<string>([\s\S]*?)<\/string>/g)].map(m => m[1].replace(/\\[a-z]+\d* ?|[{}]/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()).filter(Boolean)
        throw new ReaderError(`В этой схеме OmniGraffle нет сохранённого превью.${texts.length ? ' Надписи на схеме: ' + texts.slice(0, 40).join(' · ') : ''}`)
    }
    const x = xmpThumb(u8); if (x) tries.push({ type: 'image/jpeg', bytes: x })
    if (!tries.length) tries.push(...embeddedImages(u8).slice(0, 1))
    for (const t of tries) { try { return pagesOf([await blobPage(t.bytes, t.type)]) } catch { /* следующая */ } }
    throw new ReaderError('Внутри файла не нашлось сохранённого превью — содержимое этого формата закрыто.')
}

// ================= EPS: двоичное превью TIFF/WMF или EPSI =================
export const epsInfo = u8 => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    let ps = u8, tiff = null, wmf = null
    if (dv.getUint32(0) === 0xC5D0D3C6) {
        const g = o => dv.getUint32(o, true)
        ps = u8.subarray(g(4), g(4) + g(8))
        if (g(12) && g(16)) wmf = u8.subarray(g(12), g(12) + g(16))
        if (g(20) && g(24)) tiff = u8.subarray(g(20), g(20) + g(24))
    }
    const text = latin.decode(ps.subarray(0, Math.min(ps.length, 4e6)))
    const dsc = k => new RegExp(`^%%${k}:\\s*(.*)$`, 'm').exec(text)?.[1]?.trim() ?? ''
    return { ps, tiff, wmf, text, title: dsc('Title'), creator: dsc('Creator'), date: dsc('CreationDate'), bbox: dsc('BoundingBox') }
}
export const epsiPreview = text => {
    const m = /%%BeginPreview:\s*(\d+)\s+(\d+)\s+(\d+)\s+\d+\s*\r?\n([\s\S]*?)%%EndPreview/.exec(text)
    if (!m) return null
    const w = +m[1], h = +m[2], d = +m[3]
    const hex = m[4].replace(/[%\s]/g, '')
    const row = Math.ceil(w * d / 8)
    const out = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const bit = x * d, byte = parseInt(hex.substr((y * row + (bit >> 3)) * 2, 2), 16) || 0
        const v = (byte >> (8 - d - (bit & 7))) & ((1 << d) - 1)
        const g = v * 255 / ((1 << d) - 1) // в PostScript 0 — чёрный
        const o = ((h - 1 - y) * w + x) * 4 // EPSI идёт снизу вверх
        out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255
    }
    return { w, h, rgba: out }
}

// ================= Цветовые профили ICC =================
const ICC_CLASS = { scnr: 'устройство ввода (сканер, камера)', mntr: 'монитор', prtr: 'печать', link: 'связь устройств', spac: 'пространство цветов', abst: 'абстрактный', nmcl: 'именованные цвета' }
export const iccView = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (latin.decode(u8.subarray(36, 40)) !== 'acsp') throw new ReaderError('Это не цветовой профиль ICC.')
    const s4 = o => latin.decode(u8.subarray(o, o + 4)).replace(/\0/g, '').trim()
    const n = dv.getUint32(128)
    const tags = new Map()
    for (let i = 0; i < n; i++) { const o = 132 + i * 12; tags.set(s4(o), [dv.getUint32(o + 4), dv.getUint32(o + 8)]) }
    const text = sig => {
        const t = tags.get(sig); if (!t) return ''
        const [o, len] = t, type = s4(o)
        if (type === 'desc') { const l = dv.getUint32(o + 8); return latin.decode(u8.subarray(o + 12, o + 12 + l)).replace(/\0.*$/s, '') }
        if (type === 'text') return latin.decode(u8.subarray(o + 8, o + len)).replace(/\0.*$/s, '')
        if (type === 'mluc') { const cnt = dv.getUint32(o + 8); let best = ''; for (let i = 0; i < cnt; i++) { const r = o + 16 + i * 12; const lang = s4(r); const l = dv.getUint32(r + 4), off = dv.getUint32(r + 8); const s = new TextDecoder('utf-16be').decode(u8.subarray(o + off, o + off + l)); if (!best || lang === 'ru' || (lang === 'en' && !best)) best = s } return best }
        return ''
    }
    const xyz = sig => { const t = tags.get(sig); if (!t || s4(t[0]) !== 'XYZ') return null; const o = t[0] + 8; return [0, 1, 2].map(k => dv.getInt32(o + k * 4) / 65536) }
    const trc = sig => {
        const t = tags.get(sig); if (!t) return ''
        const o = t[0], type = s4(o)
        if (type === 'curv') { const c = dv.getUint32(o + 8); return c === 0 ? 'линейная' : c === 1 ? `гамма ${(dv.getUint16(o + 12) / 256).toFixed(2)}` : `таблица из ${c} точек` }
        if (type === 'para') return `гамма ${(dv.getInt32(o + 12) / 65536).toFixed(2)}${dv.getUint16(o + 8) ? ' (с линейным участком, как в sRGB)' : ''}`
        return type
    }
    const ver = `${u8[8]}.${u8[9] >> 4}${u8[9] & 15 ? '.' + (u8[9] & 15) : ''}`
    const date = `${dv.getUint16(28)}.${String(dv.getUint16(26)).padStart(2, '0')}.${dv.getUint16(24)}`.replace(/^(\d+)\.(\d+)\.(\d+)$/, (m, d, mo, y) => `${String(d).padStart(2, '0')}.${mo}.${y}`)
    const rows = [['Название', text('desc')], ['Авторские права', text('cprt')], ['Назначение', ICC_CLASS[s4(12)] ?? s4(12)], ['Цвета', s4(16)], ['Связующее пространство', s4(20)], ['Версия ICC', ver],
        ['Дата', date], ['Производитель', [s4(48), text('dmnd')].filter(Boolean).join(' ')], ['Модель', text('dmdd') || s4(52)], ['Создатель', s4(80)], ['Платформа', { APPL: 'Apple', MSFT: 'Microsoft', SGI: 'SGI', SUNW: 'Sun' }[s4(40)] ?? s4(40)],
        ['Кривая (красный)', trc('rTRC')], ['Кривая (серый)', trc('kTRC')], ['Размер', `${dv.getUint32(0)} байт, меток: ${n}`]]
    const wrap = el('div', 'ur-icc', `<h2>${esc(text('desc') || 'Цветовой профиль')}</h2><table class="ur-table ur-sci-info"><tbody>${rows.filter(r => r[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`)
    const R = xyz('rXYZ'), G = xyz('gXYZ'), B = xyz('bXYZ'), WP = xyz('wtpt')
    if (R && G && B) { // охват на диаграмме цветности xy
        const xy = c => [c[0] / (c[0] + c[1] + c[2]), c[1] / (c[0] + c[1] + c[2])]
        const pts = [R, G, B].map(xy)
        const locus = [[0.1741, 0.005], [0.1440, 0.0297], [0.1241, 0.0578], [0.0913, 0.1327], [0.0454, 0.2950], [0.0082, 0.5384], [0.0139, 0.7502], [0.0743, 0.8338], [0.1547, 0.8059], [0.2296, 0.7543], [0.3016, 0.6923], [0.3731, 0.6245], [0.4441, 0.5547], [0.5125, 0.4866], [0.5752, 0.4242], [0.6270, 0.3725], [0.6658, 0.3340], [0.6915, 0.3083], [0.7347, 0.2653]]
        const S = 300, X = v => 30 + v * S / 0.8, Y = v => S + 10 - v * S / 0.9
        const srgb = [[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]]
        wrap.append(el('section', '', `<h3>Охват цветов</h3><svg viewBox="0 0 ${S + 60} ${S + 40}" class="ur-icc-gamut"><polygon points="${locus.map(p => `${X(p[0])},${Y(p[1])}`).join(' ')}" fill="none" stroke="currentColor" opacity="0.4"/>
            <polygon points="${srgb.map(p => `${X(p[0])},${Y(p[1])}`).join(' ')}" fill="none" stroke="currentColor" stroke-dasharray="4 3" opacity="0.6"/>
            <polygon points="${pts.map(p => `${X(p[0])},${Y(p[1])}`).join(' ')}" fill="rgba(80,140,255,0.25)" stroke="#3a7bd5" stroke-width="2"/>
            ${pts.map((p, i) => `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="4" fill="${['#e33', '#3b3', '#33e'][i]}"/>`).join('')}
            ${WP ? `<circle cx="${X(xy(WP)[0])}" cy="${Y(xy(WP)[1])}" r="3" fill="none" stroke="currentColor"/>` : ''}
            <text x="${X(0.45)}" y="${Y(0.82)}" font-size="11" fill="currentColor" opacity="0.7">— профиль, - - - sRGB</text></svg>`))
    }
    wrap.append(el('details', '', `<summary>Все метки профиля</summary><table class="ur-table"><tbody>${[...tags].map(([k, [o, l]]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(s4(o))}</td><td>${l} байт</td></tr>`).join('')}</tbody></table>`))
    return wrap
}

// ================= LUT (.cube, .3dl): «до и после» на тестовой картинке =================
export const parseLut = (text, ext) => {
    const lines = text.split(/\r?\n/).map(l => l.replace(/#.*$/, '').trim()).filter(Boolean)
    let size = 0, size1 = 0, title = '', dmin = [0, 0, 0], dmax = [1, 1, 1]
    const data = []
    if (ext === 'cube') {
        for (const l of lines) {
            const m = /^(TITLE|LUT_3D_SIZE|LUT_1D_SIZE|DOMAIN_MIN|DOMAIN_MAX)\s+(.*)$/i.exec(l)
            if (m) { const k = m[1].toUpperCase(); if (k === 'TITLE') title = m[2].replace(/"/g, ''); else if (k === 'LUT_3D_SIZE') size = +m[2]; else if (k === 'LUT_1D_SIZE') size1 = +m[2]; else if (k === 'DOMAIN_MIN') dmin = m[2].split(/\s+/).map(Number); else dmax = m[2].split(/\s+/).map(Number); continue }
            const v = l.split(/\s+/).map(Number); if (v.length === 3 && v.every(Number.isFinite)) data.push(v)
        }
        if (!size && !size1) throw new ReaderError('В файле нет размера таблицы (LUT_3D_SIZE).')
        return { title, size, size1, data, dmin, dmax, order: 'r' }
    }
    // .3dl: первая строка может быть «сеткой» входных значений
    let rows = lines.map(l => l.split(/\s+/).map(Number)).filter(v => v.every(Number.isFinite))
    if (rows[0]?.length > 3) rows = rows.slice(1)
    rows = rows.filter(v => v.length === 3)
    const max = Math.max(...rows.flat())
    const scale = max > 4095 ? 65535 : max > 1023 ? 4095 : max > 1 ? 1023 : 1
    size = Math.round(Math.cbrt(rows.length))
    if (size ** 3 !== rows.length) throw new ReaderError('Не удалось понять размер таблицы .3dl.')
    return { title: '', size, data: rows.map(v => v.map(x => x / scale)), dmin, dmax, order: 'b' }
}
const applyLut = (lut, r, g, b) => {
    const nr = (r - lut.dmin[0]) / (lut.dmax[0] - lut.dmin[0]), ng = (g - lut.dmin[1]) / (lut.dmax[1] - lut.dmin[1]), nb = (b - lut.dmin[2]) / (lut.dmax[2] - lut.dmin[2])
    if (!lut.size) { const n = lut.size1 - 1; const f = (v, c) => { const x = Math.max(0, Math.min(n, v * n)), i = Math.floor(x), t = x - i; return lut.data[i][c] * (1 - t) + lut.data[Math.min(n, i + 1)][c] * t }; return [f(nr, 0), f(ng, 1), f(nb, 2)] }
    const n = lut.size - 1
    const idx = (i, j, k) => lut.order === 'r' ? lut.data[i + j * lut.size + k * lut.size * lut.size] : lut.data[k + j * lut.size + i * lut.size * lut.size]
    const x = Math.max(0, Math.min(n, nr * n)), y = Math.max(0, Math.min(n, ng * n)), z = Math.max(0, Math.min(n, nb * n))
    const i = Math.min(n - 1, Math.floor(x)), j = Math.min(n - 1, Math.floor(y)), k = Math.min(n - 1, Math.floor(z)), fx = x - i, fy = y - j, fz = z - k
    const out = [0, 0, 0]
    for (let c = 0; c < 3; c++) {
        const c00 = idx(i, j, k)[c] * (1 - fx) + idx(i + 1, j, k)[c] * fx, c10 = idx(i, j + 1, k)[c] * (1 - fx) + idx(i + 1, j + 1, k)[c] * fx
        const c01 = idx(i, j, k + 1)[c] * (1 - fx) + idx(i + 1, j, k + 1)[c] * fx, c11 = idx(i, j + 1, k + 1)[c] * (1 - fx) + idx(i + 1, j + 1, k + 1)[c] * fx
        out[c] = (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz
    }
    return out
}
export const lutView = (text, ext) => {
    const lut = parseLut(text, ext)
    // тестовая картинка: радуга сверху, телесные тона, серая шкала снизу
    const W = 480, H = 270
    const src = new Float32Array(W * H * 3)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 3, t = x / (W - 1)
        let c
        if (y < 150) { const h = t * 6, l = 1 - y / 150 * 0.5; const f = (n) => { const k = (n + h) % 6; return Math.max(0, Math.min(1, Math.abs(k - 3) - 1)) }; c = [f(0), f(4), f(2)].map(v => v * l + (1 - l) * 0.15 * 0) }
        else if (y < 210) { const tones = [[0.98, 0.84, 0.74], [0.91, 0.72, 0.58], [0.78, 0.57, 0.42], [0.55, 0.38, 0.27], [0.36, 0.24, 0.17], [0.2, 0.4, 0.15], [0.3, 0.55, 0.85], [0.95, 0.85, 0.3]]; c = tones[Math.min(7, Math.floor(t * 8))] }
        else c = [t, t, t]
        src[o] = c[0]; src[o + 1] = c[1]; src[o + 2] = c[2]
    }
    const draw = (fn) => { const cv = el('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d'); const im = g.createImageData(W, H); for (let i = 0; i < W * H; i++) { const c = fn(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]); im.data[i * 4] = c[0] * 255; im.data[i * 4 + 1] = c[1] * 255; im.data[i * 4 + 2] = c[2] * 255; im.data[i * 4 + 3] = 255 } g.putImageData(im, 0, 0); return cv }
    const wrap = el('div', 'ur-lut', `<h2>${esc(lut.title || 'Цветовая таблица (LUT)')}</h2><div class="ur-meta">${lut.size ? `3D-таблица ${lut.size}×${lut.size}×${lut.size}` : `1D-таблица на ${lut.size1} точек`} · так она меняет цвета на тестовой картинке</div>`)
    const grid = el('div', 'ur-lut-grid')
    const a = el('figure', '', ''), b = el('figure', '', '')
    a.append(draw((r, g, bl) => [r, g, bl]), el('figcaption', '', 'До')); b.append(draw((r, g, bl) => applyLut(lut, r, g, bl)), el('figcaption', '', 'После'))
    grid.append(a, b); wrap.append(grid)
    return wrap
}

// ================= Blender (.blend): миниатюра, сохранённая в файле =================
export const blendThumb = async (ctx, buf) => {
    let u8 = new Uint8Array(buf)
    if (u8[0] === 0x1F && u8[1] === 0x8B) u8 = await gunzip(u8)
    else if (u8[0] === 0x28 && u8[1] === 0xB5) { const z = await ctx.loadLib('zstd'); u8 = z.decompress(u8) }
    if (latin.decode(u8.subarray(0, 7)) !== 'BLENDER') throw new ReaderError('Это не файл Blender.')
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    let p, big, ptr, le, ver
    if (u8[7] === 0x5F || u8[7] === 0x2D) { ptr = u8[7] === 0x5F ? 4 : 8; le = u8[8] === 0x76; ver = latin.decode(u8.subarray(9, 12)); p = 12; big = false }
    else { // новый заголовок Blender 5: BLENDER17-01v0500
        const hl = +latin.decode(u8.subarray(7, 9)); ptr = 8; le = latin.decode(u8.subarray(12, 13)) === 'v'; ver = latin.decode(u8.subarray(13, 17)); p = hl; big = true
    }
    while (p + 16 < u8.length) {
        const code = latin.decode(u8.subarray(p, p + 4))
        let len, head
        if (big) { len = Number(dv.getBigInt64(p + 16, le)); head = 32 } else { len = dv.getInt32(p + 4, le); head = ptr === 8 ? 24 : 20 }
        const d = p + head
        if (code === 'TEST') {
            const w = dv.getInt32(d, le), h = dv.getInt32(d + 4, le)
            const px = u8.subarray(d + 8, d + 8 + w * h * 4), out = new Uint8ClampedArray(w * h * 4)
            for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4) // строки снизу вверх
            return { pages: pagesOf([await page(w, h, out)], [{ label: `Миниатюра, сохранённая Blender ${ver.replace(/^0?(\d)(\d+)$/, '$1.$2')} (сама сцена не отрисовывается)`, target: 0 }]) }
        }
        if (code === 'ENDB' || code === 'DNA1' && false) break
        p = d + len
    }
    throw new ReaderError(`В файле Blender ${ver.replace(/^0?(\d)(\d+)$/, '$1.$2')} нет сохранённой миниатюры — саму сцену читалка отрисовать не может.`)
}
