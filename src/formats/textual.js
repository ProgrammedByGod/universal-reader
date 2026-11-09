// Разбор «текстовых» форматов с особым видом: субтитры, тексты песен, контакты, календарь,
// OPML, RSS/Atom, переводы .po, письма .eml, списки литературы, .nfo, diff, сценарии Fountain.
import { escapeHtml as esc, decodeText, ReaderError } from '../util.js'
import { NT, plural } from '../i18n.js'

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
const DAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
const nl2br = s => esc(s).replace(/\n/g, '<br>')
const linkify = s => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" class="external-link" target="_blank" rel="noopener">$1</a>')

export const assertText = (text, hint = '') => {
    if (text.slice(0, 4000).includes('\u0000')) throw new ReaderError('Похоже, это двоичный файл, а не текст.' + (hint ? ' ' + hint : ''))
}

// ================= Субтитры =================
const fmtTime = sec => {
    if (sec == null || !isFinite(sec)) return ''
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60)
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0')
}
const parseClock = t => {
    const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,:](\d{1,3}))?/.exec(t)
    if (!m) return null
    return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4].padEnd(3, '0')) / 1000 : 0)
}
const cleanCue = s => s
    .replace(/\{\\[^}]*\}/g, '')            // теги ASS {\i1}
    .replace(/\\N|\\n/g, '\n').replace(/\\h/g, ' ')
    .replace(/<\/?(?:i|b|u|s|font|c|ruby|rt|lang)[^>]*>/gi, '')
    .replace(/<\d{1,2}:\d{2}[^>]*>/g, '')   // таймкоды внутри реплик VTT
    .replace(/\{[^}]*\}/g, '')              // остатки {an8}
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim()

export const parseSubtitles = (text, ext) => {
    text = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '')
    const cues = []
    if (ext === 'srt' || ext === 'vtt') {
        for (const block of text.split(/\n\s*\n/)) {
            const lines = block.split('\n').filter(l => l.trim() !== '')
            const ti = lines.findIndex(l => l.includes('-->'))
            if (ti < 0) continue
            if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue
            const [a, b] = lines[ti].split('-->')
            let body = lines.slice(ti + 1).join('\n')
            let speaker = ''
            const v = /<v(?:\.[^ >]*)?\s+([^>]+)>/.exec(body)
            if (v) { speaker = v[1].trim(); body = body.replace(/<\/?v[^>]*>/g, '') }
            cues.push({ start: parseClock(a), end: parseClock(b), speaker, text: cleanCue(body) })
        }
    }
    if (ext === 'sbv') {
        for (const block of text.split(/\n\s*\n/)) {
            const lines = block.split('\n')
            const m = /^([\d:.]+),([\d:.]+)$/.exec(lines[0]?.trim() || '')
            if (!m) continue
            cues.push({ start: parseClock(m[1]), end: parseClock(m[2]), speaker: '', text: cleanCue(lines.slice(1).join('\n')) })
        }
    } else if (ext === 'ass' || ext === 'ssa') {
        let fields = null, inEvents = false
        for (const line of text.split('\n')) {
            if (/^\[events\]/i.test(line.trim())) { inEvents = true; continue }
            if (/^\[/.test(line.trim())) { inEvents = false; continue }
            if (!inEvents) continue
            if (/^Format:/i.test(line)) { fields = line.slice(7).split(',').map(f => f.trim().toLowerCase()); continue }
            if (!/^Dialogue:/i.test(line) || !fields) continue
            const parts = line.slice(line.indexOf(':') + 1).split(',')
            const rec = {}
            fields.forEach((f, i) => { rec[f] = i === fields.length - 1 ? parts.slice(i).join(',') : (parts[i] ?? '').trim() })
            const body = cleanCue(rec.text ?? '')
            if (body) cues.push({ start: parseClock(rec.start), end: parseClock(rec.end), speaker: rec.name || rec.actor || '', text: body })
        }
    } else if (ext === 'sub') {
        let fps = 25
        for (const line of text.split('\n')) {
            const m = /^\{(\d+)\}\{(\d*)\}(.*)$/.exec(line.trim())
            if (!m) continue
            if (m[1] === '1' && m[2] === '1' && /^\d+([.,]\d+)?$/.test(m[3].trim())) { fps = parseFloat(m[3].replace(',', '.')); continue }
            cues.push({ start: Number(m[1]) / fps, end: m[2] ? Number(m[2]) / fps : null, speaker: '', text: cleanCue(m[3].replace(/\|/g, '\n')) })
        }
        if (!cues.length) {
            // SubViewer 2: [INFORMATION]… 00:00:01.00,00:00:04.00 \n текст
            for (const block of text.split(/\n\s*\n/)) {
                const lines = block.split('\n')
                const m = /^(\d+:\d+:\d+[.,]\d+),(\d+:\d+:\d+[.,]\d+)/.exec(lines[0] || '')
                if (m) cues.push({ start: parseClock(m[1]), end: parseClock(m[2]), speaker: '', text: cleanCue(lines.slice(1).join('\n').replace(/\[br\]/gi, '\n')) })
            }
        }
    }
    else if (ext === 'mpl') {
        // MPL2: [начало][конец]текст|вторая строка, время в десятых долях секунды, «/» — курсив
        for (const l of text.split('\n')) {
            const m = /^\[(\d+)\]\[(\d*)\](.*)$/.exec(l.trim())
            if (m) cues.push({ start: +m[1] / 10, end: m[2] ? +m[2] / 10 : null, speaker: '', text: m[3].split('|').map(x => x.replace(/^\//, '')).join('\n') })
        }
    } else if (ext === 'usf') {
        const doc = new DOMParser().parseFromString(text, 'application/xml')
        if (doc.querySelector('parsererror')) throw new ReaderError('Файл субтитров повреждён (ошибка XML).')
        for (const s of doc.getElementsByTagName('subtitle')) {
            const body = Array.from(s.getElementsByTagName('text')).map(t => t.textContent.trim()).join('\n') || s.textContent.trim()
            const start = parseClock(s.getAttribute('start') ?? ''), end = parseClock(s.getAttribute('stop') ?? '') ?? (start != null && s.getAttribute('duration') ? start + (parseClock(s.getAttribute('duration')) ?? 0) : null)
            if (body) cues.push({ start, end, speaker: '', text: body })
        }
    } else if (ext === 'ttml' || ext === 'dfxp') {
        const doc = new DOMParser().parseFromString(text, 'application/xml')
        if (doc.querySelector('parsererror')) throw new ReaderError('Файл субтитров повреждён (ошибка XML).')
        const root = doc.documentElement
        const attr = (el, name) => el.getAttribute(name) ?? [...el.attributes].find(a => a.localName === name)?.value
        const tickRate = Number(attr(root, 'tickRate')) || 10_000_000
        const frameRate = Number(attr(root, 'frameRate')) || 30
        const t = v => {
            if (!v) return null
            let m = /^([\d.]+)(h|m|s|ms|f|t)$/.exec(v.trim())
            if (m) { const n = parseFloat(m[1]); return { h: n * 3600, m: n * 60, s: n, ms: n / 1000, f: n / frameRate, t: n / tickRate }[m[2]] }
            m = /^(\d+):(\d{2}):(\d{2})(?:([.:])(\d+))?$/.exec(v.trim())
            if (!m) return null
            const frac = m[5] ? (m[4] === ':' ? Number(m[5]) / frameRate : Number('0.' + m[5])) : 0
            return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac
        }
        for (const p of doc.getElementsByTagNameNS('*', 'p')) {
            const clone = p.cloneNode(true)
            for (const br of [...clone.getElementsByTagNameNS('*', 'br')]) br.replaceWith('\n')
            const start = t(attr(p, 'begin')), end = t(attr(p, 'end')) ?? (start != null && t(attr(p, 'dur')) != null ? start + t(attr(p, 'dur')) : null)
            const body = clone.textContent.replace(/[ \t]+/g, ' ').trim()
            if (body) cues.push({ start, end, speaker: '', text: body })
        }
    } else if (ext === 'smi') {
        const re = /<SYNC\s+Start\s*=\s*"?(\d+)"?[^>]*>([\s\S]*?)(?=<SYNC|<\/BODY|$)/gi
        let m, prev = null
        while ((m = re.exec(text))) {
            const start = Number(m[1]) / 1000
            if (prev) prev.end = start
            const body = cleanCue(m[2].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' '))
            prev = body ? { start, end: null, speaker: '', text: body } : null
            if (prev) cues.push(prev)
        }
    }
    cues.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
    if (!cues.length) throw new ReaderError('Не удалось найти реплики в файле субтитров.' + (ext === 'sub' ? ' Возможно, это субтитры-картинки VobSub (пара .sub + .idx) — их прочитать как текст нельзя.' : ''))
    return cues
}
export const subtitlesTable = cues => {
    const rows = cues.map(c => `<tr><td class="ur-sub-time">${fmtTime(c.start)}${c.end != null ? `<span>–${fmtTime(c.end)}</span>` : ''}</td><td>${c.speaker ? `<b>${esc(c.speaker)}:</b> ` : ''}${nl2br(c.text)}</td></tr>`)
    return `<div class="ur-meta">${cues.length} реплик · длительность ${fmtTime(cues.at(-1)?.end ?? cues.at(-1)?.start)}</div><table class="ur-sub-table">${rows.join('')}</table>`
}
export const subtitlesText = cues => {
    // склеиваем реплики в абзацы: новый абзац при паузе > 2,5 c или смене говорящего
    const paras = []
    let cur = [], prevEnd = null, prevSpeaker = null
    for (const c of cues) {
        const pause = prevEnd != null && c.start != null && c.start - prevEnd > 2.5
        if (cur.length && (pause || (c.speaker && c.speaker !== prevSpeaker))) { paras.push(cur); cur = [] }
        cur.push(c); prevEnd = c.end ?? c.start; prevSpeaker = c.speaker || prevSpeaker
    }
    if (cur.length) paras.push(cur)
    return paras.map(p => `<p>${p[0].speaker ? `<b>${esc(p[0].speaker)}:</b> ` : ''}${p.map(c => esc(c.text.replace(/\n/g, ' '))).join(' ')}</p>`).join('')
}

// ================= Тексты песен .lrc =================
export const parseLrc = text => {
    const meta = {}, lines = []
    for (const raw of text.replace(/\r/g, '').split('\n')) {
        const tags = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)]
        const m = /^\[(ti|ar|al|by|au|length):([^\]]*)\]$/i.exec(raw.trim())
        if (m) { meta[m[1].toLowerCase()] = m[2].trim(); continue }
        const body = raw.replace(/\[[^\]]*\]/g, '').replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim()
        if (!tags.length) { if (body) lines.push({ t: null, text: body }); continue }
        for (const t of tags) lines.push({ t: Number(t[1]) * 60 + parseFloat(t[2].replace(':', '.')), text: body })
    }
    lines.sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
    return { meta, lines }
}
export const lrcView = ({ meta, lines }, withTime) => {
    const head = [meta.ti && `<h2>${esc(meta.ti)}</h2>`, (meta.ar || meta.al) && `<div class="ur-meta">${esc([meta.ar, meta.al].filter(Boolean).join(' — '))}</div>`].filter(Boolean).join('')
    let html = '', prev = null
    for (const l of lines) {
        if (!l.text) { html += '<br>'; continue }
        if (!withTime && prev != null && l.t != null && l.t - prev > 8) html += '<br>'
        html += `<div class="ur-lrc-line">${withTime && l.t != null ? `<span class="ur-sub-time">${fmtTime(l.t)}</span> ` : ''}${esc(l.text)}</div>`
        prev = l.t
    }
    return head + `<div class="ur-lrc">${html}</div>`
}

// ================= vCard / iCalendar: общий построчный разбор =================
const decodeQP = (s, charset = 'utf-8') => {
    const bytes = []
    s = s.replace(/=\r?\n/g, '')
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '=' && /^[0-9A-F]{2}$/i.test(s.substr(i + 1, 2))) { bytes.push(parseInt(s.substr(i + 1, 2), 16)); i += 2 }
        else { const c = s.charCodeAt(i); if (c < 128) bytes.push(c); else bytes.push(...new TextEncoder().encode(s[i])) }
    }
    try { return new TextDecoder(charset).decode(new Uint8Array(bytes)) } catch { return new TextDecoder().decode(new Uint8Array(bytes)) }
}
const unfold = text => {
    text = text.replace(/\r\n?/g, '\n')
    // QUOTED-PRINTABLE в vCard 2.1 переносится через «=» в конце строки
    text = text.replace(/=\n(?=[^\n])/g, m => m)
    const out = []
    for (const line of text.split('\n')) {
        if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += line.slice(1)
        else if (out.length && /QUOTED-PRINTABLE/i.test(out[out.length - 1]) && out[out.length - 1].endsWith('=')) out[out.length - 1] = out[out.length - 1].slice(0, -1) + line
        else out.push(line)
    }
    return out.filter(Boolean)
}
const parseProp = line => {
    const i = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    if (i < 0) return null
    const left = line.slice(0, i), value = line.slice(i + 1)
    const [nameRaw, ...paramParts] = left.split(';')
    const params = {}
    for (const p of paramParts) {
        const [k, v] = p.split('=')
        if (v === undefined) (params.TYPE ??= []).push(k.toUpperCase())
        else (params[k.toUpperCase()] ??= []).push(...v.replace(/"/g, '').split(',').map(x => x.toUpperCase()))
    }
    const name = nameRaw.replace(/^item\d+\./i, '').toUpperCase()
    let v = value
    if (params.ENCODING?.includes('QUOTED-PRINTABLE')) v = decodeQP(v, (params.CHARSET?.[0] || 'utf-8').toLowerCase())
    return { name, params, value: v }
}
const icsUnescape = s => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')

// ----- vCard -----
const TEL_TYPES = { CELL: 'моб.', HOME: 'дом.', WORK: 'раб.', FAX: 'факс', MAIN: 'осн.', VOICE: '' }
export const parseVcf = text => {
    const cards = []
    let cur = null
    for (const line of unfold(text)) {
        if (/^BEGIN:VCARD/i.test(line)) { cur = { tel: [], email: [], adr: [], url: [], props: {} }; continue }
        if (/^END:VCARD/i.test(line)) { if (cur) cards.push(cur); cur = null; continue }
        if (!cur) continue
        const p = parseProp(line)
        if (!p) continue
        const v = icsUnescape(p.value)
        switch (p.name) {
            case 'FN': cur.fn = v; break
            case 'N': cur.n = v.split(';'); break
            case 'ORG': cur.org = v.split(';').filter(Boolean).join(', '); break
            case 'TITLE': cur.title = v; break
            case 'TEL': cur.tel.push({ v, t: (p.params.TYPE || []).map(t => TEL_TYPES[t] ?? '').filter(Boolean).join(', ') }); break
            case 'EMAIL': cur.email.push(v); break
            case 'ADR': cur.adr.push(v.split(';').filter(x => x.trim()).join(', ')); break
            case 'URL': cur.url.push(v); break
            case 'BDAY': cur.bday = v; break
            case 'NOTE': cur.note = v; break
            case 'NICKNAME': cur.nick = v; break
            case 'PHOTO': {
                if (/^(https?|data):/i.test(p.value)) cur.photo = p.value
                else if (p.params.ENCODING?.some(e => e === 'B' || e === 'BASE64')) cur.photo = `data:image/${(p.params.TYPE?.[0] || 'jpeg').toLowerCase()};base64,${p.value}`
                break
            }
        }
    }
    for (const c of cards) c.name = c.fn || (c.n ? [c.n[1], c.n[2], c.n[0]].filter(Boolean).join(' ') : '') || c.org || c.email[0] || 'Без имени'
    return cards.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
}
const fmtBday = v => {
    const m = /^(\d{4}|--)-?(\d{2})-?(\d{2})/.exec(v)
    if (!m) return v
    return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${m[1] !== '--' && m[1] !== '1604' ? ' ' + m[1] : ''}`
}
export const vcfView = cards => {
    const items = cards.map(c => `<div class="ur-card">
        ${c.photo ? `<img class="ur-card-photo" src="${esc(c.photo)}">` : `<div class="ur-card-photo ur-card-initial">${esc(c.name[0] || '?')}</div>`}
        <div class="ur-card-body"><div class="ur-card-name">${esc(c.name)}</div>
        ${c.nick ? `<div class="ur-card-sub">«${esc(c.nick)}»</div>` : ''}
        ${c.org || c.title ? `<div class="ur-card-sub">${esc([c.org, c.title].filter(Boolean).join(', '))}</div>` : ''}
        ${c.tel.map(t => `<div>📞 ${esc(t.v)}${t.t ? ` <span class="ur-muted">(${esc(t.t)})</span>` : ''}</div>`).join('')}
        ${c.email.map(e => `<div>✉ <a href="mailto:${esc(e)}">${esc(e)}</a></div>`).join('')}
        ${c.adr.map(a => `<div>🏠 ${esc(a)}</div>`).join('')}
        ${c.url.map(u => `<div>🔗 ${linkify(u)}</div>`).join('')}
        ${c.bday ? `<div>🎂 ${esc(fmtBday(c.bday))}</div>` : ''}
        ${c.note ? `<div class="ur-muted">${nl2br(c.note)}</div>` : ''}</div></div>`)
    return `<div class="ur-meta">Контактов: ${cards.length}</div><div class="ur-cards">${items.join('')}</div>`
}

// ----- iCalendar -----
const parseIcsDate = (v, params) => {
    if (!v) return null
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/.exec(v)
    if (!m) return null
    const allDay = !m[4] || params?.VALUE?.includes('DATE')
    const d = m[7] ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)))
        : new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))
    return { d, allDay }
}
const RRULE_FREQ = { DAILY: ['день', 'дня', 'дней'], WEEKLY: ['неделю', 'недели', 'недель'], MONTHLY: ['месяц', 'месяца', 'месяцев'], YEARLY: ['год', 'года', 'лет'] }
const DAY_FULL = { MO: 'понедельник', TU: 'вторник', WE: 'среду', TH: 'четверг', FR: 'пятницу', SA: 'субботу', SU: 'воскресенье' }
const describeRrule = r => {
    const o = Object.fromEntries(r.split(';').map(x => x.split('=')))
    const f = RRULE_FREQ[o.FREQ]
    if (!f) return 'повторяется'
    const n = Number(o.INTERVAL || 1)
    let s = n === 1 ? (o.FREQ === 'DAILY' ? 'каждый день' : o.FREQ === 'WEEKLY' ? 'каждую неделю' : o.FREQ === 'MONTHLY' ? 'каждый месяц' : 'каждый год') : `каждые ${n} ${plural(n, f)}`
    if (o.BYDAY && o.FREQ === 'WEEKLY') s = (n === 1 ? 'каждый ' : `раз в ${n} ${plural(n, f)}: `) + o.BYDAY.split(',').map(d => DAY_FULL[d.slice(-2)] || d).join(', ')
    if (n === 1 && o.FREQ === 'WEEKLY' && o.BYDAY && /^(WE|FR|SA)$/.test(o.BYDAY)) s = s.replace('каждый', 'каждую')
    if (o.COUNT) s += `, ${o.COUNT} раз`
    if (o.UNTIL) { const u = parseIcsDate(o.UNTIL); if (u) s += `, до ${u.d.toLocaleDateString('ru-RU')}` }
    return s
}
export const parseIcs = text => {
    const events = []
    let cur = null, depth = 0
    for (const line of unfold(text)) {
        if (/^BEGIN:VEVENT/i.test(line)) { cur = {}; continue }
        if (/^BEGIN:/i.test(line) && cur) { depth++; continue }
        if (/^END:VEVENT/i.test(line)) { if (cur) events.push(cur); cur = null; depth = 0; continue }
        if (/^END:/i.test(line) && cur) { depth--; continue }
        if (!cur || depth > 0) continue
        const p = parseProp(line)
        if (!p) continue
        const v = icsUnescape(p.value)
        if (p.name === 'SUMMARY') cur.summary = v
        else if (p.name === 'LOCATION') cur.location = v
        else if (p.name === 'DESCRIPTION') cur.description = v
        else if (p.name === 'DTSTART') cur.start = parseIcsDate(p.value, p.params)
        else if (p.name === 'DTEND') cur.end = parseIcsDate(p.value, p.params)
        else if (p.name === 'RRULE') cur.rrule = describeRrule(p.value)
        else if (p.name === 'URL') cur.url = v
    }
    return events.filter(e => e.start).sort((a, b) => a.start.d - b.start.d)
}
export const icsView = events => {
    if (!events.length) return '<p>В календаре нет событий.</p>'
    const hm = d => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    let html = `<div class="ur-meta">Событий: ${events.length}</div>`, lastDay = ''
    for (const e of events) {
        const d = e.start.d
        const day = `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
        if (day !== lastDay) { html += `<h3 class="ur-ics-day">${day}</h3>`; lastDay = day }
        const time = e.start.allDay ? 'весь день' : hm(d) + (e.end && !e.end.allDay ? '–' + hm(e.end.d) : '')
        const details = [e.location && `📍 ${esc(e.location)}`, e.description && nl2br(e.description), e.url && linkify(e.url)].filter(Boolean)
        const head = `<span class="ur-ics-time">${time}</span> <span class="ur-ics-title">${esc(e.summary || 'Без названия')}</span>${e.rrule ? ` <span class="ur-muted">↻ ${esc(e.rrule)}</span>` : ''}${e.location ? ` <span class="ur-muted">· ${esc(e.location)}</span>` : ''}`
        html += details.length ? `<details class="ur-ics-event"><summary>${head}</summary><div class="ur-ics-desc">${details.join('<br>')}</div></details>` : `<div class="ur-ics-event">${head}</div>`
    }
    return html
}

// ================= OPML =================
export const opmlView = text => {
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    if (doc.querySelector('parsererror')) throw new ReaderError('Файл OPML повреждён (ошибка XML).')
    const title = doc.querySelector('head > title')?.textContent
    const walk = el => Array.from(el.children).filter(c => c.localName === 'outline').map(o => {
        const label = o.getAttribute('text') || o.getAttribute('title') || '—'
        const url = o.getAttribute('htmlUrl') || o.getAttribute('url')
        const feed = o.getAttribute('xmlUrl')
        const kids = walk(o)
        const line = `${esc(label)}${url ? ` — <a href="${esc(url)}" class="external-link">${esc(url)}</a>` : ''}${feed ? ` <span class="ur-muted">(RSS: ${esc(feed)})</span>` : ''}`
        return kids.length ? `<li><details open><summary>${line} <span class="ur-muted">(${kids.length})</span></summary><ul>${kids.join('')}</ul></details></li>` : `<li>${line}</li>`
    })
    const body = doc.querySelector('body')
    return (title ? `<h2>${esc(title)}</h2>` : '') + `<ul class="ur-tree">${body ? walk(body).join('') : ''}</ul>`
}

// ================= RSS / Atom =================
export const feedView = (text, sanitize) => {
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    if (doc.querySelector('parsererror')) throw new ReaderError('Лента повреждена (ошибка XML).')
    const t = (el, sel) => el.querySelector(sel)?.textContent?.trim() ?? ''
    const isAtom = doc.documentElement.localName === 'feed'
    const title = isAtom ? t(doc.documentElement, ':scope > title') : t(doc, 'channel > title')
    const items = Array.from(doc.querySelectorAll(isAtom ? 'entry' : 'item')).map(it => ({
        title: t(it, 'title'),
        link: isAtom ? (it.querySelector('link[rel="alternate"]') || it.querySelector('link'))?.getAttribute('href') : t(it, 'link'),
        date: t(it, isAtom ? 'published, updated' : 'pubDate') || Array.from(it.children).find(c => c.localName === 'date')?.textContent,
        body: isAtom ? (t(it, 'content') || t(it, 'summary')) : (Array.from(it.children).find(c => c.localName === 'encoded')?.textContent || t(it, 'description')),
    }))
    const wrap = document.createElement('div')
    wrap.innerHTML = (title ? `<h2>${esc(title)}</h2>` : '') + `<div class="ur-meta">Записей: ${items.length}</div>`
    for (const it of items) {
        const det = document.createElement('details')
        det.className = 'ur-feed-item'
        const d = it.date ? new Date(it.date) : null
        const date = d && !isNaN(d) ? d.toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }) : (it.date || '')
        det.innerHTML = `<summary><span class="ur-feed-title">${esc(it.title || 'Без заголовка')}</span> <span class="ur-muted">${esc(date)}</span></summary>`
        const body = document.createElement('div')
        body.className = 'ur-feed-body'
        body.append(sanitize(it.body || ''))
        if (it.link) body.insertAdjacentHTML('beforeend', `<p><a href="${esc(it.link)}" class="external-link">Открыть оригинал</a></p>`)
        det.append(body)
        wrap.append(det)
    }
    return wrap
}

// ================= .po / .pot =================
const poUnquote = s => s.replace(/^"|"$/g, '').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
export const parsePo = text => {
    const entries = []
    let cur = { msgstr: [] }, key = null
    const push = () => { if (cur.msgid != null) entries.push(cur); cur = { msgstr: [] }; key = null }
    for (const raw of text.replace(/\r/g, '').split('\n')) {
        const line = raw.trim()
        if (!line) { push(); continue }
        if (line.startsWith('#,')) { cur.fuzzy = /fuzzy/.test(line); continue }
        if (line.startsWith('#.')) { cur.note = (cur.note ? cur.note + '\n' : '') + line.slice(2).trim(); continue }
        if (line.startsWith('#')) continue
        let m
        if ((m = /^msgctxt\s+(".*")$/.exec(line))) { if (cur.msgid != null) push(); cur.ctx = poUnquote(m[1]); key = 'ctx'; continue }
        if ((m = /^msgid\s+(".*")$/.exec(line))) { if (cur.msgid != null && key !== 'ctx') push(); cur.msgid = poUnquote(m[1]); key = 'msgid'; continue }
        if ((m = /^msgid_plural\s+(".*")$/.exec(line))) { cur.plural = poUnquote(m[1]); key = 'plural'; continue }
        if ((m = /^msgstr(?:\[(\d+)\])?\s+(".*")$/.exec(line))) { const i = Number(m[1] || 0); cur.msgstr[i] = poUnquote(m[2]); key = 'msgstr' + i; continue }
        if (line.startsWith('"')) {
            const v = poUnquote(line)
            if (key === 'ctx') cur.ctx += v
            else if (key === 'msgid') cur.msgid += v
            else if (key === 'plural') cur.plural += v
            else if (key?.startsWith('msgstr')) cur.msgstr[Number(key.slice(6))] += v
        }
    }
    push()
    return entries.filter(e => e.msgid !== '')
}
export const poView = entries => {
    const done = entries.filter(e => e.msgstr.some(s => s) && !e.fuzzy).length
    const rows = entries.map(e => {
        const empty = !e.msgstr.some(s => s)
        const tr = e.msgstr.length > 1 ? e.msgstr.map((s, i) => `<div><span class="ur-muted">[${i}]</span> ${nl2br(s)}</div>`).join('') : nl2br(e.msgstr[0] ?? '')
        return `<tr class="${empty ? 'is-empty' : e.fuzzy ? 'is-fuzzy' : ''}"><td>${e.ctx ? `<div class="ur-muted">${esc(e.ctx)}</div>` : ''}${nl2br(e.msgid)}${e.plural ? `<div class="ur-muted">мн.: ${nl2br(e.plural)}</div>` : ''}</td><td>${empty ? '<span class="ur-muted">не переведено</span>' : tr}${e.fuzzy ? ' <span class="ur-badge">неточно</span>' : ''}</td></tr>`
    })
    return `<div class="ur-meta">Переведено ${done} из ${entries.length}</div><table class="ur-po-table"><thead><tr><th>Оригинал</th><th>Перевод</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
}

// ================= Письма .eml =================
const latin1 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return s }
const b64bytes = s => { const bin = atob(s.replace(/[^A-Za-z0-9+/=]/g, '')); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }
const qpBytes = s => { const out = []; s = s.replace(/=\r?\n/g, ''); for (let i = 0; i < s.length; i++) { if (s[i] === '=' && /^[0-9A-F]{2}$/i.test(s.substr(i + 1, 2))) { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2 } else out.push(s.charCodeAt(i) & 0xff) } return new Uint8Array(out) }
const decodeBytes = (u8, charset) => { try { return new TextDecoder(charset || 'utf-8').decode(u8) } catch { return decodeText(u8) } }
// заголовки вида =?utf-8?B?...?= и =?koi8-r?Q?...?=
export const decodeWords = s => (s || '').replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs, enc, data) => {
    const bytes = enc.toUpperCase() === 'B' ? b64bytes(data) : qpBytes(data.replace(/_/g, ' '))
    return decodeBytes(bytes, cs)
})
const parseHeaders = block => {
    const h = {}
    for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
        const i = line.indexOf(':')
        if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(); h[k] = h[k] ? h[k] + ', ' + line.slice(i + 1).trim() : line.slice(i + 1).trim() }
    }
    return h
}
const param = (v, name) => new RegExp(`${name}\\*?=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(v || '')?.slice(1).find(x => x != null)
const parsePart = raw => {
    const idx = raw.search(/\r?\n\r?\n/)
    const headers = parseHeaders(idx < 0 ? raw : raw.slice(0, idx))
    const body = idx < 0 ? '' : raw.slice(idx).replace(/^\r?\n\r?\n/, '')
    const ctype = (headers['content-type'] || 'text/plain').split(';')[0].trim().toLowerCase()
    if (ctype.startsWith('multipart/')) {
        const boundary = param(headers['content-type'], 'boundary')
        const parts = boundary ? body.split('--' + boundary).slice(1).filter(p => !p.startsWith('--')).map(p => parsePart(p.replace(/^\r?\n/, ''))) : []
        return { headers, ctype, parts }
    }
    const enc = (headers['content-transfer-encoding'] || '').toLowerCase()
    const bytes = enc === 'base64' ? b64bytes(body) : enc === 'quoted-printable' ? qpBytes(body) : Uint8Array.from(body, c => c.charCodeAt(0) & 0xff)
    const disp = headers['content-disposition'] || ''
    let filename = param(disp, 'filename') || param(headers['content-type'], 'name')
    if (filename) filename = decodeWords(filename.replace(/^utf-8''/i, s => s).replace(/^([\w-]+)''(.*)$/, (_, cs, v) => { try { return decodeURIComponent(v) } catch { return v } }))
    return { headers, ctype, bytes, charset: param(headers['content-type'], 'charset'), filename, inline: /^inline/i.test(disp), cid: (headers['content-id'] || '').replace(/[<>]/g, '') }
}
export const parseEml = buf => {
    const root = parsePart(latin1(new Uint8Array(buf)))
    const leaves = []
    const walk = p => p.parts ? p.parts.forEach(walk) : leaves.push(p)
    walk(root)
    const html = leaves.find(p => p.ctype === 'text/html' && !p.filename)
    const plain = leaves.find(p => p.ctype === 'text/plain' && !p.filename)
    const attachments = leaves.filter(p => p !== html && p !== plain && (p.filename || !p.ctype.startsWith('text/')))
    const h = root.headers
    return {
        from: decodeWords(h.from), to: decodeWords(h.to), cc: decodeWords(h.cc), subject: decodeWords(h.subject) || '(без темы)', date: h.date,
        html: html ? decodeBytes(html.bytes, html.charset) : null,
        text: plain ? decodeBytes(plain.bytes, plain.charset) : null,
        attachments,
    }
}
const toDataUrl = p => { let s = ''; for (let i = 0; i < p.bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, p.bytes.subarray(i, i + 0x8000)); return `data:${p.ctype};base64,${btoa(s)}` }
// открыть вложение читалкой (функцию задаёт окно читалки)
export const bytesOpener = { fn: null }
export const emlView = (mail, { onSave }) => {
    const wrap = document.createElement('div')
    const d = mail.date ? new Date(mail.date) : null
    wrap.innerHTML = `<div class="ur-mail-head">
        <h2>${esc(mail.subject)}</h2>
        <div><span class="ur-muted">От:</span> ${esc(mail.from || '')}</div>
        <div><span class="ur-muted">Кому:</span> ${esc(mail.to || '')}</div>
        ${mail.cc ? `<div><span class="ur-muted">Копия:</span> ${esc(mail.cc)}</div>` : ''}
        <div><span class="ur-muted">Дата:</span> ${esc(d && !isNaN(d) ? d.toLocaleString('ru-RU') : (mail.date || ''))}</div></div>`
    if (mail.html != null) {
        let html = mail.html
        for (const a of mail.attachments) if (a.cid) html = html.split('cid:' + a.cid).join(toDataUrl(a))
        // картинки из интернета не грузим (это часто «счётчики прочтения»), показываем заглушку
        let blocked = 0
        html = html.replace(/<img\b[^>]*?\ssrc\s*=\s*(["'])\s*https?:[^"']*\1[^>]*>/gi, () => { blocked++; return '<span style="display:inline-block;border:1px dashed #aaa;color:#888;font:12px sans-serif;padding:2px 6px;margin:2px">🖼 картинка из интернета</span>' })
        if (blocked) wrap.insertAdjacentHTML('beforeend', `<div class="ur-meta">Скрыто картинок из интернета: ${blocked} (защита от отслеживания)</div>`)
        const f = document.createElement('iframe')
        f.className = 'ur-mail-frame'
        f.setAttribute('sandbox', 'allow-same-origin')
        // без скриптов и без загрузки чего-либо из интернета
        f.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><style>body{font-family:sans-serif;margin:12px;}</style></head><body>${html}</body></html>`
        f.onload = () => { try { f.style.height = (f.contentDocument.documentElement.scrollHeight + 20) + 'px' } catch { /* ignore */ } }
        wrap.append(f)
    } else {
        const pre = document.createElement('div')
        pre.className = 'ur-mail-text'
        pre.innerHTML = linkify(mail.text || '').replace(/\n/g, '<br>')
        wrap.append(pre)
    }
    const files = mail.attachments.filter(a => a.filename)
    if (files.length) {
        const box = document.createElement('div')
        box.className = 'ur-mail-att'
        box.innerHTML = `<h3>Вложения (${files.length})</h3>`
        for (const a of files) {
            const row = document.createElement('div')
            row.innerHTML = `📎 ${esc(a.filename)} <span class="ur-muted">${Math.max(1, Math.round(a.bytes.length / 1024))} КБ</span> `
            const b = document.createElement('button')
            b.textContent = 'Сохранить рядом с письмом'
            b.onclick = async () => { b.disabled = true; b.textContent = await onSave(a) }
            row.append(b)
            if (bytesOpener.fn) { const o = document.createElement('button'); o.textContent = 'Открыть'; o.onclick = () => bytesOpener.fn(a.bytes, a.filename); row.append(' ', o) }
            box.append(row)
        }
        wrap.append(box)
    }
    return wrap
}

// ================= Списки литературы .bib / .ris =================
const bibAuthors = s => (s || '').split(/\s+and\s+/i).map(a => {
    a = a.trim().replace(/[{}]/g, '')
    let last, first
    if (a.includes(',')) [last, first] = a.split(',').map(x => x.trim())
    else { const p = a.split(/\s+/); last = p.pop(); first = p.join(' ') }
    const ini = (first || '').split(/[\s-]+/).filter(Boolean).map(x => x[0] + '.').join(' ')
    return ini ? `${last} ${ini}` : last
}).filter(Boolean)
const formatRef = r => {
    const authors = r.authors.length > 3 ? r.authors.slice(0, 3).join(', ') + ' и др.' : r.authors.join(', ')
    let s = authors ? `<b>${esc(authors)}</b> ` : ''
    s += esc(r.title || 'Без названия')
    if (r.journal) s += ` // ${esc(r.journal)}`
    const place = [r.city, r.publisher].filter(Boolean).join(': ')
    if (place) s += `. — ${esc(place)}`
    if (r.year) s += `, ${esc(r.year)}`
    if (r.volume) s += `. — Т. ${esc(r.volume)}`
    if (r.issue) s += `, № ${esc(r.issue)}`
    if (r.pages) s += `. — С. ${esc(r.pages)}`
    s += '.'
    if (r.doi) s += ` DOI: <a href="https://doi.org/${esc(r.doi)}" class="external-link">${esc(r.doi)}</a>`
    else if (r.url) s += ` ${linkify(r.url)}`
    return s
}
export const parseBib = text => {
    const refs = []
    const re = /@(\w+)\s*\{\s*([^,]*),/g
    let m
    while ((m = re.exec(text))) {
        if (/^(comment|string|preamble)$/i.test(m[1])) continue
        let i = re.lastIndex, depth = 1
        while (i < text.length && depth > 0) { if (text[i] === '{') depth++; else if (text[i] === '}') depth--; i++ }
        const body = text.slice(re.lastIndex, i - 1)
        const f = {}
        const fre = /(\w+)\s*=\s*/g
        let fm
        while ((fm = fre.exec(body))) {
            let j = fre.lastIndex, v = ''
            if (body[j] === '{') { let d = 0; const st = j; do { if (body[j] === '{') d++; else if (body[j] === '}') d--; j++ } while (j < body.length && d > 0); v = body.slice(st + 1, j - 1) }
            else if (body[j] === '"') { const end = body.indexOf('"', j + 1); v = body.slice(j + 1, end); j = end + 1 }
            else { const end = body.slice(j).search(/[,\n]/); v = body.slice(j, end < 0 ? undefined : j + end); j += v.length }
            f[fm[1].toLowerCase()] = v.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()
            fre.lastIndex = j
        }
        refs.push({ key: m[2].trim(), type: m[1].toLowerCase(), authors: bibAuthors(f.author || f.editor), title: f.title, journal: f.journal || f.booktitle,
            publisher: f.publisher, city: f.address, year: f.year, volume: f.volume, issue: f.number, pages: f.pages?.replace(/--/g, '–'), doi: f.doi, url: f.url })
        re.lastIndex = i
    }
    return refs
}
export const parseRis = text => {
    const refs = []
    let cur = null
    for (const line of text.replace(/\r/g, '').split('\n')) {
        const m = /^([A-Z][A-Z0-9])  -\s?(.*)$/.exec(line)
        if (!m) continue
        const [, tag, v] = m
        if (tag === 'TY') { cur = { authors: [], type: v }; continue }
        if (!cur) continue
        if (tag === 'ER') { refs.push(cur); cur = null; continue }
        if (['AU', 'A1', 'A2'].includes(tag)) cur.authors.push(...bibAuthors(v))
        else if (['TI', 'T1'].includes(tag)) cur.title = v
        else if (['JO', 'JF', 'T2', 'BT'].includes(tag)) cur.journal ??= v
        else if (['PY', 'Y1', 'DA'].includes(tag)) cur.year ??= v.slice(0, 4)
        else if (tag === 'PB') cur.publisher = v
        else if (tag === 'CY') cur.city = v
        else if (tag === 'VL') cur.volume = v
        else if (tag === 'IS') cur.issue = v
        else if (tag === 'SP') cur.pages = v
        else if (tag === 'EP') cur.pages = (cur.pages ? cur.pages + '–' : '') + v
        else if (tag === 'DO') cur.doi = v
        else if (tag === 'UR') cur.url = v
    }
    if (cur) refs.push(cur)
    return refs
}
export const refsView = refs => `<div class="ur-meta">Источников: ${refs.length}</div><ol class="ur-refs">${refs.map(r => `<li>${formatRef(r)}</li>`).join('')}</ol>`

// ================= .nfo (кодировка DOS 437) =================
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '
export const decodeNfo = buf => {
    const u8 = new Uint8Array(buf)
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8) } catch { /* не UTF-8 — значит DOS */ }
    let s = ''
    for (const b of u8) s += b < 128 ? String.fromCharCode(b) : CP437[b - 128]
    return s
}

// ================= diff / patch =================
export const diffView = text => {
    const lines = text.replace(/\r/g, '').split('\n')
    const add = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length
    const del = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length
    const rows = lines.map(l => {
        const cls = l.startsWith('+++') || l.startsWith('---') || /^(diff |index |From |Subject: )/.test(l) ? 'is-file'
            : l.startsWith('@@') ? 'is-hunk' : l.startsWith('+') ? 'is-add' : l.startsWith('-') ? 'is-del' : ''
        return `<div class="ur-diff-line ${cls}">${esc(l) || ' '}</div>`
    })
    return `<div class="ur-meta"><span class="ur-diff-add">+${add}</span> <span class="ur-diff-del">−${del}</span></div><div class="ur-diff">${rows.join('')}</div>`
}

// ================= Fountain (сценарии) -> HTML для книжной читалки =================
const fInline = s => esc(s)
    .replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<i>$1</i>').replace(/_(.+?)_/g, '<u>$1</u>')
const isUpper = s => /\p{L}/u.test(s) && s === s.toUpperCase()
export const fountainToHtml = text => {
    text = text.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\[\[[\s\S]*?\]\]/g, '')
    const lines = text.split('\n')
    let i = 0
    let title = ''
    let html = ''
    // титульная страница: «Ключ: значение» в начале файла
    if (/^[A-Za-zА-Яа-яЁё ]+:/.test(lines[0] || '')) {
        const tp = {}
        let key = null
        for (; i < lines.length && lines[i].trim() !== ''; i++) {
            const m = /^([A-Za-zА-Яа-яЁё ]+):\s*(.*)$/.exec(lines[i])
            if (m) { key = m[1].trim().toLowerCase(); tp[key] = m[2] } else if (key) tp[key] += '\n' + lines[i].trim()
        }
        title = (tp.title || tp['название'] || '').replace(/[_*]/g, '')
        html += `<div class="ft-title-page"><h1>${nl2br(title)}</h1>${['credit', 'author', 'authors', NT('автор'), 'source', 'draft date', 'contact'].filter(k => tp[k]).map(k => `<p>${nl2br(tp[k].replace(/[_*]/g, ''))}</p>`).join('')}</div>`
    }
    const SCENE = /^(INT|EXT|EST|INT\.?\/EXT|I\/E|ИНТ|НАТ|ЭКСТ|ИНТ\.?\/НАТ)[.\s]/i
    for (; i < lines.length; i++) {
        const line = lines[i], t = line.trim()
        if (!t) continue
        const prevBlank = i === 0 || lines[i - 1].trim() === ''
        const nextLine = lines[i + 1] ?? ''
        if (/^#+/.test(t)) { const lvl = Math.min(t.match(/^#+/)[0].length, 2); html += `<h${lvl}>${fInline(t.replace(/^#+\s*/, ''))}</h${lvl}>`; continue }
        if (/^=\s/.test(t)) { html += `<p class="ft-synopsis">${fInline(t.slice(1).trim())}</p>`; continue }
        if (prevBlank && (SCENE.test(t) || /^\.[^.]/.test(t))) { html += `<h3 class="ft-scene">${fInline(t.replace(/^\./, ''))}</h3>`; continue }
        if (/^>.*<$/.test(t)) { html += `<p class="ft-center">${fInline(t.slice(1, -1).trim())}</p>`; continue }
        if (/^>/.test(t) || (prevBlank && isUpper(t) && /:$/.test(t) && nextLine.trim() === '')) { html += `<p class="ft-transition">${fInline(t.replace(/^>\s*/, ''))}</p>`; continue }
        if (t === '===') { html += '<hr>'; continue }
        // персонаж: строка заглавными (или с @), после пустой, за ней — не пустая
        if (prevBlank && nextLine.trim() !== '' && (/^@/.test(t) || (isUpper(t.replace(/\(.*\)/, '')) && !/^!/.test(t) && t.length < 50))) {
            html += `<div class="ft-dialogue"><p class="ft-character">${fInline(t.replace(/^@/, '').replace(/\^$/, ''))}</p>`
            i++
            for (; i < lines.length && lines[i].trim() !== ''; i++) {
                const d = lines[i].trim()
                html += /^\(.*\)$/.test(d) ? `<p class="ft-paren">${fInline(d)}</p>` : `<p class="ft-line">${fInline(d)}</p>`
            }
            html += '</div>'
            continue
        }
        // действие: несколько строк до пустой
        let block = t.replace(/^!/, '')
        while (i + 1 < lines.length && lines[i + 1].trim() !== '') { i++; block += '\n' + lines[i].replace(/^!/, '') }
        html += `<p class="ft-action">${fInline(block).replace(/\n/g, '<br>')}</p>`
    }
    return { title, html }
}
export const FOUNTAIN_CSS = `
.ft-title-page { text-align: center; margin: 20% 0; }
.ft-scene { font-family: "Courier New", monospace; text-transform: uppercase; font-size: 1em; margin: 1.6em 0 .6em; }
.ft-action, .ft-dialogue p, .ft-transition, .ft-center { font-family: "Courier New", monospace; }
.ft-dialogue { margin: .8em auto; max-width: 62%; }
.ft-character { text-align: center; text-transform: uppercase; margin: 0; }
.ft-paren { text-align: center; margin: 0; font-style: italic; }
.ft-line { margin: 0; }
.ft-transition { text-align: right; text-transform: uppercase; }
.ft-center { text-align: center; }
.ft-synopsis { opacity: .6; font-style: italic; }
`
