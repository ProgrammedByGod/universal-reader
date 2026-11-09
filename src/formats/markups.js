// Языки разметки -> HTML: man (troff), POD, RDoc, MediaWiki, Creole, BBCode, txt2tags; Textile и Djot через библиотеку
import { escapeHtml as esc, ReaderError } from '../util.js'

const inlineLinks = s => s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" class="external-link">$2</a>')

// ================= man (troff) =================
const troffInline = s => {
    let out = '', stack = []
    const close = () => { while (stack.length) out += `</${stack.pop()}>` }
    s = s.replace(/\\\(em|\\\[em\]/g, '—').replace(/\\\(en|\\\[en\]/g, '–').replace(/\\\(bu|\\\[bu\]/g, '•').replace(/\\\(co/g, '©').replace(/\\\(rg/g, '®')
        .replace(/\\\(lq|\\\(rq|\\\(dq/g, '"').replace(/\\\(aq/g, "'").replace(/\\\(oq|\\\(cq/g, "'").replace(/\\\(ha/g, '^').replace(/\\\(ti/g, '~').replace(/\\\(ga/g, '`')
        .replace(/\\\*\(Tm/g, '™').replace(/\\\*\[[^\]]*\]|\\\*\(..|\\\*./g, '').replace(/\\&|\\\/|\\,|\\:|\\%|\\\^|\\\||\\0/g, '').replace(/\\-/g, '-').replace(/\\e/g, '\\').replace(/\\ /g, '\u00a0').replace(/\\c$/, '')
    const parts = s.split(/(\\f(?:\[[^\]]*\]|\(..|.))/)
    for (const p of parts) {
        const m = /^\\f(?:\[([^\]]*)\]|\((..)|(.))$/.exec(p)
        if (m) {
            const f = m[1] ?? m[2] ?? m[3]
            close()
            if (/^(B|CB|BI)$/.test(f)) { out += '<b>'; stack.push('b') }
            if (/^(I|CI|BI)$/.test(f)) { out += '<i>'; stack.push('i') }
            continue
        }
        out += esc(p)
    }
    close()
    return out
}
const macroArgs = s => { const a = []; const re = /"((?:[^"]|"")*)"|(\S+)/g; let m; while ((m = re.exec(s))) a.push((m[1] ?? m[2]).replace(/""/g, '"')); return a }
export const manToHtml = text => {
    const lines = text.replace(/\r/g, '').split('\n')
    let html = '', para = [], nf = false, list = null
    const flush = () => { if (para.length) { html += nf ? `<pre>${para.join('\n')}</pre>` : `<p>${para.join(' ')}</p>` } para = [] }
    const alt = (args, a, b) => args.map((x, i) => `<${i % 2 ? b : a}>${troffInline(x)}</${i % 2 ? b : a}>`).join('').replace(/<r>|<\/r>/g, '')
    let title = ''
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i]
        if (/^\.\s*\\"/.test(l) || /^'\\"/.test(l) || l === '.') continue
        const m = /^[.'](\w+)\s*(.*)$/.exec(l)
        if (!m) { para.push(nf ? troffInline(l) : troffInline(l)); continue }
        const [, mac, rest] = m, args = macroArgs(rest)
        switch (mac) {
            case 'TH': case 'Dt': title = `${args[0] ?? ''}(${args[1] ?? ''})`; html += `<div class="ur-man-head">${esc(title)}${args[4] ? ' — ' + esc(args[4]) : ''}</div>`; break
            case 'SH': case 'Sh': flush(); html += `<h2>${troffInline(args.join(' '))}</h2>`; break
            case 'SS': case 'Ss': flush(); html += `<h3>${troffInline(args.join(' '))}</h3>`; break
            case 'PP': case 'LP': case 'P': case 'Pp': case 'sp': case 'br': flush(); break
            case 'TP': flush(); { const term = lines[++i] ?? ''; html += `<dl><dt>${/^\./.test(term) ? manToHtml(term).replace(/^<p>|<\/p>$/g, '') : troffInline(term)}</dt><dd>`; list = 'tp'; let j = i + 1; const body = []; while (j < lines.length && !/^\.(TP|SH|SS|PP|LP|P|IP|RE|HP)\b/.test(lines[j])) body.push(lines[j++]); html += manToHtml(body.join('\n')) + '</dd></dl>'; i = j - 1; list = null } break
            case 'IP': flush(); { let j = i + 1; const body = []; while (j < lines.length && !/^\.(TP|SH|SS|PP|LP|P|IP|RE|HP)\b/.test(lines[j])) body.push(lines[j++]); html += `<dl><dt>${troffInline(args[0] ?? '')}</dt><dd>${manToHtml(body.join('\n'))}</dd></dl>`; i = j - 1 } break
            case 'RS': flush(); html += '<div class="ur-man-indent">'; break
            case 'RE': flush(); html += '</div>'; break
            case 'nf': case 'EX': flush(); nf = true; break
            case 'fi': case 'EE': flush(); nf = false; break
            case 'B': para.push(`<b>${troffInline(args.join(' '))}</b>`); break
            case 'I': para.push(`<i>${troffInline(args.join(' '))}</i>`); break
            case 'BR': para.push(alt(args, 'b', 'r')); break
            case 'RB': para.push(alt(args, 'r', 'b')); break
            case 'IR': para.push(alt(args, 'i', 'r')); break
            case 'RI': para.push(alt(args, 'r', 'i')); break
            case 'BI': para.push(alt(args, 'b', 'i')); break
            case 'IB': para.push(alt(args, 'i', 'b')); break
            case 'SM': case 'SB': para.push(troffInline(args.join(' '))); break
            case 'UR': para.push(`<a class="external-link" href="${esc(args[0] ?? '')}">`); break
            case 'UE': para.push('</a>'); break
            case 'Nm': para.push(`<b>${troffInline(args.join(' ') || title.replace(/\(.*/, ''))}</b>`); break
            case 'Nd': para.push('— ' + troffInline(args.join(' '))); break
            case 'Fl': para.push(`<b>-${troffInline(args.join(' '))}</b>`); break
            case 'Ar': para.push(`<i>${troffInline(args.join(' ') || 'file ...')}</i>`); break
            case 'It': flush(); html += `<dt>${troffInline(args.join(' ').replace(/\bFl\s+/g, '-').replace(/\bAr\s+/g, ''))}</dt>`; break
            case 'Bl': flush(); html += '<dl>'; break
            case 'El': flush(); html += '</dl>'; break
            default: if (args.length && !/^(so|ds|de|ft|ps|ne|in|ti|ad|na|hy|nh|ie|el|if|nr|rm|tr|cc|ll|ta|PD|TQ|Dd|Os|Op|Oc|Xr)$/.test(mac)) para.push(troffInline(args.join(' '))); else if (mac === 'Xr') para.push(`<b>${esc(args[0])}</b>(${esc(args[1] ?? '')})`)
        }
    }
    flush()
    if (!html.trim()) throw new ReaderError('Это не похоже на справочную страницу man.')
    return html
}

// ================= POD (Perl) =================
const podInline = s => {
    let out = esc(s)
    for (let k = 0; k < 4; k++) out = out.replace(/([BICFLSEXZ])&lt;(?:&lt;+\s)?([^<>]*?)(?:\s&gt;+)?&gt;/g, (m, c, v) => ({ B: `<b>${v}</b>`, I: `<i>${v}</i>`, C: `<code>${v}</code>`, F: `<i>${v}</i>`, S: v.replace(/ /g, '\u00a0'), E: ({ lt: '&lt;', gt: '&gt;', verbar: '|', sol: '/' })[v] ?? `&${v};`, X: '', Z: '', L: (() => { const [t, u] = v.includes('|') ? v.split('|') : [v, v]; return /^https?:/.test(u) ? `<a class="external-link" href="${u}">${t}</a>` : `<u>${t}</u>` })() })[c])
    return out
}
export const podToHtml = text => {
    const blocks = text.replace(/\r/g, '').split(/\n{2,}/)
    let html = '', inPod = !/^=\w/m.test(text), lists = []
    for (const b of blocks) {
        if (/^=cut/.test(b)) { inPod = false; continue }
        if (/^=\w/.test(b)) inPod = true
        if (!inPod) continue
        const m = /^=(\w+)\s*([\s\S]*)$/.exec(b)
        if (m) {
            const [, cmd, rest] = m
            if (/^head(\d)/.test(cmd)) html += `<h${Math.min(6, +cmd[4] + 1)}>${podInline(rest)}</h${Math.min(6, +cmd[4] + 1)}>`
            else if (cmd === 'over') { html += '<ul>'; lists.push('ul') }
            else if (cmd === 'back') html += `</${lists.pop() ?? 'ul'}>`
            else if (cmd === 'item') { const [first, ...more] = rest.split('\n'); html += `<li>${/^\*\s*$/.test(first) ? '' : `<b>${podInline(first.replace(/^\*\s*/, ''))}</b> `}${podInline(more.join(' '))}` }
            else if (cmd === 'begin' || cmd === 'for' || cmd === 'end' || cmd === 'pod' || cmd === 'encoding') { /* служебное */ }
            continue
        }
        if (/^[ \t]/.test(b)) html += `<pre>${esc(b)}</pre>`
        else html += `<p>${podInline(b.replace(/\n/g, ' '))}</p>`
    }
    while (lists.length) html += `</${lists.pop()}>`
    return html
}

// ================= RDoc =================
const rdocInline = s => esc(s).replace(/\*(\w[^*]*?)\*/g, '<b>$1</b>').replace(/(^|\W)_(\w[^_]*?)_(?=\W|$)/g, '$1<i>$2</i>').replace(/\+(\w[^+]*?)\+/g, '<code>$1</code>')
    .replace(/&lt;(b|em|i|tt|code)&gt;(.*?)&lt;\/\1&gt;/g, (m, t, v) => `<${t === 'tt' ? 'code' : t}>${v}</${t === 'tt' ? 'code' : t}>`)
    .replace(/\{([^}]+)\}\[(https?:[^\]]+)\]/g, '<a class="external-link" href="$2">$1</a>').replace(/(\S+)\[(https?:[^\]]+)\]/g, '<a class="external-link" href="$2">$1</a>')
export const rdocToHtml = text => {
    const lines = text.replace(/\r/g, '').split('\n')
    let html = '', para = [], list = null, pre = []
    const flush = () => { if (para.length) html += `<p>${rdocInline(para.join(' '))}</p>`; para = []; if (pre.length) { html += `<pre>${esc(pre.join('\n'))}</pre>`; pre = [] } }
    const closeList = () => { if (list) { html += `</${list}>`; list = null } }
    for (const l of lines) {
        let m
        if (!l.trim()) { flush(); continue }
        if ((m = /^(=+)\s*(.*)$/.exec(l))) { flush(); closeList(); const n = Math.min(6, m[1].length); html += `<h${n}>${rdocInline(m[2])}</h${n}>`; continue }
        if (/^-{3,}\s*$/.test(l)) { flush(); closeList(); html += '<hr>'; continue }
        if ((m = /^\s*[*-]\s+(.*)$/.exec(l))) { flush(); if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul' } html += `<li>${rdocInline(m[1])}</li>`; continue }
        if ((m = /^\s*\d+\.\s+(.*)$/.exec(l))) { flush(); if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol' } html += `<li>${rdocInline(m[1])}</li>`; continue }
        if ((m = /^\s*\[([^\]]+)\]\s+(.*)$/.exec(l)) || (m = /^\s*(\S.*?)::\s+(.*)$/.exec(l))) { flush(); closeList(); html += `<dl><dt>${rdocInline(m[1])}</dt><dd>${rdocInline(m[2])}</dd></dl>`; continue }
        if (/^\s{2,}\S/.test(l) && !para.length) { closeList(); pre.push(l); continue }
        closeList(); if (pre.length) flush(); para.push(l.trim())
    }
    flush(); closeList()
    return html
}

// ================= MediaWiki =================
const wikiInline = s => {
    let o = esc(s)
    o = o.replace(/'''''(.+?)'''''/g, '<b><i>$1</i></b>').replace(/'''(.+?)'''/g, '<b>$1</b>').replace(/''(.+?)''/g, '<i>$1</i>')
    o = o.replace(/\[\[(?:Файл|File|Image|Изображение):[^\]]*\]\]/gi, '🖼')
    o = o.replace(/\[\[(?:Категория|Category):[^\]]*\]\]/gi, '')
    o = o.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<u>$2</u>').replace(/\[\[([^\]]+)\]\]/g, '<u>$1</u>')
    o = o.replace(/\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/g, '<a class="external-link" href="$1">$2</a>').replace(/\[(https?:\/\/[^\s\]]+)\]/g, '<a class="external-link" href="$1">$1</a>')
    o = o.replace(/\{\{[^{}]*\}\}/g, '')
    o = o.replace(/&lt;(\/?)(b|i|u|s|sub|sup|code|small|big|br\s*\/?|del|ins|tt)&gt;/gi, '<$1$2>').replace(/&lt;ref[^&]*?\/&gt;/g, '').replace(/&lt;ref[\s\S]*?&lt;\/ref&gt;/g, '<sup>[*]</sup>')
    return o
}
export const wikiToHtml = text => {
    text = text.replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '')
    // вложенные шаблоны {{...}} убираем целиком
    for (let k = 0; k < 5; k++) text = text.replace(/\{\{(?:[^{}]|\{[^{]|\}[^}])*\}\}/g, '')
    const lines = text.split('\n')
    let html = '', para = [], listStack = [], table = null
    const flush = () => { if (para.length) { html += `<p>${para.map(wikiInline).join(' ')}</p>`; para = [] } }
    const setList = marks => {
        const want = [...marks].map(c => c === '*' ? 'ul' : c === '#' ? 'ol' : 'dl')
        let i = 0; while (i < listStack.length && i < want.length && listStack[i] === want[i]) i++
        while (listStack.length > i) html += `</${listStack.pop()}>`
        while (listStack.length < want.length) { const t = want[listStack.length]; html += `<${t}>`; listStack.push(t) }
    }
    for (const l of lines) {
        let m
        if (table) {
            if (/^\|\}/.test(l)) { html += table.html + (table.row ? '</tr>' : '') + '</table>'; table = null; continue }
            if (/^\|-/.test(l)) { if (table.row) table.html += '</tr>'; table.html += '<tr>'; table.row = true; continue }
            if (/^\|\+/.test(l)) { table.html += `<caption>${wikiInline(l.slice(2))}</caption>`; continue }
            if (/^[|!]/.test(l)) {
                const th = l[0] === '!'
                if (!table.row) { table.html += '<tr>'; table.row = true }
                for (let c of l.slice(1).split(th ? /!!|\|\|/ : /\|\|/)) { if (/^[^|[]*=[^|]*\|(?!\|)/.test(c)) c = c.slice(c.indexOf('|') + 1); table.html += `<${th ? 'th' : 'td'}>${wikiInline(c.trim())}</${th ? 'th' : 'td'}>` }
                continue
            }
            table.html += wikiInline(l); continue
        }
        if (/^\{\|/.test(l)) { flush(); setList(''); table = { html: '<table class="ur-wikitable">', row: false }; continue }
        if ((m = /^(={1,6})\s*(.+?)\s*\1\s*$/.exec(l))) { flush(); setList(''); const n = m[1].length; html += `<h${n}>${wikiInline(m[2])}</h${n}>`; continue }
        if (/^-{4,}/.test(l)) { flush(); setList(''); html += '<hr>'; continue }
        if ((m = /^([*#:;]+)\s*(.*)$/.exec(l))) { flush(); setList(m[1]); const t = listStack[listStack.length - 1]; html += t === 'dl' ? (m[1].endsWith(';') ? `<dt>${wikiInline(m[2])}</dt>` : `<dd>${wikiInline(m[2])}</dd>`) : `<li>${wikiInline(m[2])}</li>`; continue }
        if (/^ \S/.test(l)) { flush(); setList(''); html += `<pre>${esc(l.slice(1))}</pre>`; continue }
        if (!l.trim()) { flush(); setList(''); continue }
        setList(''); para.push(l)
    }
    flush(); setList('')
    if (table) html += table.html + '</table>'
    return html.replace(/<\/pre><pre>/g, '\n')
}

// ================= Creole =================
const creoleInline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^:])\/\/(.+?)\/\//g, '$1<i>$2</i>').replace(/\{\{\{(.+?)\}\}\}/g, '<code>$1</code>')
    .replace(/\[\[(https?:[^\]|]+)\|([^\]]+)\]\]/g, '<a class="external-link" href="$1">$2</a>').replace(/\[\[(https?:[^\]]+)\]\]/g, '<a class="external-link" href="$1">$1</a>')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<u>$2</u>').replace(/\[\[([^\]]+)\]\]/g, '<u>$1</u>').replace(/\{\{([^|}]+)\|?([^}]*)\}\}/g, '🖼 $2').replace(/\\\\/g, '<br>')
export const creoleToHtml = text => {
    const lines = text.replace(/\r/g, '').split('\n')
    let html = '', para = [], list = [], pre = null
    const flush = () => { if (para.length) { html += `<p>${creoleInline(para.join(' '))}</p>`; para = [] } }
    const setList = (depth, type) => { while (list.length > depth) html += `</${list.pop()}>`; while (list.length < depth) { html += `<${type}>`; list.push(type) } }
    for (const l of lines) {
        let m
        if (pre != null) { if (/^\}\}\}\s*$/.test(l)) { html += `<pre>${esc(pre.join('\n'))}</pre>`; pre = null } else pre.push(l); continue }
        if (/^\{\{\{\s*$/.test(l)) { flush(); setList(0); pre = []; continue }
        if ((m = /^\s*(=+)\s*(.*?)\s*=*\s*$/.exec(l))) { flush(); setList(0); const n = Math.min(6, m[1].length); html += `<h${n}>${creoleInline(m[2])}</h${n}>`; continue }
        if (/^\s*-{4,}\s*$/.test(l)) { flush(); setList(0); html += '<hr>'; continue }
        if ((m = /^\s*([*#]+)\s+(.*)$/.exec(l))) { flush(); setList(m[1].length, m[1].endsWith('#') ? 'ol' : 'ul'); html += `<li>${creoleInline(m[2])}</li>`; continue }
        if (/^\s*\|/.test(l)) { flush(); setList(0); html += '<table class="ur-wikitable"><tr>' + l.trim().replace(/\|\s*$/, '').split('|').slice(1).map(c => c.startsWith('=') ? `<th>${creoleInline(c.slice(1).trim())}</th>` : `<td>${creoleInline(c.trim())}</td>`).join('') + '</tr></table>'; continue }
        if (!l.trim()) { flush(); setList(0); continue }
        setList(0); para.push(l.trim())
    }
    flush(); setList(0)
    return html.replace(/<\/table><table class="ur-wikitable">/g, '')
}

// ================= BBCode =================
export const bbcodeToHtml = text => {
    let h = esc(text.replace(/\r/g, ''))
    const simple = { b: 'b', i: 'i', u: 'u', s: 's', strike: 's', sub: 'sub', sup: 'sup', center: 'center', h1: 'h2', h2: 'h3', h3: 'h4', h: 'h3' }
    for (let k = 0; k < 6; k++) {
        h = h.replace(/\[(b|i|u|s|strike|sub|sup|center|h1|h2|h3|h)\]([\s\S]*?)\[\/\1\]/gi, (m, t, v) => `<${simple[t.toLowerCase()]}>${v}</${simple[t.toLowerCase()]}>`)
            .replace(/\[color=([#\w]+)\]([\s\S]*?)\[\/color\]/gi, '<span style="color:$1">$2</span>')
            .replace(/\[size=(\d+)\]([\s\S]*?)\[\/size\]/gi, (m, n, v) => `<span style="font-size:${Math.min(300, Math.max(60, +n > 7 ? +n : +n * 30))}%">${v}</span>`)
            .replace(/\[quote(?:=(?:&quot;)?([^\]]*?)(?:&quot;)?)?\]([\s\S]*?)\[\/quote\]/gi, (m, who, v) => `<blockquote>${who ? `<div class="ur-muted">${who} пишет:</div>` : ''}${v}</blockquote>`)
            .replace(/\[spoiler(?:=([^\]]*))?\]([\s\S]*?)\[\/spoiler\]/gi, (m, t, v) => `<details><summary>${t || 'Спойлер'}</summary>${v}</details>`)
    }
    h = h.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, '<a class="external-link" href="$1">$2</a>').replace(/\[url\]([\s\S]*?)\[\/url\]/gi, '<a class="external-link" href="$1">$1</a>')
        .replace(/\[img[^\]]*\]([\s\S]*?)\[\/img\]/gi, '🖼 <a class="external-link" href="$1">картинка</a>')
        .replace(/\[code(?:=\w+)?\]([\s\S]*?)\[\/code\]/gi, '<pre>$1</pre>')
        .replace(/\[list(=1)?\]([\s\S]*?)\[\/list\]/gi, (m, num, v) => `<${num ? 'ol' : 'ul'}>${v.split(/\[\*\]/).slice(1).map(x => `<li>${x.trim()}</li>`).join('')}</${num ? 'ol' : 'ul'}>`)
        .replace(/\[hr\]/gi, '<hr>')
    return h.replace(/\n/g, '<br>').replace(/(<\/(?:pre|ul|ol|blockquote|h\d|details)>)<br>/g, '$1')
}

// ================= txt2tags =================
const t2tInline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\/\/(.+?)\/\//g, '<i>$1</i>').replace(/__(.+?)__/g, '<u>$1</u>').replace(/--(.+?)--/g, '<s>$1</s>').replace(/``(.+?)``/g, '<code>$1</code>')
    .replace(/\[([^\]]+?)\s+(https?:[^\]\s]+)\]/g, '<a class="external-link" href="$2">$1</a>')
export const t2tToHtml = text => {
    const lines = text.replace(/\r/g, '').split('\n')
    // первые три строки — заголовок документа (если первая не пустая)
    let html = ''
    let start = 0
    if (lines[0]?.trim()) { html += `<h1>${t2tInline(lines[0])}</h1>${lines[1]?.trim() ? `<p class="ur-muted">${t2tInline(lines[1])}</p>` : ''}${lines[2]?.trim() ? `<p class="ur-muted">${t2tInline(lines[2])}</p>` : ''}`; start = 3 }
    else start = 1
    let para = [], list = null, pre = null
    const flush = () => { if (para.length) { html += `<p>${t2tInline(para.join(' '))}</p>`; para = [] } }
    const closeList = () => { if (list) { html += `</${list}>`; list = null } }
    for (const l of lines.slice(start)) {
        let m
        if (pre) { if (l.trim() === '```') { html += `<pre>${esc(pre.join('\n'))}</pre>`; pre = null } else pre.push(l); continue }
        if (l.trim() === '```') { flush(); closeList(); pre = []; continue }
        if (/^%/.test(l)) continue
        if ((m = /^\s*(=+|\++)\s*(.*?)\s*\1(?:\[[^\]]*\])?\s*$/.exec(l))) { flush(); closeList(); const n = Math.min(6, m[1].length); html += `<h${n}>${t2tInline(m[2])}</h${n}>`; continue }
        if ((m = /^\s*([-+])\s+(.*)$/.exec(l))) { flush(); const t = m[1] === '-' ? 'ul' : 'ol'; if (list !== t) { closeList(); html += `<${t}>`; list = t } html += `<li>${t2tInline(m[2])}</li>`; continue }
        if (/^\s*\|/.test(l)) { flush(); closeList(); const th = /^\s*\|\|/.test(l); html += '<table class="ur-wikitable"><tr>' + l.trim().replace(/^\|\|?/, '').replace(/\|\s*$/, '').split('|').map(c => `<${th ? 'th' : 'td'}>${t2tInline(c.trim())}</${th ? 'th' : 'td'}>`).join('') + '</tr></table>'; continue }
        if (/^\s*[-=_]{20,}\s*$/.test(l)) { flush(); closeList(); html += '<hr>'; continue }
        if (/^\t/.test(l)) { flush(); closeList(); html += `<blockquote>${t2tInline(l.trim())}</blockquote>`; continue }
        if (!l.trim()) { flush(); closeList(); continue }
        closeList(); para.push(l.trim())
    }
    flush(); closeList()
    return html.replace(/<\/table><table class="ur-wikitable">/g, '')
}

export const markupToHtml = async (ctx, ext, text) => {
    switch (ext) {
        case 'textile': { const m = await ctx.loadLib('markup'); return m.textile(text) }
        case 'djot': { const m = await ctx.loadLib('markup'); return m.djot(text) }
        case 'wiki': case 'mediawiki': return wikiToHtml(text)
        case 'creole': return creoleToHtml(text)
        case 'bbcode': return bbcodeToHtml(text)
        case 't2t': return t2tToHtml(text)
        case 'rdoc': return rdocToHtml(text)
        case 'pod': return podToHtml(text)
        default: return manToHtml(text)
    }
}
export { inlineLinks }
