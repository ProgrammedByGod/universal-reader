// Почта (mbox, emlx, msg), сохранённые страницы (webarchive, maff, warc, wacz), ярлыки ссылок, LDIF
import JSZip from 'jszip'
import { escapeHtml as esc, decodeText, ReaderError, naturalCompare } from '../util.js'
import { parseEml, emlView, decodeWords } from './textual.js'
import { parseBplistObj } from './extra.js'
import { gunzip, inflateRaw } from './compress.js'
import { fmtSize } from './archives.js'

const latin = new TextDecoder('latin1')
const indexOfBytes = (u8, pat, from = 0) => {
    outer: for (let i = from; i <= u8.length - pat.length; i++) {
        for (let k = 0; k < pat.length; k++) if (u8[i + k] !== pat[k]) continue outer
        return i
    }
    return -1
}
const fmtDate = d => d && !isNaN(d) ? d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : ''

// ================= Почтовый ящик mbox =================
const quickHeaders = u8 => {
    const end = Math.min(u8.length, 64 * 1024)
    const raw = latin.decode(u8.subarray(0, end))
    const i = raw.search(/\r?\n\r?\n/)
    const block = (i < 0 ? raw : raw.slice(0, i)).replace(/\r?\n[ \t]+/g, ' ')
    const h = {}
    for (const line of block.split(/\r?\n/)) { const k = line.indexOf(':'); if (k > 0) { const key = line.slice(0, k).trim().toLowerCase(); h[key] ??= line.slice(k + 1).trim() } }
    return h
}
export const parseMbox = buf => {
    const u8 = new Uint8Array(buf)
    const starts = []
    if (latin.decode(u8.subarray(0, 5)) === 'From ') starts.push(0)
    const pat = [10, 70, 114, 111, 109, 32] // "\nFrom "
    for (let p = 0; (p = indexOfBytes(u8, pat, p)) >= 0; p++) starts.push(p + 1)
    if (!starts.length) throw new ReaderError('Это не почтовый ящик mbox (нет строк «From »).')
    return starts.map((s, i) => {
        const e = i + 1 < starts.length ? starts[i + 1] : u8.length
        const lineEnd = u8.indexOf(10, s)
        const body = u8.subarray(lineEnd + 1, e)
        const h = quickHeaders(body)
        const d = h.date ? new Date(h.date) : null
        return { name: String(i + 1), size: body.length, bytes: body, subject: decodeWords(h.subject) || '(без темы)', from: decodeWords(h.from), date: d }
    })
}
const toLatinBytes = s => Uint8Array.from(s, c => c.charCodeAt(0) & 255)
export const mboxArchive = msgs => ({
    entries: msgs,
    getBytes: async n => msgs[+n - 1].bytes,
})
export const mboxList = (arc, onOpen) => {
    const wrap = document.createElement('div')
    wrap.innerHTML = `<div class="ur-meta">Писем: ${arc.entries.length}</div>`
    const table = document.createElement('table'); table.className = 'ur-arc-table ur-mbox-table'
    const withFolder = arc.entries.some(m => m.folder)
    table.innerHTML = `<thead><tr><th>Тема</th><th>От</th><th>Дата</th>${withFolder ? '<th>Папка</th>' : ''}</tr></thead>`
    const tb = document.createElement('tbody')
    for (const m of arc.entries) {
        const tr = document.createElement('tr')
        tr.innerHTML = `<td>${m.attachments ? '📎 ' : ''}${esc(m.subject)}</td><td>${esc(m.from || '')}</td><td>${esc(fmtDate(m.date))}</td>${withFolder ? `<td>${esc(m.folder || '')}</td>` : ''}`
        tr.onclick = () => onOpen(m)
        tb.append(tr)
    }
    table.append(tb); wrap.append(table)
    return wrap
}
export const mailPreview = onSave => async (arc, entry) => {
    const bytes = await arc.getBytes(entry.name)
    const raw = latin.decode(bytes)
    const fixed = raw.includes('\n>From ') ? toLatinBytes(raw.replace(/\n>(>*From )/g, '\n$1')) : bytes
    return emlView(parseEml(fixed.buffer.slice(fixed.byteOffset, fixed.byteOffset + fixed.byteLength)), { onSave })
}

// ================= Apple Mail .emlx =================
export const emlxToEml = buf => {
    const u8 = new Uint8Array(buf)
    const nl = u8.indexOf(10)
    const len = parseInt(latin.decode(u8.subarray(0, nl)).trim(), 10)
    if (!len) return buf
    return buf.slice(nl + 1, nl + 1 + len)
}

// ================= Outlook .msg =================
export const parseMsg = async (ctx, buf) => {
    const { MsgReader } = await ctx.loadLib('msg')
    const r = new MsgReader(buf)
    const d = r.getFileData()
    if (d.error) throw new ReaderError('Не удалось прочитать письмо Outlook: ' + d.error)
    const who = (name, email) => [name, email && email !== name ? `<${email}>` : ''].filter(Boolean).join(' ')
    const rcpt = kind => (d.recipients || []).filter(x => (x.recipType || 'to') === kind).map(x => who(x.name, x.smtpAddress || x.email)).join(', ')
    let html = null
    if (d.html) html = typeof d.html === 'string' ? d.html : new TextDecoder().decode(d.html)
    else if (d.bodyHtml) html = d.bodyHtml
    const attachments = (d.attachments || []).filter(a => !a.attachmentHidden || a.pidContentId).map(a => {
        try {
            const f = r.getAttachment(a)
            return { filename: f.fileName || a.fileName || 'вложение', bytes: f.content, ctype: a.attachMimeTag || 'application/octet-stream', cid: a.pidContentId }
        } catch { return null }
    }).filter(Boolean)
    return {
        from: who(d.senderName, d.senderSmtpAddress || d.senderEmail), to: rcpt('to'), cc: rcpt('cc'),
        subject: d.subject || '(без темы)', date: d.messageDeliveryTime || d.clientSubmitTime || d.creationTime,
        html, text: d.body || '', attachments,
    }
}

// ================= Сборка страницы из ресурсов =================
// resources: Map(абсолютный адрес -> { type, bytes }), подставляем blob-ссылки
export const packPage = ({ html, baseUrl, resources, urls }) => {
    const blobs = new Map()
    const norm = u => { try { const x = new URL(u); x.hash = ''; return x.href } catch { return u } }
    const resMap = new Map([...resources].map(([k, v]) => [norm(k), v]))
    const blobFor = (abs, depth = 0) => {
        const key = norm(abs)
        if (blobs.has(key)) return blobs.get(key)
        const r = resMap.get(key)
        if (!r) return null
        let content = r.bytes
        if (/css/.test(r.type) && depth < 4) content = rewriteCss(decodeText(r.bytes), key, depth + 1)
        const u = URL.createObjectURL(new Blob([content], { type: r.type || '' }))
        urls.push(u); blobs.set(key, u)
        return u
    }
    const resolve = (u, base) => { try { return new URL(u, base).href } catch { return null } }
    const rewriteCss = (css, base, depth = 0) => css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
        if (/^(data|blob):/.test(u)) return m
        const abs = resolve(u.trim(), base)
        const b = abs && blobFor(abs, depth)
        return b ? `url("${b}")` : 'url("")'
    }).replace(/@import\s+(['"])([^'"]+)\1/g, (m, q, u) => { const abs = resolve(u, base); const b = abs && blobFor(abs, depth); return b ? `@import "${b}"` : '' })
    const doc = new DOMParser().parseFromString(html, 'text/html')
    doc.querySelectorAll('script, noscript, base').forEach(e => e.remove())
    for (const el of doc.querySelectorAll('[src], [href], [poster], [srcset], [data-src]')) {
        for (const attr of ['src', 'href', 'poster', 'data-src']) {
            const v = el.getAttribute(attr)
            if (!v || /^(data|blob|javascript|mailto|#)/i.test(v)) continue
            const abs = resolve(v, baseUrl)
            const b = abs && blobFor(abs)
            if (b) el.setAttribute(attr, b)
            else if (attr !== 'href' || el.localName === 'link') el.removeAttribute(attr)
        }
        const ss = el.getAttribute('srcset')
        if (ss) { const first = ss.split(',')[0].trim().split(/\s+/)[0]; const abs = resolve(first, baseUrl); const b = abs && blobFor(abs); if (b) { el.setAttribute('src', b) } el.removeAttribute('srcset') }
    }
    for (const st of doc.querySelectorAll('style')) st.textContent = rewriteCss(st.textContent, baseUrl)
    for (const el of doc.querySelectorAll('[style]')) el.setAttribute('style', rewriteCss(el.getAttribute('style'), baseUrl))
    // ссылки уводим в обычный браузер
    for (const a of doc.querySelectorAll('a[href]')) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener') }
    return '<!DOCTYPE html>' + doc.documentElement.outerHTML
}

// ================= Safari .webarchive =================
export const parseWebarchive = (buf, urls) => {
    const head = latin.decode(new Uint8Array(buf, 0, 6))
    let root
    if (head === 'bplist') root = parseBplistObj(buf)
    else throw new ReaderError('Этот .webarchive сохранён в текстовом виде — такой вариант пока не поддерживается.')
    const resources = new Map()
    const addRes = r => { if (r?.WebResourceURL && r.WebResourceData) resources.set(r.WebResourceURL, { type: r.WebResourceMIMEType, bytes: r.WebResourceData }) }
    const walk = a => { (a.WebSubresources || []).forEach(addRes); (a.WebSubframeArchives || []).forEach(sub => { addRes(sub.WebMainResource); walk(sub) }) }
    walk(root)
    const main = root.WebMainResource
    if (!main?.WebResourceData) throw new ReaderError('В архиве Safari не найдена страница.')
    let html
    try { html = new TextDecoder(main.WebResourceTextEncodingName || 'utf-8').decode(main.WebResourceData) } catch { html = decodeText(main.WebResourceData) }
    return packPage({ html, baseUrl: main.WebResourceURL || 'https://page.local/', resources, urls })
}

// ================= Firefox .maff =================
export const parseMaff = async (buf, urls) => {
    const zip = await JSZip.loadAsync(buf)
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir)
    const index = names.find(n => /^[^/]+\/index\.(html?|xhtml|mht)$/i.test(n)) ?? names.find(n => /index\.html?$/i.test(n))
    if (!index) throw new ReaderError('В архиве MAFF не найдена страница index.html.')
    const base = 'https://maff.local/' + index
    const resources = new Map()
    for (const n of names) if (n !== index) resources.set('https://maff.local/' + n, { type: '', bytes: await zip.file(n).async('uint8array') })
    // тип по расширению, чтобы браузер понял стили и картинки
    for (const [k, v] of resources) v.type = /\.css$/i.test(k) ? 'text/css' : /\.svg$/i.test(k) ? 'image/svg+xml' : ''
    const html = decodeText(await zip.file(index).async('uint8array'))
    let title = ''
    const rdf = names.find(n => /index\.rdf$/i.test(n))
    if (rdf) title = /<MAF:title\s+RDF:resource="([^"]*)"/.exec(await zip.file(rdf).async('string'))?.[1] ?? ''
    return { html: packPage({ html, baseUrl: base, resources, urls }), title }
}

// ================= WARC / WACZ (архивы сайтов) =================
const parseWarcRecords = u8 => {
    const recs = []
    let p = 0
    const td = new TextDecoder()
    while (p < u8.length) {
        while (p < u8.length && (u8[p] === 13 || u8[p] === 10)) p++
        if (p >= u8.length) break
        const hEnd = indexOfBytes(u8, [13, 10, 13, 10], p)
        if (hEnd < 0) break
        const head = td.decode(u8.subarray(p, hEnd))
        if (!head.startsWith('WARC/')) break
        const h = {}
        for (const line of head.split('\r\n').slice(1)) { const i = line.indexOf(':'); if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim() }
        const len = +h['content-length'] || 0
        const block = u8.subarray(hEnd + 4, hEnd + 4 + len)
        recs.push({ type: h['warc-type'], url: (h['warc-target-uri'] || '').replace(/^<|>$/g, ''), date: h['warc-date'], block })
        p = hEnd + 4 + len
    }
    return recs
}
// gzip из множества склеенных частей: распаковываем по частям
const gunzipMulti = async u8 => {
    try { return await gunzip(u8) } catch { /* попробуем по частям */ }
    const parts = []
    let p = 0
    while (p < u8.length) {
        let q = p + 10
        let next = -1
        for (let k = q; k < u8.length - 3; k++) if (u8[k] === 0x1F && u8[k + 1] === 0x8B && u8[k + 2] === 8) {
            try { parts.push(await gunzip(u8.subarray(p, k))); next = k; break } catch { /* ложное совпадение */ }
        }
        if (next < 0) { parts.push(await gunzip(u8.subarray(p))); break }
        p = next
    }
    const n = parts.reduce((s, x) => s + x.length, 0), out = new Uint8Array(n); let o = 0
    for (const x of parts) { out.set(x, o); o += x.length }
    return out
}
const splitHttp = block => {
    const e = indexOfBytes(block, [13, 10, 13, 10])
    if (e < 0) return null
    const head = latin.decode(block.subarray(0, e))
    const lines = head.split('\r\n')
    const status = +(/^HTTP\/[\d.]+\s+(\d+)/.exec(lines[0])?.[1] || 0)
    const h = {}
    for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim() }
    return { status, headers: h, body: block.subarray(e + 4) }
}
const dechunk = u8 => {
    const parts = []; let p = 0
    while (p < u8.length) {
        const e = indexOfBytes(u8, [13, 10], p); if (e < 0) break
        const n = parseInt(latin.decode(u8.subarray(p, e)), 16); if (!n) break
        parts.push(u8.subarray(e + 2, e + 2 + n)); p = e + 2 + n + 2
    }
    const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0)); let o = 0
    for (const x of parts) { out.set(x, o); o += x.length }
    return out
}
export const openWarc = async (buf, ext) => {
    let datas = []
    if (ext === 'wacz') {
        const zip = await JSZip.loadAsync(buf)
        for (const n of Object.keys(zip.files).filter(n => /\.warc(\.gz)?$/i.test(n))) datas.push(await zip.file(n).async('uint8array'))
        if (!datas.length) throw new ReaderError('В WACZ не найдено файлов WARC.')
    } else datas = [new Uint8Array(buf)]
    const records = []
    for (let d of datas) {
        if (d[0] === 0x1F && d[1] === 0x8B) d = await gunzipMulti(d)
        records.push(...parseWarcRecords(d))
    }
    const responses = new Map()
    for (const r of records) {
        if (r.type !== 'response' && r.type !== 'resource') continue
        let res = r.type === 'response' ? splitHttp(r.block) : { status: 200, headers: {}, body: r.block }
        if (!res || (res.status && (res.status < 200 || res.status >= 400))) continue
        let body = res.body
        if (/chunked/i.test(res.headers['transfer-encoding'] || '')) body = dechunk(body)
        const enc = (res.headers['content-encoding'] || '').toLowerCase()
        try { if (enc === 'gzip') body = await gunzip(body); else if (enc === 'deflate') body = await inflateRaw(body) } catch { /* оставим как есть */ }
        const type = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
        const charset = /charset=([^;\s]+)/i.exec(res.headers['content-type'] || '')?.[1]
        responses.set(r.url, { type, charset, bytes: body, date: r.date, url: r.url })
    }
    if (!responses.size) throw new ReaderError('В архиве нет сохранённых страниц.')
    const entries = [...responses.values()].map(r => ({ name: r.url, size: r.bytes.length, date: r.date ? new Date(r.date) : null, type: r.type }))
    return { entries, responses, getBytes: async n => responses.get(n).bytes }
}
export const warcList = (arc, onOpen) => {
    const wrap = document.createElement('div')
    const pages = arc.entries.filter(e => /html/.test(e.type))
    const other = arc.entries.filter(e => !/html/.test(e.type))
    wrap.innerHTML = `<div class="ur-meta">Страниц: ${pages.length}, других файлов: ${other.length}. Нажмите на адрес, чтобы открыть.</div>`
    const table = document.createElement('table'); table.className = 'ur-arc-table'
    table.innerHTML = '<thead><tr><th>Адрес</th><th>Тип</th><th>Размер</th></tr></thead>'
    const tb = document.createElement('tbody')
    for (const e of [...pages, ...other].slice(0, 20000)) {
        const tr = document.createElement('tr')
        tr.innerHTML = `<td>${/html/.test(e.type) ? '🌐' : '📄'} ${esc(e.name)}</td><td class="ur-muted">${esc(e.type)}</td><td>${fmtSize(e.size)}</td>`
        tr.onclick = () => onOpen(e)
        tb.append(tr)
    }
    table.append(tb); wrap.append(table)
    return wrap
}
export const warcPreview = urls => async (arc, entry) => {
    const r = arc.responses.get(entry.name)
    const box = document.createElement('div')
    if (/html/.test(r.type)) {
        let html; try { html = new TextDecoder(r.charset || 'utf-8').decode(r.bytes) } catch { html = decodeText(r.bytes) }
        const page = packPage({ html, baseUrl: r.url, resources: arc.responses, urls })
        const f = document.createElement('iframe'); f.className = 'ur-web-frame ur-warc-frame'
        f.setAttribute('sandbox', 'allow-same-origin'); f.setAttribute('referrerpolicy', 'no-referrer')
        f.srcdoc = page.replace(/<head[^>]*>/i, m => m + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:">`)
        box.append(f)
    } else if (/^image\//.test(r.type)) {
        const img = new Image(); const u = URL.createObjectURL(new Blob([r.bytes], { type: r.type })); urls.push(u); img.src = u; box.append(img)
    } else {
        const pre = document.createElement('pre'); pre.className = 'ur-plain-code'
        pre.textContent = r.bytes.subarray(0, 4000).includes(0) ? `Двоичный файл, ${fmtSize(r.bytes.length)}` : decodeText(r.bytes.subarray(0, 2_000_000))
        box.append(pre)
    }
    return box
}

// ================= Ярлыки .url, .website, .webloc =================
export const shortcutView = (buf, ext) => {
    let url = '', name = ''
    const u8 = new Uint8Array(buf)
    if (ext === 'webloc') {
        if (latin.decode(u8.subarray(0, 6)) === 'bplist') url = parseBplistObj(buf)?.URL ?? ''
        else url = /<key>URL<\/key>\s*<string>([^<]*)<\/string>/.exec(decodeText(u8))?.[1] ?? ''
    } else {
        const t = decodeText(u8)
        url = /^\s*URL\s*=\s*(.+)$/mi.exec(t)?.[1]?.trim() ?? ''
        name = /^\s*Name\s*=\s*(.+)$/mi.exec(t)?.[1]?.trim() ?? ''
    }
    url = url.replace(/&amp;/g, '&')
    if (!url) throw new ReaderError('В ярлыке не найден адрес.')
    let host = ''; try { host = new URL(url).host } catch { /* не адрес */ }
    const safe = /^(https?|ftp|mailto|obsidian):/i.test(url)
    return `<div class="ur-shortcut"><div class="ur-shortcut-icon">🔗</div><h2>${esc(name || host || 'Ссылка')}</h2>
        <p><code>${esc(url)}</code></p>
        ${safe ? `<p><a class="ur-btn-link external-link" href="${esc(url)}" target="_blank" rel="noopener">Открыть ссылку</a></p>` : '<p class="ur-muted">Адрес необычного вида — открывать его отсюда не будем.</p>'}</div>`
}

// ================= LDIF (адресные книги) =================
export const parseLdif = text => {
    const entries = []
    let cur = null
    const lines = text.replace(/\r/g, '').split('\n')
    const unfolded = []
    for (const l of lines) { if (l.startsWith(' ') && unfolded.length) unfolded[unfolded.length - 1] += l.slice(1); else unfolded.push(l) }
    for (const l of unfolded) {
        if (!l.trim()) { if (cur) entries.push(cur); cur = null; continue }
        if (l.startsWith('#') || /^version:/i.test(l)) continue
        const m = /^([\w;-]+)(::?)\s?(.*)$/.exec(l)
        if (!m) continue
        let v = m[3]
        if (m[2] === '::') { try { v = new TextDecoder().decode(Uint8Array.from(atob(v), c => c.charCodeAt(0))) } catch { /* оставим */ } }
        cur ??= {}
        const k = m[1].split(';')[0].toLowerCase()
        ;(cur[k] ??= []).push(v)
    }
    if (cur) entries.push(cur)
    const one = (e, ...ks) => ks.map(k => e[k]?.[0]).find(Boolean)
    return entries.filter(e => !e.objectclass?.some(o => /organizationalUnit|domain/i.test(o)) || e.mail).map(e => ({
        name: one(e, 'displayname', 'cn') || [one(e, 'givenname'), one(e, 'sn')].filter(Boolean).join(' ') || one(e, 'mail') || 'Без имени',
        org: one(e, 'o', 'company'), title: one(e, 'title'),
        tel: [['telephonenumber', 'раб.'], ['mobile', 'моб.'], ['homephone', 'дом.'], ['facsimiletelephonenumber', 'факс']].flatMap(([k, t]) => (e[k] || []).map(v => ({ v, t }))),
        email: [...(e.mail || []), ...(e.mozillasecondemail || [])],
        adr: [[one(e, 'street', 'mozillaworkstreet2'), one(e, 'l'), one(e, 'st'), one(e, 'postalcode'), one(e, 'c')].filter(Boolean).join(', ')].filter(Boolean),
        url: [one(e, 'mozillaworkurl', 'mozillahomeurl', 'labeleduri')].filter(Boolean),
        note: one(e, 'description'),
    })).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
}
