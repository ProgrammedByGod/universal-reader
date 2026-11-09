// Табличные данные: dBase (DBF), Access, Parquet, Arrow/Feather, Avro, SPSS (.sav), Stata (.dta), SAS (.sas7bdat)
// Результат каждой функции — листы для TableRenderer: [{ name, rows: [заголовки, ...строки] }]
import { ReaderError } from '../util.js'
import { inflateRaw } from './compress.js'
import { unzlibSync } from 'fflate'

const LIMIT = 5000
const latin = new TextDecoder('latin1')
const cell = v => v == null ? '' : v instanceof Date ? (isNaN(v) ? '' : v.toISOString().replace('T', ' ').replace(/(\.000)?Z$/, '').replace(/ 00:00:00$/, '')) : typeof v === 'bigint' ? v.toString()
    : v instanceof Uint8Array || (v?.buffer instanceof ArrayBuffer && v.byteLength != null && !Array.isArray(v)) ? `[данные, ${v.byteLength} байт]` : typeof v === 'object' ? JSON.stringify(v, (k, x) => typeof x === 'bigint' ? x.toString() : x) : String(v)
const tryDecoder = name => { try { return new TextDecoder(name) } catch { return new TextDecoder('windows-1252') } }
const sheetName = (name, shown, total) => `${name} (${total > shown ? `первые ${shown} из ${total}` : total})`

// ================= dBase / FoxPro =================
const DBF_CP = { 0x01: 'ibm437', 0x02: 'ibm850', 0x03: 'windows-1252', 0x26: 'ibm866', 0x65: 'ibm866', 0x64: 'ibm852', 0x57: 'windows-1252', 0xC8: 'windows-1250', 0xC9: 'windows-1251', 0x4D: 'gb18030', 0x4E: 'euc-kr', 0x4F: 'big5', 0x7B: 'shift_jis' }
export const readDbf = (buf, name = 'Таблица') => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const n = dv.getUint32(4, true), hlen = dv.getUint16(8, true), rlen = dv.getUint16(10, true)
    if (!hlen || !rlen || hlen > u8.length) throw new ReaderError('Это не таблица dBase.')
    const fields = []
    for (let p = 32; p + 32 <= hlen && u8[p] !== 0x0D; p += 32) {
        fields.push({ name: latin.decode(u8.subarray(p, p + 11)).replace(/\0.*$/s, ''), type: String.fromCharCode(u8[p + 11]), len: u8[p + 16], dec: u8[p + 17] })
    }
    let off = 1
    for (const f of fields) { f.off = off; off += f.len }
    // кодировка: по байту языка, иначе угадываем (cp866 или cp1251)
    let cp = DBF_CP[u8[29]]
    if (!cp) {
        const sample = u8.subarray(hlen, Math.min(u8.length, hlen + rlen * 200))
        let hi866 = 0, hi1251 = 0
        for (const b of sample) { if (b >= 0x80 && b <= 0xAF) hi866++; if (b >= 0xC0) hi1251++ }
        cp = hi866 > hi1251 ? 'ibm866' : 'windows-1251'
    }
    const td = tryDecoder(cp)
    const rows = [fields.map(f => f.name)]
    const count = Math.min(n, LIMIT)
    for (let r = 0, shown = 0; r < n && shown < count; r++) {
        const base = hlen + r * rlen
        if (base + rlen > u8.length) break
        if (u8[base] === 0x2A) continue // удалённая запись
        const row = []
        for (const f of fields) {
            const s = base + f.off, raw = u8.subarray(s, s + f.len)
            let v
            switch (f.type) {
                case 'I': v = String(new DataView(buf, s, 4).getInt32(0, true)); break
                case 'B': v = f.len === 8 ? String(new DataView(buf, s, 8).getFloat64(0, true)) : td.decode(raw).trim(); break
                case 'Y': v = (Number(new DataView(buf, s, 8).getBigInt64(0, true)) / 10000).toFixed(4); break
                case 'T': { const jd = new DataView(buf, s, 8).getInt32(0, true), ms = new DataView(buf, s, 8).getInt32(4, true); v = jd ? cell(new Date((jd - 2440588) * 864e5 + ms)) : ''; break }
                case 'D': { const t = latin.decode(raw).trim(); v = /^\d{8}$/.test(t) ? `${t.slice(6, 8)}.${t.slice(4, 6)}.${t.slice(0, 4)}` : t; break }
                case 'L': { const c = String.fromCharCode(raw[0]).toUpperCase(); v = 'TY'.includes(c) ? 'да' : 'FN'.includes(c) ? 'нет' : ''; break }
                case 'M': case 'G': case 'P': v = /\d/.test(latin.decode(raw)) && !/^\s*0*\s*$/.test(latin.decode(raw)) ? '[текст в файле .dbt/.fpt]' : ''; break
                default: v = td.decode(raw).replace(/\0+$/, '').trim()
            }
            row.push(v)
        }
        rows.push(row); shown++
    }
    return [{ name: sheetName(name, rows.length - 1, n), rows }]
}

// ================= Microsoft Access =================
export const readMdb = async (ctx, buf) => {
    const { MDBReader, Buffer } = await ctx.loadLib('mdb')
    let reader
    try { reader = new MDBReader(Buffer.from(buf)) } catch (e) { throw new ReaderError('Не удалось открыть базу Access: ' + e.message) }
    const names = reader.getTableNames()
    if (!names.length) throw new ReaderError('В базе нет таблиц.')
    return names.map(n => {
        try {
            const t = reader.getTable(n)
            const cols = t.getColumnNames()
            const data = t.getData({ rowLimit: LIMIT })
            return { name: sheetName(n, data.length, t.rowCount), rows: [cols, ...data.map(r => cols.map(c => cell(r[c])))] }
        } catch (e) { return { name: n + ' (ошибка)', rows: [['Не удалось прочитать таблицу: ' + e.message]] } }
    })
}

// ================= Parquet =================
export const readParquet = async (ctx, buf) => {
    const { parquetMetadata, parquetReadObjects, parquetSchema, compressors } = await ctx.loadLib('parquet')
    const meta = parquetMetadata(buf)
    const cols = parquetSchema(meta).children.map(c => c.element.name)
    const total = Number(meta.num_rows)
    const data = await parquetReadObjects({ file: buf, compressors, rowEnd: Math.min(total, LIMIT) })
    return [{ name: sheetName('Данные', data.length, total), rows: [cols, ...data.map(r => cols.map(c => cell(r[c])))] }]
}

// ================= Arrow / Feather =================
export const readArrow = async (ctx, buf) => {
    const u8 = new Uint8Array(buf)
    if (latin.decode(u8.subarray(0, 4)) === 'FEA1') throw new ReaderError('Это старый Feather версии 1 — он не поддерживается, нужен Feather 2 (Arrow).')
    const { tableFromIPC } = await ctx.loadLib('arrow')
    const t = tableFromIPC(u8)
    const cols = t.schema.fields.map(f => f.name)
    const isTime = t.schema.fields.map(f => /^(Timestamp|Date)/.test(String(f.type)))
    const rows = [cols]
    const n = Math.min(t.numRows, LIMIT)
    for (let i = 0; i < n; i++) { const r = t.get(i); rows.push(cols.map((c, k) => { const v = r?.[c]; return isTime[k] && v != null ? cell(new Date(Number(v))) : cell(v) })) }
    return [{ name: sheetName('Данные', n, t.numRows), rows }]
}

// ================= Avro =================
export const readAvro = async (ctx, buf) => {
    const u8 = new Uint8Array(buf)
    if (latin.decode(u8.subarray(0, 4)) !== 'Obj\x01') throw new ReaderError('Это не файл Avro.')
    let p = 4
    const long = () => { let n = 0n, s = 0n, b; do { b = u8[p++]; n |= BigInt(b & 0x7F) << s; s += 7n } while (b & 0x80); return Number((n >> 1n) ^ -(n & 1n)) }
    const bytes = () => { const n = long(); const v = u8.subarray(p, p + n); p += n; return v }
    const td = new TextDecoder()
    const meta = {}
    for (let n = long(); n !== 0; n = long()) { if (n < 0) { long(); n = -n } for (let i = 0; i < n; i++) { const k = td.decode(bytes()); meta[k] = bytes() } }
    const sync = u8.subarray(p, p + 16); p += 16
    const schema = JSON.parse(td.decode(meta['avro.schema']))
    const codec = meta['avro.codec'] ? td.decode(meta['avro.codec']) : 'null'
    const named = new Map()
    const reg = s => { if (s && typeof s === 'object' && !Array.isArray(s) && s.name) named.set(s.name, s); if (Array.isArray(s)) s.forEach(reg); else if (s?.fields) s.fields.forEach(f => reg(f.type)); else if (s?.items) reg(s.items); else if (s?.values) reg(s.values) }
    reg(schema)
    let d, q
    const dlong = () => { let n = 0n, s = 0n, b; do { b = d[q++]; n |= BigInt(b & 0x7F) << s; s += 7n } while (b & 0x80); const v = (n >> 1n) ^ -(n & 1n); return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v }
    const dbytes = () => { const n = Number(dlong()); const v = d.subarray(q, q + n); q += n; return v }
    const read = t => {
        if (typeof t === 'string' && named.has(t)) t = named.get(t)
        if (Array.isArray(t)) return read(t[Number(dlong())])
        const type = typeof t === 'string' ? t : t.type
        switch (type) {
            case 'null': return null
            case 'boolean': return d[q++] !== 0
            case 'int': case 'long': {
                const v = dlong()
                if (t.logicalType === 'date') return new Date(Number(v) * 864e5)
                if (t.logicalType === 'timestamp-millis') return new Date(Number(v))
                if (t.logicalType === 'timestamp-micros') return new Date(Number(v) / 1000)
                return v
            }
            case 'float': { const v = new DataView(d.buffer, d.byteOffset + q, 4).getFloat32(0, true); q += 4; return v }
            case 'double': { const v = new DataView(d.buffer, d.byteOffset + q, 8).getFloat64(0, true); q += 8; return v }
            case 'bytes': return dbytes()
            case 'string': return td.decode(dbytes())
            case 'fixed': { const v = d.subarray(q, q + t.size); q += t.size; return v }
            case 'enum': return t.symbols[Number(dlong())]
            case 'record': case 'error': { const o = {}; for (const f of t.fields) o[f.name] = read(f.type); return o }
            case 'array': { const a = []; for (let n = Number(dlong()); n !== 0; n = Number(dlong())) { if (n < 0) { dlong(); n = -n } for (let i = 0; i < n; i++) a.push(read(t.items)) } return a }
            case 'map': { const o = {}; for (let n = Number(dlong()); n !== 0; n = Number(dlong())) { if (n < 0) { dlong(); n = -n } for (let i = 0; i < n; i++) { const k = td.decode(dbytes()); o[k] = read(t.values) } } return o }
        }
        if (typeof type === 'object') return read(type)
        throw new ReaderError('Неизвестный тип в схеме Avro: ' + type)
    }
    const recs = []
    let total = 0
    while (p < u8.length) {
        const count = long(), size = long()
        let block = u8.subarray(p, p + size); p += size + 16
        total += count
        if (recs.length >= LIMIT) continue
        if (codec === 'deflate') block = await inflateRaw(block)
        else if (codec === 'snappy') {
            const { snappyUncompress } = await ctx.loadLib('parquet')
            const src = block.subarray(0, block.length - 4)
            let len = 0, s = 0, i = 0, b; do { b = src[i++]; len |= (b & 0x7F) << s; s += 7 } while (b & 0x80)
            const out = new Uint8Array(len); snappyUncompress(src, out); block = out
        } else if (codec === 'zstandard') block = (await ctx.loadLib('zstd')).decompress(block)
        else if (codec !== 'null') throw new ReaderError('Сжатие Avro «' + codec + '» не поддерживается.')
        d = block; q = 0
        for (let i = 0; i < count && recs.length < LIMIT; i++) recs.push(read(schema))
    }
    const cols = schema.type === 'record' ? schema.fields.map(f => f.name) : ['Значение']
    return [{ name: sheetName(schema.name || 'Записи', recs.length, total), rows: [cols, ...recs.map(r => schema.type === 'record' ? cols.map(c => cell(r[c])) : [cell(r)])] }]
}

// ================= SPSS .sav =================
export const readSav = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const magic = latin.decode(u8.subarray(0, 4))
    if (magic !== '$FL2' && magic !== '$FL3') throw new ReaderError('Это не файл данных SPSS.')
    const le = dv.getInt32(64, true) === 2 || dv.getInt32(64, true) === 3
    const i32 = o => dv.getInt32(o, le), f64 = o => dv.getFloat64(o, le)
    const compression = i32(72), ncases = i32(80), bias = f64(84)
    let p = 176
    const vars = []
    const valueLabels = []
    const ext = {}
    while (p < u8.length) {
        const rec = i32(p)
        if (rec === 2) {
            const type = i32(p + 4), hasLabel = i32(p + 8), nMiss = i32(p + 12)
            const name = latin.decode(u8.subarray(p + 24, p + 32)).trim()
            p += 32
            let label = ''
            if (hasLabel) { const l = i32(p); label = u8.subarray(p + 4, p + 4 + l); p += 4 + Math.ceil(l / 4) * 4 }
            p += Math.abs(nMiss) * 8
            vars.push({ type, name, label })
        } else if (rec === 3) {
            const n = i32(p + 4); p += 8
            const labels = []
            for (let i = 0; i < n; i++) { const val = u8.slice(p, p + 8); const l = u8[p + 8]; labels.push([val, u8.subarray(p + 9, p + 9 + l)]); p += Math.ceil((9 + l) / 8) * 8 }
            const r4 = i32(p); const nv = i32(p + 4); const idx = []; for (let i = 0; i < nv; i++) idx.push(i32(p + 8 + i * 4)); p += 8 + nv * 4
            if (r4 === 4) valueLabels.push({ labels, idx })
        } else if (rec === 6) { p += 8 + i32(p + 4) * 80 }
        else if (rec === 7) { const sub = i32(p + 4), size = i32(p + 8), cnt = i32(p + 12); ext[sub] = u8.subarray(p + 16, p + 16 + size * cnt); p += 16 + size * cnt }
        else if (rec === 999) { p += 8; break }
        else throw new ReaderError('Повреждённый файл SPSS (неизвестная запись ' + rec + ').')
    }
    let enc = 'windows-1252'
    if (ext[20]) enc = latin.decode(ext[20]).trim().toLowerCase()
    else if (ext[3]) { const cp = new DataView(ext[3].buffer, ext[3].byteOffset).getInt32(28, le); enc = cp === 65001 ? 'utf-8' : cp === 1251 ? 'windows-1251' : cp === 866 ? 'ibm866' : 'windows-1252' }
    const td = tryDecoder(enc)
    // длинные имена
    const longNames = new Map()
    if (ext[13]) for (const pair of td.decode(ext[13]).split('\t')) { const [s, l] = pair.split('='); if (s && l) longNames.set(s, l) }
    // очень длинные строки (сегменты)
    const vls = new Map()
    if (ext[14]) for (const pair of td.decode(ext[14]).split(/\0?\t/)) { const [s, l] = pair.split('='); if (s && l) vls.set(s, parseInt(l, 10)) }
    // строим список переменных со слотами
    const columns = []
    for (let i = 0; i < vars.length; i++) {
        const v = vars[i]
        if (v.type === -1) { columns[columns.length - 1].slots++; continue }
        columns.push({ name: longNames.get(v.name) ?? v.name, short: v.name, type: v.type, slots: 1, slotIndex: i, label: v.label ? td.decode(v.label) : '' })
    }
    // склейка сегментов очень длинных строк
    const merged = []
    for (let i = 0; i < columns.length; i++) {
        const c = columns[i], width = vls.get(c.short)
        if (width && c.type > 0) { const segs = Math.ceil(width / 252); merged.push({ ...c, parts: columns.slice(i, i + segs) }); i += segs - 1 }
        else merged.push({ ...c, parts: [c] })
    }
    // подписи значений
    for (const vl of valueLabels) for (const idx of vl.idx) {
        const col = columns.find(c => c.slotIndex === idx - 1); if (!col) continue
        col.vlabels = new Map(vl.labels.map(([val, lab]) => [col.type === 0 ? new DataView(val.buffer).getFloat64(0, le) : latin.decode(val).trim(), td.decode(lab)]))
    }
    const totalSlots = vars.length
    const rows = [merged.map(c => c.name)]
    let q = p
    let src = u8
    if (compression === 2) {
        // ZSAV: данные лежат блоками zlib, список блоков — в конце файла
        const big = o => Number(dv.getBigUint64(o, le))
        const trailer = big(p + 8)
        const nBlocks = dv.getUint32(trailer + 20, le)
        const parts = []
        for (let i = 0; i < nBlocks; i++) { const e = trailer + 24 + i * 24; const co = big(e + 8), cs = dv.getUint32(e + 20, le); parts.push(unzlibSync(u8.subarray(co, co + cs))) }
        src = new Uint8Array(parts.reduce((s2, x) => s2 + x.length, 0)); let o2 = 0
        for (const x of parts) { src.set(x, o2); o2 += x.length }
        q = 0
    }
    const cmd = []
    const readSlot = () => {
        if (!compression) { if (q + 8 > src.length) return null; const v = src.subarray(q, q + 8); q += 8; return v }
        while (true) {
            if (!cmd.length) { if (q + 8 > src.length) return null; for (let i = 0; i < 8; i++) cmd.push(src[q + i]); q += 8 }
            const c = cmd.shift()
            if (c === 0) continue
            if (c === 252) return null
            if (c === 253) { const v = src.subarray(q, q + 8); q += 8; return v }
            if (c === 254) return new Uint8Array(8).fill(32)
            if (c === 255) return 'sysmis'
            const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, c - bias, le); return b
        }
    }
    const n = ncases >= 0 ? Math.min(ncases, LIMIT) : LIMIT
    outer: for (let r = 0; r < n; r++) {
        const slots = []
        for (let s = 0; s < totalSlots; s++) { const v = readSlot(); if (v == null) break outer; slots.push(v) }
        rows.push(merged.map(c => {
            if (c.type === 0) {
                const sl = slots[c.slotIndex]
                if (sl === 'sysmis') return ''
                const v = new DataView(sl.buffer, sl.byteOffset, 8).getFloat64(0, le)
                if (v === -Number.MAX_VALUE) return ''
                return c.vlabels?.get(v) ?? String(+v.toPrecision(15))
            }
            const bytes = c.parts.flatMap(part => { const segBytes = []; for (let k = 0; k < part.slots; k++) { const sl = slots[part.slotIndex + k]; if (sl !== 'sysmis') segBytes.push(...(c.parts.length > 1 && k === part.slots - 1 && part.slots === 32 ? sl.subarray(0, 4) : sl)) } return segBytes })
            const s = td.decode(Uint8Array.from(bytes)).replace(/\s+$/, '')
            return c.vlabels?.get(s) ?? s
        }))
    }
    const label = latin.decode(u8.subarray(108, 172)).trim()
    return [{ name: sheetName(label || 'Данные SPSS', rows.length - 1, ncases >= 0 ? ncases : rows.length - 1), rows }]
}

// ================= Stata .dta =================
const stataMissing = (t, v) => (t === 'b' && v > 100) || (t === 'i' && v > 32740) || (t === 'l' && v > 2147483620) || (t === 'f' && v > 1.701e38) || (t === 'd' && v > 8.988e307)
export const readDta = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const head = latin.decode(u8.subarray(0, 11))
    let le, nvar, nobs, types, names, labelsVar, dataOff, release, strls = new Map(), dataLabel = ''
    const tag = (name, from = 0) => { const t = `<${name}>`; const i = latin.decode(u8.subarray(from, Math.min(u8.length, from + 10_000_000))).indexOf(t); return i < 0 ? -1 : from + i + t.length }
    if (head === '<stata_dta>') {
        const relOff = tag('release'); release = +latin.decode(u8.subarray(relOff, relOff + 3))
        le = latin.decode(u8.subarray(tag('byteorder'), tag('byteorder') + 3)) === 'LSF'
        const kOff = tag('K'); nvar = release >= 119 ? dv.getUint32(kOff, le) : dv.getUint16(kOff, le)
        const nOff = tag('N'); nobs = release >= 118 ? Number(dv.getBigUint64(nOff, le)) : dv.getUint32(nOff, le)
        const lOff = tag('label'); const ll = release >= 118 ? dv.getUint16(lOff, le) : u8[lOff]; dataLabel = new TextDecoder(release >= 118 ? 'utf-8' : 'windows-1252').decode(u8.subarray(lOff + (release >= 118 ? 2 : 1), lOff + (release >= 118 ? 2 : 1) + ll))
        const mapOff = tag('map')
        const m = i => Number(dv.getBigUint64(mapOff + i * 8, le))
        const tOff = m(2) + 16, vnOff = m(3) + 10, vlOff = m(7) + 17
        types = Array.from({ length: nvar }, (_, i) => dv.getUint16(tOff + i * 2, le))
        const nameLen = release >= 118 ? 129 : 33, labLen = release >= 118 ? 321 : 81
        const td = new TextDecoder(release >= 118 ? 'utf-8' : 'windows-1252')
        names = Array.from({ length: nvar }, (_, i) => td.decode(u8.subarray(vnOff + i * nameLen, vnOff + (i + 1) * nameLen)).replace(/\0.*$/s, ''))
        labelsVar = Array.from({ length: nvar }, (_, i) => td.decode(u8.subarray(vlOff + i * labLen, vlOff + (i + 1) * labLen)).replace(/\0.*$/s, ''))
        dataOff = m(9) + 6
        // строки strL
        let s = m(10) + 7
        while (latin.decode(u8.subarray(s, s + 3)) === 'GSO') {
            const v = dv.getUint32(s + 3, le)
            const o = release >= 118 ? Number(dv.getBigUint64(s + 7, le)) : dv.getUint32(s + 7, le)
            const ps = s + (release >= 118 ? 15 : 11)
            const t = u8[ps], len = dv.getUint32(ps + 1, le)
            strls.set(`${v}:${o}`, td.decode(u8.subarray(ps + 5, ps + 5 + len - (t === 130 ? 1 : 0))))
            s = ps + 5 + len
        }
        types = types.map(t => t <= 2045 ? { s: t } : t === 32768 ? { strl: true } : { 65526: 'd', 65527: 'f', 65528: 'l', 65529: 'i', 65530: 'b' }[t])
        var td2 = td
    } else {
        release = u8[0]
        if (![104, 105, 108, 110, 111, 113, 114, 115].includes(release)) throw new ReaderError('Это не файл данных Stata (или неизвестная версия).')
        le = u8[1] === 2
        nvar = dv.getUint16(4, le); nobs = dv.getUint32(6, le)
        dataLabel = latin.decode(u8.subarray(10, 10 + (release >= 108 ? 81 : 32))).replace(/\0.*$/s, '')
        let p = 10 + (release >= 108 ? 81 : 32) + (release >= 105 ? 18 : 0)
        const rawTypes = u8.subarray(p, p + nvar); p += nvar
        types = [...rawTypes].map(t => release >= 111 ? (t <= 244 ? { s: t } : { 251: 'b', 252: 'i', 253: 'l', 254: 'f', 255: 'd' }[t]) : (t >= 0x7F ? { s: t - 0x7F } : { 98: 'b', 105: 'i', 108: 'l', 102: 'f', 100: 'd' }[t]))
        const nl = release >= 110 ? 33 : 9
        names = Array.from({ length: nvar }, (_, i) => latin.decode(u8.subarray(p + i * nl, p + (i + 1) * nl)).replace(/\0.*$/s, '')); p += nvar * nl
        p += 2 * (nvar + 1)
        p += nvar * (release >= 114 ? 49 : release >= 105 ? 12 : 7)
        p += nvar * nl
        const ll = release >= 106 ? 81 : 32
        labelsVar = Array.from({ length: nvar }, (_, i) => latin.decode(u8.subarray(p + i * ll, p + (i + 1) * ll)).replace(/\0.*$/s, '')); p += nvar * ll
        if (release >= 105) while (true) { const t = u8[p]; const len = release >= 111 ? dv.getUint32(p + 1, le) : dv.getUint16(p + 1, le); p += release >= 111 ? 5 : 3; if (!t) break; p += len }
        dataOff = p
        var td2 = new TextDecoder('windows-1252')
    }
    const sizes = types.map(t => t.s ?? (t.strl ? 8 : { b: 1, i: 2, l: 4, f: 4, d: 8 }[t]))
    const rowLen = sizes.reduce((a, b) => a + b, 0)
    const rows = [names.map((n, i) => labelsVar[i] ? `${n} (${labelsVar[i]})` : n)]
    const n = Math.min(nobs, LIMIT)
    for (let r = 0; r < n; r++) {
        let p = dataOff + r * rowLen
        const row = []
        types.forEach((t, i) => {
            let v = ''
            if (t.s) v = td2.decode(u8.subarray(p, p + t.s)).replace(/\0.*$/s, '')
            else if (t.strl) { const vv = release >= 118 ? dv.getUint16(p, le) : dv.getUint32(p, le); const oo = release >= 118 ? Number(dv.getBigUint64(p, le) >> 16n) : dv.getUint32(p + 4, le); v = (vv || oo) ? strls.get(`${vv}:${oo}`) ?? '' : '' }
            else {
                const num = t === 'b' ? dv.getInt8(p) : t === 'i' ? dv.getInt16(p, le) : t === 'l' ? dv.getInt32(p, le) : t === 'f' ? dv.getFloat32(p, le) : dv.getFloat64(p, le)
                v = stataMissing(t, num) ? '' : String(t === 'f' ? +num.toPrecision(7) : num)
            }
            row.push(v); p += sizes[i]
        })
        rows.push(row)
    }
    return [{ name: sheetName(dataLabel || 'Данные Stata', n, nobs), rows }]
}

// ================= SAS .sas7bdat (по описанию формата из pandas) =================
const SAS_MAGIC = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xc2, 0xea, 0x81, 0x60, 0xb3, 0x14, 0x11, 0xcf, 0xbd, 0x92, 0x08, 0x00, 0x09, 0xc7, 0x31, 0x8c, 0x18, 0x1f, 0x10, 0x11]
const SAS_DATE_FMT = /^(DATE|DAY|DDMMYY|DOWNAME|JULDAY|JULIAN|MMDDYY|MMYY|MONNAME|MONTH|MONYY|QTR|WEEKDATE|WEEKDAY|WORDDATE|YEAR|YYMM|YYMON|YYMMDD|YYQ|E8601DA|B8601DA|MINGUO|NENGO)/
const SAS_DT_FMT = /^(DATETIME|DTWKDATX|B8601D[NTXZ]|B8601LX|E8601D[NTXZ]|E8601LX|DATEAMPM|DTDATE|DTMONYY|DTYEAR|TOD|MDYAMPM)/
const rleDecompress = (len, inp) => {
    const out = new Uint8Array(len); let r = 0, i = 0
    const copy = n => { for (let k = 0; k < n; k++) out[r++] = inp[i++] }
    const fill = (n, v) => { for (let k = 0; k < n; k++) out[r++] = v }
    while (i < inp.length) {
        const cb = inp[i] & 0xF0, e = inp[i] & 0x0F; i++
        switch (cb) {
            case 0x00: { const n = inp[i++] + 64 + e * 256; copy(n); break }
            case 0x40: { const n = inp[i++] + 18 + e * 256; fill(n, inp[i++]); break }
            case 0x60: { const n = e * 256 + inp[i++] + 17; fill(n, 0x20); break }
            case 0x70: { const n = e * 256 + inp[i++] + 17; fill(n, 0); break }
            case 0x80: copy(e + 1); break
            case 0x90: copy(e + 17); break
            case 0xA0: copy(e + 33); break
            case 0xB0: copy(e + 49); break
            case 0xC0: { const n = e + 3; fill(n, inp[i++]); break }
            case 0xD0: fill(e + 2, 0x40); break
            case 0xE0: fill(e + 2, 0x20); break
            case 0xF0: fill(e + 2, 0); break
            default: throw new ReaderError('Ошибка распаковки SAS (RLE).')
        }
    }
    return out
}
const rdcDecompress = (len, inp) => {
    const out = new Uint8Array(len); let r = 0, i = 0, bits = 0, mask = 0
    while (i < inp.length) {
        mask >>= 1
        if (!mask) { bits = (inp[i] << 8) | inp[i + 1]; i += 2; mask = 0x8000 }
        if (!(bits & mask)) { out[r++] = inp[i++]; continue }
        const cmd = (inp[i] >> 4) & 15; let cnt = inp[i] & 15; i++
        if (cmd === 0) { cnt += 3; out.fill(inp[i], r, r + cnt); r += cnt; i++ }
        else if (cmd === 1) { cnt += (inp[i] << 4) + 19; i++; out.fill(inp[i], r, r + cnt); r += cnt; i++ }
        else if (cmd === 2) { const ofs = cnt + 3 + (inp[i] << 4); i++; cnt = inp[i] + 16; i++; for (let k = 0; k < cnt; k++) out[r + k] = out[r - ofs + k]; r += cnt }
        else { const ofs = cnt + 3 + (inp[i] << 4); i++; for (let k = 0; k < cmd; k++) out[r + k] = out[r - ofs + k]; r += cmd }
    }
    return out
}
export const readSas = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (!SAS_MAGIC.every((b, i) => u8[i] === b)) throw new ReaderError('Это не файл данных SAS.')
    const align1 = u8[32] === 0x33 ? 4 : 0
    const u64 = u8[35] === 0x33
    const le = u8[37] === 0x01
    const intLen = u64 ? 8 : 4
    const uint = (o, n) => n === 1 ? u8[o] : n === 2 ? dv.getUint16(o, le) : n === 4 ? dv.getUint32(o, le) : Number(dv.getBigUint64(o, le))
    const encByte = u8[70]
    const td = tryDecoder({ 20: 'utf-8', 28: 'iso-8859-1', 29: 'iso-8859-1', 61: 'windows-1250', 62: 'windows-1251', 33: 'iso-8859-5', 125: 'gb18030', 134: 'euc-jp', 138: 'shift_jis' }[encByte] ?? 'windows-1252')
    const name = td.decode(u8.subarray(92, 156)).replace(/[\0 ]+$/, '')
    const headerLen = uint(196 + align1, 4), pageSize = uint(200 + align1, 4), pageCount = uint(204 + align1, u64 ? 8 : 4)
    const bitOffset = u64 ? 32 : 16, ptrLen = u64 ? 24 : 12
    const textBlocks = [], colNames = [], colOffsets = [], colLengths = [], colTypes = [], cols = []
    let rowLength = 0, rowCount = 0, mixRows = 0, compression = ''
    const sigOf = o => { const b = u8.subarray(o, o + 4); const b2 = u64 && !le ? u8.subarray(o + 4, o + 8) : b; return [...b2].map(x => x.toString(16).padStart(2, '0')).join('') }
    const SIG = le
        ? { f7f7f7f7: 'row', f6f6f6f6: 'col', '00fcffff': 'counts', fdffffff: 'text', ffffffff: 'name', fcffffff: 'attr', fefbffff: 'fmt', feffffff: 'list' }
        : { f7f7f7f7: 'row', f6f6f6f6: 'col', fffffc00: 'counts', fffffffd: 'text', ffffffff: 'name', fffffffc: 'attr', fffffbfe: 'fmt', fffffffe: 'list' }
    const rows = []
    const pushRow = (o, len) => {
        let src = u8.subarray(o, o + len)
        if (compression && len < rowLength) src = compression === 'RLE' ? rleDecompress(rowLength, src) : rdcDecompress(rowLength, src)
        const row = []
        for (let j = 0; j < cols.length; j++) {
            const c = cols[j], s = colOffsets[j], l = colLengths[j]
            if (c.type === 'd') {
                const b = new Uint8Array(8)
                if (le) b.set(src.subarray(s, s + l), 8 - l); else b.set(src.subarray(s, s + l), 0)
                const v = new DataView(b.buffer).getFloat64(0, le)
                if (Number.isNaN(v)) row.push('')
                else if (SAS_DT_FMT.test(c.format)) row.push(cell(new Date(Date.UTC(1960, 0, 1) + v * 1000)))
                else if (SAS_DATE_FMT.test(c.format)) row.push(cell(new Date(Date.UTC(1960, 0, 1) + v * 864e5)))
                else row.push(String(Math.fround(v) === v ? +v.toPrecision(7) : +v.toPrecision(l >= 8 ? 15 : Math.max(3, Math.floor((l * 8 - 12) * 0.301)))))
            } else row.push(td.decode(src.subarray(s, s + l)).replace(/[\0 ]+$/, ''))
        }
        rows.push(row)
    }
    for (let pg = 0; pg < pageCount && rows.length < LIMIT; pg++) {
        const P = headerLen + pg * pageSize
        if (P + pageSize > u8.length + pageSize) break
        const type = uint(P + bitOffset, 2) & 0xFF00
        const blockCount = uint(P + bitOffset + 2, 2), shCount = uint(P + bitOffset + 4, 2)
        const dataPtrs = []
        if (type === 0 || type === 0x4000 || type === 512 || type === 1024) {
            for (let i = 0; i < shCount; i++) {
                const t = P + bitOffset + 8 + ptrLen * i
                const off = uint(t, intLen), len = uint(t + intLen, intLen), comp = u8[t + 2 * intLen], stype = u8[t + 2 * intLen + 1]
                if (!len || comp === 1) continue
                const o = P + off
                const kind = SIG[sigOf(o)] ?? (compression && (comp === 4 || comp === 0) && stype === 1 ? 'data' : null)
                if (kind === 'row') {
                    rowLength = uint(o + 5 * intLen, intLen); rowCount = uint(o + 6 * intLen, intLen); mixRows = uint(o + 15 * intLen, intLen)
                } else if (kind === 'text') {
                    const size = uint(o + intLen, 2)
                    const block = u8.subarray(o + intLen, o + intLen + size)
                    textBlocks.push(block)
                    if (textBlocks.length === 1) { const s = latin.decode(block); compression = s.includes('SASYZCRL') ? 'RLE' : s.includes('SASYZCR2') ? 'RDC' : '' }
                } else if (kind === 'name') {
                    const n = Math.floor((len - 2 * intLen - 12) / 8)
                    for (let k = 0; k < n; k++) {
                        const b = o + intLen + 8 * (k + 1)
                        const idx = uint(b, 2), co = uint(b + 2, 2), cl = uint(b + 4, 2)
                        colNames.push(td.decode((textBlocks[idx] ?? new Uint8Array()).subarray(co, co + cl)).trim())
                    }
                } else if (kind === 'attr') {
                    const n = Math.floor((len - 2 * intLen - 12) / (intLen + 8))
                    for (let k = 0; k < n; k++) {
                        colOffsets.push(uint(o + intLen + 8 + k * (intLen + 8), intLen))
                        colLengths.push(uint(o + 2 * intLen + 8 + k * (intLen + 8), 4))
                        colTypes.push(u8[o + 2 * intLen + 14 + k * (intLen + 8)] === 1 ? 'd' : 's')
                    }
                } else if (kind === 'fmt') {
                    const b = o + 3 * intLen
                    const fi = Math.min(uint(b + 22, 2), textBlocks.length - 1), fs = uint(b + 24, 2), fl = uint(b + 26, 2)
                    const li = Math.min(uint(b + 28, 2), textBlocks.length - 1), ls = uint(b + 30, 2), ll = uint(b + 32, 2)
                    const n = cols.length
                    cols.push({ name: colNames[n] ?? `Столбец ${n + 1}`, label: td.decode(textBlocks[li]?.subarray(ls, ls + ll) ?? new Uint8Array()).trim(), format: latin.decode(textBlocks[fi]?.subarray(fs, fs + fl) ?? new Uint8Array()).trim().toUpperCase(), type: colTypes[n] })
                } else if (kind === 'data') dataPtrs.push([o, len])
            }
        }
        if (!cols.length && colNames.length && colTypes.length === colNames.length && (type === 256 || type === 512)) for (let n = 0; n < colNames.length; n++) cols.push({ name: colNames[n], label: '', format: '', type: colTypes[n] })
        for (const [o, len] of dataPtrs) { if (rows.length >= LIMIT) break; pushRow(o, len) }
        if (type === 512) {
            let o = P + bitOffset + 8 + shCount * ptrLen
            o += (bitOffset + 8 + shCount * ptrLen) % 8
            const n = Math.min(rowCount, mixRows)
            for (let k = 0; k < n && rows.length < LIMIT && rows.length < rowCount; k++) pushRow(o + k * rowLength, rowLength)
        } else if (type === 256) {
            for (let k = 0; k < blockCount && rows.length < LIMIT; k++) pushRow(P + bitOffset + 8 + k * rowLength, rowLength)
        }
    }
    if (!cols.length) throw new ReaderError('Не удалось прочитать описание столбцов SAS.')
    return [{ name: sheetName(name || 'Данные SAS', rows.length, rowCount), rows: [cols.map(c => c.label && c.label !== c.name ? `${c.name} (${c.label})` : c.name), ...rows] }]
}
