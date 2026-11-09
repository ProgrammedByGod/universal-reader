// Шрифты: коллекции TTC/OTC, EOT, Type 1 (PFB/PFA), точечные FON/FNT/BDF
import { escapeHtml as esc, ReaderError } from '../util.js'
import { fontView } from './extra.js'
import { NT } from '../i18n.js'

const latin = new TextDecoder('latin1')
const SAMPLE_LAT = 'The quick brown fox jumps over the lazy dog. 0123456789'
const SAMPLE_RU = 'Съешь же ещё этих мягких французских булок, да выпей чаю.'

// ---------- TTC / OTC: делим коллекцию на отдельные шрифты ----------
export const splitTtc = buf => {
    const dv = new DataView(buf), u8 = new Uint8Array(buf)
    if (latin.decode(u8.subarray(0, 4)) !== 'ttcf') return [buf]
    const n = dv.getUint32(8)
    const fonts = []
    for (let i = 0; i < n; i++) {
        const o = dv.getUint32(12 + i * 4)
        const numTables = dv.getUint16(o + 4)
        const recs = []
        for (let t = 0; t < numTables; t++) {
            const r = o + 12 + t * 16
            recs.push({ tag: u8.subarray(r, r + 4), sum: dv.getUint32(r + 4), off: dv.getUint32(r + 8), len: dv.getUint32(r + 12) })
        }
        let size = 12 + numTables * 16
        for (const r of recs) size += Math.ceil(r.len / 4) * 4
        const out = new Uint8Array(size), odv = new DataView(out.buffer)
        out.set(u8.subarray(o, o + 12))
        let p = 12 + numTables * 16
        recs.forEach((r, t) => {
            const q = 12 + t * 16
            out.set(r.tag, q); odv.setUint32(q + 4, r.sum); odv.setUint32(q + 8, p); odv.setUint32(q + 12, r.len)
            out.set(u8.subarray(r.off, r.off + r.len), p)
            p += Math.ceil(r.len / 4) * 4
        })
        fonts.push(out.buffer)
    }
    return fonts
}
export const ttcView = async (ctx, buf, fileName) => {
    const fonts = splitTtc(buf)
    const wrap = document.createElement('div')
    wrap.innerHTML = `<div class="ur-meta">Шрифтов в коллекции: ${fonts.length}</div>`
    for (const [i, f] of fonts.entries()) {
        const sec = document.createElement('section'); sec.className = 'ur-ttc-font'
        try { sec.append(await fontView(ctx, f, 'ttf', `${fileName} — ${i + 1}`)) } catch (e) { sec.textContent = `Шрифт ${i + 1}: не удалось прочитать (${e.message})` }
        wrap.append(sec)
    }
    return wrap
}

// ---------- EOT ----------
export const eotToSfnt = buf => {
    const dv = new DataView(buf)
    const total = dv.getUint32(0, true), dataSize = dv.getUint32(4, true), flags = dv.getUint32(12, true)
    if (dv.getUint16(34, true) !== 0x504C) throw new ReaderError('Это не шрифт EOT.')
    if (flags & 0x4) throw new ReaderError('Этот EOT сжат алгоритмом MicroType Express — такие не поддерживаются.')
    const data = new Uint8Array(buf.slice(total - dataSize, total))
    if (flags & 0x10000000) for (let i = 0; i < data.length; i++) data[i] ^= 0x50
    return data.buffer
}

// ---------- Type 1 (PostScript) ----------
const decrypt = (u8, r) => { const out = new Uint8Array(u8.length); for (let i = 0; i < u8.length; i++) { const c = u8[i]; out[i] = c ^ (r >> 8); r = ((c + r) * 52845 + 22719) & 0xFFFF } return out }
const STD_ENC = { 32: 'space', 33: 'exclam', 34: 'quotedbl', 35: 'numbersign', 36: 'dollar', 37: 'percent', 38: 'ampersand', 39: 'quoteright', 40: 'parenleft', 41: 'parenright', 42: 'asterisk', 43: 'plus', 44: 'comma', 45: 'hyphen', 46: 'period', 47: 'slash', 48: 'zero', 49: 'one', 50: 'two', 51: 'three', 52: 'four', 53: 'five', 54: 'six', 55: 'seven', 56: 'eight', 57: 'nine', 58: 'colon', 59: 'semicolon', 60: 'less', 61: 'equal', 62: 'greater', 63: 'question', 64: 'at', 91: 'bracketleft', 92: 'backslash', 93: 'bracketright', 94: 'asciicircum', 95: 'underscore', 96: 'quoteleft', 123: 'braceleft', 124: 'bar', 125: 'braceright', 126: 'asciitilde' }
for (let c = 65; c <= 90; c++) { STD_ENC[c] = String.fromCharCode(c); STD_ENC[c + 32] = String.fromCharCode(c + 32) }

export const parseType1 = buf => {
    let u8 = new Uint8Array(buf)
    let clear, enc
    if (u8[0] === 0x80) {
        const parts = [[], []]
        let p = 0
        while (p < u8.length && u8[p] === 0x80 && u8[p + 1] !== 3) {
            const t = u8[p + 1], len = u8[p + 2] | (u8[p + 3] << 8) | (u8[p + 4] << 16) | (u8[p + 5] << 24)
            parts[t === 1 ? 0 : 1].push(u8.subarray(p + 6, p + 6 + len))
            p += 6 + len
        }
        clear = latin.decode(parts[0][0] ?? new Uint8Array())
        const bin = parts[1]; const n = bin.reduce((s, x) => s + x.length, 0); enc = new Uint8Array(n); let o = 0; for (const x of bin) { enc.set(x, o); o += x.length }
    } else {
        const text = latin.decode(u8)
        const i = text.indexOf('eexec')
        if (i < 0) throw new ReaderError('Это не шрифт Type 1.')
        clear = text.slice(0, i)
        const hex = text.slice(i + 5).replace(/cleartomark[\s\S]*$/, '').replace(/[^0-9a-fA-F]/g, '').replace(/0{64,}$/, '')
        enc = new Uint8Array(hex.length >> 1); for (let k = 0; k < enc.length; k++) enc[k] = parseInt(hex.substr(k * 2, 2), 16)
    }
    const priv = decrypt(enc, 55665).subarray(4)
    const ptext = latin.decode(priv)
    const str = k => new RegExp(`/${k}\\s*\\(([^)]*)\\)`).exec(clear)?.[1]
    const info = { name: /\/FontName\s*\/(\S+)/.exec(clear)?.[1] ?? '', family: str('FamilyName') ?? '', full: str('FullName') ?? '', notice: str('Notice') ?? '', copyright: str('Copyright') ?? '', weight: str('Weight') ?? '' }
    const fm = /\/FontMatrix\s*\[([^\]]*)\]/.exec(clear)?.[1]?.trim().split(/\s+/).map(Number) ?? [0.001, 0, 0, 0.001, 0, 0]
    const encoding = {}
    if (/\/Encoding\s+StandardEncoding/.test(clear)) Object.assign(encoding, STD_ENC)
    else for (const m of clear.matchAll(/dup\s+(\d+)\s*\/(\S+)\s+put/g)) encoding[m[1]] = m[2]
    const lenIV = +(/\/lenIV\s+(-?\d+)/.exec(ptext)?.[1] ?? 4)
    const subrs = [], chars = new Map()
    // разбор: «dup N len RD <bytes>» и «/name len RD <bytes>»
    const subrStart = ptext.indexOf('/Subrs')
    const csStart = ptext.indexOf('/CharStrings')
    const readBin = (re, start, end, store) => {
        re.lastIndex = start
        let m
        while ((m = re.exec(ptext)) && m.index < end) {
            const len = +m[2], s = m.index + m[0].length
            let data = priv.subarray(s, s + len)
            data = lenIV >= 0 ? decrypt(data, 4330).subarray(lenIV) : data
            store(m[1], data)
            re.lastIndex = s + len
        }
    }
    if (subrStart >= 0) readBin(/dup\s+(\d+)\s+(\d+)\s+\S+ /g, subrStart, csStart >= 0 ? csStart : ptext.length, (k, d) => { subrs[+k] = d })
    if (csStart >= 0) readBin(/\/([^\s/]+)\s+(\d+)\s+\S+ /g, csStart + 12, ptext.length, (k, d) => chars.set(k, d))
    return { info, fm, encoding, subrs, chars }
}

// Выполняем «программу» символа Type 1 и получаем контур (команды SVG)
const runCharstring = (font, name, depth = 0) => {
    const path = []
    let x = 0, y = 0, sbx = 0, width = 0
    const st = [], ps = []
    let flex = null
    const add = (cmd, ...pts) => path.push(cmd + pts.map(v => +v.toFixed(1)).join(' '))
    const exec = (code, lvl) => {
        if (lvl > 12) return true
        let i = 0
        while (i < code.length) {
            const v = code[i++]
            if (v >= 32) {
                if (v <= 246) st.push(v - 139)
                else if (v <= 250) st.push((v - 247) * 256 + code[i++] + 108)
                else if (v <= 254) st.push(-(v - 251) * 256 - code[i++] - 108)
                else { st.push((code[i] << 24) | (code[i + 1] << 16) | (code[i + 2] << 8) | code[i + 3]); i += 4 }
                continue
            }
            switch (v) {
                case 13: sbx = st[0]; width = st[1]; x = sbx; y = 0; st.length = 0; break
                case 21: if (flex) { flex.push([x + st[0], y + st[1]]); x += st[0]; y += st[1] } else { x += st[0]; y += st[1]; add('M', x, y) } st.length = 0; break
                case 22: if (flex) { x += st[0]; flex.push([x, y]) } else { x += st[0]; add('M', x, y) } st.length = 0; break
                case 4: if (flex) { y += st[0]; flex.push([x, y]) } else { y += st[0]; add('M', x, y) } st.length = 0; break
                case 5: x += st[0]; y += st[1]; add('L', x, y); st.length = 0; break
                case 6: x += st[0]; add('L', x, y); st.length = 0; break
                case 7: y += st[0]; add('L', x, y); st.length = 0; break
                case 8: { const [a, b, c, d, e, f] = st; const x1 = x + a, y1 = y + b, x2 = x1 + c, y2 = y1 + d; x = x2 + e; y = y2 + f; add('C', x1, y1, x2, y2, x, y); st.length = 0; break }
                case 30: { const [a, b, c, d] = st; const x1 = x, y1 = y + a, x2 = x1 + b, y2 = y1 + c; x = x2 + d; y = y2; add('C', x1, y1, x2, y2, x, y); st.length = 0; break }
                case 31: { const [a, b, c, d] = st; const x1 = x + a, y1 = y, x2 = x1 + b, y2 = y1 + c; x = x2; y = y2 + d; add('C', x1, y1, x2, y2, x, y); st.length = 0; break }
                case 9: path.push('Z'); st.length = 0; break
                case 10: { const n = st.pop(); const s = font.subrs[n]; if (s && exec(s, lvl + 1)) return true; break }
                case 11: return false
                case 14: return true
                case 1: case 3: st.length = 0; break
                case 12: {
                    const e = code[i++]
                    if (e === 7) { sbx = st[0]; width = st[2]; x = sbx; y = st[1]; st.length = 0 }
                    else if (e === 12) { const b = st.pop(), a = st.pop(); st.push(a / b) }
                    else if (e === 6) {
                        // seac: буква с надстрочным знаком из двух символов
                        const [asb, adx, ady, bchar, achar] = st; st.length = 0
                        const base = runCharstring(font, STD_ENC[bchar], depth + 1), acc = runCharstring(font, STD_ENC[achar], depth + 1)
                        path.push(...base.path)
                        if (acc.path.length) path.push(`<shift ${adx - asb + sbx} ${ady}>`, ...acc.path, '</shift>')
                        return true
                    }
                    else if (e === 16) {
                        const othersubr = st.pop(), n = st.pop()
                        const args = st.splice(st.length - n, n)
                        if (othersubr === 1) flex = []
                        else if (othersubr === 0 && flex) {
                            const p = flex
                            if (p.length >= 7) {
                                add('C', ...p[1], ...p[2], ...p[3]); add('C', ...p[4], ...p[5], ...p[6])
                                x = p[6][0]; y = p[6][1]
                            }
                            flex = null
                            ps.push(y, x)
                        } else if (othersubr === 3) ps.push(3)
                        else ps.push(...args.reverse())
                    }
                    else if (e === 17) st.push(ps.pop())
                    else if (e === 33) { y = st.pop(); x = st.pop(); st.length = 0 }
                    else st.length = 0
                    break
                }
                default: st.length = 0
            }
        }
        return false
    }
    const code = font.chars.get(name)
    if (code && depth < 3) exec(code, 0)
    return { path, width }
}
const t1PathD = parts => {
    // разворачиваем сдвиги от seac
    let dx = 0, dy = 0
    const out = []
    for (const p of parts) {
        const m = /^<shift (\S+) (\S+)>$/.exec(p)
        if (m) { dx = +m[1]; dy = +m[2]; continue }
        if (p === '</shift>') { dx = dy = 0; continue }
        if (!dx && !dy) { out.push(p); continue }
        const cmd = p[0], nums = p.slice(1).split(' ').map(Number)
        out.push(cmd + nums.map((v, i) => +(v + (i % 2 ? dy : dx)).toFixed(1)).join(' '))
    }
    return out.join('')
}
export const type1View = buf => {
    const font = parseType1(buf)
    const wrap = document.createElement('div')
    const upm = 1 / (font.fm[0] || 0.001)
    const facts = [['Семейство', font.info.family], ['Начертание', font.info.weight], ['Имя', font.info.name], ['Права', font.info.notice || font.info.copyright], ['Символов', String(font.chars.size)]].filter(x => x[1])
    wrap.innerHTML = `<h2>${esc(font.info.full || font.info.name || 'Шрифт Type 1')}</h2><table class="ur-font-facts">${facts.map(([k, v]) => `<tr><td class="ur-muted">${k}</td><td>${esc(v)}</td></tr>`).join('')}</table>`
    const byCode = new Map(Object.entries(font.encoding).map(([c, n]) => [String.fromCharCode(+c), n]))
    const glyph = new Map()
    const getG = n => { if (!glyph.has(n)) { const r = runCharstring(font, n); glyph.set(n, { d: t1PathD(r.path), w: r.width }) } return glyph.get(n) }
    const line = (text, size) => {
        let x = 0; const parts = []
        for (const ch of text) {
            const n = byCode.get(ch) ?? (ch === ' ' ? 'space' : null)
            if (!n || !font.chars.has(n)) { x += upm * 0.3; continue }
            const g = getG(n)
            parts.push(`<path transform="translate(${x.toFixed(0)} 0)" d="${g.d}"/>`)
            x += g.w || upm * 0.5
        }
        const h = upm * 1.25
        return `<svg class="ur-t1-line" viewBox="0 ${-upm} ${Math.max(1, x)} ${h}" style="height:${size}px"><g transform="scale(1 -1)" fill="currentColor">${parts.join('')}</g></svg>`
    }
    const samples = document.createElement('div'); samples.className = 'ur-font-samples'
    const sampleText = [...SAMPLE_LAT].some(c => byCode.has(c)) ? SAMPLE_LAT : null
    if (sampleText) for (const s of [16, 24, 40, 64]) samples.insertAdjacentHTML('beforeend', `<div><span class="ur-muted">${s}</span>${line(sampleText, s)}</div>`)
    else samples.innerHTML = '<p class="ur-muted">У шрифта нестандартная кодировка — образец текста не собрать, ниже все символы.</p>'
    wrap.append(samples)
    const grid = document.createElement('div'); grid.className = 'ur-glyphs ur-t1-grid'
    grid.innerHTML = '<h3>Символы</h3>' + [...font.chars.keys()].filter(n => n !== '.notdef').slice(0, 1500).map(n => {
        const g = getG(n)
        return `<span title="${esc(n)}"><svg viewBox="${-upm * 0.1} ${-upm * 0.85} ${Math.max(g.w, upm * 0.3) + upm * 0.2} ${upm * 1.1}"><g transform="scale(1 -1)" fill="currentColor"><path d="${g.d}"/></g></svg></span>`
    }).join('')
    wrap.append(grid)
    return wrap
}

// ---------- Точечные шрифты: FNT, FON, BDF ----------
const CP437_HI = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0'
const charOf = (charset, c) => {
    if (c < 0x80) return String.fromCharCode(c)
    if (charset === 255) return CP437_HI[c - 0x80]
    const enc = { 204: 'windows-1251', 238: 'windows-1250', 161: 'windows-1253', 162: 'windows-1254', 186: 'windows-1257', 177: 'windows-1255', 178: 'windows-1256' }[charset] ?? 'windows-1252'
    return new TextDecoder(enc).decode(new Uint8Array([c]))
}
const parseFnt = (u8, base = 0) => {
    const dv = new DataView(u8.buffer, u8.byteOffset + base)
    const ver = dv.getUint16(0, true)
    if (ver !== 0x200 && ver !== 0x300 && ver !== 0x100) throw new ReaderError('Неизвестная версия шрифта FNT.')
    const copyright = latin.decode(u8.subarray(base + 6, base + 66)).replace(/\0.*/s, '').trim()
    const points = dv.getUint16(68, true), ascent = dv.getUint16(74, true)
    const weight = dv.getUint16(83, true), italic = u8[base + 80]
    const pixWidth = dv.getUint16(86, true), height = dv.getUint16(88, true)
    const first = u8[base + 95], last = u8[base + 96]
    const charset = u8[base + 85]
    const faceOff = dv.getUint32(105, true)
    const face = faceOff ? latin.decode(u8.subarray(base + faceOff, u8.indexOf(0, base + faceOff))) : ''
    const glyphs = new Map()
    const tableOff = ver === 0x300 ? 148 : 118, entry = ver === 0x300 ? 6 : 4
    for (let c = first; c <= last; c++) {
        const e = tableOff + (c - first) * entry
        const w = ver === 0x100 ? pixWidth : dv.getUint16(e, true)
        const off = ver === 0x300 ? dv.getUint32(e + 2, true) : dv.getUint16(e + 2, true)
        if (ver === 0x100 || !w) continue
        const rows = []
        const cols = Math.ceil(w / 8)
        for (let y = 0; y < height; y++) { const row = []; for (let x = 0; x < w; x++) row.push((u8[base + off + (x >> 3) * height + y] >> (7 - (x & 7))) & 1); rows.push(row) }
        glyphs.set(charOf(charset, c), { w, rows, xoff: 0, yoff: 0 })
    }
    return { name: face, copyright, points, height, ascent, weight, italic, glyphs }
}
const parseFon = u8 => {
    const dv = new DataView(u8.buffer, u8.byteOffset)
    if (u8[0] !== 0x4D || u8[1] !== 0x5A) return [parseFnt(u8)]
    const ne = dv.getUint32(0x3C, true)
    if (latin.decode(u8.subarray(ne, ne + 2)) !== 'NE') throw new ReaderError('Этот .fon в 32-битном формате — такие пока не поддерживаются.')
    const rt = ne + dv.getUint16(ne + 0x24, true)
    const shift = dv.getUint16(rt, true)
    let p = rt + 2
    const fonts = []
    while (true) {
        const type = dv.getUint16(p, true); if (!type) break
        const count = dv.getUint16(p + 2, true)
        p += 8
        for (let i = 0; i < count; i++) {
            if (type === 0x8008) { const off = dv.getUint16(p, true) << shift; try { fonts.push(parseFnt(u8, off)) } catch (e) { console.warn(e) } }
            p += 12
        }
    }
    if (!fonts.length) throw new ReaderError('В файле .fon не найдено шрифтов.')
    return fonts
}
const parseBdf = text => {
    const lines = text.split(/\r?\n/)
    const font = { name: '', glyphs: new Map(), height: 0, ascent: 0 }
    let bb = [0, 0, 0, 0], cur = null, bitmap = false
    for (const l of lines) {
        const [k, ...v] = l.trim().split(/\s+/)
        if (bitmap) {
            if (k === 'ENDCHAR') { bitmap = false; if (cur.code >= 0) font.glyphs.set(String.fromCodePoint(cur.code), cur); continue }
            const bits = parseInt(k, 16), n = k.length * 4
            cur.rows.push(Array.from({ length: cur.w }, (_, x) => (bits >> (n - 1 - x)) & 1))
            continue
        }
        if (k === 'FONT') font.name = v.join(' ')
        else if (k === 'FAMILY_NAME') font.family = v.join(' ').replace(/"/g, '')
        else if (k === 'COPYRIGHT') font.copyright = v.join(' ').replace(/"/g, '')
        else if (k === 'FONTBOUNDINGBOX') { bb = v.map(Number); font.height = bb[1]; font.ascent = bb[1] + bb[3] }
        else if (k === 'FONT_ASCENT') font.ascent = +v[0]
        else if (k === 'STARTCHAR') cur = { rows: [], w: 0, code: -1, dw: 0 }
        else if (k === 'ENCODING') cur.code = +v[0]
        else if (k === 'DWIDTH') cur.dw = +v[0]
        else if (k === 'BBX') { cur.w = +v[0]; cur.h = +v[1]; cur.xoff = +v[2]; cur.yoff = +v[3] }
        else if (k === 'BITMAP') bitmap = true
    }
    return [font]
}
// Шрифты консоли Linux: PSF1 и PSF2 (с таблицей Юникода или без — тогда считаем, что это CP437)
const CP437_LO = '\0☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼'
const parsePsf = u8 => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    let count, h, w, start, bytesPer, table = null, uniStart = 0, v1 = false
    if (u8[0] === 0x36 && u8[1] === 0x04) {
        v1 = true
        const mode = u8[2]; h = u8[3]; w = 8; count = mode & 1 ? 512 : 256; start = 4; bytesPer = h
        if (mode & 6) uniStart = start + count * bytesPer
    } else if (dv.getUint32(0, true) === 0x864AB572) {
        start = dv.getUint32(8, true); const flags = dv.getUint32(12, true); count = dv.getUint32(16, true); bytesPer = dv.getUint32(20, true); h = dv.getUint32(24, true); w = dv.getUint32(28, true)
        if (flags & 1) uniStart = start + count * bytesPer
    } else throw new ReaderError('Это не шрифт консоли PSF.')
    if (uniStart) {
        table = []
        let p = uniStart
        for (let g = 0; g < count && p < u8.length; g++) {
            const cps = []
            if (v1) { for (; p + 1 < u8.length; p += 2) { const c = dv.getUint16(p, true); if (c === 0xFFFF) { p += 2; break } if (c !== 0xFFFE) cps.push(c) } }
            else {
                const end = u8.indexOf(0xFF, p); const seg = u8.subarray(p, end < 0 ? u8.length : end); p = end < 0 ? u8.length : end + 1
                const head = seg.indexOf(0xFE); const s = new TextDecoder().decode(head < 0 ? seg : seg.subarray(0, head))
                for (const ch of s) cps.push(ch.codePointAt(0))
            }
            table.push(cps)
        }
    }
    const font = { name: '', glyphs: new Map(), height: h, ascent: h }
    const rowBytes = Math.ceil(w / 8)
    for (let g = 0; g < count; g++) {
        const o = start + g * bytesPer
        if (o + bytesPer > u8.length) break
        const rows = []
        for (let y = 0; y < h; y++) rows.push(Array.from({ length: w }, (_, x) => (u8[o + y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1))
        const glyph = { rows, w, dw: w }
        const cps = table ? table[g] ?? [] : [g < 32 ? CP437_LO.codePointAt(g) : g < 128 ? g : g < 256 ? CP437_HI.codePointAt(g - 128) : -1]
        for (const c of cps) if (c >= 0 && !font.glyphs.has(String.fromCodePoint(c))) font.glyphs.set(String.fromCodePoint(c), glyph)
    }
    font.family = `Шрифт консоли PSF${v1 ? '1' : '2'} ${w}×${h}`
    return [font]
}
const drawBitmapText = (font, text, scale) => {
    const H = font.height || 16, A = font.ascent || H
    let width = 0
    const items = []
    for (const ch of text) { const g = font.glyphs.get(ch) ?? font.glyphs.get('?'); const adv = g ? (g.dw || g.w + (g.xoff || 0)) : H / 2; items.push([g, width]); width += adv }
    const c = document.createElement('canvas'); c.width = Math.max(1, width) * scale; c.height = H * scale
    const g2 = c.getContext('2d'); g2.fillStyle = getComputedStyle(document.body).getPropertyValue('--text-normal').trim() || '#222'
    for (const [g, x0] of items) {
        if (!g) continue
        const top = g.h != null ? A - g.yoff - g.h : 0
        g.rows.forEach((row, y) => row.forEach((b, x) => { if (b) g2.fillRect((x0 + (g.xoff || 0) + x) * scale, (top + y) * scale, scale, scale) }))
    }
    c.style.width = c.width + 'px'
    return c
}
export const bitmapFontView = (buf, ext) => {
    const u8 = new Uint8Array(buf)
    const fonts = ext === 'bdf' ? parseBdf(latin.decode(u8)) : ext === 'psf' || ext === 'psfu' || (u8[0] === 0x36 && u8[1] === 0x04) || (u8[0] === 0x72 && u8[1] === 0xB5) ? parsePsf(u8) : parseFon(u8)
    return fontGlyphsView(fonts)
}
export const fontGlyphsView = fonts => {
    const wrap = document.createElement('div')
    for (const f of fonts) {
        const sec = document.createElement('section')
        sec.innerHTML = `<h2>${esc(f.family || f.name || 'Точечный шрифт')}</h2><div class="ur-meta">${f.height ? `Высота ${f.height} пикс.` : ''}${f.points ? ` · ${f.points} пт` : ''}${f.weight >= 700 ? ' · жирный' : ''}${f.italic ? ' · курсив' : ''} · символов: ${f.glyphs.size}${f.copyright ? ' · ' + esc(f.copyright) : ''}</div>`
        const hasRu = f.glyphs.has(NT('ж'))
        for (const s of [1, 2, 3]) {
            const row = document.createElement('div'); row.className = 'ur-bitmap-sample'
            row.append(drawBitmapText(f, SAMPLE_LAT, s))
            if (hasRu) row.append(drawBitmapText(f, SAMPLE_RU, s))
            sec.append(row)
        }
        const grid = document.createElement('div'); grid.className = 'ur-bitmap-grid'
        for (const ch of [...f.glyphs.keys()].slice(0, 800)) { const cell = document.createElement('span'); cell.title = 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'); cell.append(drawBitmapText(f, ch, 2)); grid.append(cell) }
        sec.append(grid)
        wrap.append(sec)
    }
    return wrap
}
