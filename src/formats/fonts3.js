// Шрифты версии 0.6: точечные X11 (.pcf), BMFont (.fnt + картинки), чемоданы Mac (.dfont), исходники шрифтов
// FontForge (.sfd), Glyphs (.glyphs), UFO в zip (.ufoz), FontLab (.vfj), штриховые Hershey (.jhf) и Borland BGI (.chr)
import JSZip from 'jszip'
import { escapeHtml as esc, ReaderError } from '../util.js'

const latin = new TextDecoder('latin1')
const utf8 = new TextDecoder()
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e }
const SAMPLE = 'Съешь же ещё этих мягких французских булок, да выпей чаю. The quick brown fox jumps over the lazy dog 0123456789'

// ================= PCF (X11) → тот же вид, что у BDF =================
export const parsePcf = u8 => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    if (!(u8[0] === 1 && latin.decode(u8.subarray(1, 4)) === 'fcp')) throw new ReaderError('Это не шрифт PCF.')
    const n = dv.getUint32(4, true), tables = {}
    for (let i = 0; i < n; i++) { const o = 8 + i * 16; tables[dv.getUint32(o, true)] = { format: dv.getUint32(o + 4, true), size: dv.getUint32(o + 8, true), off: dv.getUint32(o + 12, true) } }
    const T = type => { const t = tables[type]; if (!t) return null; const fmt = dv.getUint32(t.off, true); const be = !!(fmt & 4); return { ...t, fmt, be, u16: o => dv.getUint16(t.off + o, !be), i16: o => dv.getInt16(t.off + o, !be), u32: o => dv.getUint32(t.off + o, !be), i32: o => dv.getInt32(t.off + o, !be) } }
    const font = { name: '', glyphs: new Map(), height: 0, ascent: 0 }
    const pr = T(1)
    if (pr) {
        const np = pr.u32(4); const strBase = pr.off + 8 + np * 9 + ((np & 3) ? 4 - (np & 3) : 0) + 4
        for (let i = 0; i < np; i++) {
            const o = 8 + i * 9, name = latin.decode(u8.subarray(strBase + pr.u32(o), u8.indexOf(0, strBase + pr.u32(o))))
            const isStr = u8[pr.off + o + 4], v = pr.i32(o + 5)
            const val = isStr ? utf8.decode(u8.subarray(strBase + v, u8.indexOf(0, strBase + v))) : v
            if (name === 'FAMILY_NAME') font.family = val; else if (name === 'COPYRIGHT') font.copyright = val; else if (name === 'FONT') font.name = val; else if (name === 'WEIGHT_NAME' && /bold/i.test(val)) font.weight = 700; else if (name === 'POINT_SIZE') font.points = Math.round(val / 10)
        }
    }
    const acc = T(256) ?? T(2)
    if (acc) { font.ascent = acc.i32(12); font.height = acc.i32(12) + acc.i32(16) }
    const mt = T(4), bm = T(8), en = T(32)
    if (!mt || !bm || !en) throw new ReaderError('В шрифте PCF нет нужных таблиц.')
    const metrics = []
    if (mt.fmt & 0x100) { const c = mt.u16(4); for (let i = 0; i < c; i++) { const o = mt.off + 6 + i * 5; metrics.push({ lsb: u8[o] - 0x80, rsb: u8[o + 1] - 0x80, w: u8[o + 2] - 0x80, asc: u8[o + 3] - 0x80, desc: u8[o + 4] - 0x80 }) } }
    else { const c = mt.u32(4); for (let i = 0; i < c; i++) { const o = 8 + i * 12; metrics.push({ lsb: mt.i16(o), rsb: mt.i16(o + 2), w: mt.i16(o + 4), asc: mt.i16(o + 6), desc: mt.i16(o + 8) }) } }
    const cnt = bm.u32(4), pad = [1, 2, 4, 8][bm.fmt & 3], msbit = !!(bm.fmt & 8)
    const offs = Array.from({ length: cnt }, (_, i) => bm.u32(8 + i * 4))
    const data = bm.off + 8 + cnt * 4 + 16
    const min2 = en.u16(4), max2 = en.u16(6), min1 = en.u16(8), max1 = en.u16(10)
    const cols = max2 - min2 + 1
    for (let b1 = min1; b1 <= max1; b1++) for (let b2 = min2; b2 <= max2; b2++) {
        const gi = en.u16(14 + ((b1 - min1) * cols + (b2 - min2)) * 2); if (gi === 0xFFFF || gi >= metrics.length) continue
        const m = metrics[gi], w = m.rsb - m.lsb, h = m.asc + m.desc
        const rowBytes = Math.ceil(Math.max(1, w) / (pad * 8)) * pad
        const rows = []
        for (let y = 0; y < h; y++) { const r = []; for (let x = 0; x < w; x++) { const byte = u8[data + offs[gi] + y * rowBytes + (x >> 3)]; r.push(msbit ? (byte >> (7 - (x & 7))) & 1 : (byte >> (x & 7)) & 1) } rows.push(r) }
        const code = (b1 << 8) | b2
        try { font.glyphs.set(String.fromCodePoint(code), { rows, w, h, xoff: m.lsb, yoff: -m.desc, dw: m.w }) } catch { /* код вне Юникода */ }
    }
    if (!font.height) { font.ascent = Math.max(...metrics.map(m => m.asc)); font.height = font.ascent + Math.max(...metrics.map(m => m.desc)) }
    return [font]
}

// ================= BMFont (.fnt + картинки страниц) =================
export const isBmFont = u8 => { const h = latin.decode(u8.subarray(0, 64)); return /^info\s+face=/.test(h) || /^BMF\x03/.test(h) || /^\s*<\?xml[\s\S]*<font>|^\s*<font>/.test(latin.decode(u8.subarray(0, 300))) }
export const parseBmFont = u8 => {
    const f = { pages: [], chars: new Map(), info: {}, common: {} }
    const h = latin.decode(u8.subarray(0, 4))
    if (h === 'BMF\x03') {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let p = 4
        while (p + 5 <= u8.length) {
            const t = u8[p], len = dv.getUint32(p + 1, true), d = p + 5
            if (t === 1) f.info.face = utf8.decode(u8.subarray(d + 14, u8.indexOf(0, d + 14))), f.info.size = Math.abs(dv.getInt16(d, true))
            else if (t === 2) { f.common.lineHeight = dv.getUint16(d, true); f.common.base = dv.getUint16(d + 2, true) }
            else if (t === 3) { let q = d; while (q < d + len) { const z = u8.indexOf(0, q); f.pages.push(utf8.decode(u8.subarray(q, z))); q = z + 1 } }
            else if (t === 4) for (let q = d; q + 20 <= d + len; q += 20) f.chars.set(dv.getUint32(q, true), { x: dv.getUint16(q + 4, true), y: dv.getUint16(q + 6, true), w: dv.getUint16(q + 8, true), h: dv.getUint16(q + 10, true), xo: dv.getInt16(q + 12, true), yo: dv.getInt16(q + 14, true), adv: dv.getInt16(q + 16, true), page: u8[q + 18] })
            p = d + len
        }
        return f
    }
    const text = utf8.decode(u8)
    if (/<font>/.test(text)) {
        const d = new DOMParser().parseFromString(text, 'application/xml')
        const a = (e, k) => e?.getAttribute(k)
        f.info.face = a(d.querySelector('info'), 'face'); f.info.size = Math.abs(+a(d.querySelector('info'), 'size'))
        f.common.lineHeight = +a(d.querySelector('common'), 'lineHeight'); f.common.base = +a(d.querySelector('common'), 'base')
        for (const p of d.querySelectorAll('pages page')) f.pages[+a(p, 'id')] = a(p, 'file')
        for (const c of d.querySelectorAll('chars char')) f.chars.set(+a(c, 'id'), { x: +a(c, 'x'), y: +a(c, 'y'), w: +a(c, 'width'), h: +a(c, 'height'), xo: +a(c, 'xoffset'), yo: +a(c, 'yoffset'), adv: +a(c, 'xadvance'), page: +a(c, 'page') })
        return f
    }
    for (const line of text.split(/\r?\n/)) {
        const [tag, ...rest] = line.trim().split(/\s+/)
        const kv = Object.fromEntries([...line.matchAll(/(\w+)=("([^"]*)"|\S+)/g)].map(m => [m[1], m[3] ?? m[2]]))
        if (tag === 'info') { f.info.face = kv.face; f.info.size = Math.abs(+kv.size) }
        else if (tag === 'common') { f.common.lineHeight = +kv.lineHeight; f.common.base = +kv.base }
        else if (tag === 'page') f.pages[+kv.id] = kv.file
        else if (tag === 'char') f.chars.set(+kv.id, { x: +kv.x, y: +kv.y, w: +kv.width, h: +kv.height, xo: +kv.xoffset, yo: +kv.yoffset, adv: +kv.xadvance, page: +kv.page })
        void rest
    }
    return f
}
export const bmFontView = async (f, loadPage) => {
    const imgs = await Promise.all(f.pages.map(async p => { try { const u = await loadPage(p); if (!u) return null; const im = new Image(); im.src = u; await im.decode(); return im } catch { return null } }))
    const wrap = el('div', '', `<h2>${esc(f.info.face ?? 'Шрифт BMFont')}</h2><div class="ur-meta">Шрифт для игр (BMFont) · размер ${f.info.size ?? '?'} · символов: ${f.chars.size} · картинок: ${f.pages.length}</div>`)
    if (!imgs.some(Boolean)) { wrap.append(el('p', 'ur-error', `Не нашлись картинки шрифта (${f.pages.map(esc).join(', ')}) — они должны лежать рядом с файлом .fnt.`)); return wrap }
    const draw = (text, scale = 1) => {
        const lh = f.common.lineHeight || f.info.size || 32
        let w = 0; for (const ch of text) w += f.chars.get(ch.codePointAt(0))?.adv ?? lh / 3
        const c = el('canvas'); c.width = Math.max(1, w * scale); c.height = lh * scale
        const g = c.getContext('2d'); g.imageSmoothingEnabled = false
        let x = 0
        for (const ch of text) { const m = f.chars.get(ch.codePointAt(0)); if (m && imgs[m.page]) g.drawImage(imgs[m.page], m.x, m.y, m.w, m.h, (x + m.xo) * scale, m.yo * scale, m.w * scale, m.h * scale); x += m?.adv ?? lh / 3 }
        c.style.maxWidth = '100%'; return c
    }
    const sample = [...SAMPLE].filter(c => c === ' ' || f.chars.has(c.codePointAt(0))).join('').replace(/\s+/g, ' ').trim().slice(0, 70)
    for (const s of [1, 2]) { const row = el('div', 'ur-bitmap-sample'); row.append(draw(sample, s)); wrap.append(row) }
    wrap.append(el('h3', '', 'Картинки шрифта'))
    for (const im of imgs) if (im) { im.className = 'ur-bmfont-page'; wrap.append(im) }
    return wrap
}

// ================= Чемоданы шрифтов Mac (.dfont и ресурсы) =================
export const dfontSfnts = u8 => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    const dataOff = dv.getUint32(0), mapOff = dv.getUint32(4)
    if (mapOff >= u8.length || dataOff >= u8.length) throw new ReaderError('Это не чемодан шрифтов Mac.')
    const tl = mapOff + dv.getUint16(mapOff + 24), nl = mapOff + dv.getUint16(mapOff + 26)
    const nTypes = dv.getUint16(tl) + 1
    const out = [], types = []
    for (let i = 0; i < nTypes; i++) {
        const o = tl + 2 + i * 8, type = latin.decode(u8.subarray(o, o + 4)), cnt = dv.getUint16(o + 4) + 1, ref = tl + dv.getUint16(o + 6)
        types.push(type)
        if (type !== 'sfnt') continue
        for (let k = 0; k < cnt; k++) {
            const r = ref + k * 12, nameOff = dv.getInt16(r + 2), d = dataOff + (dv.getUint32(r + 4) & 0xFFFFFF)
            const len = dv.getUint32(d)
            const name = nameOff >= 0 ? latin.decode(u8.subarray(nl + nameOff + 1, nl + nameOff + 1 + u8[nl + nameOff])) : ''
            out.push({ name, bytes: u8.slice(d + 4, d + 4 + len) })
        }
    }
    if (!out.length) throw new ReaderError(types.includes('NFNT') || types.includes('FONT') ? 'В чемодане только старые точечные шрифты Mac (NFNT) — они пока не поддерживаются.' : 'В файле нет шрифтов.')
    return out
}

// ================= Контурные шрифты-исходники: общий вид =================
// glyphs: [{ name, ch, d (SVG-путь в единицах шрифта, ось Y вверх), adv }]
export const outlineFontView = ({ family, upm = 1000, asc, desc, glyphs, note = '' }) => {
    asc ??= upm * 0.8; desc ??= -upm * 0.2
    const map = new Map(glyphs.filter(g => g.ch).map(g => [g.ch, g]))
    const wrap = el('div', 'ur-outline-font', `<h2>${esc(family || 'Шрифт')}</h2><div class="ur-meta">Знаков: ${glyphs.length} · единиц на кегль: ${upm}${note ? ' · ' + esc(note) : ''}</div>`)
    const H = asc - desc
    const text = s => { let x = 0; let paths = ''; for (const ch of s) { const g = map.get(ch); if (g?.d) paths += `<path transform="translate(${x} 0)" d="${g.d}"/>`; x += g?.adv ?? upm * 0.35 } return `<svg viewBox="0 ${-asc} ${Math.max(1, x)} ${H}" class="ur-outline-line"><g transform="scale(1,-1)" fill="currentColor">${paths}</g></svg>` }
    // строки образца — только из тех знаков, что есть
    const sample = [...SAMPLE].filter(c => c === ' ' || map.has(c)).join('')
    if (sample.trim()) for (const s of [48, 32]) { const d = el('div', 'ur-outline-sample'); d.style.height = s + 'px'; d.innerHTML = text(sample); wrap.append(d) }
    const grid = el('div', 'ur-outline-grid')
    for (const g of glyphs.slice(0, 1500)) {
        const w = Math.max(g.adv || upm / 2, upm * 0.3)
        grid.append(el('figure', '', `<svg viewBox="0 ${-asc} ${w} ${H}"><line x1="0" x2="${w}" y1="0" y2="0" class="base"/><g transform="scale(1,-1)" fill="currentColor"><path d="${g.d ?? ''}"/></g></svg><figcaption>${esc(g.ch ?? '')} <span class="ur-muted">${esc(g.name ?? '')}</span></figcaption>`))
    }
    wrap.append(grid)
    return wrap
}
// точки контура с признаками → путь SVG (для UFO и Glyphs): тип 'line'|'curve'|'qcurve'|'move'|'offcurve'
const contourPath = pts => {
    if (!pts.length) return ''
    const on = pts.findIndex(p => p.type !== 'offcurve')
    if (on < 0) return '' // только кривая без опорных точек (квадратичная окружность) — пропускаем
    const seq = [...pts.slice(on), ...pts.slice(0, on)]
    const open = seq[0].type === 'move'
    let d = `M${seq[0].x} ${seq[0].y}`
    let off = []
    const emit = p => {
        if (p.type === 'offcurve') { off.push(p); return }
        if (p.type === 'curve' && off.length >= 2) d += `C${off[0].x} ${off[0].y} ${off[1].x} ${off[1].y} ${p.x} ${p.y}`
        else if (p.type === 'curve' && off.length === 1) d += `Q${off[0].x} ${off[0].y} ${p.x} ${p.y}`
        else if (p.type === 'qcurve' && off.length) { for (let i = 0; i < off.length - 1; i++) { const mx = (off[i].x + off[i + 1].x) / 2, my = (off[i].y + off[i + 1].y) / 2; d += `Q${off[i].x} ${off[i].y} ${mx} ${my}` } d += `Q${off[off.length - 1].x} ${off[off.length - 1].y} ${p.x} ${p.y}` }
        else d += `L${p.x} ${p.y}`
        off = []
    }
    for (let i = 1; i < seq.length; i++) emit(seq[i])
    if (!open) { emit({ ...seq[0] }); d += 'Z' }
    return d
}

// FontForge .sfd
export const parseSfd = text => {
    if (!/^SplineFontDB:/.test(text)) throw new ReaderError('Это не исходник FontForge (.sfd).')
    const head = k => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(text)?.[1]?.trim() ?? ''
    const asc = +head('Ascent') || 800, desc = -(+head('Descent') || 200)
    const glyphs = [], byGid = new Map()
    for (const m of text.matchAll(/^StartChar:\s*(.*)\n([\s\S]*?)^EndChar/gm)) {
        const body = m[2]
        const enc = /^Encoding:\s*(-?\d+)\s+(-?\d+)\s+(\d+)/m.exec(body)
        const uni = enc ? +enc[2] : -1, gid = enc ? +enc[3] : glyphs.length
        const adv = +(/^Width:\s*(-?\d+)/m.exec(body)?.[1] ?? 0)
        let d = ''
        const ss = /^(?:SplineSet|Fore\nSplineSet)\n([\s\S]*?)^EndSplineSet/m.exec(body)
        if (ss) for (const l of ss[1].split('\n')) {
            const t = l.trim().split(/\s+/); const op = t.find(x => /^[mlc]$/.test(x)); if (!op) continue
            const n = t.slice(0, t.indexOf(op)).map(Number)
            if (op === 'm') d += (d ? 'Z' : '') + `M${n[0]} ${n[1]}`; else if (op === 'l') d += `L${n[0]} ${n[1]}`; else d += `C${n.join(' ')}`
        }
        if (d) d += 'Z'
        const refs = [...body.matchAll(/^Refer:\s*(\d+)\s+-?\d+\s+\S+\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)/gm)].map(r => ({ gid: +r[1], t: r.slice(2, 8).map(Number) }))
        const g = { name: m[1].trim(), ch: uni > 0 ? String.fromCodePoint(uni) : null, d, adv, refs }
        glyphs.push(g); byGid.set(gid, g)
    }
    for (const g of glyphs) for (const r of g.refs) { const src = byGid.get(r.gid); if (src?.d) g.d = (g.d || '') + transformPath(src.d, r.t) }
    return { family: head('FamilyName') || head('FontName'), upm: asc - desc, asc, desc, glyphs, note: head('Copyright') }
}
const transformPath = (d, [a, b, c, dd, e, f]) => d.replace(/([MLCQ])([^MLCQZ]*)/g, (m, op, nums) => { const n = nums.trim().split(/[\s,]+/).filter(Boolean).map(Number); const out = []; for (let i = 0; i + 1 < n.length; i += 2) out.push(+(a * n[i] + c * n[i + 1] + e).toFixed(2), +(b * n[i] + dd * n[i + 1] + f).toFixed(2)); return op + out.join(' ') })

// OpenStep-plist (формат .glyphs)
const parseOpenStep = text => {
    let i = 0
    const ws = () => { for (;;) { while (/\s/.test(text[i] ?? '')) i++; if (text.startsWith('//', i)) { while (i < text.length && text[i] !== '\n') i++; continue } if (text.startsWith('/*', i)) { i = text.indexOf('*/', i) + 2; continue } break } }
    const val = () => {
        ws()
        const c = text[i]
        if (c === '{') { i++; const o = {}; for (;;) { ws(); if (text[i] === '}') { i++; break } const k = val(); ws(); i++ /* = */; o[k] = val(); ws(); if (text[i] === ';') i++ } return o }
        if (c === '(') { i++; const a = []; for (;;) { ws(); if (text[i] === ')') { i++; break } a.push(val()); ws(); if (text[i] === ',') i++ } return a }
        if (c === '"') { i++; let s = ''; while (i < text.length && text[i] !== '"') { if (text[i] === '\\') { i++; const e = text[i]; s += e === 'n' ? '\n' : e === 'U' ? String.fromCharCode(parseInt(text.substr(i + 1, 4), 16)) : e; if (e === 'U') i += 4 } else s += text[i]; i++ } i++; return s }
        if (c === '<') { const e = text.indexOf('>', i); const s = text.slice(i, e + 1); i = e + 1; return s }
        const m = /^[^\s;,)}=]+/.exec(text.slice(i, i + 200)); i += m ? m[0].length : 1; return m ? m[0] : ''
    }
    return val()
}
export const parseGlyphsApp = text => {
    const f = parseOpenStep(text)
    if (!f?.glyphs) throw new ReaderError('Это не исходник Glyphs (.glyphs).')
    const v3 = +f['.formatVersion'] === 3
    const master = f.fontMaster?.[0] ?? {}
    const upm = +f.unitsPerEm || 1000
    const asc = v3 ? +(master.metricValues?.[0]?.pos ?? upm * 0.75) : +(master.ascender ?? upm * 0.75)
    const desc = v3 ? +(master.metricValues?.[1]?.pos ?? -upm * 0.25) : +(master.descender ?? -upm * 0.25)
    const byName = new Map()
    const glyphs = f.glyphs.map(g => {
        const layer = (g.layers ?? []).find(l => l.layerId === master.id || l.associatedMasterId === master.id) ?? g.layers?.[0] ?? {}
        const shapes = layer.shapes ?? [...(layer.paths ?? []), ...(layer.components ?? [])]
        let d = '', comps = []
        for (const s of shapes) {
            if (s.ref || s.name) { comps.push({ ref: s.ref ?? s.name, pos: s.pos ?? (s.transform ? String(s.transform).replace(/[{}]/g, '').split(/,\s*/).slice(4).map(Number) : [0, 0]) }); continue }
            const pts = (s.nodes ?? []).map(n => {
                if (Array.isArray(n)) return { x: +n[0], y: +n[1], type: { l: 'line', c: 'curve', o: 'offcurve', q: 'qcurve', ls: 'line', cs: 'curve', qs: 'qcurve' }[n[2]] ?? 'line' }
                const t = String(n).split(/\s+/); return { x: +t[0], y: +t[1], type: { LINE: 'line', CURVE: 'curve', OFFCURVE: 'offcurve', QCURVE: 'qcurve' }[t[2]] ?? 'line' }
            })
            if (+s.closed === 0 && pts[0]) pts[0].type = 'move'
            d += contourPath(pts)
        }
        const uni = g.unicode != null ? (v3 ? (Array.isArray(g.unicode) ? +g.unicode[0] : +g.unicode) : parseInt(String(g.unicode).split(',')[0], 16)) : null
        const out = { name: g.glyphname, ch: uni ? String.fromCodePoint(uni) : null, d, adv: +(layer.width ?? 600), comps }
        byName.set(g.glyphname, out); return out
    })
    for (const g of glyphs) for (const c of g.comps) { const s = byName.get(c.ref); if (s?.d) g.d += transformPath(s.d, [1, 0, 0, 1, +c.pos[0] || 0, +c.pos[1] || 0]) }
    return { family: f.familyName, upm, asc, desc, glyphs }
}
// UFO в zip (.ufoz)
export const parseUfoz = async buf => {
    const zip = await JSZip.loadAsync(buf)
    const names = Object.keys(zip.files)
    const root = names.find(n => /(^|\/)fontinfo\.plist$/.test(n))?.replace(/fontinfo\.plist$/, '') ?? names.find(n => /\.ufo\/$/.test(n)) ?? ''
    const plist = async n => { const t = await zip.file(root + n)?.async('string'); if (!t) return {}; const d = new DOMParser().parseFromString(t, 'application/xml'); const o = {}; const keys = [...d.querySelectorAll('dict > key')]; for (const k of keys) { const v = k.nextElementSibling; o[k.textContent] = v?.tagName === 'integer' || v?.tagName === 'real' ? +v.textContent : v?.textContent } return o }
    const info = await plist('fontinfo.plist'), contents = await plist('glyphs/contents.plist')
    const byName = new Map(), glyphs = []
    for (const [name, file] of Object.entries(contents)) {
        const t = await zip.file(root + 'glyphs/' + file)?.async('string'); if (!t) continue
        const d = new DOMParser().parseFromString(t, 'application/xml')
        let path = ''
        for (const c of d.querySelectorAll('outline > contour')) path += contourPath([...c.querySelectorAll('point')].map(p => ({ x: +p.getAttribute('x'), y: +p.getAttribute('y'), type: p.getAttribute('type') ?? 'offcurve' })))
        const comps = [...d.querySelectorAll('outline > component')].map(c => ({ ref: c.getAttribute('base'), t: ['xScale', 'xyScale', 'yxScale', 'yScale', 'xOffset', 'yOffset'].map((k, i) => +(c.getAttribute(k) ?? (i === 0 || i === 3 ? 1 : 0))) }))
        const uni = d.querySelector('unicode')?.getAttribute('hex')
        const g = { name, ch: uni ? String.fromCodePoint(parseInt(uni, 16)) : null, d: path, adv: +(d.querySelector('advance')?.getAttribute('width') ?? 500), comps }
        byName.set(name, g); glyphs.push(g)
    }
    for (const g of glyphs) for (const c of g.comps) { const s = byName.get(c.ref); if (s?.d) g.d += transformPath(s.d, c.t) }
    if (!glyphs.length) throw new ReaderError('В архиве UFO нет знаков.')
    return { family: info.familyName, upm: info.unitsPerEm || 1000, asc: info.ascender, desc: info.descender, glyphs: glyphs.sort((a, b) => (a.ch ?? '￿').localeCompare(b.ch ?? '￿')) }
}
// FontLab JSON (.vfj)
export const parseVfj = text => {
    const j = JSON.parse(text)
    const font = j.font ?? j
    if (!font.glyphs) throw new ReaderError('Это не исходник FontLab (.vfj).')
    const master = font.defaultMaster
    const glyphs = font.glyphs.map(g => {
        const layer = (g.layers ?? []).find(l => l.name === master) ?? g.layers?.[0] ?? {}
        let d = ''
        const walk = els => { for (const e of els ?? []) { if (e.elements) walk(e.elements); for (const c of e.elementData?.contours ?? []) { let first = true; for (const n of c.nodes ?? []) { const v = String(n).replace(/[^\d.\-\s]/g, ' ').trim().split(/\s+/).map(Number); if (first) { d += `M${v[0]} ${v[1]}`; first = false } else if (v.length >= 6) d += `C${v.slice(0, 6).join(' ')}`; else if (v.length >= 4) d += `Q${v.slice(0, 4).join(' ')}`; else d += `L${v[0]} ${v[1]}` } d += 'Z' } } }
        walk(layer.elements)
        const uni = g.unicode ? String(g.unicode).split(',')[0] : null
        return { name: g.name, ch: uni ? String.fromCodePoint(parseInt(uni, 16)) : null, d, adv: +(layer.advanceWidth ?? 500) }
    })
    return { family: font.info?.familyName ?? font.info?.tfn, upm: font.upm ?? 1000, glyphs }
}

// ================= Штриховые шрифты: Hershey (.jhf) и Borland BGI (.chr) =================
const strokeFontView = ({ family, glyphs, top, bottom, note }) => {
    // glyphs: Map ch → { strokes: [[ [x,y], ... ], ...], left, right }
    const wrap = el('div', 'ur-outline-font', `<h2>${esc(family)}</h2><div class="ur-meta">Штриховой шрифт · знаков: ${glyphs.size}${note ? ' · ' + esc(note) : ''}</div>`)
    const H = bottom - top
    const svgFor = (s, w) => `<svg viewBox="0 ${top} ${Math.max(1, w)} ${H}" class="ur-stroke-svg"><g fill="none" stroke="currentColor" stroke-width="${H / 25}" stroke-linecap="round" stroke-linejoin="round">${s}</g></svg>`
    const glyphSvg = (g, x0) => g.strokes.map(st => `<polyline points="${st.map(p => `${p[0] - g.left + x0},${p[1]}`).join(' ')}"/>`).join('')
    const line = text => { let x = 0, s = ''; for (const ch of text) { const g = glyphs.get(ch); if (g) { s += glyphSvg(g, x); x += g.right - g.left } else x += H / 3 } return svgFor(s, x) }
    const sample = [...SAMPLE].filter(c => glyphs.has(c) || c === ' ').join('')
    if (sample.trim()) for (const h of [48, 28]) { const d = el('div', 'ur-outline-sample'); d.style.height = h + 'px'; d.innerHTML = line(sample); wrap.append(d) }
    const grid = el('div', 'ur-outline-grid')
    for (const [ch, g] of glyphs) grid.append(el('figure', '', `${svgFor(glyphSvg(g, 0), g.right - g.left)}<figcaption>${esc(ch)}</figcaption>`))
    wrap.append(grid)
    return wrap
}
export const jhfView = (text, name) => {
    const glyphs = new Map()
    const lines = text.replace(/\r/g, '').split('\n')
    let code = 32, buf = ''
    const flush = () => {
        if (!buf) return
        const n = +buf.slice(5, 8), data = buf.slice(8)
        const v = []; for (let i = 0; i < n * 2; i += 2) v.push([data.charCodeAt(i) - 82, data.charCodeAt(i + 1) - 82])
        const [lr, ...pts] = v
        const strokes = [[]]; for (const p of pts) { if (p[0] === -50 && p[1] === 0) strokes.push([]); else strokes[strokes.length - 1].push(p) }
        glyphs.set(String.fromCharCode(code++), { strokes: strokes.filter(s => s.length), left: lr?.[0] ?? -10, right: lr?.[1] ?? 10 })
        buf = ''
    }
    for (const l of lines) { if (/^\s*\d+\s*\d+/.test(l.slice(0, 8)) && buf && buf.length >= 8 + (+buf.slice(5, 8)) * 2) flush(); buf += l }
    flush()
    if (!glyphs.size) throw new ReaderError('Это не шрифт Hershey (.jhf).')
    return strokeFontView({ family: name, glyphs, top: -16, bottom: 16, note: 'Hershey (знаки по порядку от пробела)' })
}
export const bgiChrView = (buf, name) => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (!(u8[0] === 0x50 && u8[1] === 0x4B)) throw new ReaderError('Это не шрифт Borland BGI (.chr).')
    const z = u8.indexOf(0x1A); if (z < 0 || z > 256) throw new ReaderError('Это не шрифт Borland BGI (.chr).')
    const desc = latin.decode(u8.subarray(2, z)).trim()
    const hs = dv.getUint16(z + 1, true), fname = latin.decode(u8.subarray(z + 3, z + 7))
    if (u8[hs] !== 0x2B) throw new ReaderError('Это не штриховой шрифт BGI.')
    const n = dv.getInt16(hs + 1, true), first = u8[hs + 4], so = dv.getInt16(hs + 5, true), top = dv.getInt8(hs + 8), bottom = dv.getInt8(hs + 10)
    const glyphs = new Map()
    for (let i = 0; i < n; i++) {
        let p = hs + so + dv.getInt16(hs + 16 + i * 2, true)
        const width = u8[hs + 16 + n * 2 + i]
        const strokes = []; let cur = null
        for (let guard = 0; guard < 2000 && p + 1 < u8.length; guard++, p += 2) {
            const bx = u8[p], by = u8[p + 1], op = (bx >> 7) << 1 | (by >> 7)
            if (op === 0) break
            const sx = v => (v & 0x40 ? (v & 0x7F) - 128 : v & 0x7F)
            const x = sx(bx), y = -sx(by)
            if (op === 2) { cur = [[x, y]]; strokes.push(cur) } else if (op === 3) { if (!cur) { cur = [[0, 0]]; strokes.push(cur) } cur.push([x, y]) }
        }
        glyphs.set(String.fromCharCode(first + i), { strokes, left: 0, right: width })
    }
    return strokeFontView({ family: `${name} (${fname.trim()})`, glyphs, top: -top - 2, bottom: -bottom + 2, note: desc })
}
