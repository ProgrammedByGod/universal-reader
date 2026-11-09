// Заметки, почта и подписи версии 0.6: Joplin (.jex), MindManager (.mmap), SimpleMind (.smmx), CherryTree (.ctd, .ctb),
// Xournal/Xournal++ (.xoj, .xopp), SMART Notebook (.notebook), GoodNotes (.goodnotes), Scratch (.sb3, .sb2),
// Mathematica (.nb), электронные подписи (.p7m, .p7s, .sig), Outlook для Mac (.olm), Outlook Express (.dbx)
import JSZip from 'jszip'
import { escapeHtml as esc, decodeText, ReaderError, MIME, extOf, isImageName, parseTar } from '../util.js'
import { makeHtmlBook, splitHtml } from './htmlbook.js'
import { certInfo } from './notes.js'
import { decodeWords } from './textual.js'

const latin = new TextDecoder('latin1')
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e }
const xmlDoc = (text, what) => { const d = new DOMParser().parseFromString(text, 'application/xml'); if (d.querySelector('parsererror')) throw new ReaderError(`Не удалось прочитать ${what} (ошибка XML).`); return d }
const blobUrl = (urls, bytes, name, type) => { const u = URL.createObjectURL(new Blob([bytes], { type: type || MIME[extOf(name)] || '' })); urls.push(u); return u }
const zipOf = async (buf, what) => { const u8 = new Uint8Array(buf); if (!(u8[0] === 0x50 && u8[1] === 0x4B)) throw new ReaderError(`Файл ${what} повреждён (ожидался zip-архив).`); return JSZip.loadAsync(buf) }

// ================= Joplin (.jex — tar с заметками в Markdown) =================
export const openJex = async (ctx, buf, title, renderMd) => {
    const { entries, data } = parseTar(buf)
    const files = entries.map(e => ({ name: e.name.replace(/^\.\//, ''), data: data.subarray(e.offset, e.offset + e.size) }))
    const items = new Map(), res = new Map()
    for (const f of files) {
        if (/^resources\//.test(f.name)) { res.set(f.name.slice(10).replace(/\.[^.]*$/, ''), f); continue }
        if (!/\.md$/.test(f.name)) continue
        const text = new TextDecoder().decode(f.data)
        // метаданные — в конце файла строками «ключ: значение» после пустой строки
        const m = /\n\n((?:[a-z_]+: .*(?:\n|$))+)\s*$/.exec(text)
        const meta = {}
        if (m) for (const l of m[1].split('\n')) { const i = l.indexOf(': '); if (i > 0) meta[l.slice(0, i)] = l.slice(i + 2) }
        const body = m ? text.slice(0, m.index) : text
        items.set(meta.id ?? f.name, { meta, body })
    }
    const notes = [...items.values()].filter(i => i.meta.type_ === '1')
    const folders = new Map([...items.values()].filter(i => i.meta.type_ === '2').map(i => [i.meta.id, i]))
    if (!notes.length) throw new ReaderError('В выгрузке Joplin нет заметок.')
    const pathOf = id => { const out = []; let f = folders.get(id); let g = 0; while (f && g++ < 20) { out.unshift(f.body.split('\n')[0].trim()); f = folders.get(f.meta.parent_id) } return out.join(' / ') }
    const urlOf = id => { const r = res.get(id); if (!r) return null; if (!r.url) r.url = blobUrl(ctx.urls, r.data, r.name); return r.url }
    notes.sort((a, b) => (pathOf(a.meta.parent_id) + a.body).localeCompare(pathOf(b.meta.parent_id) + b.body))
    const sections = []
    for (const n of notes) {
        const lines = n.body.split('\n')
        const name = lines[0].trim() || 'Без названия'
        const md = lines.slice(2).join('\n').replace(/\(:\/([0-9a-f]{32})\)/g, (m, id) => `(${urlOf(id) ?? '#'})`)
        sections.push({ title: name, html: `<h1>${esc(name)}</h1><p class="ur-note-path"><em>${esc(pathOf(n.meta.parent_id))}${n.meta.updated_time ? ' · ' + new Date(n.meta.updated_time).toLocaleString('ru-RU') : ''}</em></p>${await renderMd(md)}` })
    }
    return makeHtmlBook({ title, sections })
}

// ================= Карты мыслей MindManager (.mmap) и SimpleMind (.smmx) =================
export const parseMmap = async buf => {
    const zip = await zipOf(buf, 'MindManager')
    const docName = Object.keys(zip.files).find(n => /(^|\/)Document\.xml$/i.test(n))
    if (!docName) throw new ReaderError('В карте MindManager нет содержимого.')
    const d = xmlDoc(await zip.file(docName).async('string'), 'карту MindManager')
    const conv = t => ({
        text: Array.from(t.children).find(c => c.localName === 'Text')?.getAttribute('PlainText') ?? '',
        note: Array.from(t.children).find(c => c.localName === 'NotesGroup')?.textContent?.trim() || undefined,
        link: Array.from(t.children).find(c => c.localName === 'Hyperlink')?.getAttribute('Url') || undefined,
        children: Array.from(Array.from(t.children).find(c => c.localName === 'SubTopics')?.children ?? []).filter(c => c.localName === 'Topic').map(conv),
    })
    const root = d.getElementsByTagNameNS('*', 'OneTopic')[0]?.getElementsByTagNameNS('*', 'Topic')[0] ?? d.getElementsByTagNameNS('*', 'Topic')[0]
    if (!root) throw new ReaderError('В карте MindManager нет тем.')
    return [{ title: '', root: conv(root) }]
}
export const parseSmmx = async buf => {
    const zip = await zipOf(buf, 'SimpleMind')
    const name = Object.keys(zip.files).find(n => /mindmap\.xml$/i.test(n))
    if (!name) throw new ReaderError('В карте SimpleMind нет содержимого.')
    const d = xmlDoc(await zip.file(name).async('string'), 'карту SimpleMind')
    const nodes = new Map()
    for (const t of d.getElementsByTagName('topic')) nodes.set(t.getAttribute('id'), { text: (t.getAttribute('text') ?? '').replace(/\\N/g, '\n'), note: t.getElementsByTagName('note')[0]?.textContent?.trim() || undefined, children: [], parent: t.getAttribute('parent') })
    const roots = []
    for (const n of nodes.values()) (nodes.get(n.parent)?.children ?? roots).push(n)
    if (!roots.length) throw new ReaderError('В карте SimpleMind нет тем.')
    return roots.map(r => ({ title: '', root: r }))
}

// ================= CherryTree (.ctd — XML, .ctb — SQLite) =================
const ctRich = xmlText => {
    // rich_text: куски текста с атрибутами weight, style, underline, scale, link, foreground
    const d = new DOMParser().parseFromString(`<n>${xmlText.replace(/<\?xml[^>]*\?>/g, '').replace(/<\/?node[^>]*>/g, '')}</n>`, 'application/xml')
    return Array.from(d.documentElement.getElementsByTagName('rich_text')).map(r => {
        let t = esc(r.textContent).replace(/\n/g, '<br>')
        if (r.getAttribute('weight') === 'heavy') t = `<b>${t}</b>`
        if (r.getAttribute('style') === 'italic') t = `<i>${t}</i>`
        if (r.getAttribute('underline')) t = `<u>${t}</u>`
        if (r.getAttribute('strikethrough')) t = `<s>${t}</s>`
        if (r.getAttribute('family') === 'monospace') t = `<code>${t}</code>`
        const sc = r.getAttribute('scale'); if (sc === 'h1' || sc === 'h2' || sc === 'h3') t = `<span class="ur-ct-${sc}">${t}</span>`
        const lk = r.getAttribute('link'); if (lk?.startsWith('webs ')) t = `<a href="${esc(lk.slice(5))}">${t}</a>`
        const fg = r.getAttribute('foreground'); if (fg && /^#[0-9a-f]{6,12}$/i.test(fg)) t = `<span style="color:${fg.length === 13 ? '#' + fg.slice(1, 3) + fg.slice(5, 7) + fg.slice(9, 11) : fg}">${t}</span>`
        return t
    }).join('')
}
export const openCherryTree = async (ctx, buf, title, ext) => {
    const sections = []
    const add = (name, depth, html) => sections.push({ title: '  '.repeat(depth) + name, html: `<h${Math.min(depth + 1, 4)}>${esc(name)}</h${Math.min(depth + 1, 4)}>${html}` })
    const u8 = new Uint8Array(buf)
    if (latin.decode(u8.subarray(0, 15)) === 'SQLite format 3') {
        const { initSqlJs } = await ctx.loadLib('sqlite')
        const SQL = await initSqlJs(); const db = new SQL.Database(u8)
        try {
            const rows = db.exec('SELECT n.node_id, n.name, n.txt, n.syntax, c.father_id, c.sequence FROM node n LEFT JOIN children c ON c.node_id = n.node_id')[0]?.values ?? []
            const kids = new Map()
            for (const r of rows) { const f = r[4] ?? 0; if (!kids.has(f)) kids.set(f, []); kids.get(f).push(r) }
            for (const v of kids.values()) v.sort((a, b) => a[5] - b[5])
            const walk = (id, depth) => { for (const r of kids.get(id) ?? []) { add(r[1], depth, r[3] === 'custom-colors' ? ctRich(r[2] ?? '') : `<pre>${esc(r[2] ?? '')}</pre>`); walk(r[0], depth + 1) } }
            walk(0, 0)
        } finally { db.close() }
    } else {
        const d = xmlDoc(decodeText(u8), 'дерево CherryTree')
        const walk = (n, depth) => {
            for (const c of n.children) {
                if (c.localName !== 'node') continue
                const rich = Array.from(c.children).filter(x => x.localName === 'rich_text')
                const html = c.getAttribute('prog_lang') && c.getAttribute('prog_lang') !== 'custom-colors' ? `<pre>${esc(rich.map(r => r.textContent).join(''))}</pre>` : ctRich(rich.map(r => new XMLSerializer().serializeToString(r)).join(''))
                add(c.getAttribute('name') ?? '', depth, html)
                walk(c, depth + 1)
            }
        }
        walk(d.documentElement, 0)
    }
    if (!sections.length) throw new ReaderError('В дереве CherryTree нет записей.')
    return makeHtmlBook({ title, sections, css: '.ur-ct-h1{font-size:1.6em;font-weight:bold}.ur-ct-h2{font-size:1.35em;font-weight:bold}.ur-ct-h3{font-size:1.15em;font-weight:bold}' })
}

// ================= Xournal (.xoj) и Xournal++ (.xopp): рукописные заметки =================
export const xournalView = async (ctx, buf) => {
    const { gunzip } = await import('./compress.js')
    let u8 = new Uint8Array(buf)
    if (u8[0] === 0x1F && u8[1] === 0x8B) u8 = await gunzip(u8)
    const d = xmlDoc(new TextDecoder().decode(u8), 'заметку Xournal')
    const wrap = el('div', 'ur-xournal')
    const pages = Array.from(d.getElementsByTagName('page'))
    if (!pages.length) throw new ReaderError('В заметке нет страниц.')
    const col = c => { if (!c) return '#000'; if (c.startsWith('#')) return c.length === 9 ? '#' + c.slice(1, 7) : c; return { black: '#000', blue: '#3333cc', red: '#ff0000', green: '#008000', gray: '#808080', lightblue: '#00c0ff', lightgreen: '#00ff00', magenta: '#ff00ff', orange: '#ff8000', yellow: '#ffff00', white: '#fff' }[c] ?? '#000' }
    let pdfBg = false
    pages.forEach((p, i) => {
        const W = +p.getAttribute('width'), H = +p.getAttribute('height')
        let svg = ''
        const bg = p.getElementsByTagName('background')[0]
        if (bg?.getAttribute('type') === 'pdf') pdfBg = true
        const bgc = bg?.getAttribute('type') === 'solid' ? col(bg.getAttribute('color')) : '#fff'
        if (bg?.getAttribute('style') === 'lined' || bg?.getAttribute('style') === 'ruled') for (let y = 80; y < H; y += 24) svg += `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="#a0c4ff" stroke-width="0.6"/>`
        if (bg?.getAttribute('style') === 'graph') { for (let y = 0; y < H; y += 14) svg += `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="#d0e4ff" stroke-width="0.5"/>`; for (let x = 0; x < W; x += 14) svg += `<line y1="0" y2="${H}" x1="${x}" x2="${x}" stroke="#d0e4ff" stroke-width="0.5"/>` }
        for (const layer of p.getElementsByTagName('layer')) for (const n of layer.children) {
            if (n.localName === 'stroke') {
                const pts = n.textContent.trim().split(/\s+/).map(Number)
                const widths = (n.getAttribute('width') ?? '1').split(/\s+/).map(Number)
                const tool = n.getAttribute('tool')
                let pp = ''; for (let k = 0; k + 1 < pts.length; k += 2) pp += `${pts[k]},${pts[k + 1]} `
                svg += `<polyline points="${pp}" fill="none" stroke="${col(n.getAttribute('color'))}" stroke-width="${widths[0] || 1}" stroke-linecap="round" stroke-linejoin="round"${tool === 'highlighter' ? ' opacity="0.45"' : ''}/>`
            } else if (n.localName === 'text') {
                const lines = n.textContent.split('\n'); const sz = +n.getAttribute('size') || 12
                svg += `<text x="${n.getAttribute('x')}" y="${+n.getAttribute('y') + sz}" font-size="${sz}" fill="${col(n.getAttribute('color'))}" font-family="${esc(n.getAttribute('font') ?? 'sans-serif')}">${lines.map((l, k) => `<tspan x="${n.getAttribute('x')}" dy="${k ? sz * 1.2 : 0}">${esc(l)}</tspan>`).join('')}</text>`
            } else if (n.localName === 'image') {
                const b64 = n.textContent.trim()
                if (b64) svg += `<image href="data:image/png;base64,${b64}" x="${n.getAttribute('left')}" y="${n.getAttribute('top')}" width="${n.getAttribute('right') - n.getAttribute('left')}" height="${n.getAttribute('bottom') - n.getAttribute('top')}" preserveAspectRatio="none"/>`
            }
        }
        wrap.append(el('div', 'ur-ofd-page', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;background:${bgc}">${svg}</svg>`))
        void i
    })
    if (pdfBg) wrap.prepend(el('div', 'ur-meta', 'Страницы нарисованы поверх PDF — сам PDF-документ здесь не показывается, только рукописные пометки.'))
    return wrap
}

// ================= SMART Notebook (.notebook) и GoodNotes (.goodnotes) =================
export const smartNotebookView = async (ctx, buf) => {
    const zip = await zipOf(buf, 'SMART Notebook')
    let order = []
    const man = zip.file('imsmanifest.xml')
    if (man) order = [...(await man.async('string')).matchAll(/href="(page\d+\.svg)"/g)].map(m => m[1])
    if (!order.length) order = Object.keys(zip.files).filter(n => /^page\d+\.svg$/i.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    if (!order.length) throw new ReaderError('В файле SMART Notebook нет страниц.')
    const wrap = el('div', 'ur-xournal')
    for (const n of [...new Set(order)]) {
        let svg = await zip.file(n)?.async('string'); if (!svg) continue
        // картинки страницы лежат рядом в архиве — подменяем ссылки
        for (const m of [...svg.matchAll(/xlink:href="([^"#][^"]*)"/g)]) { const f = zip.file(m[1]); if (f) svg = svg.replace(m[0], `xlink:href="data:${MIME[extOf(m[1])] || 'image/png'};base64,${await f.async('base64')}"`) } // внутри SVG-картинки работают только data:-ссылки
        const u = blobUrl(ctx.urls, new TextEncoder().encode(svg.replace(/<script[\s\S]*?<\/script>/gi, '')), n, 'image/svg+xml')
        wrap.append(el('div', 'ur-ofd-page', `<img src="${u}" style="width:100%;display:block;background:#fff">`))
    }
    return wrap
}
export const goodnotesView = async (ctx, buf) => {
    const zip = await zipOf(buf, 'GoodNotes')
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir)
    const thumbs = names.filter(n => /thumbnail/i.test(n) && /\.(png|jpe?g)$/i.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    const pdfs = names.filter(n => /\.pdf$/i.test(n) || (/attachments\//i.test(n)))
    const wrap = el('div', '', `<p class="ur-muted">GoodNotes хранит рукописные страницы в своём закрытом формате — показываем сохранённые миниатюры${pdfs.length ? ' и вложенные документы' : ''}.</p>`)
    if (thumbs.length) { const g = el('div', 'ur-thumbs-grid'); for (const t of thumbs) g.append(el('figure', '', `<img src="${blobUrl(ctx.urls, await zip.file(t).async('uint8array'), t)}" style="max-width:260px;max-height:340px"><figcaption>${esc(t.split('/').pop())}</figcaption>`)); wrap.append(g) }
    if (pdfs.length) wrap.append(el('div', '', `<h3>Вложения (${pdfs.length})</h3><ul>${pdfs.map(p => `<li><code>${esc(p)}</code></li>`).join('')}</ul>`))
    if (!thumbs.length && !pdfs.length) throw new ReaderError('В файле GoodNotes нет ни миниатюр, ни вложений.')
    return wrap
}

// ================= Scratch (.sb3, .sb2) =================
const SCRATCH_CAT = { motion: 'Движение', looks: 'Внешний вид', sound: 'Звук', event: 'События', control: 'Управление', sensing: 'Сенсоры', operator: 'Операторы', data: 'Переменные', procedures: 'Мои блоки', pen: 'Перо', music: 'Музыка', videoSensing: 'Видео', text2speech: 'Речь', translate: 'Перевод' }
export const scratchView = async (ctx, buf) => {
    const zip = await zipOf(buf, 'Scratch')
    const pj = zip.file('project.json')
    if (!pj) throw new ReaderError('В проекте Scratch нет описания (project.json).')
    const p = JSON.parse(await pj.async('string'))
    const wrap = el('div', 'ur-scratch')
    const asset = async (md5ext, fmt) => { const f = zip.file(md5ext) ?? zip.file(Object.keys(zip.files).find(n => n.startsWith(md5ext.split('.')[0])) ?? ''); return f ? blobUrl(ctx.urls, await f.async('uint8array'), md5ext, fmt === 'svg' ? 'image/svg+xml' : undefined) : null }
    const targets = p.targets ?? [p, ...(p.children ?? []).filter(c => c.objName)]
    wrap.append(el('div', 'ur-meta', `Спрайтов: ${targets.filter(t => !t.isStage && t.objName !== 'Stage').length}${p.meta?.semver ? ` · Scratch ${p.meta.semver}` : ''}`))
    for (const t of targets) {
        const name = t.name ?? t.objName ?? ''
        const costumes = t.costumes ?? []
        const sounds = t.sounds ?? []
        const blocks = t.blocks ? Object.values(t.blocks).filter(b => b && typeof b === 'object' && b.opcode) : []
        const scripts = t.blocks ? blocks.filter(b => b.topLevel).length : (t.scripts ?? []).length
        const cats = new Map(); for (const b of blocks) { const c = SCRATCH_CAT[b.opcode.split('_')[0]] ?? b.opcode.split('_')[0]; cats.set(c, (cats.get(c) ?? 0) + 1) }
        const vars = Object.values(t.variables ?? {}).map(v => Array.isArray(v) ? v[0] : v.name).filter(Boolean)
        const sec = el('section', 'ur-scratch-target', `<h3>${t.isStage || name === 'Stage' ? '🎭 Сцена' : '🐱 ' + esc(name)}</h3><div class="ur-meta">Скриптов: ${scripts} · блоков: ${blocks.length}${cats.size ? ' (' + [...cats].map(([k, v]) => `${esc(k)}: ${v}`).join(', ') + ')' : ''}${vars.length ? ' · переменные: ' + esc(vars.join(', ')) : ''}</div>`)
        const g = el('div', 'ur-thumbs-grid')
        for (const c of costumes.slice(0, 40)) { const u = await asset(c.md5ext ?? (c.assetId ? `${c.assetId}.${c.dataFormat}` : c.baseLayerMD5 ?? ''), c.dataFormat); if (u) g.append(el('figure', '', `<img src="${u}" style="max-width:120px;max-height:120px;background:#fff"><figcaption>${esc(c.name ?? c.costumeName ?? '')}</figcaption>`)) }
        if (g.childNodes.length) sec.append(g)
        for (const s of sounds.slice(0, 20)) { const u = await asset(s.md5ext ?? (s.assetId ? `${s.assetId}.${s.dataFormat}` : s.md5 ?? '')); if (u) sec.append(el('div', 'ur-scratch-sound', `🔊 ${esc(s.name ?? s.soundName ?? '')} <audio controls preload="none" src="${u}"></audio>`)) }
        wrap.append(sec)
    }
    return wrap
}

// ================= Mathematica (.nb) =================
export const nbView = text => {
    if (!/Notebook\[/.test(text)) throw new ReaderError('Это не блокнот Mathematica.')
    const out = []
    // Cell["текст", "Стиль"] и Cell[BoxData[...], "Input"]
    const re = /Cell\[\s*(?:"((?:[^"\\]|\\.)*)"|(BoxData|TextData)\[)/g
    let m
    const unq = s => s.replace(/\\\[(\w+)\]/g, (x, n) => ({ Rule: '→', Equal: '⩵', LessEqual: '≤', GreaterEqual: '≥', NotEqual: '≠', Alpha: 'α', Beta: 'β', Gamma: 'γ', Pi: 'π', Infinity: '∞', Degree: '°', Times: '×', Element: '∈', Integral: '∫', Sum: '∑', DifferentialD: 'd' }[n] ?? n)).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    const styleAfter = pos => /^\s*,\s*"(\w+)"/.exec(text.slice(pos, pos + 200))?.[1] ?? ''
    // находим конец выражения со сбалансированными скобками
    const endOf = pos => { let depth = 1, i = pos, inStr = false; while (i < text.length && depth) { const c = text[i]; if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false } else if (c === '"') inStr = true; else if (c === '[') depth++; else if (c === ']') depth--; i++ } return i }
    while ((m = re.exec(text))) {
        if (m[1] != null) { out.push({ style: styleAfter(m.index + m[0].length), text: unq(m[1]) }); continue }
        const end = endOf(m.index + m[0].length)
        const body = text.slice(m.index + m[0].length, end - 1)
        const style = styleAfter(end)
        const strings = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => unq(x[1])).filter(s => !/^\\?[\[\]{},]$/.test(s))
        out.push({ style, text: strings.join(m[2] === 'TextData' ? '' : ' ') })
        re.lastIndex = end
    }
    const cells = out.filter(c => c.text.trim() && !['CellLabel', 'ExpressionUUID', 'CellTags'].includes(c.style))
    if (!cells.length) throw new ReaderError('В блокноте нет ячеек с текстом.')
    const html = cells.map(c => {
        const t = esc(c.text)
        if (/^(Title)$/.test(c.style)) return `<h1>${t}</h1>`
        if (/^(Chapter|Section)$/.test(c.style)) return `<h2>${t}</h2>`
        if (/^(Subsection|Subsubsection)$/.test(c.style)) return `<h3>${t}</h3>`
        if (/^(Input|Code)$/.test(c.style)) return `<pre class="ur-nb-in">In: ${t}</pre>`
        if (/^Output$/.test(c.style)) return `<pre class="ur-nb-out">Out: ${t}</pre>`
        return `<p>${t.replace(/\n/g, '<br>')}</p>`
    }).join('\n')
    return el('div', 'ur-nb', `<div class="ur-meta">Ячеек: ${cells.length}. Формулы показаны текстом, графики не рисуются.</div>${html}`)
}

// ================= Электронные подписи: .p7m (документ с подписью), .p7s и .sig (отдельная подпись) =================
// BER: бывает «неопределённая длина» (0x80) — тогда содержимое заканчивается двумя нулями
const ber = (u8, p, end) => {
    const out = []
    while (p < end) {
        const tag = u8[p]; if (tag === 0 && u8[p + 1] === 0) return { nodes: out, next: p + 2 }
        let len = u8[p + 1], hl = 2, indef = false
        if (len === 0x80) indef = true
        else if (len & 0x80) { const n = len & 0x7F; len = 0; for (let i = 0; i < n; i++) len = len * 256 + u8[p + 2 + i]; hl = 2 + n }
        const node = { tag, start: p, hl }
        if (indef) { const r = ber(u8, p + 2, end); node.kids = r.nodes; node.len = r.next - p - 2; node.end = r.next }
        else { node.len = len; node.end = p + hl + len; node.body = u8.subarray(p + hl, p + hl + len); if (tag & 0x20) node.kids = ber(u8, p + hl, p + hl + len).nodes }
        out.push(node)
        p = node.end
    }
    return { nodes: out, next: p }
}
const octets = n => n.body && !(n.tag & 0x20) ? n.body : (n.kids ?? []).reduce((acc, k) => { const b = octets(k); const r = new Uint8Array(acc.length + b.length); r.set(acc); r.set(b, acc.length); return r }, new Uint8Array())
const oid = b => { const a = [Math.floor(b[0] / 40), b[0] % 40]; let v = 0; for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 0x7F); if (!(b[i] & 0x80)) { a.push(v); v = 0 } } return a.join('.') }
const asnDate = n => { const s = latin.decode(n.body); const m = n.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/.exec(s) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/.exec(s); if (!m) return null; const y = n.tag === 0x17 ? (+m[1] < 50 ? 2000 : 1900) + +m[1] : +m[1]; return new Date(Date.UTC(y, m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))) }
const fromB64 = s => { const bin = atob(s.replace(/[^A-Za-z0-9+/=]/g, '')); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }
export const parseCms = buf => {
    let u8 = new Uint8Array(buf)
    const head = latin.decode(u8.subarray(0, 100))
    if (head.includes('-----BEGIN')) u8 = fromB64(latin.decode(u8).replace(/-----[^-]+-----/g, ''))
    else if (/^[A-Za-z0-9+/=\s]+$/.test(latin.decode(u8.subarray(0, 2000))) && u8[0] !== 0x30) u8 = fromB64(latin.decode(u8))
    if (u8[0] !== 0x30) throw new ReaderError('Это не электронная подпись PKCS#7/CMS.')
    const root = ber(u8, 0, u8.length).nodes[0]
    const type = root?.kids?.[0]?.tag === 0x06 ? oid(root.kids[0].body) : ''
    if (type !== '1.2.840.113549.1.7.2') throw new ReaderError('В файле нет подписанных данных (SignedData).')
    const sd = root.kids[1].kids[0]
    const k = sd.kids
    let i = 2 // версия, алгоритмы
    const eci = k[i++]
    const content = eci.kids?.[1] ? octets(eci.kids[1].kids?.[0] ?? eci.kids[1]) : null
    const certs = [], signers = []
    for (; i < k.length; i++) {
        if (k[i].tag === 0xA0) for (const c of k[i].kids ?? []) certs.push(u8.subarray(c.start, c.end))
        else if (k[i].tag === 0x31) for (const s of k[i].kids ?? []) {
            let time = null
            const sa = s.kids.find(x => x.tag === 0xA0)
            for (const a of sa?.kids ?? []) if (a.kids?.[0]?.tag === 0x06 && oid(a.kids[0].body) === '1.2.840.113549.1.9.5') { const v = a.kids[1]?.kids?.[0]; if (v) time = asnDate(v) }
            const sid = s.kids[1]
            const serial = sid?.tag === 0x30 ? sid.kids?.[1]?.body : null
            signers.push({ time, serial })
        }
    }
    return { content: content?.length ? content : null, certs, signers }
}
const hexOf = u8 => [...(u8 ?? [])].map(b => b.toString(16).padStart(2, '0')).join(':').toUpperCase()
export const signatureView = async ({ certs, signers, content }, { innerName, onOpenInner, detachedFor } = {}) => {
    const infos = []
    for (const c of certs) { try { infos.push(await certInfo(c)) } catch { /* сертификат не разобрался */ } }
    const NAME_RU = { CN: 'Имя', O: 'Организация', OU: 'Подразделение', T: 'Должность', title: 'Должность', SN: 'Фамилия', G: 'Имя и отчество', GN: 'Имя и отчество', L: 'Город', ST: 'Регион', C: 'Страна', E: 'Почта', INN: 'ИНН', OGRN: 'ОГРН', SNILS: 'СНИЛС', INNLE: 'ИНН организации', OGRNIP: 'ОГРНИП' }
    const OID_RU = { '1.2.643.3.131.1.1': 'INN', '1.2.643.100.1': 'OGRN', '1.2.643.100.3': 'SNILS', '1.2.643.100.4': 'INNLE', '1.2.643.100.5': 'OGRNIP', '2.5.4.12': 'T', '2.5.4.4': 'SN', '2.5.4.42': 'G' }
    const sig = signers.map(s => {
        const c = infos.find(ci => s.serial && ci.serial === hexOf(s.serial)) ?? infos.find(ci => !ci.isCa) ?? infos[0]
        const subject = c?.subject.map(([k, v]) => [OID_RU[k] ?? k, v]) ?? []
        const pick = k => subject.find(x => x[0] === k)?.[1]
        const who = [pick('SN') && pick('G') ? `${pick('SN')} ${pick('G')}` : pick('CN'), pick('T'), pick('O')].filter(Boolean)
        const now = new Date()
        const state = !c ? '' : c.to && c.to < (s.time ?? now) ? '<span class="ur-badge is-bad">сертификат истёк к моменту подписи</span>' : c.to && c.to < now ? '<span class="ur-badge">срок сертификата сейчас истёк</span>' : '<span class="ur-badge is-good">сертификат действовал</span>'
        return `<div class="ur-card ur-cert"><div class="ur-card-body"><div class="ur-card-name">✍️ ${esc(who[0] ?? 'Подписант')} ${state}</div>
            ${who.slice(1).map(w => `<div>${esc(w)}</div>`).join('')}
            ${s.time ? `<div>Подписано: ${s.time.toLocaleString('ru-RU')}</div>` : ''}
            ${c ? `<div class="ur-muted">Сертификат: ${c.from?.toLocaleDateString('ru-RU') ?? '?'} — ${c.to?.toLocaleDateString('ru-RU') ?? '?'}, выдан: ${esc(c.issuer.find(x => x[0] === 'CN')?.[1] ?? c.issuer.find(x => x[0] === 'O')?.[1] ?? '')}</div>
            <details><summary>Все данные сертификата</summary>${subject.map(([k, v]) => `<div><span class="ur-muted">${esc(NAME_RU[k] ?? k)}:</span> ${esc(v)}</div>`).join('')}</details>` : ''}</div></div>`
    }).join('')
    const wrap = el('div', 'ur-sig', `<p class="ur-muted">Проверку подлинности подписи (криптографию) читалка не выполняет — показывает, кто и когда подписал, по данным внутри файла.</p>${sig || '<p>В файле нет сведений о подписантах.</p>'}`)
    if (detachedFor) wrap.prepend(el('p', '', `Это отдельная подпись к файлу <b>${esc(detachedFor)}</b>.`))
    if (content && onOpenInner) {
        const b = el('button', 'mod-cta', `Сохранить подписанный документ${innerName ? ` «${esc(innerName)}»` : ''} рядом`)
        const msg = el('span', 'ur-muted')
        b.onclick = async () => { msg.textContent = ' ' + await onOpenInner() }
        const p = el('p'); p.append(b, msg)
        wrap.prepend(p)
        wrap.prepend(el('p', '', `Внутри — подписанный документ${innerName ? ` <b>${esc(innerName)}</b>` : ''} (${content.length < 1024 ? content.length + ' байт' : (content.length / 1024).toFixed(1) + ' КБ'}).`))
    }
    return wrap
}

// ================= Outlook для Mac (.olm) =================
export const openOlm = async buf => {
    const zip = await zipOf(buf, 'Outlook для Mac')
    const names = Object.keys(zip.files).filter(n => /message_\d+\.xml$/i.test(n) || /com\.microsoft\.__Messages\/.*\.xml$/i.test(n))
    if (!names.length) throw new ReaderError('В архиве Outlook нет писем.')
    const msgs = []
    for (const n of names.slice(0, 20000)) {
        const d = new DOMParser().parseFromString(await zip.file(n).async('string'), 'application/xml')
        for (const e of d.getElementsByTagName('email')) {
            const t = tag => e.getElementsByTagName(tag)[0]
            const addr = tag => Array.from(t(tag)?.getElementsByTagName('emailAddress') ?? []).map(a => `${a.getAttribute('OPFContactEmailAddressName') ?? ''} <${a.getAttribute('OPFContactEmailAddressAddress') ?? ''}>`.trim()).join(', ')
            const subject = t('OPFMessageCopySubject')?.textContent ?? ''
            const from = addr('OPFMessageCopySenderAddress') || addr('OPFMessageCopyFromAddresses')
            const date = t('OPFMessageCopySentTime')?.textContent || t('OPFMessageCopyReceivedTime')?.textContent
            const html = t('OPFMessageCopyHTMLBody')?.textContent
            const text = t('OPFMessageCopyBody')?.textContent ?? ''
            const folder = n.split('/').slice(-3, -1).join('/')
            // собираем письмо в виде .eml, чтобы показать обычным просмотрщиком писем
            const eml = `From: ${from}\r\nTo: ${addr('OPFMessageCopyToAddresses')}\r\n${addr('OPFMessageCopyCCAddresses') ? `Cc: ${addr('OPFMessageCopyCCAddresses')}\r\n` : ''}Subject: =?utf-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=\r\nDate: ${date ? new Date(date).toUTCString() : ''}\r\nMIME-Version: 1.0\r\nContent-Type: ${html ? 'text/html' : 'text/plain'}; charset=utf-8\r\n\r\n${html ?? text}`
            const bytes = new TextEncoder().encode(eml)
            msgs.push({ name: String(msgs.length + 1), size: bytes.length, bytes, subject: subject || '(без темы)', from: from.replace(/\s*<.*$/, '') || from, date: date ? new Date(date) : null, folder })
        }
    }
    if (!msgs.length) throw new ReaderError('В архиве Outlook нет писем.')
    msgs.sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
    msgs.forEach((m, i) => { m.name = String(i + 1) })
    return msgs
}

// ================= Outlook Express (.dbx) =================
// Письма лежат цепочками блоков: [адрес самого блока, размер, длина данных, …, адрес следующего] + данные
export const openDbx = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (dv.getUint32(0, true) !== 0xFE12ADCF) throw new ReaderError('Это не папка Outlook Express (.dbx).')
    const blocks = new Map(), nexts = new Set()
    for (let o = 0x24C0; o + 16 <= u8.length; o += 4) {
        if (dv.getUint32(o, true) !== o) continue
        const size = dv.getUint32(o + 4, true), len = dv.getUint16(o + 8, true), next = dv.getUint32(o + 12, true)
        if (size !== 0x200 || len === 0 || len > 0x200 || o + 16 + len > u8.length) continue
        blocks.set(o, { len, next })
        if (next) nexts.add(next)
        o += 0x200 + 16 - 4
    }
    const msgs = []
    for (const [start] of blocks) {
        if (nexts.has(start)) continue // это продолжение, а не начало письма
        const parts = []; let o = start, guard = 0
        while (o && blocks.has(o) && guard++ < 100000) { const b = blocks.get(o); parts.push(u8.subarray(o + 16, o + 16 + b.len)); o = b.next }
        const total = parts.reduce((s, p) => s + p.length, 0)
        const bytes = new Uint8Array(total); let p = 0; for (const part of parts) { bytes.set(part, p); p += part.length }
        const head = latin.decode(bytes.subarray(0, 4000))
        if (!/^(Received|From|Return-Path|Date|Subject|Message-ID|MIME-Version|X-[\w-]+|To|Delivered-To):/mi.test(head)) continue
        const h = n => { const m = new RegExp(`^${n}:\\s*(.*(?:\\r?\\n[ \\t].*)*)`, 'mi').exec(head); return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '' }
        msgs.push({ size: bytes.length, bytes, subject: decodeWords(h('Subject')) || '(без темы)', from: decodeWords(h('From')), date: h('Date') ? new Date(h('Date')) : null })
    }
    if (!msgs.length) throw new ReaderError('В папке Outlook Express не найдено писем.')
    msgs.forEach((m, i) => { m.name = String(i + 1) })
    return msgs
}

// ================= Подпись OpenPGP (.sig, .asc от GnuPG) =================
export const isPgpSig = u8 => latin.decode(u8.subarray(0, 40)).includes('-----BEGIN PGP') || u8[0] === 0x88 || u8[0] === 0x89 || u8[0] === 0xC2
export const pgpSigView = buf => {
    let u8 = new Uint8Array(buf)
    const t = latin.decode(u8)
    if (t.includes('-----BEGIN PGP')) { const m = /-----BEGIN PGP [A-Z ]+-----\r?\n(?:[\w-]+:.*\r?\n)*\r?\n([\s\S]*?)(?:\r?\n=[\w+/=]{4})?\r?\n-----END/.exec(t); if (!m) throw new ReaderError('Не удалось прочитать подпись OpenPGP.'); u8 = fromB64(m[1]) }
    let p = 0
    const tag = u8[p++]
    let len
    if (tag & 0x40) { const a = u8[p++]; len = a < 192 ? a : a < 224 ? ((a - 192) << 8) + u8[p++] + 192 : (u8[p] << 24 | u8[p + 1] << 16 | u8[p + 2] << 8 | u8[p + 3], p += 4, 0) }
    else { const lt = tag & 3; len = lt === 0 ? u8[p++] : lt === 1 ? (u8[p++] << 8 | u8[p++]) : 0 }
    void len
    const ver = u8[p]
    const info = { ver }
    const HASH = { 1: 'MD5', 2: 'SHA-1', 8: 'SHA-256', 9: 'SHA-384', 10: 'SHA-512', 11: 'SHA-224' }
    const ALG = { 1: 'RSA', 17: 'DSA', 19: 'ECDSA', 22: 'EdDSA', 27: 'Ed25519' }
    const hexs = a => [...a].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
    if (ver === 3) { info.time = new Date(((u8[p + 3] << 24) >>> 0 | u8[p + 4] << 16 | u8[p + 5] << 8 | u8[p + 6]) * 1000); info.issuer = hexs(u8.subarray(p + 7, p + 15)); info.alg = ALG[u8[p + 15]]; info.hash = HASH[u8[p + 16]] }
    else if (ver === 4 || ver === 5) {
        info.alg = ALG[u8[p + 2]]; info.hash = HASH[u8[p + 3]]
        let q = p + 4
        for (let area = 0; area < 2; area++) {
            const n = u8[q] << 8 | u8[q + 1]; const end = q + 2 + n; q += 2
            while (q < end) {
                let l = u8[q++]; if (l >= 192 && l < 255) l = ((l - 192) << 8) + u8[q++] + 192; else if (l === 255) { l = (u8[q] << 24 | u8[q + 1] << 16 | u8[q + 2] << 8 | u8[q + 3]) >>> 0; q += 4 }
                const st = u8[q] & 0x7F, body = u8.subarray(q + 1, q + l)
                if (st === 2) info.time = new Date(((body[0] << 24) >>> 0 | body[1] << 16 | body[2] << 8 | body[3]) * 1000)
                if (st === 16) info.issuer = hexs(body)
                if (st === 33) info.fp = hexs(body.subarray(1))
                if (st === 28) info.user = new TextDecoder().decode(body)
                q += l
            }
            q = end
        }
    } else throw new ReaderError('Неизвестная версия подписи OpenPGP.')
    return el('div', 'ur-sig', `<p class="ur-muted">Проверку подлинности подписи читалка не выполняет — показывает данные из самой подписи.</p>
        <div class="ur-card ur-cert"><div class="ur-card-body"><div class="ur-card-name">✍️ Подпись OpenPGP (GnuPG)</div>
        ${info.user ? `<div>Подписант: ${esc(info.user)}</div>` : ''}
        ${info.time ? `<div>Подписано: ${info.time.toLocaleString('ru-RU')}</div>` : ''}
        ${info.fp ? `<div class="ur-break">Отпечаток ключа: ${esc(info.fp.replace(/(.{4})/g, '$1 ').trim())}</div>` : info.issuer ? `<div>Ключ: ${esc(info.issuer)}</div>` : ''}
        <div class="ur-muted">Алгоритм: ${esc([info.alg, info.hash].filter(Boolean).join(', ') || '?')}</div></div></div>`)
}

// ================= Outlook (.pst, .ost) — через библиотеку pst-extractor =================
const b64utf8 = str => { const b = new TextEncoder().encode(str); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s) }
const b64bytes = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s).replace(/.{76}/g, '$&\r\n') }
const encWord = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?utf-8?B?${b64utf8(s)}?=`
export const openPst = async (ctx, buf) => {
    const u8 = new Uint8Array(buf)
    if (latin.decode(u8.subarray(0, 4)) !== '!BDN') throw new ReaderError('Это не файл Outlook (.pst/.ost).')
    if ((u8[10] | u8[11] << 8) < 20) throw new ReaderError('Это файл Outlook 97–2002 (старый формат ANSI) — читалка пока открывает только .pst и .ost от Outlook 2003 и новее.')
    const { PSTFile, Buffer } = await ctx.loadLib('pst')
    let pst
    try { pst = new PSTFile(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)) } catch (e) { throw new ReaderError('Не удалось открыть файл Outlook: ' + (e?.message || e)) }
    const msgs = []
    const KIND = { 'IPM.Contact': '👤 ', 'IPM.Appointment': '📅 ', 'IPM.Task': '✅ ', 'IPM.StickyNote': '🗒 ', 'IPM.Activity': '📓 ' }
    const toEml = m => {
        const date = m.clientSubmitTime ?? m.messageDeliveryTime
        let html = '', text = ''
        try { html = m.bodyHTML } catch { /* нет HTML */ }
        try { text = m.body } catch { /* нет текста */ }
        const cls = m.messageClass || ''
        if (!html && !text) {
            // контакты, встречи, задачи — показываем их поля
            const rows = []
            const add = (k, f) => { try { const v = f(); if (v && String(v).trim()) rows.push(`<tr><td>${k}</td><td>${esc(v instanceof Date ? v.toLocaleString('ru-RU') : String(v))}</td></tr>`) } catch { /* нет поля */ } }
            add('Имя', () => m.displayName); add('Почта', () => m.email1EmailAddress); add('Телефон', () => m.mobileTelephoneNumber || m.businessTelephoneNumber || m.homeTelephoneNumber)
            add('Организация', () => m.companyName); add('Должность', () => m.title); add('Начало', () => m.startTime); add('Конец', () => m.endTime); add('Место', () => m.location)
            if (rows.length) html = `<table>${rows.join('')}</table>`
        }
        const parts = []
        for (let i = 0; i < m.numberOfAttachments; i++) {
            try {
                const a = m.getAttachment(i); const st = a.fileInputStream; if (!st) continue
                const len = typeof st.length === 'object' ? st.length.toNumber() : Number(st.length)
                const data = Buffer.alloc(len); st.readCompletely(data)
                const name = a.longFilename || a.filename || `вложение ${i + 1}`
                parts.push(`Content-Type: ${a.mimeTag || 'application/octet-stream'}; name="${encWord(name)}"\r\nContent-Disposition: attachment; filename="${encWord(name)}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64bytes(new Uint8Array(data.buffer, data.byteOffset, data.length))}`)
            } catch { /* вложение не читается */ }
        }
        const body = `Content-Type: ${html ? 'text/html' : 'text/plain'}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64utf8(html || text).replace(/.{76}/g, '$&\r\n')}`
        const head = `From: ${encWord(m.senderName || '')} <${m.senderEmailAddress || ''}>\r\nTo: ${encWord(m.displayTo || '')}\r\n${m.displayCC ? `Cc: ${encWord(m.displayCC)}\r\n` : ''}Subject: ${encWord(m.subject || '')}\r\n${date ? `Date: ${date.toUTCString()}\r\n` : ''}X-Message-Class: ${cls}\r\nMIME-Version: 1.0\r\n`
        const eml = parts.length ? `${head}Content-Type: multipart/mixed; boundary="ur-pst-b"\r\n\r\n--ur-pst-b\r\n${body}\r\n${parts.map(p => `--ur-pst-b\r\n${p}\r\n`).join('')}--ur-pst-b--\r\n` : head + body
        return new TextEncoder().encode(eml)
    }
    const walk = (folder, path, depth) => {
        if (depth > 30) return
        if (folder.contentCount > 0) {
            let m, guard = 0
            try { m = folder.getNextChild() } catch { m = null }
            while (m && guard++ < 200000 && msgs.length < 100000) {
                const msg = m
                const cls = msg.messageClass || ''
                const prefix = Object.entries(KIND).find(([k]) => cls.startsWith(k))?.[1] ?? ''
                let date = null; try { date = msg.clientSubmitTime ?? msg.messageDeliveryTime } catch { /* без даты */ }
                let subject = ''; try { subject = msg.subject || (cls.startsWith('IPM.Contact') ? msg.displayName : '') } catch { /* без темы */ }
                const entry = { subject: prefix + (subject || '(без темы)'), from: msg.senderName || msg.senderEmailAddress || '', date, folder: path, attachments: (() => { try { return msg.numberOfAttachments > 0 } catch { return false } })() }
                let cache = null
                Object.defineProperty(entry, 'bytes', { get: () => cache ??= toEml(msg) })
                Object.defineProperty(entry, 'size', { get: () => 0 })
                msgs.push(entry)
                try { m = folder.getNextChild() } catch { m = null }
            }
        }
        if (folder.hasSubfolders) for (const f of folder.getSubFolders()) walk(f, path ? `${path}/${f.displayName}` : f.displayName, depth + 1)
    }
    walk(pst.getRootFolder(), '', 0)
    if (!msgs.length) throw new ReaderError('В файле Outlook нет писем.')
    msgs.sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
    msgs.forEach((m, i) => { m.name = String(i + 1) })
    return msgs
}
