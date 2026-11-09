// Системные и прочие файлы версии 0.6 («справочное бюро»): программы Linux и macOS (ELF, Mach-O), Java (.class),
// Android (.dex), WebAssembly, скомпилированный Python и Lua, картриджи приставок, ярлыки Windows (.lnk),
// журналы событий (.evtx), дампы падений (.dmp), профили Apple (.mobileconfig), сертификаты (.p12, .p7b, .crl),
// базы KeePass (только сведения), переводы Qt (.qm), записи терминала ttyrec, документы LyX и DITA, номера страниц Kindle
import { escapeHtml as esc, ReaderError } from '../util.js'
import { asn1, asnStr, asnTime, nameOf, certInfo } from './notes.js'
import { parseCms } from './notes3.js'

const latin = new TextDecoder('latin1')
const utf8 = new TextDecoder()
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e }
const info = (title, rows, extra = '') => el('div', 'ur-sysinfo', `<h2>${title}</h2><table class="ur-table ur-sci-info"><tbody>${rows.filter(r => r[1] !== '' && r[1] != null).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="ur-break">${esc(String(v))}</td></tr>`).join('')}</tbody></table>${extra}`)
const list = (title, items, max = 3000) => items.length ? `<details${items.length < 40 ? ' open' : ''}><summary>${esc(title)} (${items.length})</summary><div class="ur-sys-list">${items.slice(0, max).map(i => `<code>${esc(i)}</code>`).join(' ')}${items.length > max ? ' …' : ''}</div></details>` : ''
const cstr = (u8, o, n = 256) => { const e = u8.indexOf(0, o); return latin.decode(u8.subarray(o, e < 0 || e > o + n ? o + n : e)) }
const fmtSize = n => n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(1) + ' КБ' : (n / 1048576).toFixed(1) + ' МБ'

// ================= ELF (Linux) =================
const ELF_MACHINE = { 3: 'x86 (32 бит)', 62: 'x86-64', 40: 'ARM (32 бит)', 183: 'ARM64', 243: 'RISC-V', 8: 'MIPS', 20: 'PowerPC', 21: 'PowerPC 64', 22: 'IBM S/390', 2: 'SPARC', 43: 'SPARC v9', 258: 'LoongArch' }
export const elfView = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (!(u8[0] === 0x7F && latin.decode(u8.subarray(1, 4)) === 'ELF')) throw new ReaderError('Это не программа Linux (ELF).')
    const b64 = u8[4] === 2, le = u8[5] === 1
    const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le), addr = o => b64 ? Number(dv.getBigUint64(o, le)) : u32(o)
    const type = u16(16), mach = u16(18)
    const shoff = addr(b64 ? 0x28 : 0x20), shentsize = u16(b64 ? 0x3A : 0x2E), shnum = u16(b64 ? 0x3C : 0x30), shstrndx = u16(b64 ? 0x3E : 0x32)
    const sec = i => { const o = shoff + i * shentsize; return { name: u32(o), type: u32(o + 4), off: addr(o + (b64 ? 0x18 : 0x10)), size: addr(o + (b64 ? 0x20 : 0x14)), link: u32(o + (b64 ? 0x28 : 0x18)), entsize: addr(o + (b64 ? 0x38 : 0x24)) } }
    const secs = shoff && shnum ? Array.from({ length: shnum }, (_, i) => sec(i)) : []
    const shstr = secs[shstrndx]
    secs.forEach(s => { s.n = shstr ? cstr(u8, shstr.off + s.name) : '' })
    const needed = [], exports = [], imports = []
    let soname = '', interp = ''
    const dyn = secs.find(s => s.type === 6)
    if (dyn) { const str = secs[dyn.link]; const es = b64 ? 16 : 8; for (let o = dyn.off; o + es <= dyn.off + dyn.size; o += es) { const tag = b64 ? Number(dv.getBigInt64(o, le)) : dv.getInt32(o, le), val = b64 ? Number(dv.getBigUint64(o + 8, le)) : u32(o + 4); if (tag === 0) break; if (tag === 1) needed.push(cstr(u8, str.off + val)); if (tag === 14) soname = cstr(u8, str.off + val) } }
    const ds = secs.find(s => s.type === 11) // .dynsym
    if (ds) { const str = secs[ds.link]; const es = b64 ? 24 : 16; for (let o = ds.off + es; o + es <= ds.off + ds.size; o += es) { const nm = cstr(u8, str.off + u32(o)); const shndx = u16(o + (b64 ? 6 : 14)); const infoB = u8[o + (b64 ? 4 : 12)]; if (!nm) continue; if ((infoB & 15) === 2 || (infoB & 15) === 1) (shndx === 0 ? imports : exports).push(nm) } }
    const ip = secs.find(s => s.n === '.interp'); if (ip) interp = cstr(u8, ip.off)
    const comment = secs.find(s => s.n === '.comment'); const comp = comment ? [...new Set(latin.decode(u8.subarray(comment.off, comment.off + comment.size)).split('\0').filter(Boolean))].join('; ') : ''
    return info('🐧 Программа Linux (ELF)', [['Вид', { 1: 'объектный файл (.o)', 2: 'программа', 3: interp ? 'программа (PIE)' : 'библиотека (.so)', 4: 'дамп памяти (core)' }[type] ?? type], ['Процессор', ELF_MACHINE[mach] ?? `код ${mach}`], ['Разрядность', b64 ? '64 бит' : '32 бит'], ['Имя библиотеки', soname], ['Загрузчик', interp], ['Собрано', comp], ['Размер', fmtSize(u8.length)], ['Секций', secs.length || ''], ['Отладочная информация', secs.some(s => s.n === '.debug_info') ? 'есть' : 'нет']],
        list('Нужные библиотеки', needed) + list('Экспортирует функции', exports.sort()) + list('Использует функции', imports.sort()) + list('Секции', secs.filter(s => s.n).map(s => `${s.n} ${fmtSize(s.size)}`)))
}

// ================= Mach-O (macOS, iOS) =================
const MACHO_CPU = { 7: 'x86', 0x1000007: 'x86-64', 12: 'ARM', 0x100000C: 'ARM64', 18: 'PowerPC', 0x1000012: 'PowerPC 64' }
export const machoView = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const m = dv.getUint32(0)
    const parts = []
    if (m === 0xCAFEBABE || m === 0xCAFEBABF) { // универсальная программа (Java .class тоже 0xCAFEBABE — различаем по числу архитектур)
        const n = dv.getUint32(4); if (n > 30) throw new ReaderError('Это скомпилированный класс Java, а не программа macOS.')
        for (let i = 0; i < n; i++) { const o = 8 + i * (m === 0xCAFEBABF ? 32 : 20); const off = m === 0xCAFEBABF ? Number(dv.getBigUint64(o + 8)) : dv.getUint32(o + 8); parts.push(off) }
    } else parts.push(0)
    const out = []
    for (const off of parts) {
        const mg = dv.getUint32(off, true)
        const le = mg === 0xFEEDFACE || mg === 0xFEEDFACF
        if (!le && dv.getUint32(off) !== 0xFEEDFACE && dv.getUint32(off) !== 0xFEEDFACF) continue
        const b64 = (le ? mg : dv.getUint32(off)) === 0xFEEDFACF
        const g = o => dv.getUint32(off + o, le)
        const cpu = g(4), ftype = g(12), ncmds = g(16)
        let p = off + (b64 ? 32 : 28)
        const libs = [], r = { cpu: MACHO_CPU[cpu] ?? cpu, type: { 1: 'объектный файл', 2: 'программа', 6: 'библиотека (.dylib)', 8: 'модуль (.bundle)', 4: 'дамп памяти' }[ftype] ?? ftype }
        for (let i = 0; i < ncmds; i++) {
            const cmd = dv.getUint32(p, le), size = dv.getUint32(p + 4, le)
            if (cmd === 0xC || cmd === 0x80000018 || cmd === 0x8000001F || cmd === 0xD) { const s = cstr(u8, p + dv.getUint32(p + 8, le)); if (cmd === 0xD) r.id = s; else libs.push(s) }
            if (cmd === 0x24 || cmd === 0x25 || cmd === 0x2F || cmd === 0x32) { const v = cmd === 0x32 ? dv.getUint32(p + 12, le) : dv.getUint32(p + 8, le); r.minOs = `${v >> 16}.${(v >> 8) & 255}`; if (cmd === 0x32) r.platform = { 1: 'macOS', 2: 'iOS', 3: 'tvOS', 4: 'watchOS', 6: 'Mac Catalyst', 7: 'симулятор iOS', 11: 'visionOS' }[dv.getUint32(p + 8, le)] }
            if (cmd === 0x1D) r.signed = true
            p += size
        }
        r.libs = libs; out.push(r)
    }
    if (!out.length) throw new ReaderError('Это не программа macOS (Mach-O).')
    return info('🍎 Программа macOS / iOS (Mach-O)', [['Архитектуры', out.map(r => r.cpu).join(', ')], ['Вид', out[0].type], ['Платформа', out[0].platform], ['Минимальная версия системы', out[0].minOs], ['Имя библиотеки', out[0].id], ['Подпись кода', out[0].signed ? 'есть' : 'нет'], ['Размер', fmtSize(u8.length)]], list('Нужные библиотеки', [...new Set(out.flatMap(r => r.libs))]))
}

// ================= Java .class =================
const JAVA_VER = v => v >= 49 ? `Java ${v - 44}` : `Java 1.${v - 44}`
export const classView = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (dv.getUint32(0) !== 0xCAFEBABE) throw new ReaderError('Это не скомпилированный класс Java.')
    const major = dv.getUint16(6), n = dv.getUint16(8)
    const cp = [null]; let p = 10
    for (let i = 1; i < n; i++) {
        const t = u8[p]
        if (t === 1) { const l = dv.getUint16(p + 1); cp.push({ t, s: utf8.decode(u8.subarray(p + 3, p + 3 + l)) }); p += 3 + l }
        else if (t === 7 || t === 8 || t === 16 || t === 19 || t === 20) { cp.push({ t, i: dv.getUint16(p + 1) }); p += 3 }
        else if (t === 15) { cp.push({ t }); p += 4 }
        else if (t === 5 || t === 6) { cp.push({ t }, null); i++; p += 9 }
        else { cp.push({ t, i: dv.getUint16(p + 1), j: dv.getUint16(p + 3) }); p += 5 }
    }
    const S = i => cp[i]?.s ?? '', C = i => S(cp[i]?.i).replace(/\//g, '.')
    const acc = dv.getUint16(p), self = C(dv.getUint16(p + 2)), sup = C(dv.getUint16(p + 4)), ni = dv.getUint16(p + 6); p += 8
    const ifaces = []; for (let i = 0; i < ni; i++) { ifaces.push(C(dv.getUint16(p))); p += 2 }
    const desc = d => { const map = { B: 'byte', C: 'char', D: 'double', F: 'float', I: 'int', J: 'long', S: 'short', Z: 'boolean', V: 'void' }; let i = 0; const one = () => { let arr = ''; while (d[i] === '[') { arr += '[]'; i++ } if (d[i] === 'L') { const e = d.indexOf(';', i); const t = d.slice(i + 1, e).split('/').pop(); i = e + 1; return t + arr } return (map[d[i++]] ?? '?') + arr }; if (d[0] === '(') { i = 1; const args = []; while (d[i] !== ')') args.push(one()); i++; return { args, ret: one() } } return { type: one() } }
    const mods = a => [a & 1 ? 'public' : a & 2 ? 'private' : a & 4 ? 'protected' : '', a & 8 ? 'static' : '', a & 0x10 ? 'final' : '', a & 0x400 ? 'abstract' : ''].filter(Boolean).join(' ')
    const members = () => { const k = dv.getUint16(p); p += 2; const out = []; for (let i = 0; i < k; i++) { const a = dv.getUint16(p), nm = S(dv.getUint16(p + 2)), d = S(dv.getUint16(p + 4)), na = dv.getUint16(p + 6); p += 8; for (let j = 0; j < na; j++) { p += 6 + dv.getUint32(p + 2) } out.push({ a, nm, d }) } return out }
    const fields = members().map(f => `${mods(f.a)} ${desc(f.d).type} ${f.nm}`.trim())
    const methods = members().filter(m => m.nm !== '<clinit>').map(m => { const d = desc(m.d); return m.nm === '<init>' ? `${mods(m.a)} ${self.split('.').pop()}(${d.args.join(', ')})`.trim() : `${mods(m.a)} ${d.ret} ${m.nm}(${d.args.join(', ')})`.trim() })
    let source = ''; const na = dv.getUint16(p); p += 2; for (let j = 0; j < na; j++) { const nm = S(dv.getUint16(p)), len = dv.getUint32(p + 2); if (nm === 'SourceFile') source = S(dv.getUint16(p + 6)); p += 6 + len }
    const kind = acc & 0x2000 ? 'аннотация' : acc & 0x200 ? 'интерфейс' : acc & 0x4000 ? 'перечисление' : acc & 0x8000 ? 'модуль' : 'класс'
    return info(`☕ ${esc(self)}`, [['Что это', `${mods(acc & ~0x20)} ${kind}`.trim()], ['Наследует', sup && sup !== 'java.lang.Object' ? sup : ''], ['Реализует', ifaces.join(', ')], ['Исходный файл', source], ['Версия', `${JAVA_VER(major)} (формат ${major})`]], `<h3>Поля (${fields.length})</h3><pre>${esc(fields.join('\n'))}</pre><h3>Методы (${methods.length})</h3><pre>${esc(methods.join('\n'))}</pre>`)
}

// ================= Android .dex =================
export const dexView = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (latin.decode(u8.subarray(0, 4)) !== 'dex\n') throw new ReaderError('Это не код Android (.dex).')
    const g = o => dv.getUint32(o, true)
    const strN = g(0x38), strOff = g(0x3C), typeN = g(0x40), typeOff = g(0x44), methN = g(0x58), classN = g(0x60), classOff = g(0x64)
    const str = i => { let p = g(strOff + i * 4); while (u8[p] & 0x80) p++; p++; return utf8.decode(u8.subarray(p, u8.indexOf(0, p))) }
    const type = i => str(g(typeOff + i * 4))
    const classes = []; for (let i = 0; i < classN; i++) classes.push(type(g(classOff + i * 32)).replace(/^L|;$/g, '').replace(/\//g, '.'))
    const pk = new Map(); for (const c of classes) { const p = c.split('.').slice(0, -1).join('.') || '(без пакета)'; pk.set(p, (pk.get(p) ?? 0) + 1) }
    void typeN
    return info('🤖 Код Android (DEX)', [['Версия формата', latin.decode(u8.subarray(4, 7))], ['Классов', classN], ['Методов', methN], ['Строк', strN], ['Размер', fmtSize(u8.length)]], list('Пакеты', [...pk].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} (${n})`)) + list('Классы', classes.sort(), 5000))
}

// ================= WebAssembly =================
export const wasmView = buf => {
    let mod
    try { mod = new WebAssembly.Module(buf) } catch (e) { throw new ReaderError('Это не модуль WebAssembly: ' + e.message) }
    const imp = WebAssembly.Module.imports(mod), exp = WebAssembly.Module.exports(mod)
    const kinds = { function: 'функция', memory: 'память', table: 'таблица', global: 'переменная', tag: 'исключение' }
    const custom = []; try { for (const n of ['name', 'producers', 'sourceMappingURL', 'target_features', 'dylink.0']) if (WebAssembly.Module.customSections(mod, n).length) custom.push(n) } catch { /* нет */ }
    let producers = ''
    try { const s = WebAssembly.Module.customSections(mod, 'producers')[0]; if (s) producers = [...latin.decode(new Uint8Array(s)).matchAll(/([\x20-\x7e]{3,})/g)].map(m => m[1]).filter(x => !/^(language|processed-by|sdk)$/.test(x)).join(', ') } catch { /* нет */ }
    return info('🧩 WebAssembly', [['Размер', fmtSize(buf.byteLength)], ['Импортов', imp.length], ['Экспортов', exp.length], ['Чем собрано', producers], ['Служебные разделы', custom.join(', ')]], list('Экспортирует', exp.map(e => `${e.name} (${kinds[e.kind] ?? e.kind})`)) + list('Импортирует', imp.map(i => `${i.module}.${i.name} (${kinds[i.kind] ?? i.kind})`)))
}

// ================= Скомпилированный Python и Lua =================
const PYC_MAGIC = { 3413: '3.8', 3425: '3.9', 3439: '3.10', 3495: '3.11', 3531: '3.12', 3571: '3.13', 3600: '3.14', 3379: '3.6', 3394: '3.7', 3361: '3.5', 3310: '3.4' }
export const pycView = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (u8[2] !== 0x0D || u8[3] !== 0x0A) throw new ReaderError('Это не скомпилированный Python (.pyc).')
    const magic = dv.getUint16(0, true)
    const ver = PYC_MAGIC[magic] ?? Object.entries(PYC_MAGIC).sort((a, b) => Math.abs(a[0] - magic) - Math.abs(b[0] - magic))[0]?.[1] + ' (примерно)'
    const flags = magic >= 3392 ? dv.getUint32(4, true) : 0
    const ts = magic >= 3392 ? (flags & 1 ? null : dv.getUint32(8, true)) : dv.getUint32(4, true)
    // строки из констант: короткие ASCII/UTF-8 последовательности
    const strs = [...new Set([...utf8.decode(u8.subarray(16)).matchAll(/[\p{L}\p{N}_ .,:;!?'"()\-/<>]{3,}/gu)].map(m => m[0].trim()).filter(s => s.length >= 3))]
    const names = strs.filter(s => /^[A-Za-z_][\w]*$/.test(s))
    return info('🐍 Скомпилированный Python', [['Версия Python', ver], ['Исходник изменён', ts ? new Date(ts * 1000).toLocaleString('ru-RU') : flags & 1 ? 'проверка по хешу' : ''], ['Размер', fmtSize(u8.length)]], list('Имена (функции, переменные, модули)', names) + list('Строки', strs.filter(s => !names.includes(s))))
}
export const luacView = buf => {
    const u8 = new Uint8Array(buf)
    if (!(u8[0] === 0x1B && latin.decode(u8.subarray(1, 4)) === 'Lua')) {
        if (latin.decode(u8.subarray(0, 3)) === '\x1BLJ') return info('🌙 Скомпилированный LuaJIT', [['Версия байткода', u8[3]]])
        throw new ReaderError('Это не скомпилированный Lua.')
    }
    const v = u8[4]
    const strs = [...new Set([...latin.decode(u8.subarray(12)).matchAll(/[\x20-\x7e]{4,}/g)].map(m => m[0]))]
    return info('🌙 Скомпилированный Lua', [['Версия Lua', `${v >> 4}.${v & 15}`], ['Размер', fmtSize(u8.length)]], list('Строки', strs))
}

// ================= Картриджи приставок =================
const nesIcon = null
export const romView = (buf, ext) => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const rows = []
    let title = 'Картридж', icon = ''
    if (latin.decode(u8.subarray(0, 4)) === 'NES\x1a') {
        title = 'Картридж NES / Dendy'; const mapper = (u8[6] >> 4) | (u8[7] & 0xF0)
        rows.push(['Программа', `${u8[4] * 16} КБ`], ['Графика', u8[5] ? `${u8[5] * 8} КБ` : 'в ОЗУ'], ['Маппер', mapper], ['Сохранения', u8[6] & 2 ? 'есть (батарейка)' : 'нет'], ['Формат', (u8[7] & 0x0C) === 8 ? 'NES 2.0' : 'iNES'])
    } else if (latin.decode(u8.subarray(0x104, 0x108)) === '\xCE\xED\x66\x66' || ['gb', 'gbc'].includes(ext)) {
        title = u8[0x143] & 0x80 ? 'Картридж Game Boy Color' : 'Картридж Game Boy'
        rows.push(['Название', cstr(u8, 0x134, u8[0x143] & 0x80 ? 15 : 16).trim()], ['Регион', u8[0x14A] ? 'другие страны' : 'Япония'], ['Размер', `${32 << u8[0x148]} КБ`], ['Тип картриджа', u8[0x147]], ['Super Game Boy', u8[0x146] === 3 ? 'да' : 'нет'])
    } else if (ext === 'gba' || u8[0xB2] === 0x96) {
        title = 'Картридж Game Boy Advance'
        rows.push(['Название', cstr(u8, 0xA0, 12).trim()], ['Код игры', latin.decode(u8.subarray(0xAC, 0xB0))], ['Издатель', latin.decode(u8.subarray(0xB0, 0xB2))], ['Размер', fmtSize(u8.length)])
    } else if (ext === 'nds' || ext === 'dsi') {
        title = 'Картридж Nintendo DS'
        rows.push(['Название', cstr(u8, 0, 12).trim()], ['Код игры', latin.decode(u8.subarray(12, 16))], ['Издатель', latin.decode(u8.subarray(16, 18))], ['Размер', fmtSize(u8.length)])
        const bo = dv.getUint32(0x68, true)
        if (bo && bo + 0x840 <= u8.length) {
            const pal = Array.from({ length: 16 }, (_, i) => { const c = dv.getUint16(bo + 0x220 + i * 2, true); return [(c & 31) * 8, (c >> 5 & 31) * 8, (c >> 10 & 31) * 8, i ? 255 : 0] })
            const cv = document.createElement('canvas'); cv.width = cv.height = 32; const g = cv.getContext('2d'); const im = g.createImageData(32, 32)
            for (let t = 0; t < 16; t++) for (let k = 0; k < 64; k++) { const b = u8[bo + 0x20 + t * 32 + (k >> 1)]; const ci = k & 1 ? b >> 4 : b & 15; const x = (t % 4) * 8 + k % 8, y = Math.floor(t / 4) * 8 + Math.floor(k / 8); im.data.set(pal[ci], (y * 32 + x) * 4) }
            g.putImageData(im, 0, 0); icon = `<img src="${cv.toDataURL()}" class="ur-rom-icon">`
            const t = new TextDecoder('utf-16le').decode(u8.subarray(bo + 0x240 + 0x100, bo + 0x340)).replace(/\0.*$/s, '') || new TextDecoder('utf-16le').decode(u8.subarray(bo + 0x240, bo + 0x340)).replace(/\0.*$/s, '')
            if (t) rows.unshift(['Полное название', t.replace(/\n/g, ' · ')])
        }
    } else if (latin.decode(u8.subarray(0x100, 0x104)) === 'SEGA' || ['md', 'gen', 'smd', '32x'].includes(ext)) {
        title = 'Картридж Sega Mega Drive / Genesis'
        rows.push(['Система', cstr(u8, 0x100, 16).trim()], ['Название (Япония)', cstr(u8, 0x120, 48).replace(/\s+/g, ' ').trim()], ['Название', cstr(u8, 0x150, 48).replace(/\s+/g, ' ').trim()], ['Код', cstr(u8, 0x180, 14).trim()], ['Регионы', cstr(u8, 0x1F0, 3).trim()], ['Издатель', cstr(u8, 0x110, 16).trim()])
    } else if (latin.decode(u8.subarray(0x7FF0, 0x7FF8)) === 'TMR SEGA' || ['sms', 'gg'].includes(ext)) {
        title = ext === 'gg' ? 'Картридж Sega Game Gear' : 'Картридж Sega Master System'
        rows.push(['Размер', fmtSize(u8.length)], ['Регион', { 3: 'Япония', 4: 'весь мир', 5: 'Япония (GG)', 6: 'весь мир (GG)', 7: 'весь мир (GG)' }[u8[0x7FFF] >> 4] ?? ''])
    } else if (['n64', 'z64', 'v64'].includes(ext)) {
        let r = u8
        if (dv.getUint32(0) === 0x37804012) { r = new Uint8Array(u8.length); for (let i = 0; i + 1 < u8.length; i += 2) { r[i] = u8[i + 1]; r[i + 1] = u8[i] } }
        else if (dv.getUint32(0) === 0x40123780) { r = new Uint8Array(u8.length); for (let i = 0; i + 3 < u8.length; i += 4) { r[i] = u8[i + 3]; r[i + 1] = u8[i + 2]; r[i + 2] = u8[i + 1]; r[i + 3] = u8[i] } }
        title = 'Картридж Nintendo 64'
        rows.push(['Название', cstr(r, 0x20, 20).trim()], ['Код игры', latin.decode(r.subarray(0x3B, 0x3F))], ['Регион', { E: 'США', J: 'Япония', P: 'Европа', D: 'Германия', F: 'Франция' }[String.fromCharCode(r[0x3E])] ?? String.fromCharCode(r[0x3E])], ['Размер', fmtSize(u8.length)])
    } else if (['sfc', 'smc'].includes(ext)) {
        title = 'Картридж Super Nintendo'
        const skip = u8.length % 1024 === 512 ? 512 : 0
        const score = o => { const t = cstr(u8, skip + o, 21); return [...t].filter(c => c >= ' ' && c <= '~').length + ((dv.getUint16(skip + o + 0x1C, true) ^ dv.getUint16(skip + o + 0x1E, true)) === 0xFFFF ? 30 : 0) }
        const o = [0x7FC0, 0xFFC0, 0x40FFC0].filter(x => skip + x + 32 < u8.length).sort((a, b) => score(b) - score(a))[0] ?? 0x7FC0
        rows.push(['Название', cstr(u8, skip + o, 21).trim()], ['Раскладка', o === 0x7FC0 ? 'LoROM' : o === 0xFFC0 ? 'HiROM' : 'ExHiROM'], ['Размер', `${1 << u8[skip + o + 0x17]} КБ`], ['Регион', { 0: 'Япония', 1: 'Северная Америка', 2: 'Европа' }[u8[skip + o + 0x19]] ?? u8[skip + o + 0x19]])
    } else throw new ReaderError('Не удалось узнать картридж.')
    return el('div', 'ur-sysinfo', `<div class="ur-rom-head">${icon}<h2>🎮 ${esc(title)}</h2></div><table class="ur-table ur-sci-info"><tbody>${rows.filter(r => r[1] !== '' && r[1] != null).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join('')}</tbody></table><p class="ur-muted">Запустить игру читалка не может — для этого нужен эмулятор. Показаны сведения из заголовка картриджа.</p>`)
}
void nesIcon

// ================= Ярлыки Windows (.lnk) =================
export const lnkView = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (dv.getUint32(0, true) !== 0x4C) throw new ReaderError('Это не ярлык Windows.')
    const flags = dv.getUint32(20, true), attrs = dv.getUint32(24, true)
    const ft = o => { const v = dv.getBigUint64(o, true); return v ? new Date(Number(v / 10000n) - 11644473600000) : null }
    const created = ft(28), written = ft(44), size = dv.getUint32(52, true), show = dv.getUint32(60, true)
    let p = 76
    if (flags & 1) p += 2 + dv.getUint16(p, true)
    let local = '', net = '', vol = ''
    if (flags & 2) {
        const li = p, len = dv.getUint32(li, true), lf = dv.getUint32(li + 8, true), hs = dv.getUint32(li + 4, true)
        if (lf & 1) { const vo = li + dv.getUint32(li + 12, true); vol = cstr(u8, vo + dv.getUint32(vo + 12, true)); local = cstr(u8, li + dv.getUint32(li + 16, true)); if (hs >= 0x24) { const uo = dv.getUint32(li + 28, true); if (uo) local = new TextDecoder('utf-16le').decode(u8.subarray(li + uo, u8.indexOf(0, li + uo) + 1)).replace(/\0.*$/s, '') || local } }
        if (lf & 2) { const no = li + dv.getUint32(li + 20, true); net = cstr(u8, no + dv.getUint32(no + 8, true)) }
        local += cstr(u8, li + dv.getUint32(li + 24, true))
        p += len
    }
    const uni = !!(flags & 0x80)
    const sd = () => { const n = dv.getUint16(p, true); const s = uni ? new TextDecoder('utf-16le').decode(u8.subarray(p + 2, p + 2 + n * 2)) : latin.decode(u8.subarray(p + 2, p + 2 + n)); p += 2 + n * (uni ? 2 : 1); return s }
    const name = flags & 4 ? sd() : '', rel = flags & 8 ? sd() : '', wd = flags & 0x10 ? sd() : '', args = flags & 0x20 ? sd() : '', iconPath = flags & 0x40 ? sd() : ''
    return info('🔗 Ярлык Windows', [['Куда ведёт', local || net || rel], ['Описание', name], ['Аргументы', args], ['Рабочая папка', wd], ['Значок', iconPath], ['Том', vol], ['Размер цели', size ? fmtSize(size) : ''], ['Цель создана', created?.toLocaleString('ru-RU')], ['Цель изменена', written?.toLocaleString('ru-RU')], ['Окно', { 1: 'обычное', 3: 'развёрнутое', 7: 'свёрнутое' }[show] ?? ''], ['Это папка', attrs & 0x10 ? 'да' : '']])
}

// ================= Журналы событий Windows (.evtx, двоичный XML) =================
export const parseEvtx = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (latin.decode(u8.subarray(0, 7)) !== 'ElfFile') throw new ReaderError('Это не журнал событий Windows (.evtx).')
    const events = []
    const u16le = new TextDecoder('utf-16le')
    for (let ch = 0x1000; ch + 0x10000 <= u8.length && events.length < 20000; ch += 0x10000) {
        if (latin.decode(u8.subarray(ch, ch + 8)) !== 'ElfChnk\0') continue
        const templates = new Map()
        let p = ch + 0x200
        const end = ch + dv.getUint32(ch + 0x30, true)
        while (p + 24 < ch + 0x10000 && p < Math.max(end, ch + 0x200 + 24) && dv.getUint32(p, true) === 0x2A2A) {
            const size = dv.getUint32(p + 4, true), rid = Number(dv.getBigUint64(p + 8, true)), time = dv.getBigUint64(p + 16, true)
            const ev = { id: rid, time: new Date(Number(time / 10000n) - 11644473600000), data: {} }
            try { parseBinXml(u8, dv, p + 24, p + size - 4, ch, templates, ev, u16le) } catch { /* запись не разобралась */ }
            events.push(ev)
            p += size
        }
    }
    if (!events.length) throw new ReaderError('В журнале нет событий.')
    return events
}
// разбор двоичного XML: собираем имена элементов и значения «System» и «EventData»
const parseBinXml = (u8, dv, start, end, ch, templates, ev, u16le) => {
    const nameAt = off => { const n = dv.getUint16(ch + off + 6, true); return u16le.decode(u8.subarray(ch + off + 8, ch + off + 8 + n * 2)) }
    const path = []
    let p = start
    const readValue = (type, len, o) => {
        switch (type) {
            case 0x01: return u16le.decode(u8.subarray(o, o + len)).replace(/\0+$/, '')
            case 0x02: return latin.decode(u8.subarray(o, o + len)).replace(/\0+$/, '')
            case 0x04: return u8[o]; case 0x06: return dv.getUint16(o, true); case 0x08: return dv.getUint32(o, true); case 0x0A: return String(dv.getBigUint64(o, true)); case 0x03: return dv.getInt8(o); case 0x05: return dv.getInt16(o, true); case 0x07: return dv.getInt32(o, true); case 0x09: return String(dv.getBigInt64(o, true))
            case 0x0D: return u8[o] ? 'true' : 'false'
            case 0x0F: { const h = [...u8.subarray(o, o + 16)].map(b => b.toString(16).padStart(2, '0')); return `{${h.slice(0, 4).reverse().join('')}-${h.slice(4, 6).reverse().join('')}-${h.slice(6, 8).reverse().join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}}` }
            case 0x11: return new Date(Number(dv.getBigUint64(o, true) / 10000n) - 11644473600000).toISOString()
            case 0x13: { const n = u8[o + 1]; let id = 0; for (let i = 2; i < 8; i++) id = id * 256 + u8[o + i]; const subs = []; for (let i = 0; i < n; i++) subs.push(dv.getUint32(o + 8 + i * 4, true)); return `S-${u8[o]}-${id}-${subs.join('-')}` }
            case 0x14: return '0x' + dv.getUint32(o, true).toString(16).padStart(8, '0')
            case 0x15: return '0x' + dv.getBigUint64(o, true).toString(16).padStart(16, '0')
            case 0x0E: return [...u8.subarray(o, o + Math.min(len, 64))].map(b => b.toString(16).padStart(2, '0')).join('')
            case 0x81: return u16le.decode(u8.subarray(o, o + len)).split('\0').filter(Boolean).join(', ')
            default: return ''
        }
    }
    // шаблон с подстановками: подставляем значения по их номерам
    const skipName = (q, off) => q - ch === off ? q + 10 + dv.getUint16(q + 6, true) * 2 : q
    const runTemplate = (q, tEnd, subs) => {
        const stack = []
        let attr = null
        const val = v => { if (attr) { putAttr(stack, attr, v); attr = null } else putText(stack, v) }
        while (q < tEnd) {
            const b = u8[q], tok = b & 0x0F
            if (b === 0x00) break
            if (tok === 0x01) { const off = dv.getUint32(q + 7, true); stack.push(nameAt(off)); q = skipName(q + 11, off); if (b & 0x40) q += 4; continue }
            if (tok === 0x02) { q++; continue }
            if (tok === 0x03 || tok === 0x04) { stack.pop(); q++; continue }
            if (tok === 0x06) { const off = dv.getUint32(q + 1, true); attr = nameAt(off); q = skipName(q + 5, off); continue }
            if (tok === 0x05) { const n = dv.getUint16(q + 2, true); val(u16le.decode(u8.subarray(q + 4, q + 4 + n * 2))); q += 4 + n * 2; continue }
            if (tok === 0x0D || tok === 0x0E) { const s2 = subs[dv.getUint16(q + 1, true)]; val(s2 ? s2.v : ''); q += 4; continue }
            if (tok === 0x07 || tok === 0x0B) { q += 3 + dv.getUint16(q + 1, true) * 2; continue }
            if (tok === 0x08) { q += 3; continue }
            if (tok === 0x09 || tok === 0x0A) { const off = dv.getUint32(q + 1, true); q = skipName(q + 5, off); continue }
            if (tok === 0x0F) { q += 4; continue }
            break
        }
    }
    const putAttr = (stack, a, v) => {
        const e = stack[stack.length - 1]
        if (e === 'Provider' && a === 'Name') ev.Provider = v
        else if (e === 'TimeCreated' && a === 'SystemTime') ev.Time = v
        else if (e === 'Data' && a === 'Name') ev._name = v
        else if (e === 'Execution' && a === 'ProcessID') ev.ProcessID = v
    }
    const putText = (stack, v) => {
        if (v === '' || v == null) return
        const e = stack[stack.length - 1]
        if (stack.includes('System')) { if (['EventID', 'Level', 'Computer', 'Channel', 'Task', 'Opcode', 'EventRecordID'].includes(e)) ev[e] = v }
        else if (stack.includes('EventData') || stack.includes('UserData')) { const k = e === 'Data' && ev._name ? ev._name : `${e}${Object.keys(ev.data).length + 1}`; ev.data[k] = v; ev._name = null }
    }
    while (p < end) {
        const t = u8[p] & 0x0F
        if (t === 0x0F) { p += 4; continue } // начало фрагмента
        if (t === 0x0C) { // экземпляр шаблона
            const tplOff = dv.getUint32(p + 6, true)
            let tdef = ch + tplOff
            let q = p + 10
            let tplBody, tplLen
            if (tdef === q) { tplLen = dv.getUint32(q + 20, true); tplBody = q + 24; q = tplBody + tplLen; templates.set(tplOff, [tplBody, tplLen]) }
            else { const tt = templates.get(tplOff) ?? [tdef + 24, dv.getUint32(tdef + 20, true)]; tplBody = tt[0]; tplLen = tt[1] }
            const n = dv.getUint32(q, true); q += 4
            const decl = []; for (let i = 0; i < n; i++) decl.push([dv.getUint16(q + i * 4, true), u8[q + i * 4 + 2]])
            q += n * 4
            const subs = []
            for (const [len, type] of decl) { let v = ''; if (type === 0x21) { const sub = { data: {} }; try { parseBinXml(u8, dv, q, q + len, ch, templates, sub, u16le); Object.assign(ev.data, sub.data) } catch { /* вложенный */ } } else v = readValue(type, len, q); subs.push({ v, type }); q += len }
            runTemplate(tplBody, tplBody + tplLen, subs)
            p = q
            break
        }
        break
    }
    void path
}
const LEVEL = { 0: 'сведения', 1: 'критическая', 2: 'ошибка', 3: 'предупреждение', 4: 'сведения', 5: 'подробно' }
export const evtxSheets = events => {
    const keys = [...new Set(events.flatMap(e => Object.keys(e.data)))].slice(0, 30)
    return [{ name: `События (${events.length})`, rows: [['Время', 'Код', 'Уровень', 'Источник', 'Компьютер', 'Канал', ...keys], ...events.slice(0, 20000).map(e => [e.time?.toLocaleString('ru-RU') ?? '', String(e.EventID ?? ''), LEVEL[e.Level] ?? String(e.Level ?? ''), String(e.Provider ?? ''), String(e.Computer ?? ''), String(e.Channel ?? ''), ...keys.map(k => String(e.data[k] ?? ''))])] }]
}

// ================= Дампы падений Windows (.dmp, .mdmp) =================
const EXC = { 0xC0000005: 'нарушение доступа к памяти', 0xC00000FD: 'переполнение стека', 0xC0000094: 'деление на ноль', 0x80000003: 'точка останова', 0xC0000409: 'повреждение буфера в стеке', 0xC000001D: 'недопустимая инструкция', 0xE06D7363: 'исключение C++', 0xC0000374: 'повреждение кучи', 0xC0000417: 'недопустимый параметр' }
export const minidumpView = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (latin.decode(u8.subarray(0, 4)) !== 'MDMP') { if (latin.decode(u8.subarray(0, 8)) === 'PAGEDU64' || latin.decode(u8.subarray(0, 8)) === 'PAGEDUMP') return info('💥 Полный дамп памяти Windows', [['Вид', 'дамп ядра (синий экран)'], ['Код ошибки', '0x' + dv.getUint32(latin.decode(u8.subarray(4, 8)) === 'DU64' ? 0x38 : 0x20, true).toString(16).toUpperCase()]]); throw new ReaderError('Это не дамп падения Windows.') }
    const n = dv.getUint32(8, true), dir = dv.getUint32(12, true), ts = dv.getUint32(20, true)
    const str = rva => rva && rva + 4 <= u8.length ? new TextDecoder('utf-16le').decode(u8.subarray(rva + 4, rva + 4 + dv.getUint32(rva, true))) : ''
    const rows = [['Время падения', new Date(ts * 1000).toLocaleString('ru-RU')]]
    const mods = []
    let exc = null
    for (let i = 0; i < n; i++) {
        const o = dir + i * 12, type = dv.getUint32(o, true), size = dv.getUint32(o + 4, true), rva = dv.getUint32(o + 8, true)
        if (type === 4) { const k = dv.getUint32(rva, true); for (let m = 0; m < k; m++) { const mo = rva + 4 + m * 108; mods.push({ base: dv.getBigUint64(mo, true), size: dv.getUint32(mo + 8, true), name: str(dv.getUint32(mo + 20, true)), ver: [dv.getUint32(mo + 32, true), dv.getUint32(mo + 36, true)] }) } }
        else if (type === 6) { const code = dv.getUint32(rva + 8, true), addr = dv.getBigUint64(rva + 24, true); exc = { thread: dv.getUint32(rva, true), code, addr } }
        else if (type === 7) { const arch = dv.getUint16(rva, true), major = dv.getUint32(rva + 8, true), minor = dv.getUint32(rva + 12, true), build = dv.getUint32(rva + 16, true); rows.push(['Система', `Windows ${major}.${minor} (сборка ${build})`], ['Процессор', { 0: 'x86', 9: 'x64', 12: 'ARM64', 5: 'ARM' }[arch] ?? arch], ['Обновление', str(dv.getUint32(rva + 24, true))]) }
        else if (type === 15) { const pid = dv.getUint32(rva + 8, true); rows.push(['Номер процесса', pid]) }
        void size
    }
    if (exc) { rows.push(['Ошибка', `0x${exc.code.toString(16).toUpperCase()}${EXC[exc.code] ? ' — ' + EXC[exc.code] : ''}`]); const m = mods.find(md => exc.addr >= md.base && exc.addr < md.base + BigInt(md.size)); rows.push(['Где', m ? `${m.name.split('\\').pop()} + 0x${(exc.addr - m.base).toString(16)}` : '0x' + exc.addr.toString(16)]) }
    if (mods[0]) rows.splice(1, 0, ['Программа', mods[0].name])
    return info('💥 Дамп падения программы', rows, list('Загруженные модули', mods.map(m => `${m.name.split('\\').pop()} ${m.ver[0] >> 16}.${m.ver[0] & 65535}.${m.ver[1] >> 16}.${m.ver[1] & 65535}`)))
}

// ================= Профили настроек Apple (.mobileconfig) =================
const PAYLOAD = { 'com.apple.wifi.managed': 'Wi-Fi', 'com.apple.vpn.managed': 'VPN', 'com.apple.security.root': 'корневой сертификат (доверие ко всем сайтам с ним!)', 'com.apple.security.pkcs1': 'сертификат', 'com.apple.security.pkcs12': 'сертификат с ключом', 'com.apple.mail.managed': 'почта', 'com.apple.eas.account': 'Exchange', 'com.apple.webClip.managed': 'ярлык сайта', 'com.apple.mdm': 'удалённое управление (MDM)', 'com.apple.applicationaccess': 'ограничения', 'com.apple.dnsSettings.managed': 'DNS', 'com.apple.proxy.http.global': 'прокси', 'com.apple.caldav.account': 'календарь', 'com.apple.carddav.account': 'контакты', 'com.apple.mobiledevice.passwordpolicy': 'правила пароля' }
export const mobileconfigView = (buf, parseBplist) => {
    let u8 = new Uint8Array(buf)
    let signer = ''
    if (u8[0] === 0x30) { try { const c = parseCms(buf); if (c.content) { u8 = c.content; signer = 'есть' } } catch { /* не подписан */ } }
    const t = latin.decode(u8.subarray(0, 6)) === 'bplist' ? parseBplist(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)) : utf8.decode(u8)
    let o
    try { o = typeof t === 'string' && t.trim().startsWith('{') ? JSON.parse(t) : plistXml(t) } catch { throw new ReaderError('Не удалось прочитать профиль.') }
    const items = (o.PayloadContent ?? []).map(p => `<li><b>${esc(PAYLOAD[p.PayloadType] ?? p.PayloadType)}</b>${p.PayloadDisplayName ? ' — ' + esc(p.PayloadDisplayName) : ''}${p.SSID_STR ? ` (сеть «${esc(p.SSID_STR)}»)` : ''}${p.URL ? ` (${esc(p.URL)})` : ''}</li>`).join('')
    const risky = (o.PayloadContent ?? []).some(p => /security\.root|mdm|vpn|proxy/.test(p.PayloadType))
    return info(`⚙️ ${esc(o.PayloadDisplayName ?? 'Профиль настроек Apple')}`, [['Организация', o.PayloadOrganization], ['Описание', o.PayloadDescription], ['Идентификатор', o.PayloadIdentifier], ['Подпись', signer || 'нет'], ['Можно удалить', o.PayloadRemovalDisallowed ? 'нет' : 'да']], `<h3>Что профиль меняет</h3><ul>${items}</ul>${risky ? '<p class="ur-error">Профиль содержит доверенный сертификат, VPN, прокси или удалённое управление — ставьте его, только если доверяете источнику.</p>' : ''}`)
}
const plistXml = text => {
    const d = new DOMParser().parseFromString(text, 'application/xml')
    const conv = n => { if (!n) return null; switch (n.tagName) { case 'dict': { const o = {}; const ch = [...n.children]; for (let i = 0; i < ch.length; i += 2) o[ch[i].textContent] = conv(ch[i + 1]); return o } case 'array': return [...n.children].map(conv); case 'integer': case 'real': return +n.textContent; case 'true': return true; case 'false': return false; default: return n.textContent } }
    return conv(d.querySelector('plist > *'))
}

// ================= Сертификаты: .p12/.pfx, .p7b/.p7c, .crl =================
export const p7bView = async buf => {
    const c = parseCms(buf)
    if (!c.certs.length) throw new ReaderError('В файле нет сертификатов.')
    let html = `<div class="ur-meta">Сертификатов в цепочке: ${c.certs.length}</div>`
    for (const der of c.certs) {
        try {
            const ci = await certInfo(der)
            const cn = ci.subject.find(x => x[0] === 'CN')?.[1] ?? ci.subject.find(x => x[0] === 'O')?.[1] ?? 'Сертификат'
            const now = new Date()
            html += `<div class="ur-card ur-cert"><div class="ur-card-body"><div class="ur-card-name">📜 ${esc(cn)} ${ci.to && ci.to < now ? '<span class="ur-badge is-bad">просрочен</span>' : '<span class="ur-badge is-good">действует</span>'}${ci.isCa ? ' <span class="ur-badge">центр сертификации</span>' : ''}</div><div>Выдан: ${esc(ci.issuer.find(x => x[0] === 'CN')?.[1] ?? '')}</div><div>Действует: ${ci.from?.toLocaleDateString('ru-RU') ?? '?'} — ${ci.to?.toLocaleDateString('ru-RU') ?? '?'}</div><div class="ur-muted ur-break">SHA-256: ${esc(ci.fp)}</div></div></div>`
        } catch { html += '<div class="ur-card">Сертификат не разобрался</div>' }
    }
    return el('div', '', html)
}
export const crlView = buf => {
    let u8 = new Uint8Array(buf)
    const t = latin.decode(u8.subarray(0, 40))
    if (t.includes('-----BEGIN')) { const m = /-----BEGIN X509 CRL-----([\s\S]*?)-----END/.exec(latin.decode(u8)); const bin = atob(m[1].replace(/\s/g, '')); u8 = Uint8Array.from(bin, c => c.charCodeAt(0)) }
    const root = asn1(u8)[0]
    const tbs = root.kids[0].kids
    let i = 0; if (tbs[0].tag === 0x02) i++
    i++ // алгоритм
    const issuer = nameOf(tbs[i++]), upd = asnTime(tbs[i++]), next = tbs[i] && (tbs[i].tag === 0x17 || tbs[i].tag === 0x18) ? asnTime(tbs[i++]) : null
    const revoked = tbs[i]?.tag === 0x30 ? tbs[i].kids : []
    const hexs = b => [...b].map(x => x.toString(16).padStart(2, '0')).join(':').toUpperCase()
    const rows = revoked.slice(0, 20000).map(r => [hexs(r.kids[0].body), asnTime(r.kids[1])?.toLocaleString('ru-RU') ?? ''])
    void asnStr
    return info('🚫 Список отозванных сертификатов', [['Кто выпустил', issuer.map(([k, v]) => `${k}=${v}`).join(', ')], ['Обновлён', upd?.toLocaleString('ru-RU')], ['Следующее обновление', next?.toLocaleString('ru-RU')], ['Отозвано сертификатов', revoked.length]], rows.length ? `<table class="ur-table"><thead><tr><th>Серийный номер</th><th>Отозван</th></tr></thead><tbody>${rows.map(r => `<tr><td class="ur-break"><code>${esc(r[0])}</code></td><td>${esc(r[1])}</td></tr>`).join('')}</tbody></table>` : '')
}
export const p12View = buf => {
    const u8 = new Uint8Array(buf)
    let root
    try { root = asn1(u8)[0] } catch { throw new ReaderError('Это не контейнер PKCS#12.') }
    if (root?.tag !== 0x30 || root.kids?.[0]?.tag !== 0x02) throw new ReaderError('Это не контейнер PKCS#12.')
    const macAlg = root.kids[2] ? 'есть' : 'нет'
    return info('🔐 Сертификат с закрытым ключом (PKCS#12)', [['Версия', root.kids[0].body[0]], ['Проверка целостности паролем', macAlg]], '<p>Содержимое такого файла зашифровано паролем, а внутри лежит закрытый ключ — поэтому читалка его не расшифровывает. Чтобы посмотреть сам сертификат, выгрузите его отдельно в .crt или .cer.</p><p class="ur-error">Не передавайте этот файл другим — по нему можно действовать от вашего имени.</p>')
}

// ================= KeePass (.kdbx): только сведения =================
export const kdbxView = buf => {
    const dv = new DataView(buf)
    const s1 = dv.getUint32(0, true), s2 = dv.getUint32(4, true)
    if (s1 !== 0x9AA2D903 || (s2 !== 0xB54BFB67 && s2 !== 0xB54BFB66 && s2 !== 0xB54BFB65)) throw new ReaderError('Это не база KeePass.')
    const minor = dv.getUint16(8, true), major = dv.getUint16(10, true)
    const u8 = new Uint8Array(buf)
    let p = 12, cipher = '', kdf = '', comp = ''
    const CIPHER = { '31c1f2e6bf714350be5805216afc5aff': 'AES-256', 'd6038a2b8b6f4cb5a524339a31dbb59a': 'ChaCha20', 'ad68f29f576f4bb9a36ad47af965346c': 'Twofish' }
    for (let g = 0; g < 50 && p < u8.length; g++) {
        const id = u8[p], len = major >= 4 ? dv.getUint32(p + 1, true) : dv.getUint16(p + 1, true), d = p + (major >= 4 ? 5 : 3)
        if (id === 0) break
        if (id === 2) cipher = CIPHER[[...u8.subarray(d, d + 16)].map(b => b.toString(16).padStart(2, '0')).join('')] ?? 'другой'
        if (id === 3) comp = dv.getUint32(d, true) ? 'gzip' : 'нет'
        if (id === 11) { const t = latin.decode(u8.subarray(d, d + len)); kdf = /\$UUID[\s\S]{0,8}?(\x9e\x29\x8b\x19|\xef\x63\x6d\xdf)/.test(t) ? 'Argon2' : /\xc9\xd9\xf3\x9a/.test(t) ? 'AES-KDF' : 'Argon2 или AES-KDF' }
        p = d + len
    }
    return info('🔑 База паролей KeePass', [['Версия формата', `KDBX ${major}.${minor}`], ['Шифрование', cipher], ['Защита пароля', kdf || (major < 4 ? 'AES-KDF' : '')], ['Сжатие', comp]], '<p>Это зашифрованная база паролей. Читалка сознательно не открывает её содержимое — пароли не должны появляться в заметках. Откройте базу в KeePassXC, KeePassDX или Strongbox.</p>')
}

// ================= Переводы Qt (.qm) =================
export const parseQm = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if ([...u8.subarray(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('') !== '3cb86418caef9c95cd211cbf60a1bddd') throw new ReaderError('Это не перевод Qt (.qm).')
    let p = 16, msgs = null
    while (p + 5 <= u8.length) { const tag = u8[p], len = dv.getUint32(p + 1); if (tag === 0x69) msgs = [p + 5, p + 5 + len]; p += 5 + len }
    if (!msgs) throw new ReaderError('В переводе нет сообщений.')
    const out = []; let cur = {}
    p = msgs[0]
    while (p < msgs[1]) {
        const t = u8[p++]
        if (t === 1) { if (cur.tr != null || cur.src) out.push(cur); cur = {}; continue }
        if (t === 2 || t === 5 || t === 0) { p += t === 5 ? 4 : t === 2 ? 4 : 0; continue }
        const len = dv.getUint32(p); p += 4
        if (t === 3) { cur.tr = len === 0xFFFFFFFF ? '' : new TextDecoder('utf-16be').decode(u8.subarray(p, p + len)); if (len !== 0xFFFFFFFF) p += len; continue }
        const s = utf8.decode(u8.subarray(p, p + len)).replace(/\0$/, ''); p += len
        if (t === 6 || t === 8) cur.src = s; else if (t === 7) cur.ctx = s; else if (t === 6) cur.comment = s
    }
    return out.map(m => ({ msgid: m.src ?? '', msgstr: [m.tr ?? ''], context: m.ctx ?? '' }))
}

// ================= Записи терминала ttyrec / script =================
export const ttyrecToCast = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const ev = []; let p = 0, t0 = null
    while (p + 12 <= u8.length) { const s = dv.getUint32(p, true), us = dv.getUint32(p + 4, true), len = dv.getUint32(p + 8, true); if (len > 1e7) break; const t = s + us / 1e6; t0 ??= t; ev.push([t - t0, 'o', utf8.decode(u8.subarray(p + 12, p + 12 + len))]); p += 12 + len }
    if (!ev.length) throw new ReaderError('Это не запись ttyrec.')
    return JSON.stringify({ version: 2, width: 80, height: 24 }) + '\n' + ev.map(e => JSON.stringify(e)).join('\n')
}

// ================= LyX и DITA =================
export const lyxToHtml = text => {
    if (!/^#LyX/.test(text)) throw new ReaderError('Это не документ LyX.')
    const body = text.split(/\\begin_body/)[1] ?? text
    const TAG = { Title: 'h1', Author: 'p class="ur-muted"', Section: 'h2', 'Section*': 'h2', Subsection: 'h3', 'Subsection*': 'h3', Subsubsection: 'h4', Standard: 'p', Quote: 'blockquote', Quotation: 'blockquote', 'LyX-Code': 'pre', Abstract: 'p class="ur-abstract"', Itemize: 'li', Enumerate: 'li', Description: 'li' }
    let html = '', prevList = null
    for (const m of body.matchAll(/\\begin_layout (\S+)\n([\s\S]*?)\\end_layout/g)) {
        const kind = m[1]
        let t = m[2]
        t = t.replace(/\\begin_inset Formula ([\s\S]*?)\n\\end_inset/g, (x, f) => `\u0001${f.trim()}\u0002`)
            .replace(/\\begin_inset[\s\S]*?\\end_inset/g, '').replace(/\\series bold\n([\s\S]*?)\n?\\series default/g, '\u0003$1\u0004').replace(/\\shape italic\n([\s\S]*?)\n?\\shape default/g, '\u0005$1\u0006')
            .replace(/^\\[a-z_]+.*$/gm, '').replace(/\n/g, '').replace(/\\backslash /g, '\\')
        t = esc(t).replace(/\u0001(.*?)\u0002/g, '<code class="ur-math">$1</code>').replace(/\u0003(.*?)\u0004/g, '<b>$1</b>').replace(/\u0005(.*?)\u0006/g, '<i>$1</i>')
        const tag = TAG[kind] ?? 'p', name = tag.split(' ')[0]
        const list = kind === 'Itemize' ? 'ul' : kind === 'Enumerate' ? 'ol' : kind === 'Description' ? 'ul' : null
        if (prevList && prevList !== list) { html += `</${prevList}>`; prevList = null }
        if (list && !prevList) { html += `<${list}>`; prevList = list }
        html += `<${tag}>${t}</${name}>\n`
    }
    if (prevList) html += `</${prevList}>`
    return html
}
export const ditaToHtml = text => {
    const d = new DOMParser().parseFromString(text.replace(/<!DOCTYPE[^>]*>/, ''), 'application/xml')
    if (d.querySelector('parsererror')) throw new ReaderError('Не удалось прочитать DITA (ошибка XML).')
    const root = d.documentElement
    if (root.tagName === 'map' || root.tagName === 'bookmap') {
        const walk = n => [...n.children].filter(c => /topicref|chapter|appendix|part|mapref|topichead/.test(c.tagName)).map(c => `<li>${esc(c.getAttribute('navtitle') ?? c.querySelector(':scope > topicmeta > navtitle')?.textContent ?? c.getAttribute('href') ?? '')}${c.getAttribute('href') ? ` <code>${esc(c.getAttribute('href'))}</code>` : ''}${c.children.length ? `<ul>${walk(c)}</ul>` : ''}</li>`).join('')
        return `<h1>${esc(root.querySelector(':scope > title')?.textContent ?? root.getAttribute('title') ?? 'Карта DITA')}</h1><ul>${walk(root)}</ul>`
    }
    const M = { title: 'h2', shortdesc: 'p class="ur-muted"', p: 'p', ul: 'ul', ol: 'ol', li: 'li', b: 'b', i: 'i', u: 'u', codeph: 'code', codeblock: 'pre', note: 'blockquote', section: 'section', example: 'section', fig: 'figure', table: 'table', simpletable: 'table', row: 'tr', strow: 'tr', sthead: 'tr', entry: 'td', stentry: 'td', steps: 'ol', step: 'li', cmd: 'span', info: 'div', xref: 'a', dl: 'dl', dt: 'dt', dd: 'dd', dlentry: 'div', q: 'q', term: 'i', uicontrol: 'b', menucascade: 'span', filepath: 'code', cite: 'cite', image: 'span' }
    const conv = n => {
        if (n.nodeType === 3) return esc(n.textContent)
        if (n.nodeType !== 1) return ''
        const t = M[n.tagName]
        const inner = [...n.childNodes].map(conv).join('')
        if (!t) return inner
        const nm = t.split(' ')[0]
        if (n.tagName === 'note') return `<blockquote><b>${esc(n.getAttribute('type') === 'warning' ? 'Внимание' : 'Примечание')}:</b> ${inner}</blockquote>`
        if (n.tagName === 'xref') return `<a href="${esc(n.getAttribute('href') ?? '')}">${inner || esc(n.getAttribute('href') ?? '')}</a>`
        if (n.tagName === 'image') return `<span class="ur-muted">[картинка ${esc(n.getAttribute('href') ?? '')}]</span>`
        return `<${t}>${inner}</${nm}>`
    }
    const title = root.querySelector(':scope > title')
    return `<h1>${esc(title?.textContent ?? '')}</h1>` + [...root.childNodes].filter(c => c !== title).map(conv).join('')
}

// ================= Номера страниц Kindle (.apnx) =================
export const apnxView = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const hdrOff = dv.getUint32(4), hdrLen = dv.getUint32(hdrOff)
    let meta = {}; try { meta = JSON.parse(utf8.decode(u8.subarray(hdrOff + 4, hdrOff + 4 + hdrLen))) } catch { /* старый формат */ }
    const p = hdrOff + 4 + hdrLen
    const n = dv.getUint16(p + 6)
    return info('📖 Номера страниц Kindle', [['Книга (ASIN)', meta.asin ?? meta.contentGuid ?? ''], ['Источник страниц', meta.pageMap ?? meta.fileRevisionId ?? ''], ['Страниц', n], ['Способ', meta.format ?? '']], '<p>Этот файл лежит рядом с книгой и подсказывает Kindle настоящие номера страниц бумажного издания.</p>')
}
