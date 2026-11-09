// Научные и статистические данные версии 0.6: NumPy (.npy, .npz), SAS Transport (.xpt), NetCDF классический (.nc),
// SPSS Portable (.por), MATLAB (.mat v5), R (.rds, .rdata), QlikView (.qvd), банковские выписки (.ofx, .qfx),
// геномика (.gb, .bed, .gff, .gtf), LibreOffice Base (.odb)
import JSZip from 'jszip'
import { escapeHtml as esc, decodeText, ReaderError } from '../util.js'
import { decompress, compressionOf } from './compress.js'
import { unzlibSync, inflateSync } from 'fflate'

const latin = new TextDecoder('latin1')
const utf8 = new TextDecoder()
const utf8strict = new TextDecoder('utf-8', { fatal: true })
const smart = b => { try { return utf8strict.decode(b) } catch { return new TextDecoder('windows-1252').decode(b) } }
const LIMIT = 5000, COLS = 300
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e }
const num = v => v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(+v.toPrecision(10))) : typeof v === 'bigint' ? String(v) : String(v)

// Многомерный массив → таблица: строки по первому измерению, остальные — в столбцы.
// order 'F' — по столбцам (MATLAB, R, Fortran), 'C' — по строкам (NumPy, NetCDF)
export const arraySheet = (name, data, shape, order = 'C', fmt = num) => {
    const total = shape.reduce((a, b) => a * b, 1)
    if (!shape.length || total === 1 && shape.length <= 1) return { name, rows: [['Значение'], [fmt(data[0])]] }
    const nRows = shape[0] ?? 1
    const nCols = shape.length > 1 ? shape.slice(1).reduce((a, b) => a * b, 1) : 1
    const idx = (r, c) => {
        if (order === 'C') return r * nCols + c
        // по столбцам: индекс = r + n0 * (линейный индекс остальных измерений в порядке F)
        return r + nRows * c
    }
    const cols = Math.min(nCols, COLS)
    const head = shape.length > 1 ? ['№', ...Array.from({ length: cols }, (_, c) => {
        if (shape.length === 2) return String(c + 1)
        const sub = []; let k = c
        const rest = shape.slice(1)
        if (order === 'C') { for (let d = rest.length - 1; d >= 0; d--) { sub.unshift(k % rest[d] + 1); k = Math.floor(k / rest[d]) } }
        else for (let d = 0; d < rest.length; d++) { sub.push(k % rest[d] + 1); k = Math.floor(k / rest[d]) }
        return sub.join(',')
    })] : ['№', 'Значение']
    const rows = [head]
    for (let r = 0; r < Math.min(nRows, LIMIT); r++) { const row = [String(r + 1)]; for (let c = 0; c < cols; c++) row.push(fmt(data[idx(r, c)])); rows.push(row) }
    const notes = []
    if (nRows > LIMIT) notes.push(`первые ${LIMIT} из ${nRows} строк`)
    if (nCols > COLS) notes.push(`первые ${COLS} из ${nCols} столбцов`)
    return { name: name + (notes.length ? ` (${notes.join(', ')})` : ''), rows }
}
const dimsStr = shape => shape.length ? shape.join('×') : '1'

// ================= NumPy (.npy, .npz) =================
const NPY_TYPES = { b1: [1, (dv, o) => dv.getUint8(o) ? 'true' : 'false'], i1: [1, (dv, o) => dv.getInt8(o)], u1: [1, (dv, o) => dv.getUint8(o)],
    i2: [2, (dv, o, le) => dv.getInt16(o, le)], u2: [2, (dv, o, le) => dv.getUint16(o, le)], i4: [4, (dv, o, le) => dv.getInt32(o, le)], u4: [4, (dv, o, le) => dv.getUint32(o, le)],
    i8: [8, (dv, o, le) => dv.getBigInt64(o, le)], u8: [8, (dv, o, le) => dv.getBigUint64(o, le)], f4: [4, (dv, o, le) => dv.getFloat32(o, le)], f8: [8, (dv, o, le) => dv.getFloat64(o, le)],
    f2: [2, (dv, o, le) => { const h = dv.getUint16(o, le); const s = h >> 15 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023; return e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15) }],
    M8: [8, (dv, o, le) => dv.getBigInt64(o, le)], m8: [8, (dv, o, le) => dv.getBigInt64(o, le)] }
const npyReader = descr => {
    const m = /^([<>|=]?)([a-zA-Z])(\d+)/.exec(descr)
    if (!m) return null
    const le = m[1] !== '>'
    const kind = m[2], n = +m[3]
    if (kind === 'U') return { size: n * 4, read: (dv, o) => { let s = ''; for (let i = 0; i < n; i++) { const c = dv.getUint32(o + i * 4, le); if (!c) break; s += String.fromCodePoint(c) } return s } }
    if (kind === 'S' || kind === 'a') return { size: n, read: (dv, o) => utf8.decode(new Uint8Array(dv.buffer, dv.byteOffset + o, n)).replace(/\0+$/, '') }
    if (kind === 'c') { const half = NPY_TYPES['f' + n / 2]; return { size: n, read: (dv, o) => { const re = half[1](dv, o, le), im = half[1](dv, o + n / 2, le); return `${num(re)}${im < 0 ? '−' : '+'}${num(Math.abs(im))}i` } } }
    const t = NPY_TYPES[kind + n] ?? NPY_TYPES[kind + (kind === 'b' ? '1' : n)]
    if (!t) return null
    return { size: t[0], read: (dv, o) => t[1](dv, o, le) }
}
const pyLiteral = s => { // словарь заголовка .npy — питоновский литерал, переводим в JSON
    const js = s.replace(/\(/g, '[').replace(/\)/g, ']').replace(/'/g, '"').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/,\s*([\]}])/g, '$1')
    return JSON.parse(js)
}
export const parseNpy = (u8, name = 'Массив') => {
    if (!(u8[0] === 0x93 && latin.decode(u8.subarray(1, 6)) === 'NUMPY')) throw new ReaderError('Это не массив NumPy (.npy).')
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    const major = u8[6]
    const hl = major === 1 ? dv.getUint16(8, true) : dv.getUint32(8, true)
    const hstart = major === 1 ? 10 : 12
    const head = pyLiteral((major >= 3 ? utf8 : latin).decode(u8.subarray(hstart, hstart + hl)).trim())
    const off = hstart + hl
    const shape = head.shape ?? []
    const total = shape.reduce((a, b) => a * b, 1)
    const order = head.fortran_order ? 'F' : 'C'
    if (Array.isArray(head.descr)) { // структурированный массив — сразу таблица
        let pos = 0
        const fields = head.descr.map(([fname, d]) => { const r = npyReader(Array.isArray(d) ? 'V' : d); const f = { name: Array.isArray(fname) ? fname[1] : fname, at: pos, r }; pos += r?.size ?? 0; return f })
        if (fields.some(f => !f.r)) throw new ReaderError('Сложный структурированный массив NumPy пока не поддерживается.')
        const rows = [fields.map(f => f.name)]
        for (let i = 0; i < Math.min(total, LIMIT); i++) rows.push(fields.map(f => num(f.r.read(dv, off + i * pos + f.at))))
        return { name: `${name} (${total > LIMIT ? `первые ${LIMIT} из ${total}` : total})`, rows, shape, descr: 'запись' }
    }
    const r = npyReader(head.descr)
    if (!r) throw new ReaderError(`Тип данных NumPy «${head.descr}» пока не поддерживается (например, объекты Python).`)
    const max = Math.min(total, LIMIT * COLS)
    const vals = new Array(max)
    // для порядка 'F' читаем всё нужное выборочно через индекс
    const get = i => r.read(dv, off + i * r.size)
    const proxy = new Proxy([], { get: (t, k) => typeof k === 'string' && /^\d+$/.test(k) ? get(+k) : undefined })
    void vals
    return { ...arraySheet(name, proxy, shape, order), shape, descr: head.descr }
}
export const readNpz = async buf => {
    const zip = await JSZip.loadAsync(buf)
    const names = Object.keys(zip.files).filter(n => n.endsWith('.npy'))
    if (!names.length) throw new ReaderError('В архиве .npz нет массивов.')
    const out = [], summary = [['Массив', 'Размер', 'Тип']]
    for (const n of names) {
        const short = n.replace(/\.npy$/, '')
        try { const s = parseNpy(await zip.file(n).async('uint8array'), short); out.push(s); summary.push([short, dimsStr(s.shape), String(s.descr)]) }
        catch (e) { summary.push([short, '', 'не прочитан: ' + e.message]) }
    }
    return [{ name: 'Список массивов', rows: summary }, ...out]
}

// ================= SAS Transport (.xpt, версия 5) =================
const ibmFloat = (u8, o, len) => {
    const b0 = u8[o]
    let zero = true; for (let i = 1; i < len; i++) if (u8[o + i]) { zero = false; break }
    if (zero && (b0 === 0x2E || b0 === 0x5F || (b0 >= 0x41 && b0 <= 0x5A))) return null // пропуск: . ._ .A–.Z
    if (zero && b0 === 0) return 0
    let mant = 0
    for (let i = 1; i < 8; i++) mant = mant * 256 + (i < len ? u8[o + i] : 0)
    const sign = b0 & 0x80 ? -1 : 1
    return sign * mant / 2 ** 56 * 16 ** ((b0 & 0x7F) - 64)
}
export const readXpt = buf => {
    const u8 = new Uint8Array(buf)
    const rec = p => latin.decode(u8.subarray(p, p + 80))
    const v8 = rec(0).startsWith('HEADER RECORD*******LIBV8   HEADER RECORD!!!!!!!')
    if (!v8 && !rec(0).startsWith('HEADER RECORD*******LIBRARY HEADER RECORD!!!!!!!')) throw new ReaderError('Это не файл SAS Transport (.xpt).')
    const MEMBER = v8 ? 'HEADER RECORD*******MEMBV8  HEADER RECORD!!!!!!!' : 'HEADER RECORD*******MEMBER  HEADER RECORD!!!!!!!'
    const sheets = []
    let p = 0
    const all = latin.decode(u8)
    while ((p = all.indexOf(MEMBER, p)) >= 0) {
        const nsLen = +rec(p).slice(74, 78) || 140
        const dsName = rec(p + 160).slice(8, v8 ? 40 : 16).trim()
        const dsLabel = rec(p + 240).slice(32, 72).trim()
        const nsHead = p + 320
        if (!/^HEADER RECORD\*{7}(NAMESTR|NAMSTV8) HEADER RECORD!{7}/.test(rec(nsHead))) break
        const nvar = +rec(nsHead).slice(54, 58)
        const dv = new DataView(u8.buffer, u8.byteOffset)
        let q = nsHead + 80
        const vars = []
        for (let i = 0; i < nvar; i++, q += nsLen) vars.push({ type: dv.getInt16(q), len: dv.getInt16(q + 4), name: (v8 ? smart(u8.subarray(q + 88, q + 120)).trim() : '') || smart(u8.subarray(q + 8, q + 16)).trim(), label: smart(u8.subarray(q + 16, q + 56)).trim(), fmt: latin.decode(u8.subarray(q + 56, q + 64)).trim(), pos: dv.getInt32(q + 84) })
        q = nsHead + 80 + Math.ceil(nvar * nsLen / 80) * 80
        // в версии 8 длинные подписи лежат в записях LABELV8/LABELV9
        if (/^HEADER RECORD\*{7}LABELV[89] HEADER RECORD!{7}/.test(rec(q))) {
            const nl = +rec(q).slice(48, 80).trim(); const isV9 = rec(q).includes('LABELV9'); let r = q + 80
            for (let k = 0; k < nl; k++) {
                const vn = dv.getUint16(r), nameLen = dv.getUint16(r + 2), labLen = dv.getUint16(r + 4); let h = 6
                let fl = 0, il = 0; if (isV9) { fl = dv.getUint16(r + 6); il = dv.getUint16(r + 8); h = 10 }
                const v = vars[vn - 1]; if (v) { v.name = smart(u8.subarray(r + h, r + h + nameLen)); v.label = smart(u8.subarray(r + h + nameLen, r + h + nameLen + labLen)) }
                r += h + nameLen + labLen + fl + il
            }
            q = q + 80 + Math.ceil((r - q - 80) / 80) * 80
        }
        if (!/^HEADER RECORD\*{7}(OBS     |OBSV8   )HEADER RECORD!{7}/.test(rec(q))) break
        q += 80
        const rl = vars.reduce((s, v) => Math.max(s, v.pos + v.len), 0)
        const next = all.indexOf(MEMBER, q)
        const end = next >= 0 ? next : u8.length
        const rows = [vars.map(v => v.label && v.label !== v.name ? `${v.name} (${v.label})` : v.name)]
        let n = 0
        for (let r = q; r + rl <= end && n < LIMIT; r += rl) {
            // хвост — пробелы до конца 80-байтовой записи
            if (u8.subarray(r, r + rl).every(b => b === 0x20)) break
            rows.push(vars.map(v => {
                if (v.type === 2) return smart(u8.subarray(r + v.pos, r + v.pos + v.len)).trimEnd()
                const x = ibmFloat(u8, r + v.pos, v.len)
                if (x == null) return ''
                if (/^(DATE|YYMMDD|MMDDYY|DDMMYY|E8601DA)/i.test(v.fmt)) return new Date(Date.UTC(1960, 0, 1) + x * 864e5).toISOString().slice(0, 10)
                if (/^(DATETIME|E8601DT)/i.test(v.fmt)) return new Date(Date.UTC(1960, 0, 1) + x * 1000).toISOString().replace('T', ' ').slice(0, 19)
                return num(x)
            }))
            n++
        }
        sheets.push({ name: dsName + (dsLabel ? ` — ${dsLabel}` : ''), rows })
        p = end
        if (next < 0) break
    }
    if (!sheets.length) throw new ReaderError('В файле SAS Transport нет таблиц.')
    return sheets
}

// ================= NetCDF классический (CDF-1, CDF-2, CDF-5) =================
export const readNetcdf = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (u8[0] === 0x89 && latin.decode(u8.subarray(1, 4)) === 'HDF') throw new ReaderError('Это NetCDF-4 (внутри HDF5) — для него нужна отдельная библиотека, она пока не подключена.')
    if (latin.decode(u8.subarray(0, 3)) !== 'CDF') throw new ReaderError('Это не файл NetCDF.')
    const ver = u8[3]
    let p = 4
    const i32 = () => { const v = dv.getInt32(p); p += 4; return v }
    const big = () => { const v = Number(dv.getBigInt64(p)); p += 8; return v }
    const cnt = () => ver === 5 ? big() : i32()
    const off = () => ver === 1 ? i32() : big()
    const str = () => { const n = cnt(); const s = utf8.decode(u8.subarray(p, p + n)); p += Math.ceil(n / 4) * 4; return s }
    const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8, 7: 1, 8: 2, 9: 4, 10: 8, 11: 8 }
    const readVal = (t, o) => [null, () => dv.getInt8(o), () => u8[o], () => dv.getInt16(o), () => dv.getInt32(o), () => dv.getFloat32(o), () => dv.getFloat64(o), () => dv.getUint8(o), () => dv.getUint16(o), () => dv.getUint32(o), () => dv.getBigInt64(o), () => dv.getBigUint64(o)][t]()
    const values = (t, n) => { if (t === 2) { const s = utf8.decode(u8.subarray(p, p + n)).replace(/\0+$/, ''); p += Math.ceil(n / 4) * 4; return s } const a = []; for (let i = 0; i < n; i++) a.push(readVal(t, p + i * SIZE[t])); p += Math.ceil(n * SIZE[t] / 4) * 4; return a.length === 1 ? a[0] : a }
    const attrs = () => { const tag = i32(); const n = cnt(); if (tag === 0 && n === 0) return {}; const o = {}; for (let i = 0; i < n; i++) { const name = str(); const t = i32(); o[name] = values(t, cnt()) } return o }
    const numrecs = cnt()
    let tag = i32(), n = cnt()
    const dims = []
    for (let i = 0; i < n; i++) dims.push({ name: str(), len: cnt() })
    void tag
    const gatts = attrs()
    tag = i32(); n = cnt()
    const vars = []
    for (let i = 0; i < n; i++) {
        const name = str(); const nd = cnt(); const ids = []; for (let k = 0; k < nd; k++) ids.push(cnt())
        const at = attrs(); const type = i32(); const vsize = cnt(); const begin = off()
        vars.push({ name, ids, at, type, vsize, begin, isRec: ids.length > 0 && dims[ids[0]].len === 0 })
    }
    const recVars = vars.filter(v => v.isRec)
    const perRec = v => v.ids.slice(1).reduce((a, id) => a * dims[id].len, 1) * SIZE[v.type]
    const recsize = recVars.length === 1 ? perRec(recVars[0]) : recVars.reduce((s, v) => s + v.vsize, 0)
    const fmtAttr = v => Array.isArray(v) ? v.map(num).join(', ') : num(v)
    const TYPE = { 1: 'byte', 2: 'char', 3: 'short', 4: 'int', 5: 'float', 6: 'double', 7: 'ubyte', 8: 'ushort', 9: 'uint', 10: 'int64', 11: 'uint64' }
    const summary = [['Переменная', 'Измерения', 'Размер', 'Тип', 'Единицы', 'Описание']]
    const sheets = []
    for (const v of vars) {
        const shape = v.ids.map(id => dims[id].len || numrecs)
        summary.push([v.name, v.ids.map(id => dims[id].name).join(', '), dimsStr(shape), TYPE[v.type] ?? '?', fmtAttr(v.at.units ?? ''), fmtAttr(v.at.long_name ?? v.at.standard_name ?? '')])
        const per = shape.slice(v.isRec ? 1 : 0).reduce((a, b) => a * b, 1)
        const scale = typeof v.at.scale_factor === 'number' ? v.at.scale_factor : 1, add = typeof v.at.add_offset === 'number' ? v.at.add_offset : 0
        const fill = v.at._FillValue
        const get = i => {
            const o = v.isRec ? v.begin + Math.floor(i / per) * recsize + (i % per) * SIZE[v.type] : v.begin + i * SIZE[v.type]
            if (o + SIZE[v.type] > u8.length) return null
            const x = readVal(v.type, o)
            if (fill != null && x === fill) return null
            return typeof x === 'number' && (scale !== 1 || add) ? x * scale + add : x
        }
        if (v.type === 2) { // текстовые переменные: последнее измерение — строка
            const sl = shape[shape.length - 1] || 1, nStr = shape.slice(0, -1).reduce((a, b) => a * b, 1)
            const rows = [['№', v.name]]
            for (let i = 0; i < Math.min(nStr, LIMIT); i++) { let s = ''; for (let k = 0; k < sl; k++) { const c = get(i * sl + k); if (!c) break; s += String.fromCharCode(c) } rows.push([String(i + 1), s]) }
            sheets.push({ name: v.name, rows }); continue
        }
        const proxy = new Proxy([], { get: (t, k) => typeof k === 'string' && /^\d+$/.test(k) ? get(+k) : undefined })
        sheets.push(arraySheet(v.name + (v.at.units ? `, ${fmtAttr(v.at.units)}` : ''), proxy, shape, 'C'))
    }
    const meta = [['Свойство', 'Значение'], ['Формат', ver === 1 ? 'NetCDF classic' : ver === 2 ? 'NetCDF 64-bit offset' : 'NetCDF CDF-5'], ['Записей', String(numrecs)],
        ...dims.map(d => [`Измерение ${d.name}`, d.len ? String(d.len) : `без ограничения (${numrecs})`]), ...Object.entries(gatts).map(([k, v]) => [k, fmtAttr(v)])]
    return [{ name: 'Переменные', rows: summary }, { name: 'Сведения', rows: meta }, ...sheets]
}

// ================= SPSS Portable (.por) =================
export const readPor = buf => {
    const u8 = new Uint8Array(buf)
    // строки по 80 символов: убираем переводы строк и дополняем короткие строки пробелами
    const lines = latin.decode(u8).split(/\r?\n/)
    let raw = lines.map(l => l.length < 80 ? l.padEnd(80, ' ') : l).join('')
    const table = raw.slice(200, 456)
    // таблица перекодировки: позиция символа в «стандартной» таблице → символ в файле
    const STD = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz .<(+|&[]!$*);^-/|,%_>?`:#@\'="'
    const map = new Map()
    for (let i = 0; i < STD.length; i++) { const c = table[64 + i]; if (c && !map.has(c)) map.set(c, STD[i]) }
    const tr = s => [...s].map(c => map.get(c) ?? c).join('')
    let s = tr(raw.slice(456))
    if (!s.startsWith('SPSSPORT')) { s = raw.slice(456); if (!s.startsWith('SPSSPORT')) throw new ReaderError('Это не файл SPSS Portable (.por).') }
    let p = 8
    const D = '0123456789ABCDEFGHIJKLMNOPQRST'
    const skipSp = () => { while (s[p] === ' ') p++ }
    const number = () => {
        skipSp()
        if (s[p] === '*' && s[p + 1] === '.') { p += 2; return null }
        let neg = false; if (s[p] === '-') { neg = true; p++ }
        let ip = 0, fr = 0, fd = 0, exp = 0, inFrac = false
        while (p < s.length) {
            const c = s[p]
            if (c === '.') { inFrac = true; p++; continue }
            const d = D.indexOf(c)
            if (d < 0) break
            if (inFrac) { fr = fr * 30 + d; fd++ } else ip = ip * 30 + d
            p++
        }
        if (s[p] === '+' || s[p] === '-') { const es = s[p] === '-' ? -1 : 1; p++; let e = 0; while (D.indexOf(s[p]) >= 0) e = e * 30 + D.indexOf(s[p++]); exp = es * e }
        if (s[p] === '/') p++
        const v = (ip + fr / 30 ** fd) * 30 ** exp
        return neg ? -v : v
    }
    const string = () => { const n = number(); const v = s.slice(p, p + n); p += n; return v }
    const vars = [], valueLabels = new Map()
    let product = '', date = ''
    if (s[p] === 'A') { p++; date = string(); string() }
    while (p < s.length) {
        const tag = s[p++]
        if (tag === '1') product = string()
        else if (tag === '2' || tag === '3') string()
        else if (tag === '4') number()
        else if (tag === '5') number()
        else if (tag === '6') string()
        else if (tag === '7') { const w = number(); const name = string(); const pf = [number(), number(), number()]; number(); number(); number(); vars.push({ width: w, name, label: '', fmt: pf }) }
        else if (tag === '8') { const v = vars[vars.length - 1]; v.width ? string() : number() }
        else if (tag === '9' || tag === 'A') { const v = vars[vars.length - 1]; v.width ? string() : number() }
        else if (tag === 'B') { const v = vars[vars.length - 1]; if (v.width) { string(); string() } else { number(); number() } }
        else if (tag === 'C') vars[vars.length - 1].label = string()
        else if (tag === 'D') { const nv = number(); const names = []; for (let i = 0; i < nv; i++) names.push(string()); const nl = number(); const isStr = vars.find(v => v.name === names[0])?.width > 0; const m = new Map(); for (let i = 0; i < nl; i++) { const k = isStr ? string() : number(); m.set(String(k), string()) } for (const nm of names) valueLabels.set(nm, m) }
        else if (tag === 'E') { const n = number(); for (let i = 0; i < n; i++) string() }
        else if (tag === 'F') break
        else if (tag === ' ') continue
        else break
    }
    void date
    if (!vars.length) throw new ReaderError('В файле SPSS не найдено переменных.')
    const rows = [vars.map(v => v.label ? `${v.name} (${v.label})` : v.name)]
    while (p < s.length && rows.length <= LIMIT) {
        skipSp()
        if (s[p] === 'Z' || p >= s.length) break
        const row = []
        for (const v of vars) {
            const x = v.width ? string().trimEnd() : number()
            const lab = valueLabels.get(v.name)?.get(String(x))
            row.push(lab ?? (x == null ? '' : v.width ? x : v.fmt[0] === 20 || v.fmt[0] === 22 || v.fmt[0] === 23 || v.fmt[0] === 24 || v.fmt[0] === 28 || v.fmt[0] === 29 || v.fmt[0] === 30 || v.fmt[0] === 38 || v.fmt[0] === 39 ? new Date(Date.UTC(1582, 9, 14) + x * 1000).toISOString().slice(0, v.fmt[0] === 22 ? 19 : 10).replace('T', ' ') : num(x)))
        }
        rows.push(row)
    }
    return [{ name: `Данные${product ? ' — ' + product.trim() : ''}`, rows }, { name: 'Переменные', rows: [['Имя', 'Описание', 'Тип'], ...vars.map(v => [v.name, v.label, v.width ? `текст (${v.width})` : 'число'])] }]
}

// ================= MATLAB (.mat, версии 5–7.2) =================
const MI = { 1: [1, 'getInt8'], 2: [1, 'getUint8'], 3: [2, 'getInt16'], 4: [2, 'getUint16'], 5: [4, 'getInt32'], 6: [4, 'getUint32'], 7: [4, 'getFloat32'], 9: [8, 'getFloat64'], 12: [8, 'getBigInt64'], 13: [8, 'getBigUint64'] }
const MX_CLASS = { 1: 'cell', 2: 'struct', 3: 'object', 4: 'char', 5: 'sparse', 6: 'double', 7: 'single', 8: 'int8', 9: 'uint8', 10: 'int16', 11: 'uint16', 12: 'int32', 13: 'uint32', 14: 'int64', 15: 'uint64', 16: 'function', 17: 'opaque' }
export const readMat = buf => {
    const u8 = new Uint8Array(buf)
    const text = latin.decode(u8.subarray(0, 116))
    if (u8[0] === 0x89 && latin.decode(u8.subarray(1, 4)) === 'HDF' || /MATLAB 7\.3/.test(text) || latin.decode(u8.subarray(512, 516)) === '\x89HDF') throw new ReaderError('Это MATLAB 7.3 (внутри HDF5) — для него нужна отдельная библиотека, она пока не подключена.')
    if (!/^MATLAB 5\.0 MAT-file/.test(text)) {
        if (u8[0] === 0 || u8[0] === 10) throw new ReaderError('Это MATLAB версии 4 — такие файлы пока не поддерживаются.')
        throw new ReaderError('Это не файл MATLAB (.mat).')
    }
    const le = latin.decode(u8.subarray(126, 128)) === 'IM'
    const parseElements = (bytes, start, end, out) => {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        let p = start
        while (p + 8 <= end) {
            let type = dv.getUint32(p, le), size, data, next
            if (type >> 16) { size = type >> 16; type &= 0xFFFF; data = p + 4; next = p + 8 }
            else { size = dv.getUint32(p + 4, le); data = p + 8; next = data + Math.ceil(size / 8) * 8 }
            if (type === 15) { // сжатый блок
                let inner; try { inner = unzlibSync(bytes.subarray(data, data + size)) } catch { inner = inflateSync(bytes.subarray(data + 2, data + size)) }
                parseElements(inner, 0, inner.length, out)
                p = data + size; continue
            }
            out.push({ type, bytes, dv, at: data, size })
            p = next
        }
        return out
    }
    const numbers = e => {
        const t = MI[e.type]
        if (!t) { if (e.type === 16) return [...utf8.decode(e.bytes.subarray(e.at, e.at + e.size))]; if (e.type === 17) return [...new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(e.bytes.subarray(e.at, e.at + e.size))]; return [] }
        const n = e.size / t[0], a = new Array(n)
        for (let i = 0; i < n; i++) a[i] = e.dv[t[1]](e.at + i * t[0], le)
        return a
    }
    const matrix = e => { // элемент miMATRIX
        if (e.size === 0) return { cls: 'empty', dims: [0, 0], data: [] }
        const subs = parseElements(e.bytes, e.at, e.at + e.size, [])
        const flags = numbers(subs[0])[0]
        const cls = MX_CLASS[flags & 0xFF] ?? '?'
        const complex = !!(flags & 0x800), logical = !!(flags & 0x200)
        const dims = numbers(subs[1]).map(Number)
        const name = utf8.decode(subs[2].bytes.subarray(subs[2].at, subs[2].at + subs[2].size))
        const total = dims.reduce((a, b) => a * b, 1)
        if (cls === 'cell') return { name, cls, dims, data: subs.slice(3).map(matrix) }
        if (cls === 'struct' || cls === 'object') {
            let k = 3; if (cls === 'object') k++
            const fl = numbers(subs[k])[0]; const raw = subs[k + 1].bytes.subarray(subs[k + 1].at, subs[k + 1].at + subs[k + 1].size)
            const fields = []; for (let i = 0; i < raw.length / fl; i++) fields.push(utf8.decode(raw.subarray(i * fl, (i + 1) * fl)).replace(/\0.*$/, ''))
            const vals = subs.slice(k + 2).map(matrix)
            return { name, cls, dims, fields, data: Array.from({ length: total }, (_, i) => Object.fromEntries(fields.map((f, j) => [f, vals[i * fields.length + j]]))) }
        }
        if (cls === 'sparse') {
            const ir = numbers(subs[3]), jc = numbers(subs[4]), pr = numbers(subs[5])
            const items = []; for (let c = 0; c + 1 < jc.length; c++) for (let k = jc[c]; k < jc[c + 1]; k++) items.push([ir[k] + 1, c + 1, pr[k]])
            return { name, cls, dims, sparse: items }
        }
        let re = subs[3] ? numbers(subs[3]) : []
        if (complex && subs[4]) { const im = numbers(subs[4]); re = re.map((r, i) => `${num(r)}${im[i] < 0 ? '−' : '+'}${num(Math.abs(im[i]))}i`) }
        if (cls === 'char') { const chars = re.map(c => typeof c === 'number' ? String.fromCharCode(c) : c); return { name, cls, dims, data: chars, text: dims[0] <= 1 ? chars.join('') : null } }
        if (logical) re = re.map(v => v ? 'true' : 'false')
        return { name, cls, dims, data: re }
    }
    const top = parseElements(u8, 128, u8.length, []).filter(e => e.type === 14).map(matrix)
    if (!top.length) throw new ReaderError('В файле MATLAB нет переменных.')
    const brief = m => {
        if (!m) return ''
        if (m.cls === 'char') return m.text ?? `[текст ${dimsStr(m.dims)}]`
        if (m.cls === 'struct') return `[структура: ${m.fields.join(', ')}]`
        if (m.cls === 'cell') return `{${m.data.slice(0, 5).map(brief).join('; ')}${m.data.length > 5 ? '; …' : ''}}`
        if (m.data?.length === 1) return num(m.data[0])
        return `[${m.cls} ${dimsStr(m.dims)}]`
    }
    const summary = [['Переменная', 'Тип', 'Размер', 'Значение']]
    const sheets = []
    const add = (m, name) => {
        summary.push([name, m.cls, dimsStr(m.dims), brief(m)])
        if (m.cls === 'char' && m.text != null) return
        if (m.cls === 'sparse') { sheets.push({ name, rows: [['Строка', 'Столбец', 'Значение'], ...m.sparse.slice(0, LIMIT).map(r => r.map(num))] }); return }
        if (m.cls === 'struct') {
            if (m.data.length === 1) { for (const f of m.fields) { const v = m.data[0][f]; if (v && (v.cls === 'struct' || (v.data?.length ?? 0) > 1 && !(v.cls === 'char' && v.text != null))) add(v, `${name}.${f}`); else summary.push([`${name}.${f}`, v?.cls ?? '', v ? dimsStr(v.dims) : '', brief(v)]) } return }
            sheets.push({ name, rows: [m.fields, ...m.data.slice(0, LIMIT).map(r => m.fields.map(f => brief(r[f])))] }); return
        }
        if (m.cls === 'cell') { sheets.push(arraySheet(name, m.data.map(brief), m.dims, 'F', x => x)); return }
        if (m.data?.length > 1) sheets.push(arraySheet(name, m.data, m.dims, 'F'))
    }
    for (const m of top) add(m, m.name)
    return [{ name: 'Переменные', rows: summary }, ...sheets]
}

// ================= R (.rds, .rdata, .rda) =================
export const readRData = async (ctx, buf) => {
    let u8 = new Uint8Array(buf)
    const kind = compressionOf(u8)
    if (kind) u8 = await decompress(ctx, u8, kind)
    let p = 0
    const head5 = latin.decode(u8.subarray(0, 5))
    const isRData = /^RD[XAB][23]\n/.test(head5)
    if (isRData) p = 5
    const fmt = latin.decode(u8.subarray(p, p + 2))
    if (fmt === 'A\n') throw new ReaderError('Файл R сохранён в текстовом виде (ascii = TRUE) — такой вариант пока не поддерживается.')
    if (fmt !== 'X\n' && fmt !== 'B\n') throw new ReaderError('Это не файл данных R (.rds, .RData).')
    const le = fmt === 'B\n'
    p += 2
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    const int = () => { const v = dv.getInt32(p, !le ? false : true); p += 4; return v }
    const dbl = () => { const v = dv.getFloat64(p, le); p += 8; return v }
    const version = int(); int(); int()
    if (version === 3) { const n = int(); p += n }
    const refs = []
    const NA_INT = -2147483648
    const isNaReal = (o) => { const hi = dv.getUint32(o + (le ? 4 : 0), le), lo = dv.getUint32(o + (le ? 0 : 4), le); return hi === 0x7FF00000 && lo === 1954 || (hi & 0x7FF00000) === 0x7FF00000 && lo === 1954 }
    const length = () => { const n = int(); if (n === -1) { const hi = int(), lo = int(); return hi * 2 ** 32 + lo } return n }
    const item = () => {
        const flags = int()
        const type = flags & 0xFF, hasAttr = !!(flags & 0x200), hasTag = !!(flags & 0x400), isObj = !!(flags & 0x100)
        void isObj
        switch (type) {
            case 254: return null // NILVALUE
            case 242: case 241: case 253: return { type: 'env', special: true }
            case 251: case 252: return { type: 'missing' }
            case 250: return { type: 'env', special: true }
            case 255: { let i = flags >> 8; if (i === 0) i = int(); return refs[i - 1] }
            case 249: case 248: case 247: { // NAMESPACESXP, PACKAGESXP, PERSISTSXP: список строк
                const v = { type: 'namespace' }; int(); const n = int(); for (let i = 0; i < n; i++) item(); refs.push(v); return v }
            case 1: { const name = item(); const v = { type: 'sym', name: name?.value ?? '' }; refs.push(v); return v }
            case 4: { // окружение
                const v = { type: 'env' }; refs.push(v); int(); item(); v.frame = item(); item(); item(); return v
            }
            case 9: { const n = int(); if (n === -1) return { type: 'char', value: null }; const s = ((flags >> 12) & 4 ? latin : utf8).decode(u8.subarray(p, p + n)); p += n; return { type: 'char', value: s } }
            case 2: case 3: case 5: case 6: case 17: case 239: case 240: { // пары и вызовы
                const items = []
                let f = flags, tp = type
                for (let guard = 0; guard < 1e7; guard++) {
                    const a = (f & 0x200) || tp === 239 || tp === 240 ? item() : null
                    const tag = f & 0x400 ? item() : null
                    const car = item()
                    items.push({ tag: tag?.name ?? null, value: car, attr: a })
                    // следующий элемент списка (cdr) читается как новый заголовок
                    const nf = int(); const nt = nf & 0xFF
                    if (nt === 254) break
                    if (![2, 3, 5, 6, 17, 239, 240].includes(nt)) { p -= 4; items.push({ tag: null, value: item() }); break }
                    f = nf; tp = nt
                }
                return { type: type === 6 || type === 240 ? 'lang' : 'pairlist', items }
            }
            case 238: { // ALTREP: компактные последовательности и «обёртки»
                const info = item(), state = item(), attr = item()
                const cls = info?.items?.[0]?.value?.name ?? ''
                let v
                if (cls === 'compact_intseq' || cls === 'compact_realseq') { const [n, start, step] = state.data; v = { type: cls === 'compact_intseq' ? 'int' : 'real', data: Array.from({ length: Math.min(n, 1e7) }, (_, i) => start + i * step) } }
                else if (cls === 'deferred_string') { const src = state?.items?.[0]?.value ?? state; v = { type: 'str', data: (src.data ?? []).map(x => x == null ? null : String(x)) } }
                else if (/^wrap_/.test(cls)) v = { ...(state?.data?.[0] ?? state?.items?.[0]?.value ?? { type: 'list', data: [] }) }
                else v = { type: 'unknown', note: cls }
                if (attr) v.attr = toAttr(attr)
                return v
            }
            case 10: case 13: { const n = length(); const a = new Array(n); for (let i = 0; i < n; i++) { const x = int(); a[i] = x === NA_INT ? null : type === 10 ? !!x : x } const v = { type: type === 10 ? 'lgl' : 'int', data: a }; if (hasAttr) v.attr = toAttr(item()); return v }
            case 14: { const n = length(); const a = new Array(n); for (let i = 0; i < n; i++) { a[i] = isNaReal(p) ? null : dbl(); if (a[i] === null) p += 8 } const v = { type: 'real', data: a }; if (hasAttr) v.attr = toAttr(item()); return v }
            case 15: { const n = length(); const a = new Array(n); for (let i = 0; i < n; i++) { const re = dbl(), im = dbl(); a[i] = `${num(re)}${im < 0 ? '−' : '+'}${num(Math.abs(im))}i` } const v = { type: 'cplx', data: a }; if (hasAttr) v.attr = toAttr(item()); return v }
            case 16: { const n = length(); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = item().value; const v = { type: 'str', data: a }; if (hasAttr) v.attr = toAttr(item()); return v }
            case 19: case 20: { const n = length(); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = item(); const v = { type: 'list', data: a }; if (hasAttr) v.attr = toAttr(item()); return v }
            case 24: { const n = length(); const v = { type: 'raw', data: [...u8.subarray(p, p + n)] }; p += n; if (hasAttr) v.attr = toAttr(item()); return v }
            case 25: { const v = { type: 's4' }; if (hasAttr) v.attr = toAttr(item()); return v }
            case 22: { const v = { type: 'extptr' }; refs.push(v); item(); item(); if (hasAttr) item(); return v }
            case 23: { const v = { type: 'weakref' }; refs.push(v); if (hasAttr) item(); return v }
            case 21: throw new ReaderError('В файле R есть скомпилированные функции — такие объекты пока не читаются.')
            default: throw new ReaderError(`Неизвестный тип объекта R (${type}).`)
        }
    }
    const toAttr = pl => Object.fromEntries((pl?.items ?? []).map(i => [i.tag, i.value]))
    let root
    try { root = item() } catch (e) { if (e instanceof ReaderError) throw e; throw new ReaderError('Не удалось прочитать файл R: ' + e.message) }
    // превращаем в листы таблицы
    const cls = v => v?.attr?.class?.data ?? []
    const colValues = v => {
        if (!v) return []
        const c = cls(v)
        if (c.includes('factor')) { const lv = v.attr.levels?.data ?? []; return v.data.map(i => i == null ? '' : lv[i - 1] ?? '') }
        if (c.includes('Date')) return v.data.map(d => d == null ? '' : new Date(d * 864e5).toISOString().slice(0, 10))
        if (c.includes('POSIXct')) return v.data.map(d => d == null ? '' : new Date(d * 1000).toISOString().replace('T', ' ').slice(0, 19))
        if (v.type === 'list') return v.data.map(brief)
        return (v.data ?? []).map(x => x == null ? 'NA' : typeof x === 'boolean' ? (x ? 'TRUE' : 'FALSE') : num(x))
    }
    const brief = v => {
        if (v == null) return 'NULL'
        if (v.type === 'str' || v.type === 'int' || v.type === 'real' || v.type === 'lgl' || v.type === 'cplx') { const vals = colValues(v); return vals.length === 1 ? vals[0] : `${v.type === 'str' ? 'текст' : 'числа'} [${vals.length}]: ${vals.slice(0, 5).join(', ')}${vals.length > 5 ? ', …' : ''}` }
        if (v.type === 'list') return cls(v).includes('data.frame') ? `таблица ${v.data[0]?.data?.length ?? 0}×${v.data.length}` : `список [${v.data.length}]`
        return `[${v.type}]`
    }
    const sheets = [], summary = [['Объект', 'Что это', 'Кратко']]
    const add = (v, name, depth = 0) => {
        if (!v) return
        const c = cls(v)
        if (v.type === 'list' && c.includes('data.frame')) {
            const names = v.attr?.names?.data ?? v.data.map((_, i) => `V${i + 1}`)
            const cols = v.data.map(colValues)
            const n = Math.max(0, ...cols.map(x => x.length))
            const rn = v.attr?.['row.names']
            const rowNames = rn?.type === 'str' ? rn.data : null
            const rows = [[...(rowNames ? [''] : []), ...names]]
            for (let i = 0; i < Math.min(n, LIMIT); i++) rows.push([...(rowNames ? [rowNames[i]] : []), ...cols.map(col => col[i] ?? '')])
            sheets.push({ name: `${name} (${n > LIMIT ? `первые ${LIMIT} из ${n}` : n} строк)`, rows })
            summary.push([name, 'таблица (data.frame)', `${n} строк × ${names.length} столбцов`])
            return
        }
        if (v.type === 'list') {
            const names = v.attr?.names?.data ?? []
            summary.push([name, 'список', `${v.data.length} элементов`])
            if (depth < 3) v.data.forEach((x, i) => add(x, `${name}$${names[i] || i + 1}`, depth + 1))
            return
        }
        if (['str', 'int', 'real', 'lgl', 'cplx'].includes(v.type)) {
            const dim = v.attr?.dim?.data
            const vals = colValues(v)
            summary.push([name, dim ? `матрица ${dim.join('×')}` : c.includes('factor') ? 'фактор' : 'вектор', brief(v)])
            if (dim) sheets.push(arraySheet(name, vals, dim, 'F', x => x))
            else if (vals.length > 5) { const nm = v.attr?.names?.data; sheets.push({ name, rows: [nm ? ['Имя', 'Значение'] : ['№', 'Значение'], ...vals.slice(0, LIMIT).map((x, i) => [nm ? nm[i] : String(i + 1), x])] }) }
            return
        }
        summary.push([name, v.type, ''])
    }
    if (isRData && root?.type === 'pairlist') for (const it of root.items) add(it.value, it.tag ?? '?')
    else add(root, 'объект')
    if (sheets.length === 1 && summary.length === 2) return sheets
    return [{ name: 'Объекты', rows: summary }, ...sheets]
}

// ================= QlikView / Qlik Sense (.qvd) =================
export const readQvd = buf => {
    const u8 = new Uint8Array(buf)
    const headEnd = latin.decode(u8.subarray(0, Math.min(u8.length, 1 << 22))).indexOf('</QvdTableHeader>')
    if (headEnd < 0) throw new ReaderError('Это не файл QlikView (.qvd).')
    let start = headEnd + '</QvdTableHeader>'.length
    while (u8[start] === 13 || u8[start] === 10) start++
    if (u8[start] === 0) start++
    const d = new DOMParser().parseFromString(utf8.decode(u8.subarray(0, headEnd + 17)).replace(/^﻿/, ''), 'application/xml')
    const t = tag => d.querySelector(`QvdTableHeader > ${tag}`)?.textContent ?? ''
    const fields = [...d.querySelectorAll('Fields > QvdFieldHeader')].map(f => {
        const g = k => f.querySelector(`:scope > ${k}`)?.textContent ?? ''
        return { name: g('FieldName'), bitOffset: +g('BitOffset'), bitWidth: +g('BitWidth'), bias: +g('Bias'), nSym: +g('NoOfSymbols'), offset: +g('Offset'), length: +g('Length'), fmt: g('NumberFormat > Type') }
    })
    const dv = new DataView(u8.buffer, u8.byteOffset)
    for (const f of fields) { // таблица уникальных значений поля
        const sym = []; let p = start + f.offset; const end = p + f.length
        const str = () => { const z = u8.indexOf(0, p); const s = utf8.decode(u8.subarray(p, z)); p = z + 1; return s }
        while (p < end && sym.length < f.nSym) {
            const k = u8[p++]
            if (k === 1) { sym.push(String(dv.getInt32(p, true))); p += 4 }
            else if (k === 2) { sym.push(num(dv.getFloat64(p, true))); p += 8 }
            else if (k === 4) sym.push(str())
            else if (k === 5) { p += 4; sym.push(str()) }
            else if (k === 6) { p += 8; sym.push(str()) }
            else break
        }
        f.sym = sym
    }
    const recSize = +t('RecordByteSize'), nRec = +t('NoOfRecords'), idxOff = start + +t('Offset')
    const rows = [fields.map(f => f.name)]
    for (let r = 0; r < Math.min(nRec, LIMIT); r++) {
        const base = idxOff + r * recSize
        rows.push(fields.map(f => {
            let v = 0
            for (let b = 0; b < f.bitWidth; b++) { const bit = f.bitOffset + b; if (u8[base + (bit >> 3)] >> (bit & 7) & 1) v += 2 ** b }
            v += f.bias
            return v < 0 ? '' : f.sym[v] ?? ''
        }))
    }
    return [{ name: `${t('TableName') || 'Таблица'} (${nRec > LIMIT ? `первые ${LIMIT} из ${nRec}` : nRec})`, rows }]
}

// ================= Банковские выписки OFX и QFX =================
export const readOfx = text => {
    const body = text.slice(Math.max(0, text.indexOf('<OFX>')))
    if (!/<OFX>/i.test(body)) throw new ReaderError('Это не банковская выписка OFX.')
    const val = (s, tag) => new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(s)?.[1]?.trim() ?? ''
    const date = s => { const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2}))?/.exec(s); return m ? `${m[1]}-${m[2]}-${m[3]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}` : s }
    const sheets = []
    for (const m of body.matchAll(/<(STMTRS|CCSTMTRS|INVSTMTRS)>([\s\S]*?)<\/\1>/gi)) {
        const s = m[2]
        const acct = val(s, 'ACCTID'), cur = val(s, 'CURDEF')
        const rows = [['Дата', 'Сумма', 'Тип', 'Получатель', 'Комментарий', 'Номер чека']]
        for (const t of s.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|(?=<\/BANKTRANLIST>))/gi)) {
            const x = t[1]
            rows.push([date(val(x, 'DTPOSTED')), val(x, 'TRNAMT'), val(x, 'TRNTYPE'), val(x, 'NAME') || val(x, 'PAYEE'), val(x, 'MEMO'), val(x, 'CHECKNUM')])
        }
        const bal = /<LEDGERBAL>([\s\S]*?)<\/LEDGERBAL>/i.exec(s)?.[1]
        if (bal) rows.push(['', '', '', '', `Остаток на ${date(val(bal, 'DTASOF'))}: ${val(bal, 'BALAMT')} ${cur}`, ''])
        sheets.push({ name: `Счёт ${acct || sheets.length + 1}${cur ? ' (' + cur + ')' : ''}`, rows })
    }
    if (!sheets.length) throw new ReaderError('В выписке нет операций.')
    return sheets
}

// ================= Геномика: BED, GFF, GTF — таблицы; GenBank — карточка =================
const GENOME_COLS = {
    bed: ['Хромосома', 'Начало', 'Конец', 'Имя', 'Оценка', 'Цепь', 'thickStart', 'thickEnd', 'Цвет', 'Блоков', 'Размеры блоков', 'Начала блоков'],
    gff: ['Последовательность', 'Источник', 'Тип', 'Начало', 'Конец', 'Оценка', 'Цепь', 'Фаза', 'Атрибуты'],
}
export const readGenomeTable = (text, ext) => {
    const cols = ext === 'bed' ? GENOME_COLS.bed : GENOME_COLS.gff
    const rows = []
    let width = 0
    for (const line of text.split(/\r?\n/)) {
        if (!line || /^(#|track |browser )/.test(line)) { if (/^##FASTA/.test(line)) break; continue }
        const f = line.split('\t'); if (f.length < 3) continue
        if (ext !== 'bed' && f[8]) f[8] = decodeURIComponent(f[8].replace(/%(?![0-9A-F]{2})/gi, '%25')).replace(/;\s*/g, '; ')
        width = Math.max(width, f.length)
        rows.push(f)
        if (rows.length >= LIMIT) break
    }
    if (!rows.length) throw new ReaderError('В файле нет записей.')
    return [{ name: ext.toUpperCase(), rows: [cols.slice(0, width).concat(Array.from({ length: Math.max(0, width - cols.length) }, (_, i) => `Столбец ${cols.length + i + 1}`)), ...rows] }]
}
export const genbankView = text => {
    if (!/^LOCUS\s/m.test(text)) throw new ReaderError('Это не запись GenBank.')
    const records = text.split(/^\/\/\s*$/m).filter(r => /LOCUS/.test(r))
    const wrap = el('div', 'ur-genbank')
    for (const r of records.slice(0, 50)) {
        const field = k => { const m = new RegExp(`^${k}\\s+(.*(?:\\n {12}.*)*)`, 'm').exec(r); return m ? m[1].replace(/\n {12}/g, ' ').trim() : '' }
        const feats = []
        const fm = /^FEATURES.*\n([\s\S]*?)^(?:ORIGIN|CONTIG|BASE COUNT)/m.exec(r)
        if (fm) {
            let cur = null
            for (const line of fm[1].split('\n')) {
                const k = /^ {5}(\S+)\s+(.*)$/.exec(line)
                if (k) { cur = { type: k[1], loc: k[2].trim(), q: {} }; feats.push(cur); continue }
                const q = /^ {21}\/(\w+)(?:=(.*))?$/.exec(line)
                if (q && cur) { cur.last = q[1]; cur.q[q[1]] = (q[2] ?? '').replace(/^"|"$/g, ''); continue }
                if (cur && /^ {21}/.test(line)) { if (cur.last) cur.q[cur.last] += (cur.last === 'translation' ? '' : ' ') + line.trim().replace(/"$/, ''); else cur.loc += line.trim() }
            }
        }
        const om = /^ORIGIN.*\n([\s\S]*)$/m.exec(r)
        const seq = om ? om[1].replace(/[\d\s]/g, '').toUpperCase() : ''
        const gc = seq ? Math.round([...seq].filter(c => c === 'G' || c === 'C').length / seq.length * 1000) / 10 : 0
        const shown = feats.filter(f => f.type !== 'source')
        wrap.append(el('section', '', `<h2>${esc(field('DEFINITION') || field('LOCUS'))}</h2>
            <div class="ur-meta">${esc(field('ACCESSION'))} · ${esc(field('LOCUS').split(/\s+/).slice(1, 3).join(' '))}${seq ? ` · GC ${gc}%` : ''}</div>
            ${field('ORGANISM') ? `<p><b>Организм:</b> ${esc(field('ORGANISM'))}</p>` : ''}
            ${shown.length ? `<h3>Участки (${shown.length})</h3><table class="ur-table"><thead><tr><th>Тип</th><th>Где</th><th>Ген</th><th>Продукт</th><th>Примечание</th></tr></thead><tbody>${shown.slice(0, 2000).map(f => `<tr><td>${esc(f.type)}</td><td>${esc(f.loc)}</td><td>${esc(f.q.gene ?? f.q.locus_tag ?? '')}</td><td>${esc(f.q.product ?? '')}</td><td>${esc(f.q.note ?? '')}</td></tr>`).join('')}</tbody></table>` : ''}
            ${seq ? `<h3>Последовательность (${seq.length} ${/aa/.test(field('LOCUS')) ? 'аминокислот' : 'нуклеотидов'})</h3><pre class="ur-seq">${esc(seq.slice(0, 200000).match(/.{1,60}/g).map((l, i) => String(i * 60 + 1).padStart(8) + '  ' + l.match(/.{1,10}/g).join(' ')).join('\n'))}${seq.length > 200000 ? '\n…' : ''}</pre>` : ''}`))
    }
    return wrap
}

// ================= LibreOffice Base (.odb) =================
export const readOdb = async buf => {
    const zip = await JSZip.loadAsync(buf)
    const sheets = []
    const script = zip.file('database/script')
    if (script) {
        const s = await script.async('string')
        const tables = new Map()
        for (const m of s.matchAll(/^CREATE (?:CACHED |MEMORY |TEXT )?TABLE (?:PUBLIC\.)?"?([^"(\s]+)"?\s*\((.*)\)\s*$/gm)) {
            const cols = []; let depth = 0, cur = ''
            for (const c of m[2]) { if (c === '(') depth++; if (c === ')') depth--; if (c === ',' && !depth) { cols.push(cur.trim()); cur = '' } else cur += c }
            cols.push(cur.trim())
            tables.set(m[1], { cols: cols.filter(c => !/^(CONSTRAINT|PRIMARY KEY|UNIQUE|FOREIGN)/i.test(c)).map(c => c.match(/^"([^"]+)"|^(\S+)/).slice(1).find(Boolean)), rows: [], cached: /CACHED/.test(m[0]) })
        }
        for (const m of s.matchAll(/^INSERT INTO (?:PUBLIC\.)?"?([^"(\s]+)"? VALUES\((.*)\)\s*$/gm)) {
            const t = tables.get(m[1]); if (!t || t.rows.length >= LIMIT) continue
            const vals = []; let i = 0; const v = m[2]
            while (i < v.length) {
                if (v[i] === "'") { let s2 = ''; i++; while (i < v.length) { if (v[i] === "'" && v[i + 1] === "'") { s2 += "'"; i += 2 } else if (v[i] === "'") { i++; break } else s2 += v[i++] } vals.push(s2) }
                else { const e = v.indexOf(',', i); const tok = (e < 0 ? v.slice(i) : v.slice(i, e)).trim(); vals.push(tok === 'NULL' ? '' : tok); i = e < 0 ? v.length : e }
                while (v[i] === ',' || v[i] === ' ') i++
            }
            t.rows.push(vals)
        }
        for (const [name, t] of tables) sheets.push({ name, rows: [t.cols, ...t.rows, ...(t.rows.length || !t.cached ? [] : [Array(t.cols.length).fill('').map((_, i) => i ? '' : '(данные этой таблицы хранятся в двоичном виде — пока не читаются)')])] })
    }
    const content = zip.file('content.xml')
    if (content) {
        const x = await content.async('string')
        const q = [...x.matchAll(/<db:query [^>]*db:name="([^"]*)"[^>]*db:command="([^"]*)"/g)].map(m => [m[1], m[2].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')])
        if (q.length) sheets.push({ name: 'Запросы', rows: [['Запрос', 'SQL'], ...q] })
        const conn = /xlink:href="([^"]+)"/.exec(x)?.[1]
        if (conn && !script) sheets.push({ name: 'Подключение', rows: [['Источник данных'], [conn]] })
        const forms = [...x.matchAll(/<db:component [^>]*db:name="([^"]*)"/g)].map(m => [m[1]])
        if (forms.length) sheets.push({ name: 'Формы и отчёты', rows: [['Имя'], ...forms] })
    }
    if (zip.file('database/firebird.fbk')) sheets.unshift({ name: 'Firebird', rows: [['Сведения'], ['Данные хранятся во встроенной базе Firebird — её содержимое пока не читается.']] })
    if (!sheets.length) throw new ReaderError('В файле LibreOffice Base не найдено таблиц.')
    return sheets
}
export const odbText = decodeText
