// Распознавание по содержимому (версия 0.6): одно расширение — несколько разных форматов,
// выгрузки чатов и истории перемещений внутри обычных .json/.txt/.xml, резервные копии (.bak и т. п.)
import { escapeHtml as esc, decodeText, ReaderError, MIME } from '../util.js'
import { FORMAT_BY_EXT } from '../registry.js'
import { NT } from '../i18n.js'

const latin = new TextDecoder('latin1')
const head = (u8, n = 4096) => latin.decode(u8.subarray(0, n))
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e }

// ---------- Что лежит внутри файла (по «магическим» байтам) ----------
export const sniffBytes = (u8, nameHint = '') => {
    const h = head(u8, 600)
    const b = i => u8[i]
    if (b(0) === 0x50 && b(1) === 0x4B) {
        const t = latin.decode(u8.subarray(0, Math.min(u8.length, 200000)))
        const mt = /mimetypeapplication\/(epub\+zip|vnd\.oasis\.opendocument\.(text|spreadsheet|presentation|graphics))/.exec(t)
        if (mt) return mt[1] === 'epub+zip' ? 'epub' : { text: 'odt', spreadsheet: 'ods', presentation: 'odp', graphics: 'odg' }[mt[2]]
        if (t.includes('[Content_Types].xml')) { if (t.includes('word/')) return 'docx'; if (t.includes('xl/')) return 'xlsx'; if (t.includes('ppt/')) return 'pptx' }
        return 'zip'
    }
    if (h.startsWith('%PDF')) return 'pdf'
    if (b(0) === 0x89 && h.slice(1, 4) === 'PNG') return 'png'
    if (b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return 'jpg'
    if (h.startsWith('GIF8')) return 'gif'
    if (h.startsWith('RIFF') && h.slice(8, 12) === 'WEBP') return 'webp'
    if (h.startsWith('RIFF') && h.slice(8, 12) === 'WAVE') return 'wav'
    if (h.startsWith('BM') && u8.length > 54 && u8[14] >= 12 && u8[15] === 0) return 'bmp'
    if (h.startsWith('ID3') || (b(0) === 0xFF && (b(1) & 0xE0) === 0xE0 && /\.mp3/i.test(nameHint))) return 'mp3'
    if (h.startsWith('fLaC')) return 'flac'
    if (h.startsWith('OggS')) return 'ogg'
    if (h.slice(4, 8) === 'ftyp') return /M4A |M4B /.test(h.slice(8, 12)) ? 'm4a' : 'mp4'
    if (b(0) === 0x1A && b(1) === 0x45 && b(2) === 0xDF && b(3) === 0xA3) return h.includes('webm') ? 'webm' : 'mkv'
    if (h.startsWith('Rar!')) return 'rar'
    if (b(0) === 0x37 && b(1) === 0x7A && b(2) === 0xBC && b(3) === 0xAF) return '7z'
    if (b(0) === 0x1F && b(1) === 0x8B) return 'gz'
    if (h.startsWith('BZh')) return 'bz2'
    if (b(0) === 0xFD && h.slice(1, 6) === '7zXZ\0') return 'xz'
    if (b(0) === 0x28 && b(1) === 0xB5 && b(2) === 0x2F && b(3) === 0xFD) return 'zst'
    if (h.slice(257, 262) === 'ustar') return 'tar'
    if (h.startsWith('SQLite format 3')) return 'sqlite'
    if (h.startsWith('MZ')) return 'exe'
    if (h.startsWith('AT&TFORM') && h.slice(12, 16).startsWith('DJV')) return 'djvu'
    if (h.slice(60, 68) === 'BOOKMOBI' || h.slice(60, 68) === 'TEXtREAd') return 'mobi'
    if (h.startsWith('{\\rtf')) return 'rtf'
    if (/^\s*<\?xml[^>]*>\s*<FictionBook/.test(h)) return 'fb2'
    if (/^\s*(<!DOCTYPE html|<html)/i.test(h)) return 'html'
    if (/^\s*<svg[\s>]/.test(h) || /^\s*<\?xml[^>]*>\s*(<!--[\s\S]*?-->\s*)?<svg/.test(h)) return 'svg'
    if (h.startsWith('bplist')) return 'plist'
    if (b(0) === 0xD0 && b(1) === 0xCF && b(2) === 0x11 && b(3) === 0xE0) return 'ole'
    return null
}

// ---------- Резервные копии и недокачанные файлы ----------
export const BACKUP_EXTS = new Set(['bak', 'old', 'orig', 'tmp', 'backup', 'part', 'crdownload', 'download', 'partial'])
const OBSIDIAN_IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'])
const OBSIDIAN_MEDIA = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'oga', 'opus', '3gp', 'mp4', 'webm', 'mov', 'mkv', 'ogv'])
// Настоящее расширение: сначала по имени (отчёт.docx.bak → docx), потом по содержимому
export const realExtOf = (name, u8) => {
    const parts = name.toLowerCase().split('.')
    while (parts.length > 1 && (BACKUP_EXTS.has(parts[parts.length - 1]) || /^~|^\d+$|~$/.test(parts[parts.length - 1]))) parts.pop()
    const inner = parts.length > 1 ? parts[parts.length - 1].replace(/~$/, '') : ''
    const byBytes = sniffBytes(u8, name)
    if (inner && (FORMAT_BY_EXT.has(inner) || OBSIDIAN_IMAGES.has(inner) || OBSIDIAN_MEDIA.has(inner) || inner === 'md' || inner === 'pdf')) {
        // имя не врёт, если содержимое не противоречит явно (например, .docx.bak, а внутри не zip)
        if (!byBytes || byBytes === inner || ['zip', 'ole', 'xz', 'gz'].includes(byBytes) || (byBytes === 'jpg' && inner === 'jpeg')) return inner
    }
    if (byBytes && byBytes !== 'ole') return byBytes
    if (byBytes === 'ole') return inner || 'ole'
    return inner || null
}
export const nativeView = (ctx, url, ext) => {
    const wrap = el('div', 'ur-media-wrap')
    if (OBSIDIAN_IMAGES.has(ext)) { const img = el('img', 'ur-preview-img'); img.src = url; wrap.append(img); return wrap }
    const audio = ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'oga', 'opus'].includes(ext)
    const m = document.createElement(audio ? 'audio' : 'video'); m.controls = true; m.src = url; m.className = 'ur-media'
    wrap.append(m)
    return wrap
}
export const isObsidianNative = ext => OBSIDIAN_IMAGES.has(ext) || OBSIDIAN_MEDIA.has(ext)

// ---------- Выгрузки чатов: Телеграм, Discord, WhatsApp, SMS ----------
// Общий вид: { chats: [{ name, messages: [{ from, date, text, me, media: [{ kind, url, name }], service }] }], title }
const fmtDate = t => { const d = t instanceof Date ? t : new Date(t); return isNaN(d) ? '' : d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) }
const dayOf = t => { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) }
const linkify = s => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" class="external-link" target="_blank" rel="noopener">$1</a>')
export const chatView = (data, { pageSize = 400 } = {}) => {
    const wrap = el('div', 'ur-chat')
    const chats = data.chats.filter(c => c.messages.length)
    if (!chats.length) throw new ReaderError('В выгрузке нет сообщений.')
    const top = el('div', 'ur-chat-top ur-nosearch')
    wrap.append(top)
    const body = el('div', 'ur-chat-body')
    wrap.append(body)
    let sel = null
    if (chats.length > 1) {
        sel = document.createElement('select')
        chats.forEach((c, i) => sel.append(new Option(`${c.name || 'Без названия'} (${c.messages.length})`, i)))
        top.append(el('span', '', `Чатов: ${chats.length} · `), sel)
    }
    const show = idx => {
        const c = chats[idx]
        body.innerHTML = ''
        body.append(el('h2', '', esc(c.name || data.title || 'Переписка')))
        body.append(el('div', 'ur-meta', `Сообщений: ${c.messages.length.toLocaleString('ru-RU')}${c.messages[0]?.date ? ` · с ${dayOf(c.messages[0].date)} по ${dayOf(c.messages[c.messages.length - 1].date)}` : ''}`))
        let shown = 0, lastDay = ''
        const list = el('div', 'ur-chat-list')
        body.append(list)
        const more = el('button', 'ur-chat-more', '')
        const page = () => {
            const end = Math.min(c.messages.length, shown + pageSize)
            const frag = document.createDocumentFragment()
            for (let i = shown; i < end; i++) {
                const m = c.messages[i]
                const day = m.date ? dayOf(m.date) : ''
                if (day && day !== lastDay) { frag.append(el('div', 'ur-chat-day', esc(day))); lastDay = day }
                if (m.service) { frag.append(el('div', 'ur-chat-service', esc(m.text))); continue }
                const prev = c.messages[i - 1]
                const b = el('div', 'ur-chat-msg' + (m.me ? ' ur-chat-me' : ''))
                const sameAuthor = prev && !prev.service && prev.from === m.from && (!m.date || !prev.date || new Date(m.date) - new Date(prev.date) < 600000)
                b.innerHTML = (sameAuthor ? '' : `<div class="ur-chat-from">${esc(m.from || '—')}</div>`) +
                    (m.reply ? `<div class="ur-chat-reply">${esc(m.reply)}</div>` : '') +
                    (m.media ?? []).map(x => x.kind === 'image' && x.url ? `<img class="ur-chat-img" src="${esc(x.url)}" loading="lazy" alt="">` : `<div class="ur-chat-file">${x.kind === 'voice' ? '🎤' : x.kind === 'video' ? '🎬' : x.kind === 'sticker' ? '🙂' : x.kind === 'image' ? '🖼' : '📎'} ${esc(x.name || '')}</div>`).join('') +
                    (m.text ? `<div class="ur-chat-text">${linkify(m.text)}</div>` : '') +
                    `<div class="ur-chat-time">${m.date ? new Date(m.date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''}${m.edited ? ' · изменено' : ''}</div>`
                frag.append(b)
            }
            list.append(frag)
            shown = end
            more.textContent = `Показать ещё (осталось ${(c.messages.length - shown).toLocaleString('ru-RU')})`
            more.style.display = shown < c.messages.length ? '' : 'none'
        }
        more.onclick = page
        body.append(more)
        page()
    }
    sel?.addEventListener('change', () => show(+sel.value))
    show(0)
    return wrap
}

// Телеграм (result.json): одна переписка или весь аккаунт
const tgText = t => typeof t === 'string' ? t : Array.isArray(t) ? t.map(x => typeof x === 'string' ? x : x.text ?? '').join('') : ''
const TG_SERVICE = { create_group: 'создал(а) группу', invite_members: 'добавил(а) участников', remove_members: 'удалил(а) участников', join_group_by_link: 'присоединился(-ась) по ссылке', pin_message: 'закрепил(а) сообщение', phone_call: 'звонок', edit_group_title: 'переименовал(а) группу', edit_group_photo: 'сменил(а) фото группы', migrate_to_supergroup: 'группа стала супергруппой' }
export const isTelegram = j => j && (Array.isArray(j.messages) && ('type' in j || 'name' in j) && (j.messages[0]?.date || j.messages.length === 0) || Array.isArray(j.chats?.list))
export const parseTelegram = (j, urlFor) => {
    const meId = j.personal_information?.user_id != null ? 'user' + j.personal_information.user_id : null
    const raw = j.chats?.list ?? [j]
    const chats = raw.map(c => {
        const byId = new Map()
        const messages = (c.messages ?? []).map(m => {
            const media = []
            if (m.photo) media.push({ kind: 'image', url: urlFor(m.photo), name: '' })
            if (m.file) media.push({ kind: m.media_type === 'voice_message' ? 'voice' : m.media_type === 'video_file' || m.media_type === 'video_message' ? 'video' : m.media_type === 'sticker' ? 'sticker' : /\.(jpe?g|png|webp|gif)$/i.test(m.file) ? 'image' : 'file', url: /\.(jpe?g|png|webp|gif)$/i.test(m.file) ? urlFor(m.file) : null, name: m.sticker_emoji ?? m.file_name ?? m.file.split('/').pop() })
            if (m.location_information) media.push({ kind: 'file', name: `📍 ${m.location_information.latitude}, ${m.location_information.longitude}` })
            if (m.poll) media.push({ kind: 'file', name: '📊 Опрос: ' + m.poll.question })
            const out = { from: m.from ?? m.actor ?? '', date: m.date, text: tgText(m.text), me: meId && m.from_id === meId, media, edited: !!m.edited }
            if (m.type === 'service') { out.service = true; out.text = `${m.actor ?? ''} ${TG_SERVICE[m.action] ?? m.action ?? ''} ${tgText(m.text)}`.trim() }
            byId.set(m.id, out)
            if (m.reply_to_message_id != null) { const r = byId.get(m.reply_to_message_id); out.reply = r ? `↪ ${r.from}: ${r.text.slice(0, 80)}` : '↪ ответ' }
            return out
        })
        return { name: c.name ?? (c.type === 'saved_messages' ? 'Избранное' : ''), messages }
    })
    return { chats, title: 'Телеграм' }
}

// DiscordChatExporter (.json)
export const isDiscord = j => j && j.guild && j.channel && Array.isArray(j.messages)
export const parseDiscord = j => ({
    title: j.guild.name,
    chats: [{
        name: `${j.guild.name} · #${j.channel.name}`,
        messages: j.messages.map(m => ({
            from: m.author?.nickname || m.author?.name || '', date: m.timestamp, text: m.content ?? '', edited: !!m.timestampEdited,
            media: [...(m.attachments ?? []).map(a => ({ kind: /\.(png|jpe?g|gif|webp)$/i.test(a.fileName) ? 'image' : 'file', url: /^https?:/.test(a.url) ? null : null, name: a.fileName })), ...(m.embeds ?? []).filter(e => e.title).map(e => ({ kind: 'file', name: '🔗 ' + e.title }))],
            service: m.type && !['Default', 'Reply'].includes(m.type) && !m.content, reply: m.reference ? '↪ ответ' : '',
        })).map(m => m.service ? { ...m, text: m.text || m.from + ' — служебное сообщение' } : m),
    }],
})

// WhatsApp (_chat.txt, «Чат WhatsApp с …txt»)
const WA_LINE = /^‎?\[?(\d{1,4}[./-]\d{1,2}[./-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp]\.?\s?[Mm]\.?)?)\]?(?:\s[-–]\s|\s)(.*)$/
export const isWhatsapp = text => { const lines = text.slice(0, 5000).split(/\r?\n/).filter(Boolean).slice(0, 15); return lines.length >= 2 && lines.filter(l => WA_LINE.test(l)).length >= Math.min(3, lines.length) * 0.66 }
const waDate = (d, t, monthFirst) => {
    const p = d.split(/[./-]/).map(Number)
    let [day, mon, yr] = p
    if (monthFirst) [mon, day] = [p[0], p[1]] // американский порядок: месяц/день/год
    if (p[0] > 31) [yr, mon, day] = p
    if (yr < 100) yr += 2000
    let [hh, mm, ss = 0] = t.replace(/\s?[AaPp]\.?\s?[Mm]\.?/, '').split(':').map(Number)
    if (/p/i.test(t) && hh < 12) hh += 12; if (/a/i.test(t) && hh === 12) hh = 0
    return new Date(yr, mon - 1, day, hh, mm, ss)
}
export const parseWhatsapp = (text, title, urlFor) => {
    const messages = []
    // порядок день/месяц угадываем по всему файлу: число больше 12 бывает только днём
    let firstBig = false, secondBig = false, slash = false
    for (const m of text.matchAll(/^\u200e?\[?(\d{1,2})([./-])(\d{1,2})[./-]\d{2,4},/gm)) { if (+m[1] > 12) firstBig = true; if (+m[3] > 12) secondBig = true; if (m[2] === '/') slash = true }
    const monthFirst = secondBig && !firstBig ? true : firstBig ? false : slash
    for (const line of text.replace(/\r/g, '').split('\n')) {
        const m = WA_LINE.exec(line)
        if (!m) { if (messages.length && line) messages[messages.length - 1].text += '\n' + line; continue }
        const rest = m[3].replace(/^‎/, '')
        const c = rest.indexOf(': ')
        const date = waDate(m[1], m[2], monthFirst)
        if (c < 0) { messages.push({ service: true, text: rest, date }); continue }
        let body = rest.slice(c + 2).replace(/‎/g, '')
        const media = []
        const att = /<(?:attached|прикреплено|приложено):\s*([^>]+)>/i.exec(body) || /^(\S+\.(?:jpe?g|png|webp|opus|mp4|pdf|vcf|docx?|xlsx?)) \((?:file attached|файл прикреплён|файл приложен)\)/i.exec(body)
        if (att) {
            const n = att[1].trim()
            const kind = /\.(jpe?g|png|webp)$/i.test(n) ? 'image' : /\.opus$/i.test(n) ? 'voice' : /\.mp4$/i.test(n) ? 'video' : 'file'
            media.push({ kind, url: kind === 'image' ? urlFor(n) : null, name: n })
            body = body.replace(att[0], '').trim()
        }
        if (/^<(Media omitted|Без медиафайлов|Медиафайл пропущен)>$/i.test(body)) { media.push({ kind: 'file', name: 'медиафайл не выгружен' }); body = '' }
        messages.push({ from: rest.slice(0, c), date, text: body, media })
    }
    return { chats: [{ name: title.replace(/^(WhatsApp Chat with|Чат WhatsApp с)\s*/i, '').replace(/^_chat$/, 'WhatsApp'), messages }], title: 'WhatsApp' }
}

// SMS Backup & Restore (sms-*.xml), журнал звонков (calls-*.xml)
export const isSmsBackup = t => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(smses|calls)[\s>]/.test(t.slice(0, 2000))
export const parseSmsBackup = (text, ctxUrls) => {
    const d = new DOMParser().parseFromString(text, 'application/xml')
    if (d.querySelector('parsererror')) throw new ReaderError('Резервная копия SMS повреждена (ошибка XML).')
    if (d.documentElement.localName === 'calls') {
        const TYPES = { 1: 'входящий', 2: 'исходящий', 3: 'пропущенный', 4: 'голосовая почта', 5: 'отклонённый', 6: 'заблокирован' }
        const rows = [['Дата', 'Контакт', 'Номер', 'Тип', 'Длительность']]
        for (const c of d.getElementsByTagName('call')) { const s = +c.getAttribute('duration') || 0; rows.push([fmtDate(+c.getAttribute('date')), c.getAttribute('contact_name') ?? '', c.getAttribute('number') ?? '', TYPES[c.getAttribute('type')] ?? c.getAttribute('type'), `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`]) }
        return { calls: [{ name: 'Звонки', rows }] }
    }
    const conv = new Map()
    const add = (addr, name, m) => { const k = addr || name || '?'; if (!conv.has(k)) conv.set(k, { name: name && name !== '(Unknown)' ? `${name} (${addr})` : addr, messages: [] }); conv.get(k).messages.push(m) }
    for (const s of d.getElementsByTagName('sms')) {
        const me = s.getAttribute('type') === '2'
        add(s.getAttribute('address'), s.getAttribute('contact_name'), { from: me ? 'Я' : (s.getAttribute('contact_name') !== '(Unknown)' && s.getAttribute('contact_name')) || s.getAttribute('address'), date: +s.getAttribute('date'), text: s.getAttribute('body') ?? '', me })
    }
    for (const s of d.getElementsByTagName('mms')) {
        const me = s.getAttribute('msg_box') === '2'
        let text = '', media = []
        for (const p of s.getElementsByTagName('part')) {
            const ct = p.getAttribute('ct') ?? ''
            if (ct === 'text/plain') text += p.getAttribute('text') ?? ''
            else if (ct.startsWith('image/') && p.getAttribute('data')) {
                const bin = atob(p.getAttribute('data')); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
                const url = URL.createObjectURL(new Blob([u], { type: ct })); ctxUrls.push(url)
                media.push({ kind: 'image', url })
            } else if (ct !== 'application/smil') media.push({ kind: 'file', name: p.getAttribute('cl') || ct })
        }
        add(s.getAttribute('address'), s.getAttribute('contact_name'), { from: me ? 'Я' : s.getAttribute('contact_name') || s.getAttribute('address'), date: +s.getAttribute('date'), text, me, media })
    }
    const chats = [...conv.values()].map(c => ({ ...c, messages: c.messages.sort((a, b) => a.date - b.date) })).sort((a, b) => b.messages.length - a.messages.length)
    return { chats, title: 'SMS' }
}

// ---------- История перемещений Google (Takeout и выгрузка с телефона) ----------
const geo = s => { const m = /(-?[\d.]+)°?,\s*(-?[\d.]+)/.exec(String(s ?? '').replace(/^geo:/, '')); return m ? [+m[2], +m[1]] : null }
const e7 = (o, a = 'latitudeE7', b = 'longitudeE7') => o && o[a] != null ? [o[b] / 1e7, o[a] / 1e7] : null
export const isLocationHistory = j => j && (Array.isArray(j.locations) && j.locations[0]?.latitudeE7 != null || Array.isArray(j.timelineObjects) || Array.isArray(j.semanticSegments) || (Array.isArray(j) && j[0] && ('visit' in j[0] || 'activity' in j[0] || 'timelinePath' in j[0]) && 'startTime' in j[0]))
const ACT = { WALKING: 'пешком', RUNNING: 'бег', CYCLING: 'велосипед', IN_PASSENGER_VEHICLE: 'на машине', IN_VEHICLE: 'на машине', IN_BUS: 'на автобусе', IN_SUBWAY: 'на метро', IN_TRAIN: 'на поезде', IN_TRAM: 'на трамвае', FLYING: 'самолётом', IN_FERRY: 'на пароме', walking: 'пешком', cycling: 'велосипед', in_passenger_vehicle: 'на машине', in_bus: 'на автобусе', in_subway: 'на метро', in_train: 'на поезде', flying: 'самолётом', running: 'бег' }
export const parseLocationHistory = j => {
    const feats = []
    const when = (a, b) => [fmtDate(a), b ? fmtDate(b) : ''].filter(Boolean).join(' — ')
    if (Array.isArray(j.locations)) {
        // Records.json: миллионы точек — линия на каждый день, не больше 2000 точек в дне
        const days = new Map()
        for (const l of j.locations) {
            const p = e7(l); if (!p) continue
            const t = l.timestamp ? Date.parse(l.timestamp) : +l.timestampMs
            const k = new Date(t).toISOString().slice(0, 10)
            if (!days.has(k)) days.set(k, [])
            days.get(k).push([p[0], p[1], undefined, t])
        }
        for (const [k, pts] of [...days].sort()) {
            const step = Math.max(1, Math.floor(pts.length / 2000))
            feats.push({ kind: 'line', coords: pts.filter((_, i) => i % step === 0), name: new Date(k).toLocaleDateString('ru-RU'), track: true })
        }
    } else {
        const objs = j.timelineObjects ?? j.semanticSegments ?? j
        for (const o of objs) {
            const pv = o.placeVisit, as = o.activitySegment
            if (pv) { const p = e7(pv.location); if (p) feats.push({ kind: 'point', coords: [p], name: pv.location.name || pv.location.address || 'Место', desc: when(pv.duration?.startTimestamp, pv.duration?.endTimestamp) }) }
            if (as) {
                const pts = (as.simplifiedRawPath?.points ?? as.waypointPath?.waypoints ?? []).map(w => e7(w, 'latE7', 'lngE7')).filter(Boolean)
                const line = [e7(as.startLocation), ...pts, e7(as.endLocation)].filter(Boolean)
                if (line.length > 1) feats.push({ kind: 'line', coords: line, name: ACT[as.activityType] ?? as.activityType ?? 'Поездка', desc: when(as.duration?.startTimestamp, as.duration?.endTimestamp) })
            }
            if (o.visit) { const p = geo(o.visit.topCandidate?.placeLocation?.latLng ?? o.visit.topCandidate?.placeLocation); if (p) feats.push({ kind: 'point', coords: [p], name: o.visit.topCandidate?.semanticType && o.visit.topCandidate.semanticType !== 'UNKNOWN' ? o.visit.topCandidate.semanticType : 'Место', desc: when(o.startTime, o.endTime) }) }
            if (o.activity) { const a = geo(o.activity.start?.latLng ?? o.activity.start), b = geo(o.activity.end?.latLng ?? o.activity.end); if (a && b) feats.push({ kind: 'line', coords: [a, b], name: ACT[o.activity.topCandidate?.type] ?? o.activity.topCandidate?.type ?? 'Поездка', desc: when(o.startTime, o.endTime) }) }
            if (o.timelinePath?.length > 1) { const pts = o.timelinePath.map(p => geo(p.point)).filter(Boolean); if (pts.length > 1) feats.push({ kind: 'line', coords: pts, name: 'Путь', desc: when(o.startTime, o.endTime) }) }
        }
    }
    if (!feats.length) throw new ReaderError('В истории перемещений нет точек.')
    return { feats, title: 'История перемещений' }
}

// ---------- Выписки 1С «Клиент — Банк» (kl_to_1c.txt) ----------
export const is1C = t => t.trimStart().startsWith('1CClientBankExchange')
export const parse1C = text => {
    const docs = [], acc = []
    let cur = null, sect = null
    for (const raw of text.replace(/\r/g, '').split('\n')) {
        const l = raw.trim()
        if (l.startsWith(NT('СекцияДокумент='))) { cur = { 'Вид': l.split('=')[1] }; docs.push(cur); continue }
        if (l === NT('КонецДокумента')) { cur = null; continue }
        if (l === NT('СекцияРасчСчет')) { sect = {}; acc.push(sect); continue }
        if (l === NT('КонецРасчСчет')) { sect = null; continue }
        const i = l.indexOf('='); if (i < 0) continue
        const k = l.slice(0, i), v = l.slice(i + 1)
        if (cur) cur[k] = v; else if (sect) sect[k] = v
    }
    const cols = [['Дата', NT('Дата')], ['Номер', NT('Номер')], ['Вид', NT('Вид')], ['Сумма', NT('Сумма')], ['Плательщик', NT('Плательщик1')], ['Плательщик', NT('Плательщик')], ['Получатель', NT('Получатель1')], ['Получатель', NT('Получатель')], ['Назначение платежа', NT('НазначениеПлатежа')], ['Списано', NT('ДатаСписано')], ['Поступило', NT('ДатаПоступило')]]
    const used = []
    for (const [title, key] of cols) if (docs.some(d => d[key]) && !used.some(u => u[0] === title)) used.push([title, key])
    const sheets = [{ name: 'Платежи', rows: [used.map(u => u[0]), ...docs.map(d => used.map(u => d[u[1]] ?? ''))] }]
    if (acc.length) { const ks = [...new Set(acc.flatMap(a => Object.keys(a)))]; sheets.push({ name: 'Счета', rows: [ks, ...acc.map(a => ks.map(k => a[k] ?? ''))] }) }
    if (!docs.length && !acc.length) throw new ReaderError('В выгрузке 1С нет документов.')
    return sheets
}

// ---------- EBU STL — телевизионные субтитры (у .stl есть и 3D-модели) ----------
export const isEbuStl = u8 => /^\d{3}STL(25|30)\.01/.test(head(u8, 12))
export const parseEbuStl = u8 => {
    const fps = head(u8, 12).includes('STL30') ? 30 : 25
    const cct = latin.decode(u8.subarray(12, 14))
    const dec = cct === '01' ? new TextDecoder('iso-8859-5') : cct === '03' ? new TextDecoder('iso-8859-7') : cct === '04' ? new TextDecoder('iso-8859-8') : cct === '02' ? new TextDecoder('iso-8859-6') : latin
    const title = latin.decode(u8.subarray(16, 48)).trim()
    const cues = []
    let cur = null
    for (let o = 1024; o + 128 <= u8.length; o += 128) {
        const sn = u8[o + 1] | u8[o + 2] << 8, ebn = u8[o + 3]
        if (ebn === 0xFE) continue // пользовательские данные
        const tc = i => (u8[o + i] * 3600 + u8[o + i + 1] * 60 + u8[o + i + 2]) + u8[o + i + 3] / fps
        const tf = u8.subarray(o + 16, o + 128)
        let s = ''
        const bytes = []
        const flush = () => { if (bytes.length) { s += dec.decode(new Uint8Array(bytes)); bytes.length = 0 } }
        for (const c of tf) {
            if (c === 0x8A) { flush(); s += '\n' } else if (c === 0x8F) break
            else if (c < 0x20 || (c >= 0x80 && c <= 0x9F)) { flush(); if (c < 0x20 && s && !s.endsWith(' ') && !s.endsWith('\n')) s += ' ' }
            else bytes.push(c)
        }
        flush()
        if (cur && cur.sn === sn) cur.text += s
        else { cur = { sn, start: tc(5), end: tc(9), speaker: '', text: s }; cues.push(cur) }
    }
    for (const c of cues) c.text = c.text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim()
    return { cues: cues.filter(c => c.text), title }
}

// ---------- Thumbs.db: миниатюры, которые Windows XP сохраняла в папках ----------
export const isOle = u8 => u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0
export const openThumbsDb = async (ctx, buf) => {
    const XLSX = await ctx.loadLib('xlsx')
    let cfb
    try { cfb = XLSX.CFB.read(new Uint8Array(buf), { type: 'array' }) } catch { throw new ReaderError('Файл Thumbs.db пустой или повреждён.') }
    const names = new Map()
    const cat = cfb.FileIndex.find(f => f.name === 'Catalog')
    if (cat?.content) {
        const c = cat.content instanceof Uint8Array ? cat.content : new Uint8Array(cat.content)
        const dv = new DataView(c.buffer, c.byteOffset, c.byteLength)
        let p = dv.getUint16(0, true) // длина заголовка
        const count = dv.getUint32(4, true)
        for (let i = 0; i < count && p + 16 < c.length; i++) {
            const len = dv.getUint32(p, true), id = dv.getUint32(p + 4, true)
            let e = p + 16; let n = ''
            while (e + 1 < p + len) { const ch = dv.getUint16(e, true); if (!ch) break; n += String.fromCharCode(ch); e += 2 }
            names.set(String(id).split('').reverse().join(''), n)
            if (!len) break
            p += len
        }
    }
    const items = []
    for (const f of cfb.FileIndex) {
        if (f.type !== 2 || !f.content || f.name === 'Catalog') continue
        const c = f.content instanceof Uint8Array ? f.content : new Uint8Array(f.content)
        let s = -1
        for (let i = 0; i < Math.min(64, c.length - 2); i++) if (c[i] === 0xFF && c[i + 1] === 0xD8 && c[i + 2] === 0xFF) { s = i; break }
        if (s < 0) continue
        const url = URL.createObjectURL(new Blob([c.subarray(s)], { type: 'image/jpeg' })); ctx.urls.push(url)
        items.push({ url, name: names.get(f.name) ?? f.name })
    }
    if (!items.length) throw new ReaderError('В файле Thumbs.db нет миниатюр (или он в формате новых Windows).')
    const wrap = el('div', '', `<h2>Миниатюры папки</h2><p class="ur-muted">Thumbs.db — служебный файл Windows: в нём хранятся уменьшенные копии картинок из этой папки (даже тех, что уже удалены). Миниатюр: ${items.length}.</p>`)
    const grid = el('div', 'ur-thumbs-grid')
    for (const it of items) grid.append(el('figure', '', `<img src="${it.url}" loading="lazy" alt=""><figcaption>${esc(it.name)}</figcaption>`))
    wrap.append(grid)
    return wrap
}

// ---------- VCF: визитки или геномные варианты; Qt Linguist .ts; SMILES .smi ----------
export const isVcfGenomic = t => t.startsWith('##fileformat=VCF')
export const readVcfGenomic = (text, title) => {
    const lines = text.replace(/\r/g, '').split('\n')
    const meta = lines.filter(l => l.startsWith('##'))
    const hdr = lines.find(l => l.startsWith('#CHROM'))?.slice(1).split('\t') ?? ['CHROM', 'POS', 'ID', 'REF', 'ALT', 'QUAL', 'FILTER', 'INFO']
    const rows = lines.filter(l => l && !l.startsWith('#')).slice(0, 100000).map(l => l.split('\t'))
    return [{ name: title, rows: [hdr, ...rows] }, { name: 'Заголовок', rows: [['Строка'], ...meta.map(m => [m])] }]
}
export const parseQtTs = text => {
    const d = new DOMParser().parseFromString(text, 'application/xml')
    if (d.querySelector('parsererror')) throw new ReaderError('Файл перевода повреждён (ошибка XML).')
    const lang = d.documentElement.getAttribute('language')
    return Array.from(d.getElementsByTagName('message')).map(m => ({ msgid: m.getElementsByTagName('source')[0]?.textContent ?? '', msgstr: [m.getElementsByTagName('translation')[0]?.textContent ?? ''], ctx: m.parentElement?.getElementsByTagName('name')[0]?.textContent ?? '', comments: lang ? [] : [], fuzzy: m.getElementsByTagName('translation')[0]?.getAttribute('type') === 'unfinished' }))
}

// ---------- Плоттеры HPGL (.plt, .hpgl) ----------
export const isHpgl = t => /^\s*(\x1b%-?\d*[AB])?\s*(IN|DF|PU|SP|IP|SC)[;\s\d-]/.test(t.slice(0, 200))
export const hpglView = (ctx, text) => {
    let x = 0, y = 0, pen = 1, down = false, abs = true
    const paths = []; let cur = null
    const COLORS = ['#000', '#000', '#d00', '#090', '#00c', '#c0c', '#0aa', '#a60', '#666']
    const moveTo = (nx, ny) => {
        if (down) { if (!cur) { cur = { pen, pts: [[x, y]] }; paths.push(cur) } cur.pts.push([nx, ny]) } else cur = null
        x = nx; y = ny
    }
    for (const cmd of text.replace(/\x1b[^A-Za-z]*[A-Za-z]/g, '').split(/;|\n/)) {
        const m = /^\s*([A-Z]{2})(.*)$/i.exec(cmd); if (!m) continue
        const op = m[1].toUpperCase(), nums = m[2].split(/[\s,]+/).filter(Boolean).map(Number)
        if (op === 'SP') { pen = nums[0] || 0; cur = null; continue }
        if (op === 'PA' || op === 'PR') abs = op === 'PA'
        if (op === 'PU' || op === 'PD') { down = op === 'PD'; cur = down ? cur : null }
        if (['PU', 'PD', 'PA', 'PR'].includes(op)) for (let i = 0; i + 1 < nums.length; i += 2) moveTo(abs ? nums[i] : x + nums[i], abs ? nums[i + 1] : y + nums[i + 1])
        if (op === 'CI' && nums[0]) { const r = nums[0]; const c = { pen, pts: [] }; for (let a = 0; a <= 36; a++) c.pts.push([x + r * Math.cos(a * Math.PI / 18), y + r * Math.sin(a * Math.PI / 18)]); paths.push(c) }
    }
    if (!paths.length) throw new ReaderError('В файле нет линий для плоттера.')
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of paths) for (const [a, b] of p.pts) { minX = Math.min(minX, a); maxX = Math.max(maxX, a); minY = Math.min(minY, b); maxY = Math.max(maxY, b) }
    const w = maxX - minX || 1, h = maxY - minY || 1, pad = Math.max(w, h) * 0.03
    const dark = ctx.isDark?.()
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${-maxY - pad} ${w + 2 * pad} ${h + 2 * pad}" style="width:100%;max-height:80vh;background:${dark ? '#1e1e1e' : '#fff'}">${paths.map(p => `<polyline fill="none" stroke="${dark && p.pen <= 1 ? '#ddd' : COLORS[p.pen % COLORS.length]}" stroke-width="${Math.max(w, h) / 1500}" points="${p.pts.map(([a, b]) => `${a},${-b}`).join(' ')}"/>`).join('')}</svg>`
    return el('div', 'ur-hpgl', `<div class="ur-meta">Чертёж для плоттера HPGL · линий: ${paths.length} · размер ${Math.round(w / 40)} × ${Math.round(h / 40)} мм</div>${svg}`)
}

// ---------- Молекулы XYZ (у .xyz бывают и облака точек) ----------
export const isXyzMolecule = t => { const l = t.split(/\r?\n/, 4); return /^\s*\d+\s*$/.test(l[0] ?? '') && /^\s*[A-Z][a-z]?\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+/.test(l[2] ?? '') }
export const parseXyzMolecule = text => {
    const lines = text.replace(/\r/g, '').split('\n')
    const atoms = []
    let i = 0
    while (i < lines.length && /^\s*\d+\s*$/.test(lines[i])) { // в файле может быть несколько кадров — берём первый
        const n = +lines[i]; const comment = lines[i + 1] ?? ''
        for (let k = 0; k < n; k++) { const f = (lines[i + 2 + k] ?? '').trim().split(/\s+/); if (f.length >= 4) atoms.push({ el: f[0], x: +f[1], y: +f[2], z: +f[3] }) }
        return { atoms, title: comment.trim() }
    }
    return { atoms, title: '' }
}
