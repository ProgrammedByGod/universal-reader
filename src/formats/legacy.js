// Старые форматы электронных книг: TCR (Psion), PML и eReader (Palm), zTXT (Palm),
// SNB (Shanda Bambook), LRF (Sony BBeB — только текст без оформления).
// Устройство форматов — по исходникам Calibre (GPL-3).
import { unzlibSync } from '../../vendor/foliate-js/vendor/fflate.js'
import { escapeHtml as esc, ReaderError } from '../util.js'

// ---------- общее ----------
// Старые книги бывают в cp1252 (английские) или cp1251 (русские); угадываем по байтам
export const decodeLegacy = u8 => {
    if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8)
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8) } catch { /* не UTF-8 */ }
    let hi = 0, cyr = 0
    for (const b of u8) { if (b >= 0x80) { hi++; if (b >= 0xC0) cyr++ } }
    return new TextDecoder(hi > 20 && cyr / hi > 0.6 ? 'windows-1251' : 'windows-1252').decode(u8)
}

// Разбор контейнера Palm Database (.pdb/.prc)
const pdbRecords = buf => {
    const u8 = new Uint8Array(buf)
    const dv = new DataView(buf)
    const n = dv.getUint16(76)
    const offs = Array.from({ length: n }, (_, i) => dv.getUint32(78 + i * 8))
    offs.push(u8.length)
    const name = new TextDecoder('latin1').decode(u8.subarray(0, 32)).replace(/\0.*$/s, '').replace(/_/g, ' ').trim()
    return { name, records: offs.slice(0, -1).map((o, i) => u8.subarray(o, offs[i + 1])) }
}

// PalmDOC (LZ77-подобное сжатие)
const palmdocDecompress = rec => {
    const out = []
    for (let i = 0; i < rec.length;) {
        const c = rec[i++]
        if (c === 0 || (c >= 9 && c <= 0x7f)) out.push(c)
        else if (c >= 1 && c <= 8) { for (let k = 0; k < c && i < rec.length; k++) out.push(rec[i++]) }
        else if (c >= 0xC0) out.push(32, c ^ 0x80)
        else {
            const pair = (c << 8) | rec[i++]
            const dist = (pair >> 3) & 0x7FF, len = (pair & 7) + 3
            for (let k = 0; k < len; k++) out.push(out[out.length - dist])
        }
    }
    return new Uint8Array(out)
}
const concat = arrs => {
    const total = arrs.reduce((s, a) => s + a.length, 0)
    const out = new Uint8Array(total)
    let o = 0
    for (const a of arrs) { out.set(a, o); o += a.length }
    return out
}

// ---------- TCR ----------
export const openTcr = (buf, title) => {
    const u8 = new Uint8Array(buf)
    const magic = new TextDecoder('latin1').decode(u8.subarray(0, 9))
    if (magic !== '!!8-Bit!!') throw new ReaderError('Это не файл TCR (нет заголовка «!!8-Bit!!»).')
    let p = 9
    const dict = []
    for (let i = 0; i < 256; i++) {
        const len = u8[p++]
        dict.push(u8.subarray(p, p + len))
        p += len
    }
    const parts = []
    for (; p < u8.length; p++) parts.push(dict[u8[p]])
    return { title, text: decodeLegacy(concat(parts)) }
}

// ---------- PML (разметка eReader) -> HTML ----------
const TOGGLES = { i: 'i', I: 'i', b: 'b', B: 'b', u: 'u', o: 's', l: 'big', k: 'small', s: 'small', Sp: 'sup', Sb: 'sub' }
export const pmlToHtml = (pml, extraNotes = []) => {
    pml = pml.replace(/\r\n?/g, '\n')
        .replace(/\\v[\s\S]*?\\v/g, '')                                   // комментарии
        .replace(/\\a(\d{3})/g, (_, n) => String.fromCharCode(Number(n) === 0 ? 32 : new TextDecoder('windows-1252').decode(new Uint8Array([Number(n)])).charCodeAt(0)))
        .replace(/\\U([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    // сноски и врезки в виде <footnote id="x">…</footnote>
    const notes = [...extraNotes]
    pml = pml.replace(/<(footnote|sidebar)\s+id="([^"]+)">\s*([\s\S]*?)\s*<\/\1>/g, (_, kind, id, text) => { notes.push({ id, text, kind }); return '' })
    const inline = text => {
        let out = '', open = []
        const toggle = tag => {
            const i = open.lastIndexOf(tag)
            if (i >= 0) { for (let k = open.length - 1; k >= i; k--) out += `</${open[k]}>`; const rest = open.slice(i + 1); open = open.slice(0, i); for (const r of rest) { out += `<${r}>`; open.push(r) } }
            else { out += `<${tag}>`; open.push(tag) }
        }
        for (let i = 0; i < text.length;) {
            if (text[i] !== '\\') { out += esc(text[i]); i++; continue }
            const rest = text.slice(i + 1)
            let m
            if (rest[0] === '\\') { out += '\\'; i += 2; continue }
            if (rest[0] === '-') { i += 2; continue }                                        // мягкий перенос
            if ((m = /^(Fn|Sd)="([^"]*)"/.exec(rest))) { out += `<sup><a href="#fn-${esc(m[2])}">`; open.push('a', 'sup'); i += 1 + m[0].length; continue }
            if ((m = /^(Fn|Sd)/.exec(rest))) { if (open.includes('a')) { out += '</a></sup>'; open = open.filter(t => t !== 'a' && t !== 'sup') } i += 3; continue }
            if ((m = /^q="#?([^"]*)"/.exec(rest))) { out += `<a href="#${esc(m[1])}">`; open.push('a'); i += 1 + m[0].length; continue }
            if (rest[0] === 'q') { if (open.includes('a')) toggle('a'); i += 2; continue }
            if ((m = /^Q="([^"]*)"/.exec(rest))) { out += `<span id="${esc(m[1])}"></span>`; i += 1 + m[0].length; continue }
            if ((m = /^(m|w|T|C\d|X\d|x)="[^"]*"/.exec(rest))) { i += 1 + m[0].length; continue }   // картинки, линии, отступы, метки оглавления
            if ((m = /^(Sp|Sb)/.exec(rest))) { toggle(TOGGLES[m[1]]); i += 3; continue }
            if (TOGGLES[rest[0]]) { toggle(TOGGLES[rest[0]]); i += 2; continue }
            i += 2                                                                            // прочие коды (\p, \n, \t, \c, \r и т. п.)
        }
        for (let k = open.length - 1; k >= 0; k--) out += `</${open[k]}>`
        return out
    }
    // главы \x…\x и заголовки \X0…\X0 выносим отдельными строками
    pml = pml.replace(/\\x([\s\S]*?)\\x/g, (_, t) => `\n\u0001H2${t.replace(/\n/g, ' ')}\n`)
        .replace(/\\X([0-4])([\s\S]*?)\\X\1/g, (_, l, t) => `\n\u0001H${Math.min(Number(l) + 3, 6)}${t.replace(/\n/g, ' ')}\n`)
    let html = ''
    for (const raw of pml.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        const h = /^\u0001H(\d)(.*)$/.exec(line)
        if (h) { const t = inline(h[2]).trim(); if (t) html += `<h${h[1]}>${t}</h${h[1]}>`; continue }
        const align = /\\c/.test(line) ? ' style="text-align:center"' : /\\r/.test(line) ? ' style="text-align:right"' : ''
        const t = inline(line.replace(/\\p/g, '').replace(/\\[crt]/g, '').replace(/\\T="[^"]*"/g, ''))
        if (t.replace(/<[^>]+>/g, '').trim()) html += `<p${align}>${t}</p>`
    }
    if (notes.length) {
        html += '<h2>Примечания</h2>'
        for (const n of notes) html += `<div class="ur-note" id="fn-${esc(n.id)}">${pmlToHtml(n.text)}</div>`
    }
    return html
}
export const openPml = (buf, title) => {
    const text = decodeLegacy(new Uint8Array(buf))
    const html = pmlToHtml(text)
    return { title, html }
}

// ---------- zTXT (Palm) ----------
export const openZtxt = (buf, title) => {
    const { name, records } = pdbRecords(buf)
    const h = new DataView(records[0].buffer, records[0].byteOffset, records[0].byteLength)
    const numRecords = h.getUint16(2)
    const data = concat(records.slice(1, numRecords + 1))
    let text
    try { text = unzlibSync(data) } catch (e) { throw new ReaderError('Не удалось распаковать zTXT: ' + e.message) }
    return { title: name || title, text: decodeLegacy(text) }
}

// ---------- eReader (Palm, PML внутри) ----------
export const openEreader = (buf, title) => {
    const { name, records } = pdbRecords(buf)
    const r0 = records[0]
    const dv = new DataView(r0.buffer, r0.byteOffset, r0.byteLength)
    let pml = ''
    const notes = []
    if (r0.length === 132) {
        const compression = dv.getUint16(0)
        if (compression === 260 || compression === 272) throw new ReaderError('Эта книга eReader защищена DRM — открыть её нельзя.')
        if (compression !== 2 && compression !== 10) throw new ReaderError('Неизвестное сжатие книги eReader: ' + compression)
        const dec = rec => compression === 2 ? palmdocDecompress(rec) : unzlibSync(rec)
        const nonText = dv.getUint16(12)
        for (let i = 1; i < nonText && i < records.length; i++) pml += decodeLegacy(dec(records[i]))
        const fCount = dv.getUint16(28), fOff = dv.getUint16(48)
        if (fCount > 0 && records[fOff]) {
            const ids = (new TextDecoder('windows-1252').decode(records[fOff]).match(/\w+(?=\0)/g)) || []
            for (let k = 0, i = fOff + 1; i < fOff + fCount && records[i]; i++, k++) {
                try { notes.push({ id: ids[k] || String(k + 1), text: decodeLegacy(dec(records[i])) }) } catch { /* пропускаем битую сноску */ }
            }
        }
    } else if (r0.length === 202 || r0.length === 116) {
        const version = dv.getUint16(0)
        if (version !== 2 && version !== 4) throw new ReaderError('Неизвестная версия книги eReader: ' + version)
        const nonText = dv.getUint16(8)
        for (let i = 1; i < nonText && i < records.length; i++) pml += decodeLegacy(palmdocDecompress(records[i].map(b => b ^ 0xA5)))
    } else throw new ReaderError('Неизвестный вариант книги eReader.')
    return { title: name || title, html: pmlToHtml(pml, notes) }
}

// ---------- SNB (Shanda Bambook) ----------
export const openSnb = async (ctx, buf, title) => {
    const u8 = new Uint8Array(buf)
    const dv = new DataView(buf)
    if (new TextDecoder('latin1').decode(u8.subarray(0, 8)) !== 'SNBP000B') throw new ReaderError('Это не файл SNB.')
    const fileCount = dv.getInt32(20), vfatCompressed = dv.getInt32(28)
    const binStreamSize = dv.getInt32(32), plainSize = dv.getInt32(36)
    const vfat = unzlibSync(u8.subarray(44, 44 + vfatCompressed))
    const vdv = new DataView(vfat.buffer, vfat.byteOffset, vfat.byteLength)
    const names = new TextDecoder().decode(vfat.subarray(fileCount * 12)).split('\0')
    const files = Array.from({ length: fileCount }, (_, i) => ({ attr: vdv.getInt32(i * 12) >>> 0, size: vdv.getInt32(i * 12 + 8), name: names[i] }))
    const tailSize = dv.getInt32(u8.length - 16), tailOffset = dv.getInt32(u8.length - 12)
    const tail = unzlibSync(u8.subarray(tailOffset, tailOffset + tailSize))
    const tdv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
    const binBlocks = Math.ceil(binStreamSize / 0x8000), plainBlocks = Math.ceil(plainSize / 0x8000)
    const blocks = Array.from({ length: binBlocks + plainBlocks }, (_, i) => tdv.getInt32(i * 4))
    // открытый (текстовый) поток сжат блоками по 32 КБ через bzip2
    let plain = null
    const getPlain = async () => {
        if (plain) return plain
        const { decompress } = await ctx.loadLib('bz2')
        const parts = []
        for (let i = 0; i < plainBlocks; i++) {
            const start = blocks[binBlocks + i]
            const end = i < plainBlocks - 1 ? blocks[binBlocks + i + 1] : tailOffset
            const data = u8.subarray(start, end)
            parts.push(data.length < 32768 ? decompress(data) : data)
        }
        plain = concat(parts)
        return plain
    }
    let plainPos = 0, binPos = 0
    const body = new Map()
    for (const f of files) {
        if ((f.attr & 0x41000000) === 0x41000000) { const p = await getPlain(); body.set(f.name, p.subarray(plainPos, plainPos + f.size)); plainPos += f.size }
        else if ((f.attr & 0x01000000) === 0x01000000) { body.set(f.name, u8.subarray(44 + vfatCompressed + binPos, 44 + vfatCompressed + binPos + f.size)); binPos += f.size }
    }
    const xml = name => body.has(name) ? new DOMParser().parseFromString(new TextDecoder().decode(body.get(name)), 'application/xml') : null
    const meta = xml('snbf/book.snbf')
    const bookTitle = meta?.querySelector('head > name')?.textContent?.trim() || title
    const toc = xml('snbf/toc.snbf')
    const urls = []
    const imgUrl = name => {
        const key = [...body.keys()].find(k => k === name || k.endsWith('/' + name))
        if (!key) return null
        const u = URL.createObjectURL(new Blob([body.get(key)]))
        urls.push(u)
        return u
    }
    let html = ''
    for (const ch of toc?.querySelectorAll('body > chapter') ?? []) {
        const doc = xml('snbc/' + ch.getAttribute('src'))
        html += `<h1>${esc(ch.textContent.trim())}</h1>`
        for (const el of doc?.querySelector('body')?.children ?? []) {
            if (el.tagName === 'text') html += `<p>${esc(el.textContent.trim())}</p>`
            else if (el.tagName === 'img') { const u = imgUrl(el.textContent.trim()); if (u) html += `<p><img src="${u}"></p>` }
        }
    }
    if (!html) throw new ReaderError('В файле SNB не найдено глав.')
    return { title: bookTitle, html, urls }
}

// ---------- LRF (Sony BBeB): только текст ----------
// Размеры параметров тегов 0xF5xx (таблица из Calibre). Строковые значения — особые.
const LRF_TAG = (() => {
    const t = {}
    const set = (size, ...ids) => ids.forEach(id => { t[id] = size })
    set(6, 0x00, 0x29, 0xF9); set(0, 0x01, 0x05, 0x06, 0x4D, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x6B, 0x6E, 0x71, 0x72, 0x81, 0x82, 0xA2, 0xA6, 0xA8, 0xA9, 0xAA, 0xAB, 0xAC, 0xAD, 0xAE, 0xB1, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xC1, 0xC2, 0xC4, 0xC7, 0xC9, 0xD2, 0xD6)
    set(4, 0x02, 0x03, 0x04, 0x07, 0x08, 0x09, 0x0A, 0x17, 0x18, 0x2D, 0x34, 0x37, 0x44, 0x45, 0x4B, 0x4C, 0x53, 0x5B, 0x7B, 0x7C, 0xA1, 0xA7, 0xD8, 0xF2, 0xF3, 0xF5, 0xF6, 0xF7, 0xF8)
    set(2, 0x0D, 0x0E, 0x11, 0x12, 0x13, 0x14, 0x15, 0x19, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2A, 0x2B, 0x2C, 0x2E, 0x31, 0x32, 0x33, 0x35, 0x36, 0x38, 0x39, 0x3A, 0x3C, 0x3D, 0x3E, 0x41, 0x42, 0x46, 0x47, 0x48, 0x51, 0x52, 0x54, 0x56, 0x57, 0x58, 0x5E, 0x61, 0x6D, 0x75, 0x76, 0x77, 0x79, 0x7A, 0xC3, 0xC5, 0xC6, 0xC8, 0xCA, 0xCC, 0xD4, 0xDA, 0xDB, 0xDC, 0xDD, 0xF1, 0xF4)
    set(8, 0x49, 0x4A, 0x6C, 0xD9); set(12, 0x4E, 0xD1); set(10, 0x73); set(14, 0xD7)
    set('s', 0x16, 0x55, 0x59, 0x5A, 0x5D); set('l', 0x0B, 0x5C); set('78', 0x78); set('u', 0xA5, 0xCB)
    return t
})()
// читает тег по смещению p; возвращает { id, p (после тега), value }
const lrfTag = (u8, dv, p) => {
    if (u8[p + 1] !== 0xF5) return null
    const id = u8[p]
    const size = LRF_TAG[id]
    if (size === undefined) return null
    p += 2
    if (typeof size === 'number') { const value = u8.subarray(p, p + size); return { id, p: p + size, value } }
    if (size === 's') { const len = dv.getUint16(p, true); return { id, p: p + 2 + len } }
    if (size === 'l') { const cnt = dv.getUint16(p, true); const list = []; for (let i = 0; i < cnt; i++) list.push(dv.getUint32(p + 2 + i * 4, true)); return { id, p: p + 2 + cnt * 4, list } }
    if (size === '78') { const inner = lrfTag(u8, dv, p + 4); return inner ? { id, p: inner.p + 2 } : null }
    return { id, p }
}
export const openLrf = (buf, title) => {
    const u8 = new Uint8Array(buf)
    const dv = new DataView(buf)
    if (new TextDecoder('utf-16le').decode(u8.subarray(0, 6)) !== 'LRF') throw new ReaderError('Это не файл LRF.')
    const xorKey = dv.getUint16(0x0A, true)
    const count = Number(dv.getBigUint64(0x10, true))
    const indexOff = Number(dv.getBigUint64(0x18, true))
    // заголовок книги из сжатого XML с описанием
    let bookTitle = title
    try {
        const infoSize = dv.getUint16(0x4C, true)
        const version = dv.getUint16(0x08, true)
        const start = version >= 800 ? 0x58 : 0x54
        const info = new TextDecoder('utf-16le').decode(unzlibSync(u8.subarray(start + 4, start + infoSize)))
        bookTitle = /<Title[^>]*>([^<]*)<\/Title>/.exec(info)?.[1]?.trim() || title
    } catch { /* без заголовка */ }
    // таблица объектов
    const objects = new Map()
    for (let i = 0; i < count; i++) {
        const e = indexOff + i * 16
        objects.set(dv.getUint32(e, true), { off: dv.getUint32(e + 4, true), size: dv.getUint32(e + 8, true) })
    }
    const parsed = new Map()
    const parse = id => {
        if (parsed.has(id)) return parsed.get(id)
        const o = objects.get(id)
        if (!o) return null
        const end = o.off + o.size
        const first = lrfTag(u8, dv, o.off)
        if (!first || first.id !== 0x00) return null
        const obj = { id, type: dv.getUint16(o.off + 6, true), tags: [] }
        let p = first.p, flags = 0, ssize = 0
        while (p < end) {
            const t = lrfTag(u8, dv, p)
            if (!t) break
            if (t.id === 0x54) flags = dv.getUint16(p + 2, true)
            else if (t.id === 0x04) ssize = dv.getUint32(p + 2, true)
            else if (t.id === 0x05) {
                let s = u8.subarray(t.p, t.p + ssize)
                if (flags & 0x200) {
                    let key = xorKey & 0xFF
                    key = key !== 0 && key <= 0xF0 ? s.length % key + 0x0F : 0
                    if (key) s = s.map(b => b ^ key)
                }
                if (flags & 0x100) s = unzlibSync(s.subarray(4))
                obj.stream = s
                p = t.p + ssize + 2                 // пропускаем F506 (конец потока)
                continue
            } else if (t.id === 0x5C || t.id === 0x0B) obj.list = t.list
            else if (t.id === 0x03 && t.value?.length === 4) obj.link = dv.getUint32(p + 2, true)
            p = t.p
        }
        parsed.set(id, obj)
        return obj
    }
    // текст объекта Text: UTF-16LE вперемешку с тегами
    const textOf = obj => {
        const s = obj.stream
        if (!s) return ''
        const sdv = new DataView(s.buffer, s.byteOffset, s.byteLength)
        let out = '', p = 0
        while (p + 1 < s.length) {
            if (s[p + 1] === 0xF5 && LRF_TAG[s[p]] !== undefined) {
                const id = s[p]
                if (id === 0xCC) { const len = sdv.getUint16(p + 2, true); out += new TextDecoder('utf-16le').decode(s.subarray(p + 4, p + 4 + len)); p += 4 + len; continue }
                if (id === 0xA2) out += '\n\n'                         // конец абзаца
                else if (id === 0xD2) out += '\n'                      // перевод строки
                const t = lrfTag(s, sdv, p)
                p = t ? t.p : p + 2
                continue
            }
            out += String.fromCharCode(sdv.getUint16(p, true))
            p += 2
        }
        return out
    }
    // порядок чтения: деревья страниц -> страницы -> блоки -> текст
    const pieces = []
    const seen = new Set()
    const fromBlock = blockId => {
        const b = parse(blockId)
        if (!b?.stream) return
        const t = lrfTag(b.stream, new DataView(b.stream.buffer, b.stream.byteOffset, b.stream.byteLength), 0)
        if (!t || t.id !== 0x03) return
        const ref = new DataView(b.stream.buffer, b.stream.byteOffset).getUint32(2, true)
        const tx = parse(ref)
        if (tx && (tx.type === 0x0A || tx.type === 0x1D) && !seen.has(ref)) { seen.add(ref); pieces.push(textOf(tx)) }
    }
    const fromPage = pageId => {
        const pg = parse(pageId)
        if (!pg?.stream) return
        const s = pg.stream, sdv = new DataView(s.buffer, s.byteOffset, s.byteLength)
        for (let p = 0; p + 1 < s.length;) {
            const t = lrfTag(s, sdv, p)
            if (!t) { p += 2; continue }
            if (t.id === 0x03) fromBlock(sdv.getUint32(p + 2, true))
            p = t.p
        }
    }
    for (const id of [...objects.keys()].sort((a, b) => a - b)) {
        const o = parse(id)
        if (o?.type === 0x01 && o.list) for (const pg of o.list) fromPage(pg)
    }
    // запасной путь: все текстовые объекты по порядку
    if (!pieces.length) for (const id of [...objects.keys()].sort((a, b) => a - b)) { const o = parse(id); if (o?.type === 0x0A) pieces.push(textOf(o)) }
    const text = pieces.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!text) throw new ReaderError('В файле LRF не найден текст.')
    return { title: bookTitle, text }
}
