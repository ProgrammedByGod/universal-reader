// Звук и видео версии 0.6: аудиокниги .m4b с главами, AIFF, CAF, Matroska-звук, DSD (.dsf, .dff), проекты Ableton (.als),
// трекерная музыка и музыка приставок (сведения), FLV и MPEG-TS (через mpegts.js), субтитры-картинки (VobSub, PGS), SCC
import { escapeHtml as esc, ReaderError } from '../util.js'
import { gunzip } from './compress.js'

const latin = new TextDecoder('latin1')
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e }
const fmtT = s => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60); return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(sec).padStart(2, '0')}` }
const blobUrl = (ctx, bytes, type) => { const u = URL.createObjectURL(new Blob([bytes], { type })); ctx.urls.push(u); return u }
const infoTable = rows => `<table class="ur-table ur-sci-info"><tbody>${rows.filter(r => r[1] !== '' && r[1] != null).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join('')}</tbody></table>`

// WAV из каналов Float32 (-1…1)
export const wavFrom = (channels, rate) => {
    const n = channels[0].length, ch = channels.length
    const buf = new ArrayBuffer(44 + n * ch * 2), dv = new DataView(buf)
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true)
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * ch * 2, true)
    let p = 44
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, channels[c][i])); dv.setInt16(p, v * 32767, true); p += 2 }
    return new Uint8Array(buf)
}
const player = (ctx, url, extra = '') => {
    const wrap = el('div', 'ur-media-wrap', extra)
    const a = document.createElement('audio'); a.controls = true; a.src = url; a.className = 'ur-media'; a.preload = 'metadata'
    const note = el('p', 'ur-muted', '')
    a.addEventListener('error', () => { note.textContent = 'Встроенный проигрыватель не смог воспроизвести этот звук.' })
    wrap.prepend(a); wrap.append(note)
    return { wrap, audio: a }
}

// ================= Аудиокниги .m4b: главы и обложка =================
const atoms = (u8, s, e) => { const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); const out = []; let p = s; while (p + 8 <= e) { let size = dv.getUint32(p); const type = latin.decode(u8.subarray(p + 4, p + 8)); let h = 8; if (size === 1) { size = Number(dv.getBigUint64(p + 8)); h = 16 } else if (size === 0) size = e - p; if (size < h) break; out.push({ type, s: p + h, e: p + size }); p += size } return out }
const find = (u8, list, path) => { let cur = list; let a = null; for (const t of path) { a = cur.find(x => x.type === t); if (!a) return null; cur = atoms(u8, a.s + (t === 'meta' ? 4 : 0), a.e) } return a }
export const parseMp4Book = u8 => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    const top = atoms(u8, 0, u8.length)
    const moov = top.find(a => a.type === 'moov'); if (!moov) throw new ReaderError('В аудиокниге нет описания (moov).')
    const mv = atoms(u8, moov.s, moov.e)
    const tag = {}, chapters = []
    const ilst = find(u8, mv, ['udta', 'meta', 'ilst'])
    if (ilst) for (const it of atoms(u8, ilst.s, ilst.e)) {
        const data = atoms(u8, it.s, it.e).find(a => a.type === 'data'); if (!data) continue
        const body = u8.subarray(data.s + 8, data.e)
        const k = { '\xA9nam': 'title', '\xA9ART': 'artist', '\xA9alb': 'album', '\xA9wrt': 'writer', '\xA9day': 'year', '\xA9cmt': 'comment', desc: 'desc', '\xA9nrt': 'narrator', aART: 'albumArtist' }[it.type]
        if (k) tag[k] = new TextDecoder().decode(body)
        if (it.type === 'covr') tag.cover = { bytes: body, type: body[0] === 0x89 ? 'image/png' : 'image/jpeg' }
    }
    // главы Nero (chpl)
    const chpl = find(u8, mv, ['udta', 'chpl'])
    if (chpl) { const v = u8[chpl.s]; let p = chpl.s + (v ? 9 : 5); const n = v ? u8[chpl.s + 8] : u8[chpl.s + 4]; for (let i = 0; i < n && p < chpl.e; i++) { const t = Number(dv.getBigUint64(p)) / 1e7; const l = u8[p + 8]; chapters.push({ t, title: new TextDecoder().decode(u8.subarray(p + 9, p + 9 + l)) }); p += 9 + l } }
    // главы QuickTime: дорожка с текстом
    if (!chapters.length) for (const tr of mv.filter(a => a.type === 'trak')) {
        const tl = atoms(u8, tr.s, tr.e)
        const mdia = tl.find(a => a.type === 'mdia'); if (!mdia) continue
        const ml = atoms(u8, mdia.s, mdia.e)
        const hdlr = ml.find(a => a.type === 'hdlr'); if (!hdlr || latin.decode(u8.subarray(hdlr.s + 8, hdlr.s + 12)) !== 'text') continue
        const mdhd = ml.find(a => a.type === 'mdhd'); const ts = u8[mdhd.s] === 1 ? dv.getUint32(mdhd.s + 20) : dv.getUint32(mdhd.s + 12)
        const stbl = find(u8, ml, ['minf', 'stbl']); if (!stbl) continue
        const sl = atoms(u8, stbl.s, stbl.e), get = t => sl.find(a => a.type === t)
        const stts = get('stts'), stsz = get('stsz'), stco = get('stco') ?? get('co64'), stsc = get('stsc')
        const durs = []; for (let i = 0, n = dv.getUint32(stts.s + 4); i < n; i++) { const c = dv.getUint32(stts.s + 8 + i * 8), d = dv.getUint32(stts.s + 12 + i * 8); for (let k = 0; k < c; k++) durs.push(d) }
        const nS = dv.getUint32(stsz.s + 8), fixed = dv.getUint32(stsz.s + 4)
        const sizes = Array.from({ length: nS }, (_, i) => fixed || dv.getUint32(stsz.s + 12 + i * 4))
        const co64 = stco.type === 'co64', nC = dv.getUint32(stco.s + 4)
        const chunks = Array.from({ length: nC }, (_, i) => co64 ? Number(dv.getBigUint64(stco.s + 8 + i * 8)) : dv.getUint32(stco.s + 8 + i * 4))
        const runs = Array.from({ length: dv.getUint32(stsc.s + 4) }, (_, i) => [dv.getUint32(stsc.s + 8 + i * 12), dv.getUint32(stsc.s + 12 + i * 12)])
        let si = 0, t = 0
        for (let c = 0; c < nC && si < nS; c++) {
            const per = [...runs].reverse().find(r => r[0] <= c + 1)?.[1] ?? 1
            let off = chunks[c]
            for (let k = 0; k < per && si < nS; k++, si++) { const l = dv.getUint16(off); chapters.push({ t: t / ts, title: new TextDecoder().decode(u8.subarray(off + 2, off + 2 + l)) }); off += sizes[si]; t += durs[si] ?? 0 }
        }
    }
    return { tag, chapters }
}
export const m4bView = (ctx, buf) => {
    const u8 = new Uint8Array(buf)
    const { tag, chapters } = parseMp4Book(u8)
    const url = blobUrl(ctx, u8, 'audio/mp4')
    const head = el('div', 'ur-book-head', `${tag.cover ? `<img class="ur-book-cover" src="${blobUrl(ctx, tag.cover.bytes, tag.cover.type)}">` : ''}<div><h2>${esc(tag.title ?? 'Аудиокнига')}</h2>${tag.artist ? `<p>${esc(tag.artist)}</p>` : ''}${tag.narrator ? `<p class="ur-muted">Читает: ${esc(tag.narrator)}</p>` : ''}${tag.year ? `<p class="ur-muted">${esc(tag.year)}</p>` : ''}</div>`)
    const { wrap, audio } = player(ctx, url)
    wrap.prepend(head)
    if (chapters.length) {
        const ol = el('ol', 'ur-chapters')
        chapters.forEach((c, i) => { const li = el('li', '', `<a href="#">${esc(c.title || `Глава ${i + 1}`)}</a> <span class="ur-muted">${fmtT(c.t)}</span>`); li.querySelector('a').onclick = e => { e.preventDefault(); audio.currentTime = c.t; audio.play() }; ol.append(li) })
        audio.addEventListener('timeupdate', () => { const i = chapters.findLastIndex(c => c.t <= audio.currentTime + 0.1); ol.querySelectorAll('li').forEach((li, k) => li.classList.toggle('is-active', k === i)) })
        wrap.append(el('h3', '', `Главы (${chapters.length})`), ol)
    }
    if (tag.desc || tag.comment) wrap.append(el('p', '', esc(tag.desc ?? tag.comment)))
    return wrap
}

// ================= AIFF / AIFC =================
const ext80 = (u8, o) => { const e = ((u8[o] & 0x7F) << 8 | u8[o + 1]) - 16383; let m = 0; for (let i = 0; i < 8; i++) m = m * 256 + u8[o + 2 + i]; return (u8[o] & 0x80 ? -1 : 1) * m * 2 ** (e - 63) }
export const aiffView = (ctx, buf) => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const form = latin.decode(u8.subarray(8, 12))
    if (latin.decode(u8.subarray(0, 4)) !== 'FORM' || !/^AIF[FC]$/.test(form)) throw new ReaderError('Это не звук AIFF.')
    let p = 12, comm = null, ssnd = null; const names = {}
    while (p + 8 <= u8.length) {
        const id = latin.decode(u8.subarray(p, p + 4)), len = dv.getUint32(p + 4), d = p + 8
        if (id === 'COMM') comm = { ch: dv.getUint16(d), frames: dv.getUint32(d + 2), bits: dv.getUint16(d + 6), rate: ext80(u8, d + 8), comp: form === 'AIFC' ? latin.decode(u8.subarray(d + 18, d + 22)) : 'NONE' }
        else if (id === 'SSND') ssnd = d + 8 + dv.getUint32(d)
        else if (id === 'NAME' || id === 'AUTH' || id === '(c) ' || id === 'ANNO') names[id] = latin.decode(u8.subarray(d, d + len)).replace(/\0+$/, '')
        p = d + len + (len & 1)
    }
    if (!comm || ssnd == null) throw new ReaderError('В файле AIFF нет звука.')
    const { ch, frames, bits, rate } = comm
    const comp = comm.comp.trim()
    const out = Array.from({ length: ch }, () => new Float32Array(frames))
    const bps = comp === 'fl32' || comp === 'FL32' ? 4 : comp === 'fl64' || comp === 'FL64' ? 8 : comp === 'ulaw' || comp === 'alaw' ? 1 : Math.ceil(bits / 8)
    const le = comp === 'sowt'
    const ulaw = v => { v = ~v & 255; const t = ((v & 15) << 3) + 0x84 << ((v & 0x70) >> 4); return (v & 0x80 ? 0x84 - t : t - 0x84) / 32768 }
    const alaw = v => { v ^= 0x55; let t = (v & 15) << 4; const seg = (v & 0x70) >> 4; t = seg ? (t + 0x108) << (seg - 1) : t + 8; return (v & 0x80 ? t : -t) / 32768 }
    if (!['NONE', 'none', 'sowt', 'twos', 'fl32', 'FL32', 'fl64', 'FL64', 'ulaw', 'alaw', 'raw '].includes(comm.comp) && !['NONE', 'sowt'].includes(comp)) throw new ReaderError(`Сжатие AIFC «${comp}» пока не поддерживается.`)
    for (let i = 0; i < frames; i++) for (let c = 0; c < ch; c++) {
        const o = ssnd + (i * ch + c) * bps; if (o + bps > u8.length) break
        let v
        if (bps === 4 && /fl32/i.test(comp)) v = dv.getFloat32(o)
        else if (bps === 8) v = dv.getFloat64(o)
        else if (comp === 'ulaw') v = ulaw(u8[o]); else if (comp === 'alaw') v = alaw(u8[o])
        else if (bps === 1) v = ((u8[o] << 24) >> 24) / 128
        else if (bps === 2) v = dv.getInt16(o, le) / 32768
        else if (bps === 3) v = (le ? (u8[o] | u8[o + 1] << 8 | u8[o + 2] << 16) << 8 >> 8 : (u8[o] << 16 | u8[o + 1] << 8 | u8[o + 2]) << 8 >> 8) / 8388608
        else v = dv.getInt32(o, le) / 2147483648
        out[c][i] = v
    }
    const { wrap } = player(ctx, blobUrl(ctx, wavFrom(out, Math.round(rate)), 'audio/wav'), infoTable([['Название', names.NAME ?? ''], ['Автор', names.AUTH ?? ''], ['Права', names['(c) '] ?? ''], ['Формат', `${form}${comp !== 'NONE' ? ' ' + comp : ''}, ${bits} бит, ${Math.round(rate)} Гц, каналов: ${ch}`], ['Длительность', fmtT(frames / rate)]]))
    return wrap
}

// ================= Apple Core Audio (.caf) =================
export const cafView = (ctx, buf) => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (latin.decode(u8.subarray(0, 4)) !== 'caff') throw new ReaderError('Это не звук CAF.')
    let p = 8, desc = null, data = null, info = {}
    while (p + 12 <= u8.length) {
        const id = latin.decode(u8.subarray(p, p + 4)); let len = Number(dv.getBigInt64(p + 4)); const d = p + 12
        if (len < 0) len = u8.length - d
        if (id === 'desc') desc = { rate: dv.getFloat64(d), fmt: latin.decode(u8.subarray(d + 8, d + 12)), flags: dv.getUint32(d + 12), bpp: dv.getUint32(d + 16), ch: dv.getUint32(d + 24), bits: dv.getUint32(d + 28) }
        else if (id === 'data') data = u8.subarray(d + 4, d + len)
        else if (id === 'info') { const n = dv.getUint32(d); const parts = new TextDecoder().decode(u8.subarray(d + 4, d + len)).split('\0'); for (let i = 0; i < n * 2; i += 2) info[parts[i]] = parts[i + 1] }
        p = d + len
    }
    if (!desc || !data) throw new ReaderError('В файле CAF нет звука.')
    const meta = infoTable([['Название', info.title ?? ''], ['Автор', info.artist ?? ''], ['Формат', `${desc.fmt.trim()}, ${desc.bits || '?'} бит, ${desc.rate} Гц, каналов: ${desc.ch}`]])
    if (desc.fmt !== 'lpcm') {
        if (desc.fmt === 'aac ') throw new ReaderError('Внутри CAF — звук AAC. Встроенный проигрыватель открывает его только в контейнере .m4a; сам CAF пока не перепаковывается.')
        throw new ReaderError(`Звук в формате «${desc.fmt.trim()}» внутри CAF пока не поддерживается.`)
    }
    const fl = desc.flags & 1, le = !!(desc.flags & 2), bps = desc.bits / 8, ch = desc.ch
    const frames = Math.floor(data.length / (bps * ch))
    const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const out = Array.from({ length: ch }, () => new Float32Array(frames))
    for (let i = 0; i < frames; i++) for (let c = 0; c < ch; c++) {
        const o = (i * ch + c) * bps
        out[c][i] = fl ? (bps === 4 ? ddv.getFloat32(o, le) : ddv.getFloat64(o, le)) : bps === 1 ? (data[o] - 128) / 128 : bps === 2 ? ddv.getInt16(o, le) / 32768 : bps === 3 ? ((le ? (data[o] | data[o + 1] << 8 | data[o + 2] << 16) : (data[o] << 16 | data[o + 1] << 8 | data[o + 2])) << 8 >> 8) / 8388608 : ddv.getInt32(o, le) / 2147483648
    }
    return player(ctx, blobUrl(ctx, wavFrom(out, Math.round(desc.rate)), 'audio/wav'), meta).wrap
}

// ================= DSD (.dsf, .dff): переводим в обычный звук 44,1 кГц =================
const ONES = new Uint8Array(256).map((_, i) => { let n = 0, v = i; while (v) { n += v & 1; v >>= 1 } return n })
const dsdToPcm = (getByte, nBytesPerCh, ch, rate, maxSec = 600) => {
    const factor = rate / 44100 // бит на один отсчёт (64 для DSD64)
    const bytesPer = factor / 8
    const n = Math.min(Math.floor(nBytesPerCh / bytesPer), 44100 * maxSec)
    const out = Array.from({ length: ch }, () => new Float32Array(n))
    for (let c = 0; c < ch; c++) {
        let prev = 0
        for (let i = 0; i < n; i++) {
            let ones = 0
            const b0 = Math.floor(i * bytesPer)
            for (let k = 0; k < bytesPer; k++) ones += ONES[getByte(c, b0 + k)]
            const v = ones / factor * 2 - 1
            out[c][i] = (v + prev) / 2 // простой фильтр, чтобы убрать шум высоких частот
            prev = v
        }
    }
    return out
}
export const dsdView = (ctx, buf, ext) => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    let rate, ch, perCh, getByte, meta = []
    if (latin.decode(u8.subarray(0, 4)) === 'DSD ') { // DSF
        const fmt = 28
        ch = dv.getUint32(fmt + 24, true); rate = dv.getUint32(fmt + 28, true)
        const bits = dv.getUint32(fmt + 32, true), samples = Number(dv.getBigUint64(fmt + 36, true)), blk = dv.getUint32(fmt + 44, true)
        const data = fmt + Number(dv.getBigUint64(fmt + 4, true)) + 12
        perCh = Math.floor(samples / 8)
        const rev = new Uint8Array(256).map((_, i) => { let r = 0; for (let b = 0; b < 8; b++) if (i & (1 << b)) r |= 1 << (7 - b); return r })
        getByte = (c, i) => { const b = Math.floor(i / blk); const v = u8[data + (b * ch + c) * blk + i % blk]; return bits === 1 ? v : rev[v] } // порядок бит не важен для подсчёта единиц
        meta.push(['Формат', `DSF, DSD${Math.round(rate / 44100)}, каналов: ${ch}`])
    } else if (latin.decode(u8.subarray(0, 4)) === 'FRM8') { // DFF
        let p = 16, dsdStart = 0, dsdLen = 0
        const walk = (s, e) => { let q = s; while (q + 12 <= e) { const id = latin.decode(u8.subarray(q, q + 4)), len = Number(dv.getBigUint64(q + 4)), d = q + 12; if (id === 'PROP') walk(d + 4, d + len); else if (id === 'FS  ') rate = dv.getUint32(d); else if (id === 'CHNL') ch = dv.getUint16(d); else if (id === 'CMPR' && latin.decode(u8.subarray(d, d + 4)) !== 'DSD ') throw new ReaderError('Сжатый DST в DFF пока не поддерживается.'); else if (id === 'DSD ') { dsdStart = d; dsdLen = len } q = d + len + (len & 1) } }
        walk(p, u8.length)
        perCh = Math.floor(dsdLen / ch)
        getByte = (c, i) => u8[dsdStart + i * ch + c]
        meta.push(['Формат', `DFF, DSD${Math.round(rate / 44100)}, каналов: ${ch}`])
    } else throw new ReaderError('Это не звук DSD.')
    void ext
    const pcm = dsdToPcm(getByte, perCh, ch, rate)
    meta.push(['Длительность', fmtT(perCh * 8 / rate)])
    if (perCh * 8 / rate > 600) meta.push(['Внимание', 'проигрываются первые 10 минут'])
    return player(ctx, blobUrl(ctx, wavFrom(pcm, 44100), 'audio/wav'), infoTable(meta) + '<p class="ur-muted">Звук DSD переведён в обычный (44,1 кГц) упрощённо — для прослушивания «на пробу», не для оценки качества.</p>').wrap
}

// ================= Matroska-звук (.mka) =================
export const mkaView = (ctx, buf) => player(ctx, blobUrl(ctx, new Uint8Array(buf), 'audio/webm')).wrap

// ================= Проекты Ableton Live (.als) =================
export const alsView = async buf => {
    let u8 = new Uint8Array(buf)
    if (u8[0] === 0x1F && u8[1] === 0x8B) u8 = await gunzip(u8)
    const d = new DOMParser().parseFromString(new TextDecoder().decode(u8), 'application/xml')
    const root = d.querySelector('Ableton')
    if (!root) throw new ReaderError('Это не проект Ableton Live.')
    const v = (n, sel) => n?.querySelector(sel)?.getAttribute('Value') ?? ''
    const master = d.querySelector('MasterTrack') ?? d.querySelector('MainTrack')
    const tempo = v(master, 'Tempo > Manual')
    const ts = master?.querySelector('RemoteableTimeSignature')
    const tracks = [...d.querySelectorAll('LiveSet > Tracks > *')].map(t => {
        const clips = [...t.querySelectorAll('AudioClip, MidiClip')].map(c => ({ name: v(c, ':scope > Name'), kind: c.tagName === 'AudioClip' ? '🔊' : '🎹', file: v(c, 'SampleRef FileRef Path') || v(c, 'SampleRef FileRef RelativePath') }))
        const devices = [...t.querySelectorAll('DeviceChain Devices > *')].map(x => x.tagName === 'PluginDevice' || x.tagName === 'AuPluginDevice' ? v(x, 'PlugName') || v(x, 'Name') || 'плагин' : x.tagName)
        return { kind: { AudioTrack: 'звук', MidiTrack: 'MIDI', ReturnTrack: 'возврат', GroupTrack: 'группа' }[t.tagName] ?? t.tagName, name: v(t, ':scope > Name > EffectiveName') || v(t, ':scope > Name > UserName'), clips, devices }
    })
    const files = [...new Set(tracks.flatMap(t => t.clips.map(c => c.file)).filter(Boolean))]
    return el('div', 'ur-als', `<h2>Проект Ableton Live</h2>${infoTable([['Версия', root.getAttribute('Creator') ?? ''], ['Темп', tempo ? `${+(+tempo).toFixed(2)} уд/мин` : ''], ['Размер', ts ? `${v(ts, 'Numerator')}/${v(ts, 'Denominator')}` : ''], ['Дорожек', String(tracks.length)]])}
        <h3>Дорожки</h3><table class="ur-table"><thead><tr><th>Дорожка</th><th>Вид</th><th>Клипы</th><th>Эффекты и инструменты</th></tr></thead><tbody>${tracks.map(t => `<tr><td>${esc(t.name)}</td><td>${esc(t.kind)}</td><td>${t.clips.map(c => `${c.kind} ${esc(c.name)}`).join('<br>')}</td><td>${esc(t.devices.join(', '))}</td></tr>`).join('')}</tbody></table>
        ${files.length ? `<h3>Используемые звуковые файлы (${files.length})</h3><ul>${files.map(f => `<li><code>${esc(f)}</code></li>`).join('')}</ul>` : ''}`)
}

// ================= Трекерная музыка и музыка приставок: сведения =================
const cstr = (u8, o, n) => latin.decode(u8.subarray(o, o + n)).replace(/\0.*$/s, '').trim()
export const chipInfo = (buf, ext) => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const sig = latin.decode(u8.subarray(0, 64))
    let rows = [], list = [], kind = ''
    if (/^Extended Module: /.test(sig)) { kind = 'FastTracker 2 (XM)'; rows = [['Название', cstr(u8, 17, 20)], ['Программа', cstr(u8, 38, 20)], ['Каналов', dv.getUint16(68, true)], ['Шаблонов', dv.getUint16(70, true)], ['Инструментов', dv.getUint16(72, true)], ['Темп', `${dv.getUint16(78, true)} уд/мин`]]
        let p = 60 + dv.getUint32(60, true); for (let i = 0; i < dv.getUint16(70, true) && p + 9 <= u8.length; i++) p += dv.getUint32(p, true) + dv.getUint16(p + 7, true)
        for (let i = 0; i < dv.getUint16(72, true) && p + 29 <= u8.length; i++) { const sz = dv.getUint32(p, true); list.push(cstr(u8, p + 4, 22)); const ns = dv.getUint16(p + 27, true); let q = p + sz; let sum = 0; if (ns) { for (let k = 0; k < ns; k++) sum += dv.getUint32(q + k * 40, true); q += ns * 40 + sum } p = q } }
    else if (sig.startsWith('IMPM')) { kind = 'Impulse Tracker (IT)'; const ins = dv.getUint16(34, true), smp = dv.getUint16(36, true), ord = dv.getUint16(32, true); rows = [['Название', cstr(u8, 4, 26)], ['Инструментов', ins], ['Сэмплов', smp], ['Темп', `${u8[51]} уд/мин`]]; for (let i = 0; i < smp; i++) { const o = dv.getUint32(0xC0 + ord + ins * 4 + i * 4, true); if (o + 0x30 <= u8.length) list.push(cstr(u8, o + 0x14, 26)) } const msgLen = dv.getUint16(0x36, true), msgOff = dv.getUint32(0x38, true); if (u8[0x2E] & 1 && msgLen) rows.push(['Сообщение', cstr(u8, msgOff, msgLen).replace(/\r/g, '\n')]) }
    else if (latin.decode(u8.subarray(44, 48)) === 'SCRM') { kind = 'Scream Tracker 3 (S3M)'; const ord = dv.getUint16(0x20, true), ins = dv.getUint16(0x22, true); rows = [['Название', cstr(u8, 0, 28)], ['Инструментов', ins], ['Темп', `${u8[0x32]} уд/мин`]]; for (let i = 0; i < ins; i++) { const o = dv.getUint16(0x60 + ord + i * 2, true) * 16; if (o + 0x50 <= u8.length) list.push(cstr(u8, o + 0x30, 28)) } }
    else if (/^(M\.K\.|M!K!|FLT[48]|[2-9]CHN|[1-3]\dCH|OCTA|CD81)/.test(latin.decode(u8.subarray(1080, 1084))) || ext === 'mod') { kind = 'ProTracker (MOD)'; rows = [['Название', cstr(u8, 0, 20)], ['Подпись', latin.decode(u8.subarray(1080, 1084))]]; for (let i = 0; i < 31; i++) list.push(cstr(u8, 20 + i * 30, 22)) }
    else if (/^[PR]SID/.test(sig)) { kind = `Commodore 64 (${sig.slice(0, 4)})`; rows = [['Название', cstr(u8, 0x16, 32)], ['Автор', cstr(u8, 0x36, 32)], ['Выпущено', cstr(u8, 0x56, 32)], ['Мелодий', dv.getUint16(0x0E)]] }
    else if (sig.startsWith('NESM\x1a')) { kind = 'NES / Dendy (NSF)'; rows = [['Название', cstr(u8, 0x0E, 32)], ['Автор', cstr(u8, 0x2E, 32)], ['Права', cstr(u8, 0x4E, 32)], ['Мелодий', u8[6]]] }
    else if (sig.startsWith('SNES-SPC700')) { kind = 'Super Nintendo (SPC)'; rows = [['Название', cstr(u8, 0x2E, 32)], ['Игра', cstr(u8, 0x4E, 32)], ['Автор', cstr(u8, 0xB1, 32)], ['Снял', cstr(u8, 0x6E, 16)], ['Комментарий', cstr(u8, 0x7E, 32)]] }
    else if (sig.startsWith('Vgm ')) {
        kind = 'Музыка приставок Sega и других (VGM)'
        const total = dv.getUint32(0x18, true) / 44100
        const g = dv.getUint32(0x14, true) + 0x14
        let s = []; if (g > 0x14 && latin.decode(u8.subarray(g, g + 4)) === 'Gd3 ') s = new TextDecoder('utf-16le').decode(u8.subarray(g + 12, g + 12 + dv.getUint32(g + 8, true))).split('\0')
        rows = [['Название', s[0] || s[1] || ''], ['Игра', s[2] || s[3] || ''], ['Приставка', s[4] || ''], ['Автор', s[6] || s[7] || ''], ['Дата', s[8] || ''], ['Длительность', fmtT(total)], ['Заметки', s[10] || '']]
    }
    else if (latin.decode(u8.subarray(0, 4)) === 'MAC ') { kind = "Monkey's Audio (APE)"; rows = [['Версия', dv.getUint16(4, true) / 1000]] }
    else if (latin.decode(u8.subarray(0, 4)) === 'wvpk') kind = 'WavPack'
    else if (latin.decode(u8.subarray(0, 4)) === 'TTA1') { kind = 'True Audio (TTA)'; rows = [['Каналов', dv.getUint16(6, true)], ['Бит', dv.getUint16(8, true)], ['Частота', `${dv.getUint32(10, true)} Гц`], ['Длительность', fmtT(dv.getUint32(14, true) / dv.getUint32(10, true))]] }
    else if (sig.startsWith('#!AMR')) kind = 'Голосовая запись AMR'
    else throw new ReaderError('Неизвестный формат музыки.')
    // теги APEv2 / ID3 в конце или начале (у APE, WavPack, TTA)
    const tags = readApeTags(u8); for (const k of ['Title', 'Artist', 'Album', 'Year']) if (tags[k]) rows.push([{ Title: 'Название', Artist: 'Исполнитель', Album: 'Альбом', Year: 'Год' }[k], tags[k]])
    const lossless = /APE|WavPack|TTA/.test(kind), amr = /AMR/.test(kind)
    return el('div', 'ur-chip', `<h2>${esc(kind)}</h2>${infoTable(rows)}
        ${list.filter(Boolean).length ? `<h3>Инструменты и сэмплы</h3><ol class="ur-chip-list">${list.map(n => `<li>${esc(n) || '&nbsp;'}</li>`).join('')}</ol><p class="ur-muted">Музыканты часто прячут в названиях сэмплов приветы и подписи.</p>` : ''}
        <p class="ur-muted">${lossless ? 'Этот формат сжатия без потерь встроенный проигрыватель не понимает, а отдельный декодер в плагин пока не добавлен — показаны только сведения.' : amr ? 'Встроенный проигрыватель не понимает голосовые записи AMR — показаны только сведения.' : 'Такая музыка — это программа для эмулятора или трекера; проигрывание пока не поддерживается, показаны сведения.'}</p>`)
}
const readApeTags = u8 => {
    const out = {}
    const end = u8.length - 32
    if (end > 0 && latin.decode(u8.subarray(end, end + 8)) === 'APETAGEX') {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
        const size = dv.getUint32(end + 12, true), n = dv.getUint32(end + 16, true)
        let p = end + 32 - size
        for (let i = 0; i < n && p < end; i++) { const len = dv.getUint32(p, true); let k = p + 8; while (u8[k]) k++; const key = latin.decode(u8.subarray(p + 8, k)); out[key[0]?.toUpperCase() + key.slice(1).toLowerCase()] = new TextDecoder().decode(u8.subarray(k + 1, k + 1 + len)); p = k + 1 + len }
    }
    return out
}

// ================= FLV и MPEG-TS через mpegts.js =================
export const mpegtsView = async (ctx, buf, kind) => {
    const lib = await ctx.loadLib('mpegts')
    const mpegts = lib.default ?? lib
    const url = blobUrl(ctx, new Uint8Array(buf), kind === 'flv' ? 'video/x-flv' : 'video/mp2t')
    const wrap = el('div', 'ur-media-wrap')
    const v = document.createElement('video'); v.controls = true; v.className = 'ur-media'
    const note = el('p', 'ur-muted', '')
    wrap.append(v, note)
    if (!mpegts.isSupported?.()) { note.textContent = 'В этой версии Обсидиана нет поддержки Media Source — видео не проигрывается.'; return wrap }
    const p = mpegts.createPlayer({ type: kind === 'flv' ? 'flv' : 'mpegts', isLive: false, url }, { enableWorker: false, lazyLoad: false })
    p.attachMediaElement(v); p.load()
    p.on(mpegts.Events.ERROR, (t, d) => { note.textContent = `Не удалось проиграть видео (${d || t}). Старые FLV с кодеком Sorenson или VP6 браузер не понимает.` })
    v.addEventListener('loadedmetadata', () => { note.textContent = `${fmtT(v.duration)} · ${v.videoWidth}×${v.videoHeight}` })
    ctx.cleanups.push(() => { try { p.destroy() } catch { /* ignore */ } })
    return wrap
}

// ================= Субтитры-картинки =================
const ycc = (y, cr, cb) => [y + 1.402 * (cr - 128), y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128), y + 1.772 * (cb - 128)].map(v => Math.max(0, Math.min(255, v)))
const imgOf = (w, h, rgba) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0); return c }
const subsList = (items, note) => {
    const wrap = el('div', 'ur-bitmap-subs', `<div class="ur-meta">Субтитров: ${items.length}${note ? ' · ' + esc(note) : ''}</div>`)
    for (const it of items.slice(0, 2000)) { const row = el('div', 'ur-bsub', `<div class="ur-bsub-time">${fmtT(it.start)}${it.end ? ' — ' + fmtT(it.end) : ''}</div>`); row.append(it.canvas); wrap.append(row) }
    if (!items.length) throw new ReaderError('В файле нет субтитров.')
    return wrap
}
// Blu-ray PGS (.sup)
export const pgsView = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (!(u8[0] === 0x50 && u8[1] === 0x47)) throw new ReaderError('Это не субтитры Blu-ray (PGS).')
    let p = 0, pal = new Map(), objs = new Map(), comp = null
    const items = []
    while (p + 13 <= u8.length && u8[p] === 0x50 && u8[p + 1] === 0x47) {
        const pts = dv.getUint32(p + 2) / 90000, type = u8[p + 10], len = dv.getUint16(p + 11), d = p + 13
        if (type === 0x16) { const n = u8[d + 10]; comp = { pts, objs: Array.from({ length: n }, (_, i) => ({ id: dv.getUint16(d + 11 + i * 8), x: dv.getUint16(d + 15 + i * 8), y: dv.getUint16(d + 17 + i * 8) })) }; if (!n && items.length && !items[items.length - 1].end) items[items.length - 1].end = pts }
        else if (type === 0x14) for (let q = d + 2; q + 5 <= d + len; q += 5) { const [r, g, b] = ycc(u8[q + 1], u8[q + 2], u8[q + 3]); pal.set(u8[q], [r, g, b, u8[q + 4]]) }
        else if (type === 0x15) { const id = dv.getUint16(d), flag = u8[d + 3]; if (flag & 0x80) objs.set(id, { w: dv.getUint16(d + 7), h: dv.getUint16(d + 9), parts: [u8.subarray(d + 11, d + len)] }); else objs.get(id)?.parts.push(u8.subarray(d + 4, d + len)) }
        else if (type === 0x80 && comp?.objs.length) {
            for (const o of comp.objs) {
                const ob = objs.get(o.id); if (!ob) continue
                const data = ob.parts.length === 1 ? ob.parts[0] : Uint8Array.from(ob.parts.flatMap(x => [...x]))
                const rgba = new Uint8ClampedArray(ob.w * ob.h * 4); let x = 0, y = 0, i = 0
                const put = (c, n) => { const col = pal.get(c) ?? [0, 0, 0, 0]; for (let k = 0; k < n && x < ob.w; k++, x++) rgba.set(col, (y * ob.w + x) * 4) }
                while (i < data.length && y < ob.h) {
                    const b = data[i++]
                    if (b) { put(b, 1); continue }
                    const f = data[i++]
                    if (f === 0) { x = 0; y++; continue }
                    const long = f & 0x40, colored = f & 0x80
                    let n = f & 0x3F; if (long) n = (n << 8) | data[i++]
                    put(colored ? data[i++] : 0, n)
                }
                items.push({ start: pts, canvas: imgOf(ob.w, ob.h, rgba) })
            }
            comp = null
        }
        p = d + len
    }
    return subsList(items)
}
// DVD VobSub (.idx + .sub)
export const parseIdx = text => {
    const pal = (/^palette:\s*(.*)$/m.exec(text)?.[1] ?? '').split(',').map(s => { const v = parseInt(s.trim(), 16); return [v >> 16 & 255, v >> 8 & 255, v & 255] })
    const ts = [...text.matchAll(/timestamp:\s*(\d+):(\d+):(\d+):(\d+),\s*filepos:\s*([0-9a-f]+)/gi)].map(m => ({ t: +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000, pos: parseInt(m[5], 16) }))
    return { pal, ts }
}
export const vobsubView = (subBuf, idxText) => {
    const u8 = new Uint8Array(subBuf), dv = new DataView(subBuf)
    const { pal, ts } = parseIdx(idxText)
    if (!ts.length) throw new ReaderError('В файле .idx нет отметок времени.')
    const items = []
    for (const { t, pos } of ts.slice(0, 3000)) {
        // собираем пакет SPU из PES-пакетов, начиная с позиции
        let p = pos, spu = null, need = 0, got = 0
        while (p + 14 < u8.length && (spu == null || got < need)) {
            if (dv.getUint32(p) !== 0x1BA) { p++; continue }
            p += 14 + (u8[p + 13] & 7)
            if (dv.getUint32(p) !== 0x1BD) { const l = dv.getUint16(p + 4); p += 6 + l; continue }
            const l = dv.getUint16(p + 4), hl = u8[p + 8]
            const payload = u8.subarray(p + 9 + hl + 1, p + 6 + l)
            if (spu == null) { need = payload[0] << 8 | payload[1]; spu = new Uint8Array(need) }
            spu.set(payload.subarray(0, need - got), got); got += payload.length
            p += 6 + l
        }
        if (!spu) continue
        const sdv = new DataView(spu.buffer)
        let ctrl = sdv.getUint16(2), colors = [0, 1, 2, 3], alpha = [0, 15, 15, 15], x1 = 0, x2 = 0, y1 = 0, y2 = 0, off = [0, 0], end = 0
        for (let guard = 0; guard < 50; guard++) {
            const delay = sdv.getUint16(ctrl), next = sdv.getUint16(ctrl + 2)
            let q = ctrl + 4
            for (;;) {
                const c = spu[q++]
                if (c === 0x03) { colors = [spu[q] >> 4, spu[q] & 15, spu[q + 1] >> 4, spu[q + 1] & 15].reverse(); q += 2 }
                else if (c === 0x04) { alpha = [spu[q] >> 4, spu[q] & 15, spu[q + 1] >> 4, spu[q + 1] & 15].reverse(); q += 2 }
                else if (c === 0x05) { x1 = spu[q] << 4 | spu[q + 1] >> 4; x2 = (spu[q + 1] & 15) << 8 | spu[q + 2]; y1 = spu[q + 3] << 4 | spu[q + 4] >> 4; y2 = (spu[q + 4] & 15) << 8 | spu[q + 5]; q += 6 }
                else if (c === 0x06) { off = [sdv.getUint16(q), sdv.getUint16(q + 2)]; q += 4 }
                else if (c === 0x02) end = delay * 1024 / 90000
                else if (c === 0x00 || c === 0x01) { /* показ */ }
                else break
            }
            if (next === ctrl) break
            ctrl = next
        }
        const w = x2 - x1 + 1, h = y2 - y1 + 1
        if (w <= 0 || h <= 0 || w > 4000 || h > 4000) continue
        const rgba = new Uint8ClampedArray(w * h * 4)
        for (let field = 0; field < 2; field++) {
            let q = off[field] * 2 // в полубайтах
            const nib = () => { const b = spu[q >> 1]; const v = q & 1 ? b & 15 : b >> 4; q++; return v }
            for (let y = field; y < h; y += 2) {
                let x = 0
                while (x < w) {
                    let v = nib()
                    if (v < 4) { v = v << 4 | nib(); if (v < 0x10) { v = v << 4 | nib(); if (v < 0x40) { v = v << 4 | nib() } } }
                    const c = v & 3; let n = v >> 2; if (n === 0) n = w - x
                    const col = pal[colors[c]] ?? [255, 255, 255], a = alpha[c] * 17
                    for (let k = 0; k < n && x < w; k++, x++) rgba.set([col[0], col[1], col[2], a], (y * w + x) * 4)
                }
                if (q & 1) q++ // строка выравнивается по байту
            }
        }
        items.push({ start: t, end: end ? t + end : 0, canvas: imgOf(w, h, rgba) })
    }
    return subsList(items)
}
// Scenarist SCC (скрытые субтитры CEA-608)
const SCC_SPECIAL = { 0x30: '®', 0x31: '°', 0x32: '½', 0x33: '¿', 0x34: '™', 0x35: '¢', 0x36: '£', 0x37: '♪', 0x38: 'à', 0x39: ' ', 0x3A: 'è', 0x3B: 'â', 0x3C: 'ê', 0x3D: 'î', 0x3E: 'ô', 0x3F: 'û' }
const SCC_BASIC = { 0x2A: 'á', 0x5C: 'é', 0x5E: 'í', 0x5F: 'ó', 0x60: 'ú', 0x7B: 'ç', 0x7C: '÷', 0x7D: 'Ñ', 0x7E: 'ñ', 0x7F: '█' }
export const parseScc = text => {
    if (!/^Scenarist_SCC/.test(text.trim())) throw new ReaderError('Это не субтитры SCC.')
    const cues = []
    let buf = '', shown = null, last = ''
    for (const line of text.split(/\r?\n/)) {
        const m = /^(\d\d):(\d\d):(\d\d)[:;.](\d\d)\s+(.*)$/.exec(line); if (!m) continue
        let t = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 29.97
        for (const w of m[5].trim().split(/\s+/)) {
            if (w === last && /^[19][0-7]/.test(w)) { last = ''; t += 1 / 29.97; continue } // управляющие коды повторяются
            last = w
            const a = parseInt(w.slice(0, 2), 16) & 0x7F, b = parseInt(w.slice(2), 16) & 0x7F
            if (a >= 0x10 && a <= 0x1F) {
                if ((a === 0x14 || a === 0x1C) && b === 0x2F) { if (shown) shown.end = t; if (buf.trim()) { shown = { start: t, end: t + 3, text: buf.trim() }; cues.push(shown) } buf = '' } // показать
                else if ((a === 0x14 || a === 0x1C) && b === 0x2C) { if (shown) { shown.end = t; shown = null } } // стереть экран
                else if ((a === 0x14 || a === 0x1C) && b === 0x2E) buf = '' // стереть буфер
                else if ((a === 0x14 || a === 0x1C) && b === 0x2D) buf += '\n'
                else if ((a === 0x11 || a === 0x19) && b >= 0x30 && b <= 0x3F) buf += SCC_SPECIAL[b] ?? ''
                else if (b >= 0x40 && buf && !buf.endsWith('\n')) buf += '\n' // новая строка экрана
            } else for (const c of [a, b]) if (c >= 0x20) buf += SCC_BASIC[c] ?? String.fromCharCode(c)
            t += 1 / 29.97
        }
    }
    if (!cues.length) throw new ReaderError('В файле SCC нет субтитров.')
    return cues.map(c => ({ start: c.start, end: c.end, text: c.text.replace(/\n{2,}/g, '\n') }))
}
