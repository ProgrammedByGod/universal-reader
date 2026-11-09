// Заметки и всякое полезное: Evernote, TextPack, карты мыслей, Anki, GEDCOM, выписки Kindle,
// песни с аккордами, плейлисты, торренты, сертификаты, переводы (XLIFF/TMX/MO), ANSI-рисунки, hex
import JSZip from 'jszip'
import { escapeHtml as esc, decodeText, ReaderError, MIME, extOf, naturalCompare } from '../util.js'
import { md5 } from './compress.js'
import { NT } from '../i18n.js'
import { makeHtmlBook } from './htmlbook.js'
import { fmtSize } from './archives.js'

const latin = new TextDecoder('latin1')
const nl2br = s => esc(s).replace(/\n/g, '<br>')
const xml = (text, what = 'файл') => {
    const d = new DOMParser().parseFromString(text, 'application/xml')
    if (d.querySelector('parsererror')) throw new ReaderError(`Не удалось прочитать ${what}: ошибка XML.`)
    return d
}
const kids = (el, name) => Array.from(el?.children ?? []).filter(c => c.localName === name)
const kid = (el, name) => kids(el, name)[0]
const b64 = s => { const bin = atob(s.replace(/\s/g, '')); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }

// ================= Evernote .enex =================
const enDate = s => { const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(s || ''); return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null }
export const openEnex = (buf, title, urls) => {
    const doc = xml(decodeText(buf), 'выгрузку Evernote')
    const notes = Array.from(doc.getElementsByTagName('note'))
    if (!notes.length) throw new ReaderError('В выгрузке Evernote нет заметок.')
    const sections = notes.map((n, i) => {
        const t = kid(n, 'title')?.textContent?.trim() || `Заметка ${i + 1}`
        const created = enDate(kid(n, 'created')?.textContent), updated = enDate(kid(n, 'updated')?.textContent)
        const tags = kids(n, 'tag').map(x => x.textContent)
        const src = kid(n, 'note-attributes')?.querySelector('source-url')?.textContent
        const res = new Map()
        for (const r of kids(n, 'resource')) {
            const dataEl = kid(r, 'data'); if (!dataEl) continue
            const bytes = b64(dataEl.textContent)
            const mime = kid(r, 'mime')?.textContent || 'application/octet-stream'
            const fname = r.querySelector('resource-attributes > file-name')?.textContent || ''
            const u = URL.createObjectURL(new Blob([bytes], { type: mime })); urls.push(u)
            res.set(md5(bytes), { url: u, mime, fname, size: bytes.length })
        }
        // самозакрывающиеся теги ENML HTML-разборщик не понимает — раскрываем их
        let content = (kid(n, 'content')?.textContent || '').replace(/<(en-todo|en-media|en-crypt)\b([^>]*?)\/>/g, '<$1$2></$1>')
        const cdoc = new DOMParser().parseFromString(content.replace(/<!DOCTYPE[^>]*>/i, ''), 'text/html')
        const body = cdoc.querySelector('en-note') ?? cdoc.body
        for (const m of [...body.querySelectorAll('en-media')]) {
            const r = res.get(m.getAttribute('hash'))
            let el
            if (!r) { el = cdoc.createElement('span'); el.textContent = '[вложение не найдено]' }
            else if (r.mime.startsWith('image/')) { el = cdoc.createElement('img'); el.setAttribute('src', r.url); for (const a of ['width', 'height']) if (m.getAttribute(a)) el.setAttribute(a, m.getAttribute(a)) }
            else if (r.mime.startsWith('audio/')) { el = cdoc.createElement('audio'); el.setAttribute('controls', ''); el.setAttribute('src', r.url) }
            else { el = cdoc.createElement('a'); el.setAttribute('href', r.url); el.setAttribute('download', r.fname || 'вложение'); el.textContent = `📎 ${r.fname || r.mime} (${fmtSize(r.size)})` }
            m.replaceWith(el)
        }
        for (const td of body.querySelectorAll('en-todo')) td.replaceWith(cdoc.createTextNode(td.getAttribute('checked') === 'true' ? '☑ ' : '☐ '))
        for (const c of body.querySelectorAll('en-crypt')) c.replaceWith(cdoc.createTextNode('[зашифрованный текст]'))
        body.querySelectorAll('script').forEach(s => s.remove())
        const meta = [created && 'Создана: ' + created.toLocaleString('ru-RU'), updated && 'Изменена: ' + updated.toLocaleString('ru-RU'), tags.length && 'Метки: ' + tags.join(', ')].filter(Boolean)
        const html = `<h1>${esc(t)}</h1>${meta.length ? `<p class="ur-enex-meta" style="opacity:.7;font-size:.9em">${esc(meta.join(' · '))}${src ? ` · <a href="${esc(src)}">источник</a>` : ''}</p>` : ''}<div>${body.innerHTML}</div>`
        return { title: t, html }
    })
    return makeHtmlBook({ title, sections })
}

// ================= TextPack (Markdown + картинки) =================
export const openTextpack = async (buf, urls) => {
    const zip = await JSZip.loadAsync(buf)
    const names = Object.keys(zip.files)
    const main = names.find(n => /(^|\/)text\.(md|markdown|txt)$/i.test(n)) ?? names.find(n => /\.(md|markdown)$/i.test(n))
    if (!main) throw new ReaderError('В архиве TextPack не найден текст заметки.')
    const dir = main.includes('/') ? main.slice(0, main.lastIndexOf('/') + 1) : ''
    let text = decodeText(await zip.file(main).async('uint8array'))
    const assets = new Map()
    for (const n of names) if (n.startsWith(dir + 'assets/') && !zip.files[n].dir) {
        const u = URL.createObjectURL(new Blob([await zip.file(n).async('uint8array')], { type: MIME[extOf(n)] || '' })); urls.push(u)
        assets.set(n.slice(dir.length), u)
    }
    // картинки подставляем через временные адреса: Обсидиан нарисует <img>, а мы заменим адрес на настоящий
    const map = new Map()
    const ph = p => { const u = assets.get(decodeURIComponent(p)); if (!u) return null; const k = `https://ur-asset.invalid/${map.size}.png`; map.set(k, u); return k }
    text = text.replace(/(!?\[[^\]]*\]\()([^)\s]+)(\s+"[^"]*")?\)/g, (m, a, p, t) => { const k = ph(p); return k ? `${a}${k}${t || ''})` : m })
        .replace(/(<img[^>]+src=")([^"]+)"/g, (m, a, p) => { const k = ph(p); return k ? `${a}${k}"` : m })
    return { text, map }
}

// ================= Карты мыслей =================
// Узел: { text, note?, link?, children: [] }
const mmNode = el => ({
    text: el.getAttribute('TEXT') ?? el.querySelector(':scope > richcontent[TYPE="NODE"]')?.textContent?.trim() ?? '',
    note: el.querySelector(':scope > richcontent[TYPE="NOTE"]')?.textContent?.trim(),
    link: el.getAttribute('LINK'),
    children: kids(el, 'node').map(mmNode),
})
const xmindJsonNode = t => ({
    text: t.title ?? '',
    note: t.notes?.plain?.content ?? t.notes?.realHTML?.content?.replace(/<[^>]+>/g, ' '),
    link: t.href,
    labels: t.labels,
    children: [...(t.children?.attached ?? []), ...(t.children?.detached ?? [])].map(xmindJsonNode),
})
const xmindXmlNode = t => ({
    text: kid(t, 'title')?.textContent ?? '',
    note: kid(t, 'notes')?.textContent?.trim(),
    link: t.getAttribute('xlink:href'),
    children: kids(kid(t, 'children'), 'topics').flatMap(ts => kids(ts, 'topic')).map(xmindXmlNode),
})
export const parseMindmap = async (buf, ext) => {
    const u8 = new Uint8Array(buf)
    const isZip = u8[0] === 0x50 && u8[1] === 0x4B
    if (ext === 'mm') {
        const d = xml(decodeText(u8), 'карту FreeMind')
        const root = d.querySelector('map > node')
        if (!root) throw new ReaderError('В карте нет узлов.')
        return [{ title: '', root: mmNode(root) }]
    }
    if (!isZip) throw new ReaderError(ext === 'mindnode' ? 'Файл MindNode на Mac — это папка, её Обсидиан не показывает. Откройте сжатую копию (zip).' : 'Файл повреждён (ожидался zip-архив).')
    const zip = await JSZip.loadAsync(buf)
    const file = n => zip.file(n) ?? zip.file(Object.keys(zip.files).find(k => k.endsWith('/' + n)) ?? '')
    if (ext === 'xmind' || file('content.json') || file('content.xml')) {
        const j = file('content.json')
        if (j) { const sheets = JSON.parse(await j.async('string')); return sheets.map(s => ({ title: s.title, root: xmindJsonNode(s.rootTopic) })) }
        const x = file('content.xml')
        if (!x) throw new ReaderError('В файле XMind нет содержимого.')
        const d = xml(await x.async('string'), 'карту XMind')
        return Array.from(d.getElementsByTagName('sheet')).map(s => ({ title: kid(s, 'title')?.textContent, root: xmindXmlNode(kid(s, 'topic')) }))
    }
    if (file('mapdata.xml')) {
        const d = xml(await file('mapdata.xml').async('string'), 'карту iThoughts')
        const topics = Array.from(d.getElementsByTagName('topic'))
        const nodes = new Map(topics.map(t => [t.getAttribute('uuid'), { text: t.getAttribute('text') ?? '', note: t.getAttribute('note'), link: t.getAttribute('link'), children: [], parent: t.getAttribute('parent'), pos: +(t.getAttribute('position')?.split(',')[1] ?? 0) }]))
        const roots = []
        for (const n of nodes.values()) (nodes.get(n.parent)?.children ?? roots).push(n)
        for (const n of nodes.values()) n.children.sort((a, b) => a.pos - b.pos)
        return roots.map(r => ({ title: '', root: r }))
    }
    if (file('contents.xml')) {
        // старый MindNode: plist
        const d = xml(await file('contents.xml').async('string'), 'карту MindNode')
        const plistVal = el => {
            if (!el) return null
            if (el.localName === 'dict') { const o = {}; const ch = Array.from(el.children); for (let i = 0; i < ch.length; i += 2) o[ch[i].textContent] = plistVal(ch[i + 1]); return o }
            if (el.localName === 'array') return Array.from(el.children).map(plistVal)
            return el.textContent
        }
        const root = plistVal(d.querySelector('plist > dict'))
        const textOf = n => typeof n?.title === 'string' ? n.title : n?.title?.text ?? n?.title?.string ?? ''
        const conv = n => ({ text: String(textOf(n)).replace(/<[^>]+>/g, ''), note: n.note?.text, children: (n.subnodes || []).map(conv) })
        const mains = root?.mindMap?.mainNodes ?? root?.mainNodes ?? []
        if (!mains.length) throw new ReaderError('Не удалось найти узлы в карте MindNode.')
        return mains.map(m => ({ title: '', root: conv(m) }))
    }
    throw new ReaderError('Неизвестный вариант карты мыслей.')
}
export const mindmapView = sheets => {
    const wrap = document.createElement('div')
    const bar = document.createElement('div'); bar.className = 'ur-mm-bar ur-nosearch'
    const exp = Object.assign(document.createElement('button'), { textContent: 'Развернуть всё' })
    const col = Object.assign(document.createElement('button'), { textContent: 'Свернуть всё' })
    bar.append(exp, col); wrap.append(bar)
    exp.onclick = () => wrap.querySelectorAll('details').forEach(d => { d.open = true })
    col.onclick = () => wrap.querySelectorAll('details').forEach(d => { d.open = false })
    let count = 0
    const li = (n, depth) => {
        count++
        const label = `${esc(n.text || '—')}${n.link ? ` <a class="external-link" href="${esc(n.link)}" target="_blank" rel="noopener">🔗</a>` : ''}${n.labels?.length ? ` <span class="ur-badge">${esc(n.labels.join(', '))}</span>` : ''}${n.note ? `<div class="ur-mm-note">${nl2br(n.note)}</div>` : ''}`
        if (!n.children?.length) return `<li>${label}</li>`
        return `<li><details${depth < 2 ? ' open' : ''}><summary>${label} <span class="ur-muted">(${n.children.length})</span></summary><ul>${n.children.map(c => li(c, depth + 1)).join('')}</ul></details></li>`
    }
    for (const s of sheets) {
        const sec = document.createElement('section')
        sec.innerHTML = `${sheets.length > 1 || s.title ? `<h2>${esc(s.title || 'Лист')}</h2>` : ''}<h3 class="ur-mm-root">${esc(s.root?.text || 'Центральная тема')}</h3><ul class="ur-tree ur-mm">${(s.root?.children ?? []).map(c => li(c, 0)).join('')}</ul>`
        wrap.append(sec)
    }
    bar.insertAdjacentHTML('beforeend', ` <span class="ur-muted">Узлов: ${count}</span>`)
    return wrap
}

// ================= Колоды Anki =================
const protoMedia = u8 => {
    // MediaEntries { repeated MediaEntry entries = 1; } MediaEntry { string name = 1; ... }
    const names = []
    let p = 0
    const varint = () => { let v = 0, s = 0, b; do { b = u8[p++]; v += (b & 0x7F) * 2 ** s; s += 7 } while (b & 0x80); return v }
    while (p < u8.length) {
        const key = varint(), len = (key & 7) === 2 ? varint() : 0
        if ((key >> 3) === 1 && (key & 7) === 2) {
            const end = p + len; let name = ''
            while (p < end) { const k = varint(); if ((k & 7) === 2) { const l = varint(); if ((k >> 3) === 1) name = new TextDecoder().decode(u8.subarray(p, p + l)); p += l } else if ((k & 7) === 0) varint(); else break }
            names.push(name); p = end
        } else p += len
    }
    return names
}
export const openAnki = async (ctx, buf, urls) => {
    const head = new Uint8Array(buf, 0, 16)
    // .anki2 / .anki21 — сама база SQLite без упаковки и без картинок
    const rawDb = new TextDecoder('latin1').decode(head).startsWith('SQLite format 3')
    const zip = rawDb ? null : await JSZip.loadAsync(buf)
    const zstd = async u8 => u8[0] === 0x28 && u8[1] === 0xB5 ? (await ctx.loadLib('zstd')).decompress(u8) : u8
    const colFile = zip && (zip.file('collection.anki21b') ?? zip.file('collection.anki21') ?? zip.file('collection.anki2'))
    if (!rawDb && !colFile) throw new ReaderError('В колоде Anki нет базы карточек.')
    const dbBytes = rawDb ? new Uint8Array(buf) : await zstd(await colFile.async('uint8array'))
    let media = {}
    const mf = zip?.file('media')
    if (mf) {
        const raw = await mf.async('uint8array')
        if (raw[0] === 0x7B) media = JSON.parse(new TextDecoder().decode(raw))
        else protoMedia(await zstd(raw)).forEach((n, i) => { media[i] = n })
    }
    const mediaUrl = new Map()
    const getMedia = async name => {
        if (mediaUrl.has(name)) return mediaUrl.get(name)
        const idx = Object.keys(media).find(k => media[k] === name)
        const f = idx != null && zip?.file(idx)
        let u = null
        if (f) { u = URL.createObjectURL(new Blob([await zstd(await f.async('uint8array'))], { type: MIME[extOf(name)] || '' })); urls.push(u) }
        mediaUrl.set(name, u)
        return u
    }
    const { initSqlJs } = await ctx.loadLib('sqlite')
    const SQL = await initSqlJs()
    const db = new SQL.Database(dbBytes)
    try {
        const types = new Map()
        const hasNotetypes = db.exec("SELECT name FROM sqlite_master WHERE name='notetypes'")[0]
        if (hasNotetypes) {
            for (const [id, name] of db.exec('SELECT id, name FROM notetypes')[0]?.values ?? []) types.set(String(id), { name, fields: [] })
            for (const [ntid, ord, name] of db.exec('SELECT ntid, ord, name FROM fields ORDER BY ntid, ord')[0]?.values ?? []) types.get(String(ntid))?.fields.push(name)
        } else {
            const models = JSON.parse(db.exec('SELECT models FROM col')[0]?.values?.[0]?.[0] || '{}')
            for (const [id, m] of Object.entries(models)) types.set(String(id), { name: m.name, fields: (m.flds || []).sort((a, b) => a.ord - b.ord).map(f => f.name) })
        }
        let decks = []
        try { decks = hasNotetypes ? (db.exec('SELECT name FROM decks')[0]?.values ?? []).map(r => String(r[0]).replace(/\x1f/g, '::')) : Object.values(JSON.parse(db.exec('SELECT decks FROM col')[0].values[0][0])).map(d => d.name) } catch { /* необязательно */ }
        const total = db.exec('SELECT COUNT(*) FROM notes')[0].values[0][0]
        const rows = db.exec('SELECT mid, flds, tags FROM notes ORDER BY id LIMIT 3000')[0]?.values ?? []
        const byType = new Map()
        for (const [mid, flds, tags] of rows) { const k = String(mid); if (!byType.has(k)) byType.set(k, []); byType.get(k).push({ fields: String(flds).split('\x1f'), tags: String(tags).trim() }) }
        if (rows.length === 1 && /please update|обновите/i.test(rows[0][1])) throw new ReaderError('Колода сохранена новой версией Anki в неподдерживаемом виде.')
        const wrap = document.createElement('div')
        wrap.innerHTML = `<div class="ur-meta">Карточек (заметок): ${total}${total > rows.length ? `, показаны первые ${rows.length}` : ''}${decks.filter(d => d !== 'Default' && d !== NT('По умолчанию')).length ? ' · Колоды: ' + esc(decks.filter(d => d !== 'Default').join(', ')) : ''}</div>`
        for (const [mid, notes] of byType) {
            const t = types.get(mid) ?? { name: 'Тип ' + mid, fields: [] }
            const n = Math.max(...notes.map(x => x.fields.length))
            const heads = Array.from({ length: n }, (_, i) => t.fields[i] ?? `Поле ${i + 1}`)
            const sec = document.createElement('section')
            sec.innerHTML = `<h2>${esc(t.name)} <span class="ur-muted">(${notes.length})</span></h2>`
            const table = document.createElement('table'); table.className = 'ur-anki-table'
            table.innerHTML = `<thead><tr>${heads.map(h => `<th>${esc(h)}</th>`).join('')}<th>Метки</th></tr></thead>`
            const tb = document.createElement('tbody')
            for (const note of notes) {
                const tr = document.createElement('tr')
                for (let i = 0; i < n; i++) {
                    const td = document.createElement('td')
                    const html = (note.fields[i] ?? '').replace(/\[sound:([^\]]+)\]/g, (_, f) => `🔊 ${esc(f)}`)
                    td.append(ctx.sanitize(html))
                    for (const img of td.querySelectorAll('img')) { const src = img.getAttribute('src'); img.removeAttribute('src'); if (src && !/^https?:/.test(src)) getMedia(decodeURIComponent(src)).then(u => { if (u) img.src = u }) }
                    tr.append(td)
                }
                tr.insertAdjacentHTML('beforeend', `<td class="ur-muted">${esc(note.tags)}</td>`)
                tb.append(tr)
            }
            table.append(tb); sec.append(table); wrap.append(sec)
        }
        return wrap
    } finally { db.close() }
}

// ================= Семейное дерево GEDCOM =================
export const parseGedcom = text => {
    const recs = new Map()
    const stack = []
    for (const raw of text.replace(/^﻿/, '').split(/\r?\n|\r/)) {
        const m = /^\s*(\d+)\s+(@[^@]+@\s+)?(\w+)(?:\s(.*))?$/.exec(raw)
        if (!m) continue
        const level = +m[1], node = { tag: m[3], value: m[4] ?? '', xref: m[2]?.trim(), kids: [] }
        stack.length = level
        if (level === 0) { if (node.xref) recs.set(node.xref, node) }
        else if (stack[level - 1]) {
            const parent = stack[level - 1]
            if (node.tag === 'CONC') { parent.value += node.value; continue }
            if (node.tag === 'CONT') { parent.value += '\n' + node.value; continue }
            parent.kids.push(node)
        }
        stack[level] = node
    }
    const sub = (n, ...path) => { let cur = n; for (const t of path) { cur = cur?.kids.find(k => k.tag === t); if (!cur) return '' } return cur.value }
    const all = (n, t) => n.kids.filter(k => k.tag === t).map(k => k.value)
    const people = new Map(), fams = new Map()
    for (const [id, r] of recs) {
        if (r.tag === 'INDI') {
            const nameRaw = sub(r, 'NAME')
            const surname = /\/([^/]*)\//.exec(nameRaw)?.[1]?.trim() ?? ''
            const name = nameRaw.replace(/\//g, '').replace(/\s+/g, ' ').trim() || 'Без имени'
            const ev = t => { const e = r.kids.find(k => k.tag === t); return e ? [sub(e, 'DATE'), sub(e, 'PLAC')].filter(Boolean).join(', ') || 'да' : '' }
            people.set(id, { id, name, surname, sex: sub(r, 'SEX'), birth: ev('BIRT'), death: ev('DEAT'), occu: sub(r, 'OCCU'), note: sub(r, 'NOTE'), famc: all(r, 'FAMC'), fams: all(r, 'FAMS') })
        } else if (r.tag === 'FAM') {
            const marr = r.kids.find(k => k.tag === 'MARR')
            fams.set(id, { husb: sub(r, 'HUSB'), wife: sub(r, 'WIFE'), chil: all(r, 'CHIL'), marr: marr ? [sub(marr, 'DATE'), sub(marr, 'PLAC')].filter(Boolean).join(', ') || 'да' : '' })
        }
    }
    if (!people.size) throw new ReaderError('В файле GEDCOM нет людей.')
    return { people, fams }
}
export const gedcomView = ({ people, fams }) => {
    const wrap = document.createElement('div')
    const link = id => { const p = people.get(id); return p ? `<a class="ur-ged-link" data-id="${esc(id)}">${esc(p.name)}</a>` : '' }
    const sorted = [...people.values()].sort((a, b) => (a.surname || a.name).localeCompare(b.surname || b.name, 'ru') || a.name.localeCompare(b.name, 'ru'))
    let html = `<div class="ur-meta">Людей: ${people.size}, семей: ${fams.size}</div>`
    let letter = ''
    for (const p of sorted) {
        const L = (p.surname || p.name)[0]?.toUpperCase() ?? '?'
        if (L !== letter) { html += `<h2>${esc(L)}</h2>`; letter = L }
        const parents = p.famc.flatMap(f => [fams.get(f)?.husb, fams.get(f)?.wife]).filter(Boolean).map(link).filter(Boolean)
        const spouses = [], children = []
        for (const f of p.fams) {
            const fam = fams.get(f); if (!fam) continue
            const other = fam.husb === p.id ? fam.wife : fam.husb
            if (other) spouses.push(link(other) + (fam.marr ? ` <span class="ur-muted">(брак: ${esc(fam.marr)})</span>` : ''))
            children.push(...fam.chil.map(link).filter(Boolean))
        }
        const siblings = p.famc.flatMap(f => fams.get(f)?.chil ?? []).filter(c => c !== p.id).map(link).filter(Boolean)
        html += `<div class="ur-card ur-ged-person" id="ged-${esc(p.id)}"><div class="ur-card-photo ur-card-initial">${p.sex === 'F' ? '♀' : p.sex === 'M' ? '♂' : '•'}</div><div class="ur-card-body">
            <div class="ur-card-name">${esc(p.name)}</div>
            ${p.birth ? `<div>Рождение: ${esc(p.birth)}</div>` : ''}${p.death ? `<div>Смерть: ${esc(p.death)}</div>` : ''}${p.occu ? `<div>Занятие: ${esc(p.occu)}</div>` : ''}
            ${parents.length ? `<div>Родители: ${parents.join(', ')}</div>` : ''}
            ${spouses.length ? `<div>Супруги: ${spouses.join('; ')}</div>` : ''}
            ${children.length ? `<div>Дети: ${children.join(', ')}</div>` : ''}
            ${siblings.length ? `<div>Братья и сёстры: ${siblings.join(', ')}</div>` : ''}
            ${p.note && !p.note.startsWith('@') ? `<div class="ur-muted">${nl2br(p.note)}</div>` : ''}</div></div>`
    }
    wrap.innerHTML = html
    wrap.addEventListener('click', e => {
        const a = e.target.closest('.ur-ged-link'); if (!a) return
        const el = wrap.querySelector(`#ged-${CSS.escape(a.dataset.id)}`)
        if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('is-flash'); setTimeout(() => el.classList.remove('is-flash'), 1200) }
    })
    return wrap
}

// ================= Выписки Kindle (My Clippings.txt) =================
export const isClippings = (name, text) => /clipping/i.test(name) && /^={10}\s*$/m.test(text.slice(0, 20000))
export const openClippings = (text, title) => {
    const items = text.replace(/^﻿/, '').split(/^={10}\s*$/m).map(s => s.replace(/^﻿/, '').trim()).filter(Boolean).map(chunk => {
        const lines = chunk.split(/\r?\n/)
        const book = lines[0].trim()
        const meta = (lines[1] || '').replace(/^-\s*/, '').trim()
        const body = lines.slice(2).join('\n').trim()
        const kind = /note|заметк/i.test(meta) ? 'note' : /bookmark|закладк/i.test(meta) ? 'bookmark' : 'highlight'
        return { book, meta, body, kind }
    }).filter(x => x.book)
    if (!items.length) throw new ReaderError('В файле не найдено выписок.')
    const books = new Map()
    for (const it of items) { if (!books.has(it.book)) books.set(it.book, []); books.get(it.book).push(it) }
    const sections = [...books].sort((a, b) => naturalCompare(a[0], b[0])).map(([book, list]) => ({
        title: book,
        html: `<h1>${esc(book)}</h1><p style="opacity:.7">Выписок: ${list.filter(x => x.kind === 'highlight').length}, заметок: ${list.filter(x => x.kind === 'note').length}</p>` +
            list.filter(x => x.kind !== 'bookmark' || x.body).map(x => x.kind === 'note'
                ? `<p>📝 <i>${nl2br(x.body)}</i><br><small style="opacity:.6">${esc(x.meta)}</small></p>`
                : `<blockquote>${nl2br(x.body)}</blockquote><p><small style="opacity:.6">${esc(x.meta)}</small></p>`).join(''),
    }))
    return makeHtmlBook({ title: title + ' — выписки', sections })
}

// ================= Песни с аккордами (ChordPro) и табы =================
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const FLAT = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C' }
const CHORD_RE = /^([A-H][#b]?)((?:m|min|maj|dim|aug|sus|add|M)?[0-9]*(?:\([^)]*\))?(?:[#b+-]?\d+)*(?:sus\d?|add\d+|maj\d*|dim\d*|aug)?)(?:\/([A-H][#b]?))?$/
const shiftNote = (n, k, useFlat) => {
    if (n === 'H') n = 'B'
    const i = NOTES.indexOf(FLAT[n] ?? n); if (i < 0) return n
    const r = NOTES[(i + k + 120) % 12]
    return useFlat ? ({ 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb' }[r] ?? r) : r
}
const transpose = (ch, k) => {
    if (!k) return ch
    const m = CHORD_RE.exec(ch.trim()); if (!m) return ch
    const flat = m[1].includes('b')
    return shiftNote(m[1], k, flat) + m[2] + (m[3] ? '/' + shiftNote(m[3], k, flat) : '')
}
const isChordLine = l => { const t = l.trim().split(/\s+/).filter(Boolean); return t.length > 0 && t.every(x => CHORD_RE.test(x) || /^[|/x%-]+$/.test(x)) && t.some(x => CHORD_RE.test(x)) }
export const chordproView = (text, ext) => {
    const wrap = document.createElement('div')
    const bar = document.createElement('div'); bar.className = 'ur-chord-bar ur-nosearch'
    bar.innerHTML = `Тональность: <button data-k="-1">−½</button> <span class="ur-chord-k">0</span> <button data-k="1">+½</button>`
    const body = document.createElement('div'); body.className = 'ur-chordpro'
    wrap.append(bar, body)
    let k = 0
    const bracket = /\[[^\]]+\]/.test(text) || /^\{[a-z_]+/im.test(text)
    const render = () => {
        bar.querySelector('.ur-chord-k').textContent = k > 0 ? '+' + k : String(k)
        let html = '', mode = ''
        const meta = {}
        for (const raw of text.replace(/\r/g, '').split('\n')) {
            const line = raw.replace(/\s+$/, '')
            const d = /^\{\s*([a-z_]+)(?:\s*:\s*(.*?))?\s*\}$/i.exec(line.trim())
            if (bracket && d) {
                const name = d[1].toLowerCase(), v = d[2] ?? ''
                if (['title', 't'].includes(name)) html += `<h2>${esc(v)}</h2>`
                else if (['subtitle', 'st', 'artist'].includes(name)) html += `<h3 class="ur-muted">${esc(v)}</h3>`
                else if (['comment', 'c', 'comment_italic', 'ci', 'highlight'].includes(name)) html += `<div class="ur-chord-comment">${esc(v)}</div>`
                else if (['start_of_chorus', 'soc'].includes(name)) { html += `<div class="ur-chorus">${v ? `<div class="ur-muted">${esc(v)}</div>` : ''}`; mode = 'chorus' }
                else if (['end_of_chorus', 'eoc'].includes(name)) { html += '</div>'; mode = '' }
                else if (['start_of_tab', 'sot'].includes(name)) { html += '<pre class="ur-chord-tab">'; mode = 'tab' }
                else if (['end_of_tab', 'eot'].includes(name)) { html += '</pre>'; mode = '' }
                else if (['start_of_verse', 'sov', 'start_of_bridge', 'sob'].includes(name)) html += v ? `<div class="ur-muted">${esc(v)}</div>` : ''
                else if (name === 'chorus') html += '<div class="ur-chord-comment">Припев</div>'
                else if (['key', 'capo', 'tempo', 'time', 'album', 'year', 'composer', 'lyricist'].includes(name)) meta[name] = name === 'key' ? transpose(v, k) : v
                continue
            }
            if (mode === 'tab') { html += esc(line) + '\n'; continue }
            if (bracket && line.includes('[')) {
                const parts = line.split(/(\[[^\]]*\])/)
                let segs = '', chord = ''
                for (const p of parts) {
                    if (/^\[.*\]$/.test(p)) { if (chord) segs += `<span class="ur-cp"><b>${esc(transpose(chord, k))}</b><i>&nbsp;</i></span>`; chord = p.slice(1, -1); continue }
                    if (!p && !chord) continue
                    segs += `<span class="ur-cp"><b>${chord ? esc(transpose(chord, k)) : '&nbsp;'}</b><i>${esc(p) || '&nbsp;'}</i></span>`; chord = ''
                }
                if (chord) segs += `<span class="ur-cp"><b>${esc(transpose(chord, k))}</b><i>&nbsp;</i></span>`
                html += `<div class="ur-cp-line">${segs}</div>`
            } else if (!bracket && isChordLine(line)) {
                // строка из одних аккордов над текстом: сохраняем позиции
                html += `<div class="ur-chord-line">${esc(line.replace(/\S+/g, c => { const t = transpose(c, k); return t.length < c.length ? t.padEnd(c.length) : t }))}</div>`
            } else html += line ? `<div class="ur-lyric${bracket ? '' : ' is-mono'}">${esc(line)}</div>` : '<div class="ur-cp-gap"></div>'
        }
        const m = Object.entries(meta).map(([a, b]) => `${{ key: 'Тональность', capo: 'Каподастр', tempo: 'Темп', time: 'Размер', album: 'Альбом', year: 'Год', composer: 'Музыка', lyricist: 'Слова' }[a]}: ${esc(b)}`).join(' · ')
        body.innerHTML = (m ? `<div class="ur-meta">${m}</div>` : '') + html
        body.classList.toggle('is-plain', !bracket)
    }
    bar.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { k = (k + +b.dataset.k + 12) % 12; if (k > 6) k -= 12; render() } })
    render()
    return wrap
}

// ================= Плейлисты =================
const fmtDur = s => { if (s == null || s < 0 || isNaN(s)) return ''; s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0') }
export const parsePlaylist = (text, ext) => {
    const tracks = []
    let title = ''
    if (ext === 'xspf') {
        const d = xml(text, 'плейлист')
        title = d.querySelector('playlist > title')?.textContent ?? ''
        for (const t of d.getElementsByTagName('track')) tracks.push({ title: kid(t, 'title')?.textContent, artist: kid(t, 'creator')?.textContent, album: kid(t, 'album')?.textContent, dur: kid(t, 'duration') ? +kid(t, 'duration').textContent / 1000 : null, file: kid(t, 'location')?.textContent })
    } else if (ext === 'pls') {
        const kv = {}
        for (const l of text.split(/\r?\n/)) { const m = /^(\w+?)(\d+)=(.*)$/.exec(l.trim()); if (m) (kv[m[2]] ??= {})[m[1].toLowerCase()] = m[3] }
        for (const n of Object.keys(kv).sort((a, b) => a - b)) tracks.push({ title: kv[n].title, file: kv[n].file, dur: kv[n].length != null && +kv[n].length >= 0 ? +kv[n].length : null })
    } else if (ext === 'cue') {
        let cur = null, file = '', performer = ''
        const unq = s => s.trim().replace(/^"|"$/g, '')
        for (const l of text.split(/\r?\n/)) {
            const t = l.trim(), [cmd, ...rest] = t.split(/\s+/), v = t.slice(cmd.length)
            if (cmd === 'FILE') file = unq(v.replace(/\s+\w+$/, ''))
            else if (cmd === 'TRACK') { cur = { n: +rest[0], file, artist: performer }; tracks.push(cur) }
            else if (cmd === 'TITLE') { if (cur) cur.title = unq(v); else title = unq(v) }
            else if (cmd === 'PERFORMER') { if (cur) cur.artist = unq(v); else performer = unq(v) }
            else if (cmd === 'INDEX' && rest[0] === '01' && cur) { const [m, s, f] = rest[1].split(':').map(Number); cur.start = m * 60 + s + f / 75 }
        }
        tracks.forEach((t, i) => { const nx = tracks[i + 1]; if (nx && nx.file === t.file && nx.start != null) t.dur = nx.start - t.start })
        if (performer) title = (title ? title + ' — ' : '') + performer
    } else {
        let info = null
        for (const l of text.split(/\r?\n/)) {
            const t = l.trim()
            if (!t) continue
            if (t.startsWith('#EXTINF:')) { const m = /^#EXTINF:(-?[\d.]+)[^,]*,(.*)$/.exec(t); info = { dur: m && +m[1] >= 0 ? +m[1] : null, name: m?.[2] ?? '' }; continue }
            if (t.startsWith('#PLAYLIST:')) { title = t.slice(10); continue }
            if (t.startsWith('#')) continue
            const name = info?.name ?? ''
            const [artist, ttl] = name.includes(' - ') ? [name.slice(0, name.indexOf(' - ')), name.slice(name.indexOf(' - ') + 3)] : ['', name]
            tracks.push({ title: ttl || decodeURIComponent(t.split(/[\\/]/).pop() || t), artist, dur: info?.dur, file: t })
            info = null
        }
    }
    return { title, tracks }
}
export const playlistView = ({ title, tracks }) => {
    const total = tracks.reduce((s, t) => s + (t.dur > 0 ? t.dur : 0), 0)
    const hasArtist = tracks.some(t => t.artist), hasAlbum = tracks.some(t => t.album)
    return `${title ? `<h2>${esc(title)}</h2>` : ''}<div class="ur-meta">Треков: ${tracks.length}${total ? ` · общая длительность ${fmtDur(total)}` : ''}</div>
    <table class="ur-po-table ur-playlist"><thead><tr><th>№</th><th>Название</th>${hasArtist ? '<th>Исполнитель</th>' : ''}${hasAlbum ? '<th>Альбом</th>' : ''}<th>Время</th><th>Файл</th></tr></thead><tbody>
    ${tracks.map((t, i) => `<tr><td class="ur-muted">${t.n ?? i + 1}</td><td>${esc(t.title || '')}</td>${hasArtist ? `<td>${esc(t.artist || '')}</td>` : ''}${hasAlbum ? `<td>${esc(t.album || '')}</td>` : ''}<td>${fmtDur(t.dur)}</td><td class="ur-muted ur-break">${/^https?:/.test(t.file || '') ? `<a class="external-link" href="${esc(t.file)}">${esc(t.file)}</a>` : esc(t.file || '')}</td></tr>`).join('')}
    </tbody></table>`
}

// ================= Торрент =================
const bdecode = u8 => {
    let p = 0
    const dec = () => {
        const c = u8[p]
        if (c === 0x69) { const e = u8.indexOf(0x65, p); const v = Number(latin.decode(u8.subarray(p + 1, e))); p = e + 1; return v }
        if (c === 0x6C) { p++; const a = []; while (u8[p] !== 0x65) a.push(dec()); p++; return a }
        if (c === 0x64) {
            p++; const o = {}
            while (u8[p] !== 0x65) { const k = new TextDecoder().decode(dec()); const s = p; o[k] = dec(); if (k === 'info') o.__infoRange = [s, p] }
            p++; return o
        }
        if (c >= 0x30 && c <= 0x39) { const colon = u8.indexOf(0x3A, p); const n = +latin.decode(u8.subarray(p, colon)); const v = u8.subarray(colon + 1, colon + 1 + n); p = colon + 1 + n; return v }
        throw new ReaderError('Торрент-файл повреждён.')
    }
    return dec()
}
export const torrentView = async buf => {
    const u8 = new Uint8Array(buf)
    const t = bdecode(u8)
    const s = v => v instanceof Uint8Array ? new TextDecoder().decode(v) : v == null ? '' : String(v)
    const info = t.info ?? {}
    const name = s(info['name.utf-8'] ?? info.name)
    const files = info.files ? info.files.map(f => ({ path: (f['path.utf-8'] ?? f.path).map(s).join('/'), size: f.length })) : [{ path: name, size: info.length }]
    const total = files.reduce((a, f) => a + (f.size || 0), 0)
    let hash = ''
    if (t.__infoRange && crypto?.subtle) { const d = await crypto.subtle.digest('SHA-1', u8.subarray(...t.__infoRange)); hash = [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('') }
    const trackers = [...new Set([t.announce, ...(t['announce-list'] ?? []).flat()].filter(Boolean).map(s))]
    const created = t['creation date'] ? new Date(t['creation date'] * 1000) : null
    const magnet = hash ? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${trackers.slice(0, 5).map(x => '&tr=' + encodeURIComponent(x)).join('')}` : ''
    const facts = [['Размер', fmtSize(total)], ['Файлов', files.length], ['Создан', created ? created.toLocaleString('ru-RU') : ''], ['Программа', s(t['created by'])], ['Комментарий', s(t['comment.utf-8'] ?? t.comment)], ['Хеш', hash], ['Частная раздача', info.private ? 'да' : '']].filter(x => x[1])
    return `<h2>🧲 ${esc(name)}</h2><table class="ur-font-facts">${facts.map(([k, v]) => `<tr><td class="ur-muted">${k}</td><td class="ur-break">${esc(v)}</td></tr>`).join('')}</table>
        ${magnet ? `<p><a class="ur-btn-link" href="${esc(magnet)}">Открыть магнет-ссылку</a></p>` : ''}
        <h3>Файлы</h3><table class="ur-arc-table"><tbody>${files.sort((a, b) => naturalCompare(a.path, b.path)).slice(0, 10000).map(f => `<tr><td>${esc(f.path)}</td><td>${fmtSize(f.size)}</td></tr>`).join('')}</tbody></table>
        ${trackers.length ? `<details><summary>Трекеры (${trackers.length})</summary><ul>${trackers.map(x => `<li class="ur-break">${esc(x)}</li>`).join('')}</ul></details>` : ''}`
}

// ================= Сертификаты (X.509) =================
const OIDS = { '2.5.4.3': 'CN', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.5': 'serialNumber', '1.2.840.113549.1.9.1': 'E', '2.5.4.12': 'T', '2.5.4.42': 'GN', '2.5.4.4': 'SN', '0.9.2342.19200300.100.1.25': 'DC',
    '1.2.840.113549.1.1.1': 'RSA', '1.2.840.10045.2.1': 'EC', '1.3.101.112': 'Ed25519', '1.2.840.113549.1.1.11': 'SHA-256 с RSA', '1.2.840.113549.1.1.5': 'SHA-1 с RSA', '1.2.840.113549.1.1.12': 'SHA-384 с RSA', '1.2.840.113549.1.1.13': 'SHA-512 с RSA', '1.2.840.10045.4.3.2': 'ECDSA с SHA-256', '1.2.840.10045.4.3.3': 'ECDSA с SHA-384',
    '1.2.840.10045.3.1.7': 'P-256', '1.3.132.0.34': 'P-384', '1.2.643.7.1.1.1.1': 'ГОСТ 2012 (256)', '1.2.643.7.1.1.1.2': 'ГОСТ 2012 (512)', '1.2.643.7.1.1.3.2': 'ГОСТ 2012 (256) подпись' }
const NAME_RU = { CN: 'Имя', C: 'Страна', L: 'Город', ST: 'Регион', O: 'Организация', OU: 'Подразделение', E: 'Почта', T: 'Должность', GN: 'Имя', SN: 'Фамилия', serialNumber: 'Номер', DC: 'Домен' }
export const asn1 = (u8, p = 0, end = u8.length) => {
    const out = []
    while (p < end) {
        const tag = u8[p]; let len = u8[p + 1], hl = 2
        if (len & 0x80) { const n = len & 0x7F; len = 0; for (let i = 0; i < n; i++) len = len * 256 + u8[p + 2 + i]; hl = 2 + n }
        const node = { tag, start: p, hl, len, body: u8.subarray(p + hl, p + hl + len) }
        if (tag & 0x20) node.kids = asn1(u8, p + hl, p + hl + len)
        out.push(node)
        p += hl + len
    }
    return out
}
const oidStr = b => { const a = [Math.floor(b[0] / 40), b[0] % 40]; let v = 0; for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 0x7F); if (!(b[i] & 0x80)) { a.push(v); v = 0 } } return a.join('.') }
export const asnStr = n => n.tag === 0x1E ? new TextDecoder('utf-16be').decode(n.body) : n.tag === 0x06 ? oidStr(n.body) : new TextDecoder().decode(n.body)
export const asnTime = n => { const s = latin.decode(n.body); const m = n.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z/.exec(s) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/.exec(s); if (!m) return null; const y = n.tag === 0x17 ? (+m[1] < 50 ? 2000 : 1900) + +m[1] : +m[1]; return new Date(Date.UTC(y, m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))) }
export const nameOf = n => (n?.kids ?? []).flatMap(set => set.kids ?? []).map(av => [OIDS[asnStr(av.kids[0])] ?? asnStr(av.kids[0]), asnStr(av.kids[1])])
export const fmtName = arr => arr.map(([k, v]) => `<div><span class="ur-muted">${esc(NAME_RU[k] ?? k)}:</span> ${esc(v)}</div>`).join('')
const hex = u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join(':').toUpperCase()
export const certInfo = async der => {
    const root = asn1(der)[0]
    const tbs = root.kids[0]
    let i = 0
    const k = tbs.kids
    if (k[0].tag === 0xA0) i++
    const serial = k[i++], sigAlg = k[i++], issuer = k[i++], validity = k[i++], subject = k[i++], spki = k[i++]
    const exts = k.find(x => x.tag === 0xA3)?.kids?.[0]?.kids ?? []
    const alt = [], usage = []
    let isCa = false
    for (const e of exts) {
        const id = asnStr(e.kids[0]), val = e.kids[e.kids.length - 1]
        const inner = asn1(val.body)[0]
        if (id === '2.5.29.17') for (const g of inner.kids ?? []) alt.push((g.tag & 0x1F) === 7 ? [...g.body].join('.') : latin.decode(g.body))
        if (id === '2.5.29.19') isCa = inner.kids?.[0]?.tag === 0x01 && inner.kids[0].body[0] !== 0
        if (id === '2.5.29.37') for (const o of inner.kids ?? []) usage.push({ '1.3.6.1.5.5.7.3.1': 'сервер TLS', '1.3.6.1.5.5.7.3.2': 'клиент TLS', '1.3.6.1.5.5.7.3.3': 'подпись кода', '1.3.6.1.5.5.7.3.4': 'почта' }[asnStr(o)] ?? asnStr(o))
    }
    const keyAlg = OIDS[asnStr(spki.kids[0].kids[0])] ?? asnStr(spki.kids[0].kids[0])
    const curve = spki.kids[0].kids[1]?.tag === 0x06 ? OIDS[asnStr(spki.kids[0].kids[1])] : ''
    let bits = ''
    if (keyAlg === 'RSA') { const rsa = asn1(spki.kids[1].body.subarray(1))[0]; const mod = rsa.kids[0].body; bits = (mod.length - (mod[0] === 0 ? 1 : 0)) * 8 + ' бит' }
    const fp = crypto?.subtle ? hex(new Uint8Array(await crypto.subtle.digest('SHA-256', der))) : ''
    const from = asnTime(validity.kids[0]), to = asnTime(validity.kids[1])
    return { kind: 'cert', subject: nameOf(subject), issuer: nameOf(issuer), from, to, serial: hex(serial.body), sigAlg: OIDS[asnStr(sigAlg.kids[0])] ?? asnStr(sigAlg.kids[0]), key: [keyAlg, curve, bits].filter(Boolean).join(', '), alt, usage, isCa, fp }
}
export const certView = async buf => {
    const u8 = new Uint8Array(buf)
    const text = latin.decode(u8)
    const blocks = []
    if (text.includes('-----BEGIN')) for (const m of text.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g)) blocks.push({ type: m[1], der: m[1].includes('PRIVATE') ? null : b64(m[2].replace(/^[\w-]+:.*$/gm, '')) })
    else blocks.push({ type: 'CERTIFICATE', der: u8 })
    if (!blocks.length) throw new ReaderError('Не найдено ни одного сертификата или ключа.')
    let html = ''
    for (const b of blocks) {
        if (b.type.includes('PRIVATE')) { html += `<div class="ur-card"><div class="ur-card-body"><div class="ur-card-name">🔒 Закрытый ключ</div><div class="ur-muted">Его содержимое секретное — не показываем.</div></div></div>`; continue }
        if (b.type.includes('PUBLIC KEY')) { html += `<div class="ur-card"><div class="ur-card-body"><div class="ur-card-name">🔑 Открытый ключ</div><div class="ur-muted">${b.der.length} байт</div></div></div>`; continue }
        try {
            if (b.type.includes('REQUEST')) {
                const ri = asn1(b.der)[0].kids[0]
                html += `<div class="ur-card"><div class="ur-card-body"><div class="ur-card-name">📝 Запрос на сертификат</div>${fmtName(nameOf(ri.kids[1]))}</div></div>`
                continue
            }
            const c = await certInfo(b.der)
            const now = new Date()
            const state = c.to && c.to < now ? '<span class="ur-badge is-bad">просрочен</span>' : c.from && c.from > now ? '<span class="ur-badge">ещё не действует</span>' : '<span class="ur-badge is-good">действует</span>'
            const cn = c.subject.find(x => x[0] === 'CN')?.[1] || c.subject.find(x => x[0] === 'O')?.[1] || 'Сертификат'
            html += `<div class="ur-card ur-cert"><div class="ur-card-body"><div class="ur-card-name">📜 ${esc(cn)} ${state}${c.isCa ? ' <span class="ur-badge">центр сертификации</span>' : ''}</div>
                <div>Действует: ${c.from ? c.from.toLocaleDateString('ru-RU') : '?'} — ${c.to ? c.to.toLocaleDateString('ru-RU') : '?'}</div>
                <h4>Кому выдан</h4>${fmtName(c.subject)}<h4>Кем выдан</h4>${fmtName(c.issuer)}
                ${c.alt.length ? `<h4>Адреса</h4><div class="ur-break">${c.alt.map(esc).join(', ')}</div>` : ''}
                ${c.usage.length ? `<div><span class="ur-muted">Назначение:</span> ${esc(c.usage.join(', '))}</div>` : ''}
                <div><span class="ur-muted">Ключ:</span> ${esc(c.key)} · <span class="ur-muted">подпись:</span> ${esc(c.sigAlg)}</div>
                <div class="ur-break ur-muted">Серийный номер: ${esc(c.serial)}</div>${c.fp ? `<div class="ur-break ur-muted">Отпечаток SHA-256: ${esc(c.fp)}</div>` : ''}</div></div>`
        } catch (e) { html += `<div class="ur-card"><div class="ur-card-body">${esc(b.type)}: не удалось разобрать (${esc(e.message)})</div></div>` }
    }
    return `<div class="ur-meta">Блоков: ${blocks.length}</div>${html}`
}

// ================= Переводы: XLIFF, TMX, MO -> записи как у .po =================
export const parseTranslations = (buf, ext) => {
    if (ext === 'mo') {
        const dv = new DataView(buf)
        const le = dv.getUint32(0, true) === 0x950412de
        if (!le && dv.getUint32(0, false) !== 0x950412de) throw new ReaderError('Это не файл перевода .mo.')
        const n = dv.getUint32(8, le), oo = dv.getUint32(12, le), to = dv.getUint32(16, le)
        const td = new TextDecoder(), u8 = new Uint8Array(buf)
        const str = (t, i) => td.decode(u8.subarray(dv.getUint32(t + i * 8 + 4, le), dv.getUint32(t + i * 8 + 4, le) + dv.getUint32(t + i * 8, le)))
        const out = []
        for (let i = 0; i < n; i++) {
            const id = str(oo, i), tr = str(to, i)
            if (!id) continue
            const [ctxId, msgid] = id.includes('\x04') ? id.split('\x04') : [null, id]
            const [single, plural] = msgid.split('\0')
            out.push({ ctx: ctxId, msgid: single, plural, msgstr: tr.split('\0') })
        }
        return out
    }
    const d = xml(decodeText(buf), 'файл перевода')
    if (ext === 'tmx') {
        const srcLang = d.querySelector('header')?.getAttribute('srclang')
        return Array.from(d.getElementsByTagName('tu')).map(tu => {
            const tuvs = kids(tu, 'tuv').map(t => ({ lang: t.getAttribute('xml:lang') || t.getAttribute('lang'), text: kid(t, 'seg')?.textContent ?? '' }))
            const src = tuvs.find(t => t.lang === srcLang) ?? tuvs[0]
            const rest = tuvs.filter(t => t !== src)
            return { msgid: src?.text ?? '', msgstr: rest.map(t => (tuvs.length > 2 ? `[${t.lang}] ` : '') + t.text), ctx: tuvs.length > 1 ? tuvs.map(t => t.lang).join(' → ') : '' }
        })
    }
    const units = [...d.getElementsByTagName('trans-unit'), ...Array.from(d.getElementsByTagName('segment'))]
    return units.map(u => {
        const tgt = kid(u, 'target')
        const state = tgt?.getAttribute('state') || u.getAttribute('state')
        return { ctx: u.getAttribute('id') ?? u.parentElement?.getAttribute('id') ?? '', msgid: kid(u, 'source')?.textContent ?? '', msgstr: [tgt?.textContent ?? ''], fuzzy: /needs|new|initial/.test(state || '') && !!tgt?.textContent, note: kid(u, 'note')?.textContent }
    })
}

// ================= ANSI-рисунки =================
const CP437 = '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '
const ANSI_COLORS = ['#000', '#a00', '#0a0', '#a50', '#00a', '#a0a', '#0aa', '#aaa', '#555', '#f55', '#5f5', '#ff5', '#55f', '#f5f', '#5ff', '#fff']
export const ansiView = buf => {
    let u8 = new Uint8Array(buf)
    let width = 80, title = ''
    const sauce = u8.length >= 128 ? latin.decode(u8.subarray(u8.length - 128, u8.length - 121)) : ''
    if (sauce === 'SAUCE00') {
        const s = u8.subarray(u8.length - 128)
        title = latin.decode(s.subarray(7, 42)).trim()
        const w = s[96] | (s[97] << 8); if (s[94] === 1 && w > 0 && w < 1000) width = w
        u8 = u8.subarray(0, u8.length - 128)
    }
    const eof = u8.indexOf(0x1A); if (eof >= 0) u8 = u8.subarray(0, eof)
    const rows = []
    let x = 0, y = 0, fg = 7, bg = 0, bold = false, blink = false, saved = [0, 0]
    const put = ch => { if (x >= width) { x = 0; y++ } (rows[y] ??= [])[x] = [ch, bold ? fg + 8 : fg, blink ? bg + 8 : bg]; x++ }
    for (let i = 0; i < u8.length; i++) {
        const c = u8[i]
        if (c === 0x1B && u8[i + 1] === 0x5B) {
            let j = i + 2, params = ''
            while (j < u8.length && !(u8[j] >= 0x40 && u8[j] <= 0x7E)) params += String.fromCharCode(u8[j++])
            const cmd = String.fromCharCode(u8[j]); i = j
            const ps = params.replace(/[?=]/g, '').split(';').map(v => v === '' ? NaN : +v)
            const n = Number.isFinite(ps[0]) ? ps[0] : 1
            if (cmd === 'm') for (const p of params ? ps : [0]) { const v = Number.isFinite(p) ? p : 0; if (v === 0) { fg = 7; bg = 0; bold = false; blink = false } else if (v === 1) bold = true; else if (v === 5) blink = true; else if (v === 22) bold = false; else if (v >= 30 && v <= 37) fg = v - 30; else if (v >= 40 && v <= 47) bg = v - 40 }
            else if (cmd === 'C') x = Math.min(width - 1, x + n)
            else if (cmd === 'D') x = Math.max(0, x - n)
            else if (cmd === 'A') y = Math.max(0, y - n)
            else if (cmd === 'B') y += n
            else if (cmd === 'H' || cmd === 'f') { y = (Number.isFinite(ps[0]) ? ps[0] : 1) - 1; x = (Number.isFinite(ps[1]) ? ps[1] : 1) - 1 }
            else if (cmd === 's') saved = [x, y]
            else if (cmd === 'u') [x, y] = saved
            else if (cmd === 'J' && ps[0] === 2) { rows.length = 0; x = 0; y = 0 }
            continue
        }
        if (c === 13) { x = 0; continue }
        if (c === 10) { y++; x = 0; continue }
        put(CP437[c] ?? ' ')
    }
    const pal = ANSI_COLORS
    let html = ''
    for (let r = 0; r < rows.length; r++) {
        const row = rows[r] ?? []
        let line = '', last = ''
        for (let c = 0; c < Math.max(row.length, 1); c++) {
            const cell = row[c] ?? [' ', 7, 0]
            const style = `color:${pal[cell[1]]};background:${pal[cell[2] % 16]}`
            if (style !== last) { if (last) line += '</span>'; line += `<span style="${style}">`; last = style }
            line += esc(cell[0])
        }
        html += line + (last ? '</span>' : '') + '\n'
    }
    return `${title ? `<h2>${esc(title)}</h2>` : ''}<pre class="ur-ansi">${html}</pre>`
}

// ================= Шестнадцатеричный просмотр =================
export const hexView = (buf, start = 0) => {
    const u8 = new Uint8Array(buf)
    const wrap = document.createElement('div')
    wrap.innerHTML = `<div class="ur-meta">Размер: ${fmtSize(u8.length)} (${u8.length.toLocaleString('ru-RU')} байт)</div>`
    const pre = document.createElement('pre'); pre.className = 'ur-hex'
    wrap.append(pre)
    const ascii = b => b >= 32 && b < 127 ? String.fromCharCode(b) : '·'
    let shown = 0
    const more = document.createElement('button'); more.className = 'ur-more ur-nosearch'
    const add = () => {
        const end = Math.min(u8.length, shown + 64 * 1024)
        const lines = []
        for (let o = shown; o < end; o += 16) {
            const row = u8.subarray(o, Math.min(o + 16, u8.length))
            const h = [...row].map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(47)
            lines.push(`${o.toString(16).padStart(8, '0')}  ${h.slice(0, 23)} ${h.slice(24)}  ${[...row].map(ascii).join('')}`)
        }
        pre.append(document.createTextNode(lines.join('\n') + '\n'))
        shown = end
        if (shown < u8.length) { more.textContent = `Показать ещё (показано ${fmtSize(shown)} из ${fmtSize(u8.length)})`; if (!more.isConnected) wrap.append(more) } else more.remove()
    }
    more.onclick = add
    add()
    return wrap
}
