// Функции версии 0.6: «Сведения о файле» (EXIF и GPS на карте, теги музыки и обложки, длительность и кодеки,
// свойства документов Office, PDF и EPUB, контрольные суммы), мягкий режим при ошибке (строки и байты),
// «Скопировать как Markdown», сравнение двух файлов, открытие файла из архива или вложения письма читалкой
import JSZip from 'jszip'
import { escapeHtml as esc, decodeText } from './util.js'
import { sniffBytes } from './formats/sniff.js'
import { md5 } from './formats/compress.js'
import { parseMp4Book } from './formats/media3.js'

const latin = new TextDecoder('latin1')
const utf8 = new TextDecoder()
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e }
export const fmtSize = n => n < 1024 ? `${n} Б` : n < 1048576 ? `${(n / 1024).toFixed(1)} КБ` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} МБ` : `${(n / 1073741824).toFixed(2)} ГБ`
const fmtDur = s => { s = Math.round(s); return `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ' ч ' : ''}${Math.floor(s % 3600 / 60)} мин ${s % 60} с` }
const table = rows => `<table class="ur-table ur-sci-info"><tbody>${rows.filter(r => r[1] !== '' && r[1] != null).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="ur-break">${esc(String(v))}</td></tr>`).join('')}</tbody></table>`

// ================= Извлечение текстовых строк (как strings) =================
export const extractStrings = (u8, min = 5, max = 3000) => {
    const out = []
    const t = latin.decode(u8.length > 32e6 ? u8.subarray(0, 32e6) : u8)
    for (const m of t.matchAll(new RegExp(`[\\x20-\\x7e\\t]{${min},}`, 'g'))) { out.push(m[0]); if (out.length >= max) break }
    // UTF-8 (в том числе кириллица)
    const u = utf8.decode(u8.length > 8e6 ? u8.subarray(0, 8e6) : u8)
    for (const m of u.matchAll(/[\p{L}\p{N}\p{P}\s]{6,}/gu)) { if (/[^\x00-\x7f]/.test(m[0]) && m[0].trim().length >= 6) out.push(m[0].trim()); if (out.length >= max * 2) break }
    // UTF-16 LE (частая кодировка внутри программ Windows)
    const w = new TextDecoder('utf-16le').decode(u8.subarray(0, Math.min(u8.length, 8e6) & ~1))
    for (const m of w.matchAll(/[\p{L}\p{N} .,:;!?\-_/\\()]{6,}/gu)) { out.push(m[0]); if (out.length >= max * 3) break }
    return [...new Set(out)]
}

// ================= Мягкий режим: что показать вместо ошибки =================
export const softFallback = async (file, readBinary, err, openHex) => {
    const wrap = el('div', 'ur-soft')
    wrap.append(el('div', 'ur-message is-error', esc('Не удалось открыть файл.\n\n' + (err?.message || err)).replace(/\n/g, '<br>')))
    let u8
    try { u8 = new Uint8Array(await readBinary()) } catch { return wrap }
    const real = sniffBytes(u8, file.name)
    const textish = !u8.subarray(0, 4000).includes(0)
    wrap.append(el('div', 'ur-soft-info', `<h3>Что удалось узнать</h3>${table([['Размер', fmtSize(u8.length)], ['Похоже на', real && real !== file.extension ? `.${real}` : ''], ['Содержимое', textish ? 'текст' : 'двоичные данные']])}`))
    const btns = el('div', 'ur-sci-controls ur-nosearch')
    const strBtn = el('button', '', textish ? 'Показать как текст' : 'Показать текстовые строки'), hexBtn = el('button', '', 'Показать байты')
    const out = el('div')
    strBtn.onclick = () => { const pre = el('pre', 'ur-plain-code'); pre.textContent = textish ? decodeText(u8.subarray(0, 2e6)) : extractStrings(u8).join('\n'); out.replaceChildren(pre) }
    hexBtn.onclick = () => openHex()
    btns.append(strBtn, hexBtn); wrap.append(btns, out)
    return wrap
}

// ================= Сведения о файле =================
const exif = u8 => {
    // найти блок TIFF: в JPEG — APP1 Exif, в PNG — eXIf, в WebP — EXIF, иначе файл сам TIFF (RAW)
    let t = -1
    if (u8[0] === 0xFF && u8[1] === 0xD8) { let p = 2; const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); while (p + 4 < u8.length && u8[p] === 0xFF) { const m = u8[p + 1], len = dv.getUint16(p + 2); if (m === 0xE1 && latin.decode(u8.subarray(p + 4, p + 10)) === 'Exif\0\0') { t = p + 10; break } if (m === 0xDA) break; p += 2 + len } }
    else if (u8[0] === 0x89 && u8[1] === 0x50) { const i = latin.decode(u8.subarray(0, Math.min(u8.length, 4e6))).indexOf('eXIf'); if (i > 0) t = i + 4 }
    else if (latin.decode(u8.subarray(8, 12)) === 'WEBP') { const i = latin.decode(u8.subarray(0, Math.min(u8.length, 4e6))).indexOf('EXIF'); if (i > 0) { t = i + 8; if (latin.decode(u8.subarray(t, t + 6)) === 'Exif\0\0') t += 6 } }
    else if ((u8[0] === 0x49 && u8[1] === 0x49) || (u8[0] === 0x4D && u8[1] === 0x4D)) t = 0
    else { const i = latin.decode(u8.subarray(0, Math.min(u8.length, 2e6))).indexOf('Exif\0\0'); if (i >= 0) t = i + 6 }
    if (t < 0 || t + 8 > u8.length) return null
    const dv = new DataView(u8.buffer, u8.byteOffset + t, u8.byteLength - t)
    const le = dv.getUint16(0) === 0x4949
    const tags = {}
    const val = (type, count, off) => {
        const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] ?? 1
        const o = size * count > 4 ? dv.getUint32(off, le) : off
        if (o + size * count > dv.byteLength) return null
        if (type === 2) return latin.decode(new Uint8Array(dv.buffer, dv.byteOffset + o, count)).replace(/\0.*$/s, '').trim()
        const one = i => type === 3 ? dv.getUint16(o + i * 2, le) : type === 4 ? dv.getUint32(o + i * 4, le) : type === 9 ? dv.getInt32(o + i * 4, le) : type === 5 ? dv.getUint32(o + i * 8, le) / (dv.getUint32(o + i * 8 + 4, le) || 1) : type === 10 ? dv.getInt32(o + i * 8, le) / (dv.getInt32(o + i * 8 + 4, le) || 1) : dv.getUint8(o + i)
        return count === 1 ? one(0) : Array.from({ length: Math.min(count, 16) }, (_, i) => one(i))
    }
    const ifd = (off, prefix = '') => {
        if (!off || off + 2 > dv.byteLength) return
        const n = dv.getUint16(off, le)
        for (let i = 0; i < n && off + 2 + i * 12 + 12 <= dv.byteLength; i++) { const e = off + 2 + i * 12; tags[prefix + dv.getUint16(e, le)] = val(dv.getUint16(e + 2, le), dv.getUint32(e + 4, le), e + 8) }
    }
    ifd(dv.getUint32(4, le))
    ifd(tags[0x8769], '')
    ifd(tags[0x8825], 'g')
    const dms = (v, ref) => Array.isArray(v) ? (v[0] + v[1] / 60 + v[2] / 3600) * (/[SW]/.test(ref) ? -1 : 1) : null
    const lat = dms(tags.g2, tags.g1), lon = dms(tags.g4, tags.g3)
    return {
        rows: [['Камера', [tags[0x10F], tags[0x110]].filter(Boolean).join(' ')], ['Объектив', tags[0xA434]], ['Снято', tags[0x9003] ?? tags[0x132]], ['Выдержка', tags[0x829A] ? (tags[0x829A] < 1 ? `1/${Math.round(1 / tags[0x829A])} с` : `${tags[0x829A]} с`) : ''], ['Диафрагма', tags[0x829D] ? `f/${(+tags[0x829D]).toFixed(1)}` : ''], ['ISO', tags[0x8827]], ['Фокусное расстояние', tags[0x920A] ? `${Math.round(tags[0x920A])} мм${tags[0xA405] ? ` (${tags[0xA405]} мм экв.)` : ''}` : ''], ['Вспышка', tags[0x9209] != null ? (tags[0x9209] & 1 ? 'сработала' : 'нет') : ''], ['Программа', tags[0x131]], ['Автор', tags[0x13B]], ['Права', tags[0x8298]], ['Размер кадра', tags[0xA002] ? `${tags[0xA002]}×${tags[0xA003]}` : ''], ['GPS', lat != null && lon != null ? `${lat.toFixed(6)}, ${lon.toFixed(6)}` : ''], ['Высота над морем', tags.g6 != null ? `${Math.round(tags.g6)} м` : '']],
        gps: lat != null && lon != null && !(lat === 0 && lon === 0) ? [lon, lat] : null,
    }
}
const synchsafe = (u8, o) => (u8[o] << 21) | (u8[o + 1] << 14) | (u8[o + 2] << 7) | u8[o + 3]
const id3 = u8 => {
    if (latin.decode(u8.subarray(0, 3)) !== 'ID3') return null
    const ver = u8[3], size = synchsafe(u8, 6)
    const tags = {}; let cover = null, lyrics = ''
    let p = 10
    if (u8[5] & 0x40) p += ver === 4 ? synchsafe(u8, 10) : (u8[10] << 24 | u8[11] << 16 | u8[12] << 8 | u8[13]) + 4
    const end = Math.min(u8.length, 10 + size)
    const txt = (b) => { const enc = b[0], d = b.subarray(1); return (enc === 1 ? new TextDecoder('utf-16') : enc === 2 ? new TextDecoder('utf-16be') : enc === 3 ? utf8 : new TextDecoder('windows-1251')).decode(d).replace(/\0+$/, '').replace(/\0/g, ' / ') }
    while (p + (ver === 2 ? 6 : 10) < end) {
        const id = latin.decode(u8.subarray(p, p + (ver === 2 ? 3 : 4)))
        if (!/^[A-Z0-9]{3,4}$/.test(id)) break
        const len = ver === 2 ? (u8[p + 3] << 16 | u8[p + 4] << 8 | u8[p + 5]) : ver === 4 ? synchsafe(u8, p + 4) : (u8[p + 4] << 24 | u8[p + 5] << 16 | u8[p + 6] << 8 | u8[p + 7]) >>> 0
        const d = u8.subarray(p + (ver === 2 ? 6 : 10), p + (ver === 2 ? 6 : 10) + len)
        const k = { TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TALB: 'album', TAL: 'album', TYER: 'year', TYE: 'year', TDRC: 'year', TCON: 'genre', TCO: 'genre', TRCK: 'track', TRK: 'track', TPE2: 'albumArtist', TCOM: 'composer', TCM: 'composer' }[id]
        if (k) tags[k] = txt(d)
        else if (id === 'APIC' || id === 'PIC') { let q = 1; let mime = 'image/jpeg'; if (id === 'APIC') { const z = d.indexOf(0, 1); mime = latin.decode(d.subarray(1, z)) || mime; q = z + 1 } else { mime = latin.decode(d.subarray(1, 4)) === 'PNG' ? 'image/png' : 'image/jpeg'; q = 4 } q++; const enc = d[0]; if (enc === 1 || enc === 2) { while (q + 1 < d.length && !(d[q] === 0 && d[q + 1] === 0)) q += 2; q += 2 } else { while (q < d.length && d[q] !== 0) q++; q++ } if (!cover) cover = { bytes: d.slice(q), type: mime } }
        else if (id === 'USLT' || id === 'ULT') { const enc = d[0]; let q = 4; if (enc === 1 || enc === 2) { while (q + 1 < d.length && !(d[q] === 0 && d[q + 1] === 0)) q += 2; q += 2 } else { while (q < d.length && d[q] !== 0) q++; q++ } lyrics = (enc === 1 ? new TextDecoder('utf-16') : enc === 2 ? new TextDecoder('utf-16be') : enc === 3 ? utf8 : new TextDecoder('windows-1251')).decode(d.subarray(q)) }
        p += (ver === 2 ? 6 : 10) + len
    }
    return { tags, cover, lyrics, end }
}
const vorbisComments = (u8, o) => { const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); const vl = dv.getUint32(o, true); let p = o + 4 + vl; const n = dv.getUint32(p, true); p += 4; const out = {}; for (let i = 0; i < n && p < u8.length; i++) { const l = dv.getUint32(p, true); const s = utf8.decode(u8.subarray(p + 4, p + 4 + l)); const k = s.indexOf('='); out[s.slice(0, k).toUpperCase()] = s.slice(k + 1); p += 4 + l } return out }
const flacPicture = u8 => { const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let p = 4; const ml = dv.getUint32(p); const mime = latin.decode(u8.subarray(p + 4, p + 4 + ml)); p += 4 + ml; const dl = dv.getUint32(p); p += 4 + dl + 16; const len = dv.getUint32(p); return { bytes: u8.slice(p + 4, p + 4 + len), type: mime } }
const audioInfo = u8 => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    let tags = {}, cover = null, lyrics = '', rows = []
    const real = sniffBytes(u8)
    if (real === 'mp3' || latin.decode(u8.subarray(0, 3)) === 'ID3') {
        const t = id3(u8); let p = 0
        if (t) { tags = t.tags; cover = t.cover; lyrics = t.lyrics; p = t.end }
        while (p + 4 < u8.length && !(u8[p] === 0xFF && (u8[p + 1] & 0xE0) === 0xE0)) p++
        if (p + 4 < u8.length) {
            const h = dv.getUint32(p), ver = (h >> 19) & 3, br = (h >> 12) & 15, sr = (h >> 10) & 3, ch = (h >> 6) & 3
            const BR = ver === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
            const SR = [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]][ver]?.[sr]
            const xing = latin.decode(u8.subarray(p, p + 200)).search(/Xing|Info/)
            let dur = BR[br] ? (u8.length - p) * 8 / (BR[br] * 1000) : 0
            if (xing > 0 && dv.getUint32(p + xing + 4) & 1) { const frames = dv.getUint32(p + xing + 8); dur = frames * (ver === 3 ? 1152 : 576) / (SR || 44100) }
            rows.push(['Звук', `MP3, ${BR[br]} кбит/с${xing > 0 ? ' (переменный)' : ''}, ${SR} Гц, ${ch === 3 ? 'моно' : 'стерео'}`], ['Длительность', dur ? fmtDur(dur) : ''])
        }
    } else if (real === 'flac') {
        let p = 4
        for (;;) { const hdr = u8[p], type = hdr & 0x7F, len = u8[p + 1] << 16 | u8[p + 2] << 8 | u8[p + 3], d = p + 4
            if (type === 0) { const sr = (u8[d + 10] << 12 | u8[d + 11] << 4 | u8[d + 12] >> 4), chn = ((u8[d + 12] >> 1) & 7) + 1, bps = (((u8[d + 12] & 1) << 4) | u8[d + 13] >> 4) + 1; const total = (u8[d + 13] & 15) * 2 ** 32 + dv.getUint32(d + 14); rows.push(['Звук', `FLAC, ${bps} бит, ${sr} Гц, каналов: ${chn}`], ['Длительность', total ? fmtDur(total / sr) : '']) }
            else if (type === 4) { const c = vorbisComments(u8, d); tags = { title: c.TITLE, artist: c.ARTIST, album: c.ALBUM, year: c.DATE, genre: c.GENRE, track: c.TRACKNUMBER }; lyrics = c.LYRICS ?? c.UNSYNCEDLYRICS ?? '' }
            else if (type === 6 && !cover) cover = flacPicture(u8.subarray(d, d + len))
            p = d + len; if (hdr & 0x80 || p >= u8.length) break }
    } else if (real === 'ogg') {
        const t = latin.decode(u8.subarray(0, Math.min(u8.length, 2e6)))
        const vi = t.indexOf('\x03vorbis'), oi = t.indexOf('OpusTags')
        const c = vi >= 0 ? vorbisComments(u8, vi + 7) : oi >= 0 ? vorbisComments(u8, oi + 8) : {}
        tags = { title: c.TITLE, artist: c.ARTIST, album: c.ALBUM, year: c.DATE, genre: c.GENRE }; lyrics = c.LYRICS ?? ''
        if (c.METADATA_BLOCK_PICTURE) { try { const b = Uint8Array.from(atob(c.METADATA_BLOCK_PICTURE), x => x.charCodeAt(0)); cover = flacPicture(b) } catch { /* без обложки */ } }
        rows.push(['Звук', oi >= 0 ? 'Opus' : 'Vorbis'])
    } else if (real === 'm4a' || real === 'mp4' || /^ftyp/.test(latin.decode(u8.subarray(4, 8)))) {
        try { const b = parseMp4Book(u8); tags = b.tag; cover = b.tag.cover; if (b.chapters.length) rows.push(['Главы', b.chapters.length]) } catch { /* нет тегов */ }
        rows.push(...mp4Tech(u8))
    } else if (real === 'wav') {
        let p = 12; while (p + 8 < u8.length) { const id = latin.decode(u8.subarray(p, p + 4)), len = dv.getUint32(p + 4, true); if (id === 'fmt ') { const ch = dv.getUint16(p + 10, true), sr = dv.getUint32(p + 12, true), byteRate = dv.getUint32(p + 16, true), bits = dv.getUint16(p + 22, true); rows.push(['Звук', `WAV, ${bits} бит, ${sr} Гц, каналов: ${ch}`]); rows.byteRate = byteRate } if (id === 'data' && rows.byteRate) rows.push(['Длительность', fmtDur(len / rows.byteRate)]); p += 8 + len + (len & 1) } }
    return { rows: [['Название', tags.title], ['Исполнитель', tags.artist], ['Альбом', tags.album], ['Год', tags.year], ['Жанр', tags.genre], ['Номер', tags.track], ...rows], cover, lyrics }
}
const mp4Tech = u8 => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    const atomsIn = (s, e) => { const out = []; let p = s; while (p + 8 <= e) { let sz = dv.getUint32(p); const t = latin.decode(u8.subarray(p + 4, p + 8)); let h = 8; if (sz === 1) { sz = Number(dv.getBigUint64(p + 8)); h = 16 } else if (sz === 0) sz = e - p; if (sz < h) break; out.push({ t, s: p + h, e: p + sz }); p += sz } return out }
    const moov = atomsIn(0, u8.length).find(a => a.t === 'moov'); if (!moov) return []
    const kids = atomsIn(moov.s, moov.e)
    const rows = []
    const mvhd = kids.find(a => a.t === 'mvhd'); if (mvhd) { const v = u8[mvhd.s]; const ts = v === 1 ? dv.getUint32(mvhd.s + 20) : dv.getUint32(mvhd.s + 12); const du = v === 1 ? Number(dv.getBigUint64(mvhd.s + 24)) : dv.getUint32(mvhd.s + 16); if (ts) rows.push(['Длительность', fmtDur(du / ts)]) }
    for (const tr of kids.filter(a => a.t === 'trak')) {
        const tk = atomsIn(tr.s, tr.e)
        const tkhd = tk.find(a => a.t === 'tkhd'); const mdia = tk.find(a => a.t === 'mdia'); if (!mdia) continue
        const ml = atomsIn(mdia.s, mdia.e); const hdlr = ml.find(a => a.t === 'hdlr'); const kind = hdlr ? latin.decode(u8.subarray(hdlr.s + 8, hdlr.s + 12)) : ''
        const minf = ml.find(a => a.t === 'minf'); const stbl = minf && atomsIn(minf.s, minf.e).find(a => a.t === 'stbl'); const stsd = stbl && atomsIn(stbl.s, stbl.e).find(a => a.t === 'stsd')
        const codec = stsd ? latin.decode(u8.subarray(stsd.s + 12, stsd.s + 16)) : ''
        const NAMES = { avc1: 'H.264', avc3: 'H.264', hvc1: 'H.265 (HEVC)', hev1: 'H.265 (HEVC)', av01: 'AV1', vp09: 'VP9', mp4v: 'MPEG-4', mp4a: 'AAC', ac_3: 'AC-3', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', alac: 'Apple Lossless', Opus: 'Opus', fLaC: 'FLAC', 'tx3g': 'субтитры', text: 'текст', apcn: 'ProRes', apch: 'ProRes HQ' }
        if (kind === 'vide' && tkhd) { const v = u8[tkhd.s]; const o = tkhd.s + (v === 1 ? 88 : 76); rows.push(['Видео', `${NAMES[codec] ?? codec}, ${dv.getUint32(o) >> 16}×${dv.getUint32(o + 4) >> 16}`]) }
        else if (kind === 'soun' && stsd) rows.push(['Звук', `${NAMES[codec] ?? codec}, ${dv.getUint16(stsd.s + 8 + 8 + 16)} кан., ${dv.getUint32(stsd.s + 8 + 8 + 24) >>> 16} Гц`])
        else if (kind === 'sbtl' || kind === 'text' || kind === 'subt') rows.push(['Субтитры', NAMES[codec] ?? codec])
    }
    return rows
}
const officeInfo = async u8 => {
    const zip = await JSZip.loadAsync(u8)
    const rows = []
    const core = await zip.file('docProps/core.xml')?.async('string')
    const app = await zip.file('docProps/app.xml')?.async('string')
    const meta = await zip.file('meta.xml')?.async('string')
    const g = (x, tag) => x && new RegExp(`<(?:\\w+:)?${tag}[^>]*>([^<]*)<`).exec(x)?.[1]
    const d = s => s ? new Date(s).toLocaleString('ru-RU') : ''
    if (core) rows.push(['Заголовок', g(core, 'title')], ['Тема', g(core, 'subject')], ['Автор', g(core, 'creator')], ['Последним изменил', g(core, 'lastModifiedBy')], ['Создан', d(g(core, 'created'))], ['Изменён', d(g(core, 'modified'))], ['Ключевые слова', g(core, 'keywords')], ['Описание', g(core, 'description')], ['Редакция', g(core, 'revision')])
    if (app) rows.push(['Программа', g(app, 'Application')], ['Страниц', g(app, 'Pages')], ['Слов', g(app, 'Words')], ['Слайдов', g(app, 'Slides')], ['Компания', g(app, 'Company')], ['Время правки', g(app, 'TotalTime') ? `${g(app, 'TotalTime')} мин` : ''])
    if (meta) { const st = /<meta:document-statistic([^>]*)>/.exec(meta)?.[1] ?? ''; rows.push(['Заголовок', g(meta, 'title')], ['Автор', g(meta, 'initial-creator') ?? g(meta, 'creator')], ['Создан', d(g(meta, 'creation-date'))], ['Изменён', d(g(meta, 'date'))], ['Программа', g(meta, 'generator')], ['Страниц', /meta:page-count="(\d+)"/.exec(st)?.[1]], ['Слов', /meta:word-count="(\d+)"/.exec(st)?.[1]]) }
    const container = await zip.file('META-INF/container.xml')?.async('string')
    if (container) {
        const opfPath = /full-path="([^"]+)"/.exec(container)?.[1]; const opf = opfPath && await zip.file(opfPath)?.async('string')
        if (opf) rows.push(['Название', g(opf, 'title')], ['Автор', g(opf, 'creator')], ['Язык', g(opf, 'language')], ['Издательство', g(opf, 'publisher')], ['Дата', g(opf, 'date')], ['ISBN', /<dc:identifier[^>]*>(?:urn:isbn:)?([\d-X]{10,17})</i.exec(opf)?.[1]], ['Описание', g(opf, 'description')?.replace(/&lt;[^&]*&gt;/g, '').slice(0, 300)])
    }
    return rows
}
const pdfInfo = u8 => {
    const t = latin.decode(u8.length > 64e6 ? u8.subarray(0, 64e6) : u8)
    const str = k => {
        const all = [...t.matchAll(new RegExp(`/${k}\\s*(\\((?:\\\\.|[^\\\\)])*\\)|<[0-9A-Fa-f\\s]+>)`, 'g'))]
        const m = all[all.length - 1]?.[1]; if (!m) return ''
        if (m[0] === '<') { const h = m.slice(1, -1).replace(/\s/g, ''); const b = Uint8Array.from(h.match(/../g) ?? [], x => parseInt(x, 16)); return b[0] === 0xFE && b[1] === 0xFF ? new TextDecoder('utf-16be').decode(b.subarray(2)) : latin.decode(b) }
        let s = m.slice(1, -1).replace(/\\([nrtbf()\\])/g, (x, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[c] ?? c).replace(/\\(\d{1,3})/g, (x, o) => String.fromCharCode(parseInt(o, 8)))
        if (s.charCodeAt(0) === 0xFE && s.charCodeAt(1) === 0xFF) { const b = Uint8Array.from(s.slice(2), c => c.charCodeAt(0)); s = new TextDecoder('utf-16be').decode(b) }
        return s
    }
    const date = s => { const m = /D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s); return m ? `${m[3] ?? '01'}.${m[2] ?? '01'}.${m[1]}${m[4] ? ` ${m[4]}:${m[5] ?? '00'}` : ''}` : s }
    const xmp = (k) => new RegExp(`<${k}>(?:\\s*<rdf:\\w+>\\s*<rdf:li[^>]*>)?([^<]+)`).exec(t)?.[1]
    const pages = [...t.matchAll(/\/Type\s*\/Page(?![a-zA-Z])/g)].length || +(/\/Count\s+(\d+)/.exec(t)?.[1] ?? 0)
    return [['Версия PDF', /%PDF-(\d\.\d)/.exec(t)?.[1]], ['Заголовок', str('Title') || xmp('dc:title')], ['Автор', str('Author') || xmp('dc:creator')], ['Тема', str('Subject')], ['Ключевые слова', str('Keywords')], ['Создан в', str('Creator') || xmp('xmp:CreatorTool')], ['Сохранён программой', str('Producer') || xmp('pdf:Producer')], ['Создан', date(str('CreationDate'))], ['Изменён', date(str('ModDate'))], ['Страниц', pages || ''], ['Зашифрован', /\/Encrypt\s/.test(t) ? 'да' : ''], ['Есть формы', /\/AcroForm/.test(t) ? 'да' : ''], ['Подписан', /\/Sig\b|\/ByteRange/.test(t) ? 'да' : '']]
}
const imgSize = (u8, real) => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    if (real === 'png') return `${dv.getUint32(16)}×${dv.getUint32(20)}`
    if (real === 'gif') return `${dv.getUint16(6, true)}×${dv.getUint16(8, true)}`
    if (real === 'bmp') return `${dv.getInt32(18, true)}×${Math.abs(dv.getInt32(22, true))}`
    if (real === 'jpg') { let p = 2; while (p + 9 < u8.length && u8[p] === 0xFF) { const m = u8[p + 1]; if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return `${dv.getUint16(p + 7)}×${dv.getUint16(p + 5)}`; p += 2 + dv.getUint16(p + 2) } }
    if (real === 'webp') { const c = latin.decode(u8.subarray(12, 16)); if (c === 'VP8X') return `${1 + (u8[24] | u8[25] << 8 | u8[26] << 16)}×${1 + (u8[27] | u8[28] << 8 | u8[29] << 16)}`; if (c === 'VP8 ') return `${dv.getUint16(26, true) & 0x3FFF}×${dv.getUint16(28, true) & 0x3FFF}`; if (c === 'VP8L') { const b = dv.getUint32(21, true); return `${(b & 0x3FFF) + 1}×${((b >> 14) & 0x3FFF) + 1}` } }
    return ''
}
const KIND_RU = { pdf: 'документ PDF', png: 'картинка PNG', jpg: 'фото JPEG', gif: 'картинка GIF', webp: 'картинка WebP', bmp: 'картинка BMP', wav: 'звук WAV', mp3: 'звук MP3', flac: 'звук FLAC', ogg: 'звук Ogg', m4a: 'звук M4A', mp4: 'видео MP4', mkv: 'видео Matroska', webm: 'видео WebM', zip: 'архив ZIP', rar: 'архив RAR', '7z': 'архив 7-Zip', gz: 'сжатый gzip', tar: 'архив tar', sqlite: 'база SQLite', exe: 'программа Windows', epub: 'книга EPUB', docx: 'документ Word', xlsx: 'таблица Excel', pptx: 'презентация PowerPoint', odt: 'документ OpenDocument', ods: 'таблица OpenDocument', odp: 'презентация OpenDocument' }
export const buildFileInfo = async ({ file, bytes, mapView, ctx, onCompare }) => {
    const u8 = new Uint8Array(bytes)
    const real = sniffBytes(u8, file.name)
    const wrap = el('div', 'ur-fileinfo')
    const st = file.stat ?? {}
    wrap.append(el('div', '', `<h2>${esc(file.name)}</h2>${table([['Папка', file.parent?.path && file.parent.path !== '/' ? file.parent.path : 'корень хранилища'], ['Размер', `${fmtSize(u8.length)}${u8.length >= 1024 ? ` (${u8.length.toLocaleString('ru-RU')} байт)` : ''}`], ['Создан', st.ctime ? new Date(st.ctime).toLocaleString('ru-RU') : ''], ['Изменён', st.mtime ? new Date(st.mtime).toLocaleString('ru-RU') : ''], ['На самом деле', real ? `${KIND_RU[real] ?? '.' + real}${real !== file.extension.toLowerCase() && !(real === 'jpg' && /jpe?g/i.test(file.extension)) ? ' (расширение не совпадает!)' : ''}` : (u8.subarray(0, 4000).includes(0) ? 'двоичные данные' : 'текст')]])}`))
    const sections = []
    try {
        if (['jpg', 'png', 'webp', 'gif', 'bmp'].includes(real) || /^(tiff?|dng|cr2|nef|arw|orf|rw2|raf|pef|srw|heic|heif)$/i.test(file.extension)) {
            const size = imgSize(u8, real); const e = exif(u8)
            sections.push(['Картинка', [['Размер в точках', size], ...(e?.rows ?? [])]])
            if (e?.gps && mapView) { const m = el('div', 'ur-fileinfo-map'); try { m.append(await mapView(ctx, { feats: [{ kind: 'point', coords: [e.gps], name: 'Где снято' }], title: '' })) } catch { /* без карты */ } sections.push(['Где снято', null, m]) }
        } else if (['mp3', 'flac', 'ogg', 'm4a', 'wav'].includes(real) || (real === 'mp4' && /^(m4a|m4b|aac|mp4|m4v|mov)$/i.test(file.extension)) || /^(mp3|flac|ogg|oga|opus|m4a|wav)$/i.test(file.extension)) {
            const a = audioInfo(u8)
            const extra = el('div')
            if (a.cover) { const im = el('img', 'ur-fileinfo-cover'); const url = URL.createObjectURL(new Blob([a.cover.bytes], { type: a.cover.type })); ctx?.urls?.push(url); im.src = url; extra.append(im) }
            if (a.lyrics) extra.append(el('details', '', `<summary>Текст песни</summary><div class="ur-mail-text">${esc(a.lyrics).replace(/\n/g, '<br>')}</div>`))
            sections.push([real === 'mp4' ? 'Видео и звук' : 'Звук', a.rows, extra])
        } else if (real === 'mp4' || /^(mov|mp4|m4v|3gp)$/i.test(file.extension)) sections.push(['Видео', mp4Tech(u8)])
        else if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub'].includes(real)) sections.push(['Свойства документа', await officeInfo(u8)])
        else if (real === 'pdf') sections.push(['Свойства PDF', pdfInfo(u8)])
    } catch (e) { sections.push(['Подробности', [['Не удалось прочитать', e.message]]]) }
    for (const [title, rows, extra] of sections) { const s = el('section', '', `<h3>${esc(title)}</h3>${rows ? table(rows) : ''}`); if (extra) s.append(extra); wrap.append(s) }
    // контрольные суммы — по кнопке (большие файлы считаются долго)
    const sums = el('section', '', '<h3>Контрольные суммы</h3>')
    const btn = el('button', '', 'Посчитать MD5, SHA-1, SHA-256')
    btn.onclick = async () => { btn.disabled = true; btn.textContent = 'Считаю…'; const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); const rows = [['MD5', md5(u8)], ['SHA-1', hex(await crypto.subtle.digest('SHA-1', u8))], ['SHA-256', hex(await crypto.subtle.digest('SHA-256', u8))]]; btn.replaceWith(el('div', '', table(rows))) }
    sums.append(btn); wrap.append(sums)
    if (onCompare) { const c = el('button', '', 'Сравнить с другим файлом…'); c.onclick = onCompare; wrap.append(el('p'), c) }
    return wrap
}

// ================= Сравнение двух файлов =================
// алгоритм Майерса по строкам → единый формат diff (его показывает уже готовый просмотр .diff)
export const lineDiff = (a, b, nameA, nameB) => {
    const A = a.split(/\r?\n/), B = b.split(/\r?\n/)
    const N = A.length, M = B.length, max = N + M
    if (max > 40000) return null
    const V = new Int32Array(2 * max + 2), trace = []
    let found = false
    for (let d = 0; d <= max && !found; d++) {
        trace.push(V.slice())
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && V[max + k - 1] < V[max + k + 1]) ? V[max + k + 1] : V[max + k - 1] + 1
            let y = x - k
            while (x < N && y < M && A[x] === B[y]) { x++; y++ }
            V[max + k] = x
            if (x >= N && y >= M) { found = true; break }
        }
        if (trace.length > 4000) return null
    }
    // обратный проход — список операций
    const ops = []
    let x = N, y = M
    for (let d = trace.length - 1; d > 0; d--) {
        const Vd = trace[d], k = x - y
        const prevK = k === -d || (k !== d && Vd[max + k - 1] < Vd[max + k + 1]) ? k + 1 : k - 1
        const px = Vd[max + prevK], py = px - prevK
        while (x > px && y > py) { ops.push([' ', A[x - 1]]); x--; y-- }
        if (x === px) ops.push(['+', B[y - 1]]); else ops.push(['-', A[x - 1]])
        x = px; y = py
    }
    while (x > 0 && y > 0) { ops.push([' ', A[x - 1]]); x--; y-- }
    ops.reverse()
    // собираем куски с контекстом в 3 строки
    let out = `--- ${nameA}\n+++ ${nameB}\n`, i = 0, ai = 0, bi = 0
    if (!ops.some(o => o[0] !== ' ')) return ''
    while (i < ops.length) {
        while (i < ops.length && ops[i][0] === ' ') { i++; ai++; bi++ }
        if (i >= ops.length) break
        const start = Math.max(0, i - 3); let j = i, last = i
        while (j < ops.length && j - last <= 6) { if (ops[j][0] !== ' ') last = j; j++ }
        const end = Math.min(ops.length, last + 4)
        let sa = ai - (i - start), sb = bi - (i - start), ca = 0, cb = 0, body = ''
        for (let k = start; k < end; k++) { const [t, l] = ops[k]; body += t + l + '\n'; if (t !== '+') ca++; if (t !== '-') cb++ }
        out += `@@ -${sa + 1},${ca} +${sb + 1},${cb} @@\n${body}`
        for (let k = i; k < end; k++) { if (ops[k][0] !== '+') ai++; if (ops[k][0] !== '-') bi++ }
        i = end
    }
    return out
}
export const binaryCompare = (a, b) => {
    const n = Math.min(a.length, b.length); let first = -1, diff = 0
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) { if (first < 0) first = i; diff++ }
    diff += Math.abs(a.length - b.length)
    return { same: diff === 0, first: first < 0 && a.length !== b.length ? n : first, diff }
}

// ================= Markdown из таблицы и из страницы =================
export const tableToMarkdown = rows => {
    if (!rows?.length) return ''
    const w = Math.max(...rows.map(r => r.length))
    const cell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim()
    const lines = rows.map(r => `| ${Array.from({ length: w }, (_, i) => cell(r[i])).join(' | ')} |`)
    lines.splice(1, 0, `| ${Array(w).fill('---').join(' | ')} |`)
    return lines.join('\n')
}
export const htmlToMarkdown = root => {
    const walk = (n, ctx2 = {}) => {
        if (n.nodeType === 3) return n.textContent.replace(/\s+/g, ' ')
        if (n.nodeType !== 1) return ''
        if (n.classList?.contains('ur-nosearch') || /^(script|style|button|select|input|canvas|svg|audio|video)$/i.test(n.tagName)) return ''
        const kids = () => [...n.childNodes].map(c => walk(c, ctx2)).join('')
        switch (n.tagName.toLowerCase()) {
            case 'h1': return `\n\n# ${kids().trim()}\n\n`
            case 'h2': return `\n\n## ${kids().trim()}\n\n`
            case 'h3': return `\n\n### ${kids().trim()}\n\n`
            case 'h4': case 'h5': case 'h6': return `\n\n#### ${kids().trim()}\n\n`
            case 'p': case 'div': case 'section': case 'article': case 'figure': return `\n\n${kids().trim()}\n\n`
            case 'br': return '  \n'
            case 'b': case 'strong': { const t = kids().trim(); return t ? `**${t}**` : '' }
            case 'i': case 'em': { const t = kids().trim(); return t ? `*${t}*` : '' }
            case 'code': return '`' + n.textContent + '`'
            case 'pre': return '\n\n```\n' + n.textContent.replace(/\n$/, '') + '\n```\n\n'
            case 'a': { const t = kids().trim(), h = n.getAttribute('href'); return h && /^(https?|mailto):/.test(h) ? `[${t}](${h})` : t }
            case 'img': { const s = n.getAttribute('src') ?? ''; return /^https?:/.test(s) ? `![${n.getAttribute('alt') ?? ''}](${s})` : '' }
            case 'blockquote': return '\n\n' + kids().trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n'
            case 'ul': case 'ol': { let i = 0; return '\n\n' + [...n.children].filter(c => /^li$/i.test(c.tagName)).map(li => `${/^ol$/i.test(n.tagName) ? `${++i}.` : '-'} ${walk(li).trim().replace(/\n+/g, ' ')}`).join('\n') + '\n\n' }
            case 'li': return kids()
            case 'table': { const rows = [...n.querySelectorAll('tr')].map(tr => [...tr.children].map(td => walk(td).trim())); return '\n\n' + tableToMarkdown(rows) + '\n\n' }
            case 'details': return kids()
            case 'summary': return `\n\n**${kids().trim()}**\n\n`
            case 'hr': return '\n\n---\n\n'
            default: return kids()
        }
    }
    return walk(root).replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim()
}
