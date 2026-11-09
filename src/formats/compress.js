// Распаковка сжатых потоков: gzip, zlib, deflate, bzip2, xz, zstd, lz4, Unix compress (.Z)
import { ReaderError } from '../util.js'
import { inflateSync } from 'fflate'

const viaStream = async (u8, fmt) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream(fmt))).arrayBuffer())
export const gunzip = u8 => viaStream(u8, 'gzip')
// у некоторых программ после сжатых данных остаётся «хвост» — тогда распаковываем терпимой реализацией
export const inflateRaw = async u8 => { try { return await viaStream(u8, 'deflate-raw') } catch { return inflateSync(u8) } }
export { inflateSync }
export const inflateZlib = u8 => viaStream(u8, 'deflate')

// Несколько склеенных gzip-потоков (так устроены .warc.gz) — DecompressionStream сам их читает подряд
export const compressionOf = u8 => {
    if (u8[0] === 0x1F && u8[1] === 0x8B) return 'gzip'
    if (u8[0] === 0x42 && u8[1] === 0x5A && u8[2] === 0x68) return 'bzip2'
    if (u8[0] === 0xFD && u8[1] === 0x37 && u8[2] === 0x7A && u8[3] === 0x58 && u8[4] === 0x5A) return 'xz'
    if (u8[0] === 0x28 && u8[1] === 0xB5 && u8[2] === 0x2F && u8[3] === 0xFD) return 'zstd'
    if (u8[0] === 0x04 && u8[1] === 0x22 && u8[2] === 0x4D && u8[3] === 0x18) return 'lz4'
    if (u8[0] === 0x1F && u8[1] === 0x9D) return 'compress'
    return null
}

export const decompress = async (ctx, u8, kind = compressionOf(u8)) => {
    switch (kind) {
        case 'gzip': return gunzip(u8)
        case 'bzip2': { const bz2 = await ctx.loadLib('bz2'); return bz2.decompress(u8) }
        case 'xz': { const xz = await ctx.loadLib('xz'); return xz.decompress(u8) }
        case 'zstd': { const z = await ctx.loadLib('zstd'); return z.decompress(u8) }
        case 'lz4': { const l = await ctx.loadLib('lz4'); return l.decompress(u8) }
        case 'compress': return unlzw(u8)
    }
    throw new ReaderError('Неизвестный способ сжатия.')
}

// Unix compress (.Z): LZW с переменной длиной кода
export const unlzw = u8 => {
    if (u8[0] !== 0x1F || u8[1] !== 0x9D) throw new ReaderError('Это не файл .Z')
    const maxBits = u8[2] & 0x1F, block = (u8[2] & 0x80) !== 0
    const out = []
    let bits = 9, maxCode = (1 << bits) - 1
    const prefix = new Int32Array(1 << maxBits), suffix = new Uint8Array(1 << maxBits)
    for (let i = 0; i < 256; i++) suffix[i] = i
    let free = block ? 257 : 256
    let bitPos = 3 * 8, old = -1, fin = 0
    const stack = new Uint8Array(1 << maxBits)
    const total = u8.length * 8
    let groupStart = bitPos
    while (true) {
        if (bitPos + bits > total) break
        let code = 0
        for (let i = 0; i < bits; i++) { const p = bitPos + i; if (u8[p >> 3] & (1 << (p & 7))) code |= 1 << i }
        bitPos += bits
        if (block && code === 256) {
            // сброс словаря: пропускаем остаток группы кодов
            const groupBits = bits * 8
            bitPos = groupStart + Math.ceil((bitPos - groupStart) / groupBits) * groupBits
            bits = 9; maxCode = (1 << bits) - 1; free = 256; old = -1; groupStart = bitPos
            continue
        }
        if (old === -1) { if (code > 255) break; out.push(code); old = code; fin = code; continue }
        let sp = 0, c = code
        if (c >= free) { stack[sp++] = fin; c = old }
        while (c > 255) { stack[sp++] = suffix[c]; c = prefix[c] }
        fin = c; stack[sp++] = c
        while (sp) out.push(stack[--sp])
        if (free < (1 << maxBits)) { prefix[free] = old; suffix[free] = fin; free++ }
        old = code
        if (free > maxCode && bits < maxBits) {
            const groupBits = bits * 8
            bitPos = groupStart + Math.ceil((bitPos - groupStart) / groupBits) * groupBits
            groupStart = bitPos
            bits++; maxCode = (1 << bits) - 1
        }
    }
    return Uint8Array.from(out)
}

// MD5 — нужен для ссылок на картинки в заметках Evernote
export const md5 = bytes => {
    const K = new Int32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32)
    const len = bytes.length, n = ((len + 8) >> 6) + 1
    const w = new Int32Array(n * 16)
    for (let i = 0; i < len; i++) w[i >> 2] |= bytes[i] << ((i % 4) * 8)
    w[len >> 2] |= 0x80 << ((len % 4) * 8)
    w[n * 16 - 2] = (len * 8) >>> 0; w[n * 16 - 1] = Math.floor(len / 0x20000000)
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476
    for (let o = 0; o < w.length; o += 16) {
        let a = a0, b = b0, c = c0, d = d0
        for (let i = 0; i < 64; i++) {
            let f, g
            if (i < 16) { f = (b & c) | (~b & d); g = i }
            else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16 }
            else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 }
            else { f = c ^ (b | ~d); g = (7 * i) % 16 }
            const t = d; d = c; c = b
            const x = (a + f + K[i] + w[o + g]) | 0
            const s = S[(i >> 4) * 4 + (i % 4)]
            b = (b + ((x << s) | (x >>> (32 - s)))) | 0
            a = t
        }
        a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0
    }
    return [a0, b0, c0, d0].map(v => Array.from({ length: 4 }, (_, i) => ((v >>> (i * 8)) & 255).toString(16).padStart(2, '0')).join('')).join('')
}
