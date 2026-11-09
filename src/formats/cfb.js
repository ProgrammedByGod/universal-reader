// Минимальное чтение составных файлов OLE (Compound File Binary): .doc, .ppt, .wps, .xls, Thumbs.db
import { ReaderError } from '../util.js'

export const isCfb = u8 => u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0 && u8[4] === 0xA1 && u8[5] === 0xB1
export const readCfb = buf => {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    if (!isCfb(u8) || u8.length < 512) throw new ReaderError('Файл повреждён (это не составной документ Microsoft Office).')
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    const ss = 1 << dv.getUint16(30, true), mss = 1 << dv.getUint16(32, true)
    const nFat = dv.getUint32(44, true), dirStart = dv.getUint32(48, true), miniCut = dv.getUint32(56, true)
    const miniFatStart = dv.getUint32(60, true), nMiniFat = dv.getUint32(64, true), difStart = dv.getUint32(68, true), nDif = dv.getUint32(72, true)
    const sector = n => (n + 1) * ss
    const ENDS = 0xFFFFFFFE
    // таблица размещения (FAT): первые 109 секторов — в заголовке, остальные — в DIFAT
    const fatSecs = []
    for (let i = 0; i < 109 && fatSecs.length < nFat; i++) fatSecs.push(dv.getUint32(76 + i * 4, true))
    let d = difStart
    for (let k = 0; k < nDif && d < ENDS && fatSecs.length < nFat; k++) {
        for (let i = 0; i < ss / 4 - 1 && fatSecs.length < nFat; i++) fatSecs.push(dv.getUint32(sector(d) + i * 4, true))
        d = dv.getUint32(sector(d) + ss - 4, true)
    }
    const fat = new Uint32Array(fatSecs.length * ss / 4)
    fatSecs.forEach((s, i) => { for (let k = 0; k < ss / 4; k++) { const o = sector(s) + k * 4; fat[i * ss / 4 + k] = o + 4 <= u8.length ? dv.getUint32(o, true) : ENDS } })
    const chain = (start, table) => { const out = []; let s = start, guard = 0; while (s < ENDS && s < table.length + 1 && guard++ < 1e7) { out.push(s); s = table[s] } return out }
    const readChain = (start, size) => {
        const secs = chain(start, fat)
        const out = new Uint8Array(size ?? secs.length * ss)
        let p = 0
        for (const s of secs) { const n = Math.min(ss, out.length - p); if (n <= 0) break; out.set(u8.subarray(sector(s), sector(s) + n), p); p += n }
        return out
    }
    const dir = readChain(dirStart)
    const ddv = new DataView(dir.buffer)
    const entries = []
    for (let o = 0; o + 128 <= dir.length; o += 128) {
        const nameLen = ddv.getUint16(o + 64, true)
        const name = nameLen > 2 ? new TextDecoder('utf-16le').decode(dir.subarray(o, o + nameLen - 2)) : ''
        entries.push({ name, type: dir[o + 66], left: ddv.getInt32(o + 68, true), right: ddv.getInt32(o + 72, true), child: ddv.getInt32(o + 76, true), start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true) })
    }
    const root = entries[0]
    const miniStream = root ? readChain(root.start, root.size) : new Uint8Array()
    const miniFatBytes = nMiniFat ? readChain(miniFatStart) : new Uint8Array()
    const miniFat = new Uint32Array(miniFatBytes.buffer, 0, miniFatBytes.length >> 2)
    const readEntry = e => {
        if (e.size < miniCut && e !== root) {
            const out = new Uint8Array(e.size); let p = 0
            for (const s of chain(e.start, miniFat)) { const n = Math.min(mss, e.size - p); if (n <= 0) break; out.set(miniStream.subarray(s * mss, s * mss + n), p); p += n }
            return out
        }
        return readChain(e.start, e.size)
    }
    // полные пути: обходим дерево каталогов
    const files = new Map()
    const walk = (idx, prefix, seen = new Set()) => {
        if (idx < 0 || idx >= entries.length || seen.has(idx)) return
        seen.add(idx)
        const e = entries[idx]
        walk(e.left, prefix, seen); walk(e.right, prefix, seen)
        const path = prefix + e.name
        if (e.type === 2) files.set(path, e)
        if (e.type === 1) walk(e.child, path + '/', seen)
    }
    if (root) walk(root.child, '')
    return {
        names: [...files.keys()],
        has: n => files.has(n),
        get: n => { const e = files.get(n); return e ? readEntry(e) : null },
        find: re => [...files.keys()].find(k => re.test(k)),
    }
}
