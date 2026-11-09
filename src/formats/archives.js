// Архивы: zip, rar, 7z, tar и сжатые файлы, пакеты Linux (deb, rpm), CAB, ISO, расширения Chrome
import JSZip from 'jszip'
import { bytesOpener } from './textual.js'
import { FORMAT_BY_EXT } from '../registry.js'
import { escapeHtml as esc, decodeText, parseTar, sniffArchive, isImageName, extOf, MIME, ReaderError, naturalCompare } from '../util.js'
import { compressionOf, decompress, inflateSync } from './compress.js'

export const fmtSize = n => n == null ? '' : n < 1024 ? `${n} Б` : n < 1048576 ? `${(n / 1024).toFixed(1)} КБ` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} МБ` : `${(n / 1073741824).toFixed(2)} ГБ`
const latin = new TextDecoder('latin1')

// Результат: { entries: [{ name, size, date, dir }], getBytes(name), single?, info? (HTML над списком) }
const fromMap = (map, extra = {}) => ({
    entries: [...map].map(([name, v]) => ({ name, size: v.length ?? v.size, date: v.date })),
    getBytes: async n => { const v = map.get(n); return v instanceof Uint8Array ? v : v.get() },
    ...extra,
})

const openZip = async buf => {
    const zip = await JSZip.loadAsync(buf)
    const entries = Object.values(zip.files).map(f => ({ name: f.name, dir: f.dir, size: f._data?.uncompressedSize, date: f.date }))
    return { entries, getBytes: name => zip.file(name).async('uint8array'), zip }
}
const openTarBytes = u8 => {
    const { entries, data } = parseTar(u8.buffer.byteLength === u8.length ? u8.buffer : u8.slice().buffer)
    const map = new Map(entries.map(e => [e.name.replace(/^\.\//, ''), e]))
    return { entries: [...map].map(([name, e]) => ({ name, size: e.size })), getBytes: async n => { const e = map.get(n); return data.slice(e.offset, e.offset + e.size) } }
}
const isTar = u8 => u8.length > 262 && latin.decode(u8.subarray(257, 262)) === 'ustar'

// ---------- ar (основа .deb) ----------
const parseAr = u8 => {
    const out = new Map()
    let off = 8
    while (off + 60 <= u8.length) {
        const name = latin.decode(u8.subarray(off, off + 16)).trim().replace(/\/$/, '')
        const size = parseInt(latin.decode(u8.subarray(off + 48, off + 58)).trim(), 10) || 0
        out.set(name, u8.subarray(off + 60, off + 60 + size))
        off += 60 + size + (size % 2)
    }
    return out
}
// Обычный ar (библиотеки .a, .lib): длинные имена GNU («//» и «/N») и BSD («#1/длина»)
const openAr = u8 => {
    const files = new Map()
    let off = 8, longNames = ''
    while (off + 60 <= u8.length) {
        let name = latin.decode(u8.subarray(off, off + 16)).trim()
        const size = parseInt(latin.decode(u8.subarray(off + 48, off + 58)).trim(), 10) || 0
        let data = u8.subarray(off + 60, off + 60 + size)
        const mtime = parseInt(latin.decode(u8.subarray(off + 16, off + 28)).trim(), 10)
        off += 60 + size + (size % 2)
        if (name === '//') { longNames = latin.decode(data); continue }
        if (name === '/' || name === '/SYM64/' || name.startsWith('__.SYMDEF')) continue
        if (/^\/\d+$/.test(name)) { const i = +name.slice(1); name = longNames.slice(i, longNames.indexOf('\n', i)).replace(/\/$/, '') }
        else if (/^#1\/\d+$/.test(name)) { const n = +name.slice(3); name = latin.decode(data.subarray(0, n)).replace(/\0+$/, ''); data = data.subarray(n) }
        else name = name.replace(/\/$/, '')
        let unique = name, k = 2
        while (files.has(unique)) unique = `${name} (${k++})`
        const d = data
        files.set(unique, Object.assign(d, { date: mtime ? new Date(mtime * 1000) : undefined }))
    }
    return fromMap(files, { info: '<p class="ur-muted">Библиотека программ (архив ar): объектные файлы, из которых собирают программы.</p>' })
}
// lzip → «LZMA alone»: тот же поток LZMA, только другой заголовок (7-Zip сам lzip не знает)
const lzipToLzma = u8 => {
    const dictSize = (1 << (u8[5] & 31)) - ((1 << (u8[5] & 31)) >> 4) * (u8[5] >> 5)
    const body = u8.subarray(6, u8.length - 20)
    const out = new Uint8Array(13 + body.length)
    out[0] = 0x5D; new DataView(out.buffer).setUint32(1, dictSize, true); out.fill(0xFF, 5, 13); out.set(body, 13)
    return out
}
export const SEVEN_EXTS = new Set(['lzma', 'lz', 'tlz', 'lzh', 'lha', 'arj', 'cpio', 'snap', 'appimage', 'pkg', 'xar', 'dmg', 'msi', 'msp', 'vhd', 'vhdx', 'vmdk', 'vdi', 'qcow2', 'qcow', 'wim', 'esd', 'swm', 'img', 'ima', 'udf', 'squashfs', 'sfs', 'hfs', 'apfs', 'ntfs', 'fat', 'ext4', 'ext2', 'ext3'])
const openDeb = async (ctx, u8) => {
    const ar = parseAr(u8)
    const unpack = async name => {
        const key = [...ar.keys()].find(k => k.startsWith(name))
        if (!key) return null
        let d = ar.get(key)
        if (compressionOf(d)) d = await decompress(ctx, d)
        return openTarBytes(d)
    }
    const control = await unpack('control.tar')
    const data = await unpack('data.tar')
    let info = ''
    if (control) {
        const ce = control.entries.find(e => /(^|\/)control$/.test(e.name))
        if (ce) {
            const text = decodeText(await control.getBytes(ce.name))
            const fields = [...text.matchAll(/^([A-Za-z-]+):\s?((?:.*)(?:\n[ \t].*)*)/gm)].map(m => [m[1], m[2].replace(/\n[ \t]\.?/g, '\n').trim()])
            const pick = k => fields.find(f => f[0] === k)?.[1]
            info = `<h2>${esc(pick('Package') || 'Пакет')} ${esc(pick('Version') || '')}</h2>` +
                `<table class="ur-font-facts">${fields.filter(f => !['Package', 'Description'].includes(f[0])).map(([k, v]) => `<tr><td class="ur-muted">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>` +
                (pick('Description') ? `<p style="white-space:pre-wrap">${esc(pick('Description'))}</p>` : '')
        }
    }
    const entries = [], getters = new Map()
    for (const [prefix, arc] of [['', data], ['[служебные]/', control]]) {
        if (!arc) continue
        for (const e of arc.entries) { const n = prefix + e.name.replace(/^\.\//, ''); entries.push({ ...e, name: n }); getters.set(n, () => arc.getBytes(e.name)) }
    }
    return { entries, getBytes: n => getters.get(n)(), info }
}

// ---------- RPM ----------
const RPM_TAGS = { 1000: 'Имя', 1001: 'Версия', 1002: 'Выпуск', 1004: 'Описание кратко', 1005: 'Описание', 1009: 'Размер', 1010: 'Дистрибутив', 1011: 'Поставщик', 1014: 'Лицензия', 1016: 'Группа', 1020: 'Сайт', 1022: 'Архитектура', 1125: 'Сжатие' }
const openRpm = async (ctx, u8) => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    const readHeader = off => {
        if (dv.getUint32(off) !== 0x8EADE801) throw new ReaderError('Повреждённый пакет RPM.')
        const n = dv.getUint32(off + 8), size = dv.getUint32(off + 12)
        const store = off + 16 + n * 16
        const tags = {}
        for (let i = 0; i < n; i++) {
            const e = off + 16 + i * 16
            const tag = dv.getUint32(e), type = dv.getUint32(e + 4), o = dv.getUint32(e + 8), cnt = dv.getUint32(e + 12)
            const p = store + o
            if (type === 6 || type === 9) { let q = p; while (u8[q]) q++; tags[tag] = new TextDecoder().decode(u8.subarray(p, q)) }
            else if (type === 8) { tags[tag] = new TextDecoder().decode(u8.subarray(p, u8.indexOf(0, p))) }
            else if (type === 4 && cnt === 1) tags[tag] = dv.getUint32(p)
        }
        return { tags, end: store + size }
    }
    const sig = readHeader(96)
    const hdrOff = Math.ceil(sig.end / 8) * 8
    const hdr = readHeader(hdrOff)
    let payload = u8.subarray(hdr.end)
    if (compressionOf(payload)) payload = await decompress(ctx, payload)
    // cpio "newc"
    const map = new Map()
    let off = 0
    const td = new TextDecoder()
    while (off + 110 <= payload.length) {
        const magic = latin.decode(payload.subarray(off, off + 6))
        if (magic !== '070701' && magic !== '070702') break
        const h = i => parseInt(latin.decode(payload.subarray(off + 6 + i * 8, off + 14 + i * 8)), 16)
        const mode = h(1), mtime = h(5), fsize = h(6), nsize = h(11)
        const name = td.decode(payload.subarray(off + 110, off + 110 + nsize - 1))
        let p = off + 110 + nsize; p = Math.ceil(p / 4) * 4
        if (name === 'TRAILER!!!') break
        if ((mode & 0xF000) === 0x8000) map.set(name.replace(/^\.?\//, ''), Object.assign(payload.subarray(p, p + fsize), { date: new Date(mtime * 1000) }))
        off = Math.ceil((p + fsize) / 4) * 4
    }
    const t = hdr.tags
    const info = `<h2>${esc(t[1000] || 'Пакет')} ${esc(t[1001] || '')}-${esc(t[1002] || '')}</h2>` +
        `<table class="ur-font-facts">${[1004, 1022, 1014, 1016, 1020, 1011, 1010].filter(k => t[k]).map(k => `<tr><td class="ur-muted">${RPM_TAGS[k]}</td><td>${esc(t[k])}</td></tr>`).join('')}</table>` +
        (t[1005] ? `<p style="white-space:pre-wrap">${esc(t[1005])}</p>` : '')
    return fromMap(map, { info })
}

// ---------- CAB (установщики Windows) ----------
const openCab = async (ctx, u8) => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    if (latin.decode(u8.subarray(0, 4)) !== 'MSCF') throw new ReaderError('Это не архив CAB.')
    const coffFiles = dv.getUint32(16, true), nFolders = dv.getUint16(26, true), nFiles = dv.getUint16(28, true), flags = dv.getUint16(30, true)
    let p = 36
    let cbFolder = 0, cbData = 0
    if (flags & 4) { const cbHeader = dv.getUint16(36, true); cbFolder = u8[38]; cbData = u8[39]; p = 40 + cbHeader }
    if (flags & 1) { while (u8[p]) p++; p++; while (u8[p]) p++; p++ }
    if (flags & 2) { while (u8[p]) p++; p++; while (u8[p]) p++; p++ }
    const folders = []
    for (let i = 0; i < nFolders; i++) { folders.push({ off: dv.getUint32(p, true), blocks: dv.getUint16(p + 4, true), comp: dv.getUint16(p + 6, true) & 0xF }); p += 8 + cbFolder }
    const files = []
    p = coffFiles
    for (let i = 0; i < nFiles; i++) {
        const size = dv.getUint32(p, true), off = dv.getUint32(p + 4, true), folder = dv.getUint16(p + 8, true)
        const date = dv.getUint16(p + 10, true), time = dv.getUint16(p + 12, true), attr = dv.getUint16(p + 14, true)
        let q = p + 16; while (u8[q]) q++
        const raw = u8.subarray(p + 16, q)
        const name = (attr & 0x80 ? new TextDecoder() : new TextDecoder('windows-1252')).decode(raw).replace(/\\/g, '/')
        const d = new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2)
        files.push({ name, size, off, folder, date: d })
        p = q + 1
    }
    const cache = new Map()
    const folderData = async fi => {
        if (cache.has(fi)) return cache.get(fi)
        const f = folders[fi]
        if (!f) throw new ReaderError('Файл лежит в другом томе многотомного архива.')
        if (f.comp !== 0 && f.comp !== 1) throw new ReaderError(f.comp === 3 ? 'Этот CAB сжат методом LZX — он пока не поддерживается.' : 'Этот CAB сжат методом Quantum — он не поддерживается.')
        const parts = []
        let q = f.off, hist = new Uint8Array(0)
        for (let b = 0; b < f.blocks; b++) {
            const cb = dv.getUint16(q + 4, true)
            const data = u8.subarray(q + 8 + cbData, q + 8 + cbData + cb)
            let out
            if (f.comp === 0) out = data
            else {
                if (data[0] !== 0x43 || data[1] !== 0x4B) throw new ReaderError('Повреждённый блок MSZIP.')
                out = inflateSync(data.subarray(2), hist.length ? { dictionary: hist } : undefined)
                const all = new Uint8Array(hist.length + out.length); all.set(hist); all.set(out, hist.length)
                hist = all.subarray(Math.max(0, all.length - 32768))
            }
            parts.push(out)
            q += 8 + cbData + cb
        }
        const total = parts.reduce((s, x) => s + x.length, 0)
        const res = new Uint8Array(total); let o = 0
        for (const x of parts) { res.set(x, o); o += x.length }
        cache.set(fi, res)
        return res
    }
    const byName = new Map(files.map(f => [f.name, f]))
    return {
        entries: files.map(f => ({ name: f.name, size: f.size, date: f.date })),
        getBytes: async n => { const f = byName.get(n); const d = await folderData(f.folder); return d.subarray(f.off, f.off + f.size) },
    }
}

// ---------- ISO 9660 (+ Joliet) ----------
// reader: { size, read(offset, length) -> Promise<Uint8Array> } — чтобы не держать в памяти весь образ
export const openIso = async reader => {
    const S = 2048
    const vds = []
    for (let s = 16; s < 64; s++) {
        const d = await reader.read(s * S, S)
        if (latin.decode(d.subarray(1, 6)) !== 'CD001') break
        vds.push(d)
        if (d[0] === 255) break
    }
    if (!vds.length) {
        if (latin.decode((await reader.read(32769, 5))) !== 'CD001') throw new ReaderError('Это не образ диска ISO 9660 (возможно, UDF или образ другого типа).')
    }
    let pvd = vds.find(d => d[0] === 1)
    const joliet = vds.find(d => d[0] === 2 && d[88] === 0x25 && d[89] === 0x2F && [0x40, 0x43, 0x45].includes(d[90]))
    const vd = joliet ?? pvd
    if (!vd) throw new ReaderError('В образе не найдено описание диска.')
    const label = (joliet ? new TextDecoder('utf-16be') : latin).decode(vd.subarray(40, 72)).trim()
    const dvRoot = new DataView(vd.buffer, vd.byteOffset + 156, 34)
    const rootLba = dvRoot.getUint32(2, true), rootLen = dvRoot.getUint32(10, true)
    const entries = [], map = new Map()
    const dec = joliet ? new TextDecoder('utf-16be') : latin
    const walk = async (lba, len, path, depth) => {
        if (depth > 32 || entries.length > 50000) return
        const buf = await reader.read(lba * S, len)
        let p = 0
        while (p < buf.length) {
            const rl = buf[p]
            if (!rl) { p = (Math.floor(p / S) + 1) * S; continue }
            const dv = new DataView(buf.buffer, buf.byteOffset + p, rl)
            const elba = dv.getUint32(2, true), elen = dv.getUint32(10, true), flags = buf[p + 25], nl = buf[p + 32]
            const nameRaw = buf.subarray(p + 33, p + 33 + nl)
            if (!(nl === 1 && (nameRaw[0] === 0 || nameRaw[0] === 1))) {
                let name = dec.decode(nameRaw).replace(/;\d+$/, '').replace(/\.$/, '')
                const y = buf[p + 18], date = new Date(Date.UTC(1900 + y, buf[p + 19] - 1, buf[p + 20], buf[p + 21], buf[p + 22], buf[p + 23]))
                const full = path + name
                if (flags & 2) await walk(elba, elen, full + '/', depth + 1)
                else { entries.push({ name: full, size: elen, date }); map.set(full, [elba, elen]) }
            }
            p += rl
        }
    }
    await walk(rootLba, rootLen, '', 0)
    const total = new DataView(vd.buffer, vd.byteOffset).getUint32(80, true) * S
    return {
        entries,
        getBytes: async n => { const [lba, len] = map.get(n); if (len > 200 * 1048576) throw new ReaderError('Файл слишком большой для предпросмотра.'); return reader.read(lba * S, len) },
        info: `<h2>💿 ${esc(label || 'Образ диска')}</h2><div class="ur-meta">ISO 9660${joliet ? ' + Joliet' : ''} · ${fmtSize(total || reader.size)}</div>`,
    }
}

// ---------- Главная точка входа ----------
export const openArchive = async (ctx, buf, ext, fileName) => {
    let u8 = new Uint8Array(buf)
    // сжатый файл: распаковываем, внутри может быть tar
    const comp = compressionOf(u8)
    if (comp) {
        u8 = await decompress(ctx, u8, comp)
        if (isTar(u8)) return openTarBytes(u8)
        if (latin.decode(u8.subarray(0, 8)) === '!<arch>\n') return openDeb(ctx, u8)
        const name = fileName.replace(/\.(gz|tgz|bz2|tbz2?|xz|txz|zst|tzst|lz4|tlz4|z)$/i, '').replace(/\.t(ar)?$/i, '.tar') || 'файл'
        const data = u8
        return { entries: [{ name, size: data.length }], getBytes: async () => data, single: true }
    }
    const head = latin.decode(u8.subarray(0, 8))
    if (head === '!<arch>\n') return latin.decode(u8.subarray(8, 24)).startsWith('debian-binary') ? openDeb(ctx, u8) : openAr(u8)
    if (u8[0] === 0xED && u8[1] === 0xAB && u8[2] === 0xEE && u8[3] === 0xDB) return openRpm(ctx, u8)
    if (head.startsWith('MSCF')) return openCab(ctx, u8)
    if (head.startsWith('Cr24')) {
        const dv = new DataView(buf)
        const ver = dv.getUint32(4, true)
        const start = ver === 3 ? 12 + dv.getUint32(8, true) : 16 + dv.getUint32(8, true) + dv.getUint32(12, true)
        return openZip(buf.slice(start))
    }
    let kind = sniffArchive(buf)
    if (!kind && isTar(u8)) kind = 'tar'
    if (ext === 'zipx') kind = '7z'
    let sevenName = ext === 'zipx' ? 'zip' : '7z'
    if (!kind && SEVEN_EXTS.has(ext)) {
        kind = '7z'
        if (latin.decode(u8.subarray(0, 4)) === 'LZIP') { u8 = lzipToLzma(u8); sevenName = 'lzma' }
        else sevenName = ext === 'tlz' ? 'lzma' : ext === 'lha' ? 'lzh' : ext
    }
    if (kind === 'zip') return openZip(buf)
    if (kind === 'tar') return openTarBytes(u8)
    if (kind === 'rar') {
        const { createExtractorFromData, wasmBinary } = await ctx.loadLib('unrar')
        const ex = await createExtractorFromData({ data: buf, wasmBinary })
        const list = [...ex.getFileList().fileHeaders]
        return {
            entries: list.map(h => ({ name: h.name, dir: h.flags.directory, size: h.unpSize, date: h.time ? new Date(h.time) : null })),
            getBytes: async n => { const e2 = await createExtractorFromData({ data: buf, wasmBinary }); for (const f of e2.extract({ files: [n] }).files) return f.extraction; throw new ReaderError('Не удалось распаковать ' + n) },
        }
    }
    if (kind === '7z') return open7z(ctx, [{ name: 'a.' + sevenName, u8 }], 'a.' + sevenName, fileName, sevenName)
    throw new ReaderError('Неизвестный или повреждённый архив.')
}

const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'json', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'py', 'csv', 'tsv', 'log', 'ini', 'cfg', 'conf', 'yaml', 'yml', 'toml', 'nfo', 'diz', 'srt', 'vtt', 'sql', 'sh', 'bat', 'c', 'h', 'cpp', 'java', 'rs', 'go', 'php', 'rb', 'svg', 'tex', 'rst', 'org', 'adoc', 'fb2', 'lrc', 'po', 'mf', 'pom', 'gradle', 'properties', 'plist', 'desktop', 'service'])

// кнопка «Открыть читалкой» поверх любого предпросмотра
export const archivePreview = async (arc, entry) => {
    const box = await previewInner(arc, entry)
    const ext = extOf(entry.name)
    if (bytesOpener.fn && FORMAT_BY_EXT.has(ext) && !['txt', 'md'].includes(ext)) {
        const b = document.createElement('button'); b.className = 'mod-cta ur-nosearch ur-open-inner'; b.textContent = 'Открыть читалкой'
        b.onclick = async () => { try { bytesOpener.fn(await arc.getBytes(entry.name), entry.name.split('/').pop()) } catch (e) { b.textContent = 'Не удалось: ' + (e?.message || e) } }
        box.prepend(b)
    }
    return box
}
const previewInner = async (arc, entry) => {
    const box = document.createElement('div')
    box.className = 'ur-arc-preview'
    let bytes
    try { bytes = await arc.getBytes(entry.name) } catch (e) { box.textContent = 'Не удалось распаковать: ' + (e?.message || e); return box }
    const ext = extOf(entry.name)
    if (isImageName(entry.name)) {
        const img = document.createElement('img')
        img.src = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] || '' }))
        box.append(img)
        return box
    }
    const head = bytes.subarray(0, 4000)
    const looksText = TEXT_EXTS.has(ext) || !head.includes(0)
    if (looksText) {
        const pre = document.createElement('pre')
        pre.className = 'ur-plain-code'
        const text = decodeText(bytes.subarray(0, 2_000_000))
        pre.textContent = text + (bytes.length > 2_000_000 ? '\n\n… (показаны первые 2 МБ)' : '')
        box.append(pre)
        return box
    }
    box.innerHTML = `<p class="ur-muted">Предпросмотр для этого типа файла недоступен (${esc(fmtSize(bytes.length))}).</p>`
    return box
}

export const archiveList = (arc, onOpen) => {
    const wrap = document.createElement('div')
    const files = arc.entries.filter(e => !e.dir).sort((a, b) => naturalCompare(a.name, b.name))
    const total = files.reduce((s, e) => s + (e.size || 0), 0)
    wrap.innerHTML = (arc.info || '') + `<div class="ur-meta">Файлов: ${files.length}${total ? ` · ${fmtSize(total)} в распакованном виде` : ''}. Нажмите на файл, чтобы посмотреть его.</div>`
    const table = document.createElement('table')
    table.className = 'ur-arc-table'
    table.innerHTML = '<thead><tr><th>Имя</th><th>Размер</th><th>Изменён</th></tr></thead>'
    const tbody = document.createElement('tbody')
    for (const e of files.slice(0, 20000)) {
        const tr = document.createElement('tr')
        const slash = e.name.lastIndexOf('/')
        const dir = slash >= 0 ? e.name.slice(0, slash + 1) : ''
        const base = e.name.slice(slash + 1)
        const d = e.date instanceof Date && !isNaN(e.date) ? e.date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : ''
        tr.innerHTML = `<td>${isImageName(e.name) ? '🖼' : '📄'} <span class="ur-muted">${esc(dir)}</span>${esc(base)}</td><td>${esc(fmtSize(e.size))}</td><td>${esc(d)}</td>`
        tr.onclick = () => onOpen(e)
        tbody.append(tr)
    }
    table.append(tbody)
    wrap.append(table)
    return wrap
}

// 7-Zip: сначала только список (l -slt), файлы распаковываются по запросу — так меньше памяти на образах дисков
export const open7z = async (ctx, files, first, fileName = '', sevenName = '') => {
    const { SevenZip, wasmBinary } = await ctx.loadLib('sevenzip')
    const out = []
    const sz = await SevenZip({ wasmBinary, print: l => out.push(l), printErr: () => {} })
    sz.FS.mkdir('/in')
    const base = n => n.split('/').pop()
    for (const f of files) sz.FS.writeFile('/in/' + base(f.name), f.u8)
    first = base(first)
    sz.callMain(['l', '-slt', '/in/' + first])
    const entries = []
    let cur = null
    const sep = out.lastIndexOf('----------')
    for (const l of sep >= 0 ? out.slice(sep + 1) : out) {
        const m = /^(Path|Size|Folder|Modified|Attributes) = (.*)$/.exec(l)
        if (!m) { if (!l.trim() && cur) { entries.push(cur); cur = null } continue }
        if (m[1] === 'Path') { if (cur) entries.push(cur); cur = { name: m[2] } }
        else if (!cur) continue
        else if (m[1] === 'Size') cur.size = +m[2]
        else if (m[1] === 'Folder') cur.dir = m[2] === '+'
        else if (m[1] === 'Attributes' && /^D/.test(m[2])) cur.dir = true
        else if (m[1] === 'Modified' && m[2]) cur.date = new Date(m[2].replace(' ', 'T'))
    }
    if (cur) entries.push(cur)
    // первая запись — сам архив (Path = /in/…), её пропускаем
    const list = entries.filter(e => !e.name.startsWith('/in/')).map(e => ({ ...e, name: e.dir ? e.name.replace(/\/?$/, '/') : e.name }))
    if (!list.length) throw new ReaderError('Не удалось прочитать архив или образ (повреждён, зашифрован или формат не поддерживается).')
    const getBytes = async n => {
        try { sz.FS.mkdir('/out') } catch { /* уже есть */ }
        sz.callMain(['x', '/in/' + first, '-o/out', '-y', n])
        try { const d = sz.FS.readFile('/out/' + n); sz.FS.unlink('/out/' + n); return d } catch { throw new ReaderError('Не удалось распаковать ' + n) }
    }
    // LZMA и lzip сжимают один файл; внутри часто tar
    if (sevenName === 'lzma' && list.length === 1) {
        const inner = await getBytes(list[0].name)
        if (isTar(inner)) return openTarBytes(inner)
        const name = fileName.replace(/\.(lzma|lz|tlz)$/i, '').replace(/\.t$/i, '.tar') || 'файл'
        return { entries: [{ name, size: inner.length }], getBytes: async () => inner, single: true }
    }
    return { entries: list, getBytes }
}
