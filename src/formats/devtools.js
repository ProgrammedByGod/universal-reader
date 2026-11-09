// Код и служебные файлы версии 0.6: коллекции Postman, открытые ключи SSH/PGP/PuTTY, JWK, контрольные суммы
// (с проверкой файлов рядом), отчёты анализаторов SARIF, покрытие LCOV, результаты тестов JUnit, записи терминала asciinema
import { escapeHtml as esc, ReaderError } from '../util.js'
import { md5 } from './compress.js'

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e }
const latin = new TextDecoder('latin1')
const b64 = s => { const bin = atob(s.replace(/[^A-Za-z0-9+/=]/g, '')); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }
const b64url = s => b64(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='))
const hex = u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256b64 = async u8 => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', u8)))).replace(/=+$/, '')
const card = (icon, title, rows, note = '') => `<div class="ur-card"><div class="ur-card-body"><div class="ur-card-name">${icon} ${esc(title)}</div>${rows.filter(r => r[1] != null && r[1] !== '').map(([k, v]) => `<div><span class="ur-muted">${esc(k)}:</span> <span class="ur-break">${esc(String(v))}</span></div>`).join('')}${note ? `<div class="ur-muted">${esc(note)}</div>` : ''}</div></div>`

// ================= Коллекции Postman =================
export const isPostman = j => !!(j?.info?._postman_id || /schema\.getpostman\.com/.test(j?.info?.schema ?? '') || (j?.requests && j?.folders))
export const postmanView = j => {
    const wrap = el('div', 'ur-postman', `<h2>📮 ${esc(j.info?.name ?? j.name ?? 'Коллекция Postman')}</h2>${j.info?.description ? `<p>${esc(typeof j.info.description === 'string' ? j.info.description : j.info.description.content ?? '')}</p>` : ''}`)
    const vars = j.variable ?? []
    if (vars.length) wrap.append(el('details', '', `<summary>Переменные (${vars.length})</summary><table class="ur-table"><tbody>${vars.map(v => `<tr><td><code>{{${esc(v.key)}}}</code></td><td>${esc(v.value ?? '')}</td></tr>`).join('')}</tbody></table>`))
    let n = 0
    const urlOf = u => typeof u === 'string' ? u : u?.raw ?? [u?.protocol && u.protocol + '://', (u?.host ?? []).join?.('.') ?? u?.host, '/' + (u?.path ?? []).join?.('/')].filter(Boolean).join('')
    const req = r => {
        n++
        const q = r.request ?? r
        const method = q.method ?? 'GET', url = urlOf(q.url)
        const headers = (q.header ?? q.headers ?? []).filter?.(h => !h.disabled) ?? []
        const body = q.body?.raw ?? (q.body?.urlencoded ?? q.body?.formdata)?.map(p => `${p.key}=${p.value ?? ''}`).join('&') ?? q.body?.graphql?.query ?? ''
        const d = el('details', 'ur-postman-req', `<summary><span class="ur-badge ur-m-${esc(method.toLowerCase())}">${esc(method)}</span> ${esc(r.name ?? url)} <span class="ur-muted">${esc(url)}</span></summary>
            ${q.description ? `<p>${esc(typeof q.description === 'string' ? q.description : q.description.content ?? '')}</p>` : ''}
            ${headers.length ? `<table class="ur-table"><tbody>${headers.map(h => `<tr><td>${esc(h.key)}</td><td>${esc(h.value)}</td></tr>`).join('')}</tbody></table>` : ''}
            ${body ? `<pre>${esc(body)}</pre>` : ''}
            ${(r.response ?? []).length ? `<div class="ur-muted">Сохранённых ответов: ${r.response.length}</div>` : ''}`)
        return d
    }
    const walk = (items, box, depth) => {
        for (const it of items ?? []) {
            if (it.item) { const f = el('details', 'ur-postman-folder', `<summary>📁 ${esc(it.name)}</summary>`); f.open = depth < 1; walk(it.item, f, depth + 1); box.append(f) }
            else box.append(req(it))
        }
    }
    if (j.item) walk(j.item, wrap, 0)
    else if (j.requests) for (const r of j.requests) wrap.append(req({ name: r.name, request: { method: r.method, url: r.url, header: (r.headers ?? '').split('\n').filter(Boolean).map(l => { const i = l.indexOf(':'); return { key: l.slice(0, i), value: l.slice(i + 1).trim() } }), body: { raw: r.rawModeData } } }))
    wrap.querySelector('h2').insertAdjacentHTML('afterend', `<div class="ur-meta">Запросов: ${n}</div>`)
    return wrap
}

// ================= Ключи: SSH, PGP, PuTTY, JWK =================
const sshKeyInfo = async (type, blob) => {
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
    let p = 0; const str = () => { const l = dv.getUint32(p); const s = blob.subarray(p + 4, p + 4 + l); p += 4 + l; return s }
    const t = latin.decode(str())
    let bits = ''
    if (t === 'ssh-rsa') { str(); const n = str(); bits = (n.length - (n[0] === 0 ? 1 : 0)) * 8 }
    else if (t === 'ssh-dss') { const pp = str(); bits = (pp.length - (pp[0] === 0 ? 1 : 0)) * 8 }
    else if (/^ecdsa/.test(t)) bits = { 'nistp256': 256, 'nistp384': 384, 'nistp521': 521 }[latin.decode(str())] ?? ''
    else if (/ed25519/.test(t)) bits = 256
    return { type: t, bits, fp: 'SHA256:' + await sha256b64(blob) }
}
const KEY_NAMES = { 'ssh-rsa': 'RSA', 'ssh-ed25519': 'Ed25519', 'ssh-dss': 'DSA (устаревший)', 'ecdsa-sha2-nistp256': 'ECDSA P-256', 'ecdsa-sha2-nistp384': 'ECDSA P-384', 'ecdsa-sha2-nistp521': 'ECDSA P-521', 'sk-ssh-ed25519@openssh.com': 'Ed25519 (аппаратный ключ)', 'sk-ecdsa-sha2-nistp256@openssh.com': 'ECDSA (аппаратный ключ)' }
const PGP_ALG = { 1: 'RSA', 2: 'RSA', 3: 'RSA', 16: 'ElGamal', 17: 'DSA', 18: 'ECDH', 19: 'ECDSA', 22: 'EdDSA', 25: 'X25519', 27: 'Ed25519' }
const pgpKeys = async u8 => {
    const out = []; let p = 0, cur = null
    while (p < u8.length) {
        const h = u8[p++]; if (!(h & 0x80)) break
        let tag, len
        if (h & 0x40) { tag = h & 63; const a = u8[p++]; if (a < 192) len = a; else if (a < 224) len = ((a - 192) << 8) + u8[p++] + 192; else if (a === 255) { len = (u8[p] << 24 | u8[p + 1] << 16 | u8[p + 2] << 8 | u8[p + 3]) >>> 0; p += 4 } else len = 1 << (a & 31) }
        else { tag = (h >> 2) & 15; const lt = h & 3; len = lt === 0 ? u8[p++] : lt === 1 ? (u8[p++] << 8 | u8[p++]) : lt === 2 ? ((u8[p++] << 24 | u8[p++] << 16 | u8[p++] << 8 | u8[p++]) >>> 0) : u8.length - p }
        const body = u8.subarray(p, p + len); p += len
        if (tag === 6 || tag === 14 || tag === 5 || tag === 7) {
            const ver = body[0], created = new Date(((body[1] << 24 | body[2] << 16 | body[3] << 8 | body[4]) >>> 0) * 1000)
            const alg = body[ver === 3 ? 7 : 5]
            let bits = ''
            if (alg <= 3 || alg === 17 || alg === 16) { const o = ver === 3 ? 8 : 6; bits = body[o] << 8 | body[o + 1] }
            // отпечаток v4 = SHA-1(0x99 + длина + тело открытой части)
            let fp = ''
            if (ver === 4 && (tag === 6 || tag === 14)) { const pre = new Uint8Array(3 + body.length); pre[0] = 0x99; pre[1] = body.length >> 8; pre[2] = body.length & 255; pre.set(body, 3); fp = hex(new Uint8Array(await crypto.subtle.digest('SHA-1', pre))).toUpperCase() }
            const k = { sub: tag === 14 || tag === 7, secret: tag === 5 || tag === 7, created, alg: PGP_ALG[alg] ?? alg, bits, fp, uids: [] }
            if (!k.sub) { cur = k; out.push(k) } else (cur?.subs ?? (cur ? (cur.subs = []) : [])).push(k)
        } else if (tag === 13 && cur) cur.uids.push(new TextDecoder().decode(body))
    }
    return out
}
export const keysView = async (buf, ext) => {
    const u8 = new Uint8Array(buf)
    const text = latin.decode(u8)
    let html = ''
    // PGP
    if (/-----BEGIN PGP (PUBLIC|PRIVATE) KEY BLOCK-----/.test(text) || (u8[0] & 0x80 && [6, 5].includes((u8[0] & 0x40) ? u8[0] & 63 : (u8[0] >> 2) & 15))) {
        let bin = u8
        const m = /-----BEGIN PGP (?:PUBLIC|PRIVATE) KEY BLOCK-----\r?\n(?:[\w-]+:.*\r?\n)*\r?\n([\s\S]*?)(?:\r?\n=[\w+/=]{4})?\r?\n-----END/.exec(text)
        if (m) bin = b64(m[1])
        for (const k of await pgpKeys(bin)) html += card(k.secret ? '🔒' : '🔑', k.uids[0] ?? 'Ключ PGP', [['Все имена', k.uids.slice(1).join('; ')], ['Создан', k.created.toLocaleDateString('ru-RU')], ['Алгоритм', [k.alg, k.bits && k.bits + ' бит'].filter(Boolean).join(', ')], ['Отпечаток', k.fp.replace(/(.{4})/g, '$1 ').trim()], ['Подключи', (k.subs ?? []).map(s => `${s.alg}${s.bits ? ' ' + s.bits : ''} от ${s.created.toLocaleDateString('ru-RU')}`).join('; ')]], k.secret ? 'Это закрытый ключ — его содержимое не показывается. Не передавайте этот файл другим.' : '')
        if (html) return el('div', '', html)
    }
    // PuTTY
    if (/^PuTTY-User-Key-File-\d:/m.test(text)) {
        const g = k => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(text)?.[1]?.trim()
        const pub = text.split(/^Public-Lines:\s*\d+\s*$/m)[1]?.split(/^Private-Lines:/m)[0]?.replace(/\s/g, '')
        const info = pub ? await sshKeyInfo(g('PuTTY-User-Key-File-\\d'), b64(pub)) : {}
        html += card('🔒', g('Comment') || 'Ключ PuTTY', [['Тип', KEY_NAMES[info.type] ?? g('PuTTY-User-Key-File-\\d')], ['Размер', info.bits && info.bits + ' бит'], ['Защищён паролем', g('Encryption') === 'none' ? 'нет' : 'да'], ['Отпечаток', info.fp]], 'Это закрытый ключ PuTTY — его секретная часть не показывается. Не передавайте этот файл другим.')
        return el('div', '', html)
    }
    // OpenSSH: по ключу на строке (authorized_keys, known_hosts, .pub)
    for (const line of text.split(/\r?\n/)) {
        const m = /(?:^|\s)((?:ssh|ecdsa|sk)-[\w@.-]+)\s+([A-Za-z0-9+/=]{40,})(?:\s+(.*))?$/.exec(line.trim()); if (!m) continue
        try { const info = await sshKeyInfo(m[1], b64(m[2])); const opts = line.trim().slice(0, line.trim().indexOf(m[1])).trim(); html += card('🔑', m[3] || 'Открытый ключ SSH', [['Тип', KEY_NAMES[info.type] ?? info.type], ['Размер', info.bits && info.bits + ' бит'], ['Отпечаток', info.fp], ['Ограничения или хост', opts]]) } catch { /* строка не ключ */ }
    }
    if (/-----BEGIN (OPENSSH|RSA|EC|DSA|ENCRYPTED)? ?PRIVATE KEY-----/.test(text)) html += card('🔒', 'Закрытый ключ', [['Формат', /OPENSSH/.test(text) ? 'OpenSSH' : 'PEM (PKCS#8 или старый)'], ['Защищён паролем', /ENCRYPTED|Proc-Type: 4,ENCRYPTED|aes256-ctr|bcrypt/.test(text) ? 'да' : 'неизвестно']], 'Содержимое закрытого ключа не показывается. Не передавайте этот файл другим.')
    if (!html) throw new ReaderError(ext === 'gpg' ? 'Это не ключ PGP (возможно, это зашифрованный файл — его прочитать нельзя).' : 'В файле не найдено ключей.')
    return el('div', '', html)
}
export const jwkView = async text => {
    let j
    try { j = JSON.parse(text) } catch { if (/-----BEGIN/.test(text)) return el('div', '', card('🔒', 'Закрытый ключ (PKCS#8)', [['Формат', 'PEM']], 'Содержимое закрытого ключа не показывается. Не передавайте этот файл другим.')); throw new ReaderError('Это не ключ JWK.') }
    const keys = j.keys ?? [j]
    let html = `<div class="ur-meta">Ключей: ${keys.length}</div>`
    for (const k of keys) {
        const secret = k.d != null || k.k != null
        let bits = ''
        if (k.n) bits = (b64url(k.n).length - (b64url(k.n)[0] === 0 ? 1 : 0)) * 8 + ' бит'
        else if (k.crv) bits = k.crv
        html += card(secret ? '🔒' : '🔑', k.kid ?? `${k.kty} ключ`, [['Тип', { RSA: 'RSA', EC: 'эллиптическая кривая', OKP: 'Ed25519/X25519', oct: 'симметричный' }[k.kty] ?? k.kty], ['Размер', bits], ['Алгоритм', k.alg], ['Назначение', { sig: 'подпись', enc: 'шифрование' }[k.use] ?? k.use], ['Операции', (k.key_ops ?? []).join(', ')], ['Сертификат', k.x5c ? 'есть' : ''], ['Действует до', k.exp ? new Date(k.exp * 1000).toLocaleString('ru-RU') : '']], secret ? 'В ключе есть секретная часть — она не показывается. Не публикуйте этот файл.' : '')
    }
    return el('div', '', html)
}

// ================= Контрольные суммы (с проверкой соседних файлов) =================
export const parseChecksums = (text, ext) => {
    const out = []
    for (const line of text.split(/\r?\n/)) {
        let m
        if (!line.trim() || /^[;#]/.test(line)) continue
        if ((m = /^([0-9a-fA-F]{8,128})\s+[ *]?(.+)$/.exec(line))) out.push({ hash: m[1].toLowerCase(), name: m[2].trim() })
        else if ((m = /^(\w+)\s*\((.+)\)\s*=\s*([0-9a-fA-F]+)$/.exec(line))) out.push({ hash: m[3].toLowerCase(), name: m[2], algo: m[1] })
        else if (ext === 'sfv' && (m = /^(.+?)\s+([0-9a-fA-F]{8})$/.exec(line))) out.push({ hash: m[2].toLowerCase(), name: m[1] })
    }
    if (!out.length) throw new ReaderError('В файле нет контрольных сумм.')
    return out
}
const crc32 = (() => { const t = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 }); return u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = t[(c ^ u8[i]) & 255] ^ (c >>> 8); return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0') } })()
const algoOf = (h, ext, given) => given ? given.toUpperCase().replace('-', '') : ({ 8: 'CRC32', 32: 'MD5', 40: 'SHA1', 64: 'SHA256', 96: 'SHA384', 128: 'SHA512' }[h.length] ?? ext.toUpperCase())
export const checksumView = (items, ext, readSibling) => {
    const wrap = el('div', 'ur-checksums', `<div class="ur-meta">Файлов: ${items.length}</div>`)
    const btn = el('button', 'mod-cta', 'Проверить файлы рядом')
    const table = el('table', 'ur-table', `<thead><tr><th>Файл</th><th>Алгоритм</th><th>Контрольная сумма</th><th>Проверка</th></tr></thead><tbody>${items.map(i => `<tr><td>${esc(i.name)}</td><td>${algoOf(i.hash, ext, i.algo)}</td><td class="ur-break"><code>${esc(i.hash)}</code></td><td class="st"></td></tr>`).join('')}</tbody>`)
    btn.onclick = async () => {
        btn.disabled = true
        const rows = table.querySelectorAll('tbody tr'); let ok = 0, bad = 0, miss = 0
        for (let k = 0; k < items.length; k++) {
            const it = items[k], cell = rows[k].querySelector('.st')
            cell.textContent = '…'
            const data = await readSibling(it.name)
            if (!data) { cell.innerHTML = '<span class="ur-muted">нет файла</span>'; miss++; continue }
            const a = algoOf(it.hash, ext, it.algo)
            let h
            if (a === 'MD5') h = md5(data)
            else if (a === 'CRC32') h = crc32(data)
            else { const name = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA384: 'SHA-384', SHA512: 'SHA-512' }[a]; if (!name) { cell.textContent = 'алгоритм не поддерживается'; continue } h = hex(new Uint8Array(await crypto.subtle.digest(name, data))) }
            if (String(h).toLowerCase() === it.hash) { cell.innerHTML = '<span class="ur-badge is-good">совпадает</span>'; ok++ } else { cell.innerHTML = '<span class="ur-badge is-bad">НЕ совпадает</span>'; bad++ }
        }
        btn.textContent = `Совпало: ${ok}, не совпало: ${bad}, нет файлов: ${miss}`
    }
    wrap.append(btn, table)
    return wrap
}

// ================= SARIF: отчёты анализаторов кода =================
export const sarifView = j => {
    if (!j?.runs) throw new ReaderError('Это не отчёт SARIF.')
    const wrap = el('div', 'ur-sarif')
    for (const run of j.runs) {
        const tool = run.tool?.driver ?? {}
        const rules = new Map((tool.rules ?? []).map((r, i) => [r.id, { ...r, i }]))
        const res = run.results ?? []
        const lvl = r => r.level ?? rules.get(r.ruleId)?.defaultConfiguration?.level ?? 'warning'
        const count = l => res.filter(r => lvl(r) === l).length
        wrap.append(el('h2', '', `${esc(tool.name ?? 'Анализатор')} ${esc(tool.semanticVersion ?? tool.version ?? '')}`))
        wrap.append(el('div', 'ur-meta', `Замечаний: ${res.length} · ошибок: ${count('error')} · предупреждений: ${count('warning')} · заметок: ${count('note')}`))
        const rows = res.slice(0, 5000).map(r => {
            const loc = r.locations?.[0]?.physicalLocation
            const file = loc?.artifactLocation?.uri ?? ''
            const line = loc?.region?.startLine
            const rule = rules.get(r.ruleId)
            return `<tr class="lvl-${esc(lvl(r))}"><td><span class="ur-badge${lvl(r) === 'error' ? ' is-bad' : ''}">${{ error: 'ошибка', warning: 'предупр.', note: 'заметка', none: '—' }[lvl(r)] ?? esc(lvl(r))}</span></td><td><code>${esc(r.ruleId ?? '')}</code>${rule?.shortDescription?.text ? `<div class="ur-muted">${esc(rule.shortDescription.text)}</div>` : ''}</td><td>${esc(r.message?.text ?? r.message?.markdown ?? '')}</td><td class="ur-break">${esc(file)}${line ? ':' + line : ''}</td></tr>`
        }).join('')
        wrap.append(el('table', 'ur-table', `<thead><tr><th>Уровень</th><th>Правило</th><th>Сообщение</th><th>Где</th></tr></thead><tbody>${rows}</tbody>`))
    }
    return wrap
}

// ================= LCOV: покрытие кода тестами =================
export const isLcov = text => /^(TN:|SF:)/m.test(text.slice(0, 2000)) && /end_of_record/.test(text)
export const lcovView = text => {
    const files = []
    let cur = null
    for (const line of text.split(/\r?\n/)) {
        const [k, v = ''] = [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]
        if (line.startsWith('SF:')) cur = { name: v, lf: 0, lh: 0, fnf: 0, fnh: 0, brf: 0, brh: 0, missed: [] }
        else if (line === 'end_of_record') { if (cur) files.push(cur); cur = null }
        else if (cur) {
            if (k === 'LF') cur.lf = +v; else if (k === 'LH') cur.lh = +v; else if (k === 'FNF') cur.fnf = +v; else if (k === 'FNH') cur.fnh = +v; else if (k === 'BRF') cur.brf = +v; else if (k === 'BRH') cur.brh = +v
            else if (k === 'DA') { const [ln, hits] = v.split(','); if (+hits === 0) cur.missed.push(+ln) }
        }
    }
    if (!files.length) throw new ReaderError('В отчёте LCOV нет файлов.')
    const pct = (h, f) => f ? Math.round(h / f * 1000) / 10 : null
    const bar = p => p == null ? '—' : `<div class="ur-cov"><div style="width:${p}%;background:${p >= 80 ? '#2da44e' : p >= 50 ? '#d4a72c' : '#cf222e'}"></div><span>${p}%</span></div>`
    const tot = files.reduce((a, f) => ({ lf: a.lf + f.lf, lh: a.lh + f.lh, fnf: a.fnf + f.fnf, fnh: a.fnh + f.fnh, brf: a.brf + f.brf, brh: a.brh + f.brh }), { lf: 0, lh: 0, fnf: 0, fnh: 0, brf: 0, brh: 0 })
    const short = r => r.length > 50 ? '…' + r.slice(-50) : r
    const ranges = a => { const out = []; for (let i = 0; i < a.length; i++) { let j = i; while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++; out.push(i === j ? a[i] : `${a[i]}–${a[j]}`); i = j } return out.join(', ') }
    return el('div', 'ur-lcov', `<h2>Покрытие тестами</h2><div class="ur-meta">Файлов: ${files.length} · строк: ${pct(tot.lh, tot.lf) ?? '—'}% · функций: ${pct(tot.fnh, tot.fnf) ?? '—'}% · ветвлений: ${pct(tot.brh, tot.brf) ?? '—'}%</div>
        <table class="ur-table"><thead><tr><th>Файл</th><th>Строки</th><th>Функции</th><th>Ветвления</th><th>Не покрыты строки</th></tr></thead><tbody>${files.sort((a, b) => (pct(a.lh, a.lf) ?? 101) - (pct(b.lh, b.lf) ?? 101)).map(f => `<tr><td class="ur-break" title="${esc(f.name)}">${esc(short(f.name))}</td><td>${bar(pct(f.lh, f.lf))}</td><td>${bar(pct(f.fnh, f.fnf))}</td><td>${bar(pct(f.brh, f.brf))}</td><td class="ur-muted ur-break">${esc(ranges(f.missed.sort((a, b) => a - b)).slice(0, 200))}</td></tr>`).join('')}</tbody></table>`)
}

// ================= JUnit XML: результаты тестов =================
export const isJunit = head => /<testsuites?[\s>]/.test(head)
export const junitView = text => {
    const d = new DOMParser().parseFromString(text, 'application/xml')
    const cases = [...d.getElementsByTagName('testcase')]
    if (!cases.length) throw new ReaderError('В отчёте нет тестов.')
    const res = cases.map(c => {
        const f = c.getElementsByTagName('failure')[0] ?? c.getElementsByTagName('error')[0]
        const s = c.getElementsByTagName('skipped')[0]
        return { suite: c.getAttribute('classname') ?? c.parentElement?.getAttribute('name') ?? '', name: c.getAttribute('name') ?? '', time: +(c.getAttribute('time') ?? 0), st: f ? (f.tagName === 'error' ? 'error' : 'fail') : s ? 'skip' : 'pass', msg: f ? (f.getAttribute('message') ?? '') + '\n' + (f.textContent ?? '') : s?.getAttribute('message') ?? '' }
    })
    const n = st => res.filter(r => r.st === st).length
    const total = res.reduce((s, r) => s + r.time, 0)
    const ICON = { pass: '✅', fail: '❌', error: '💥', skip: '⏭' }
    return el('div', 'ur-junit', `<h2>Результаты тестов</h2><div class="ur-meta">Тестов: ${res.length} · прошли: ${n('pass')} · упали: ${n('fail')} · ошибки: ${n('error')} · пропущены: ${n('skip')} · время: ${total.toFixed(2)} с</div>
        <table class="ur-table"><thead><tr><th></th><th>Тест</th><th>Набор</th><th>Время</th></tr></thead><tbody>${res.sort((a, b) => ['error', 'fail', 'skip', 'pass'].indexOf(a.st) - ['error', 'fail', 'skip', 'pass'].indexOf(b.st)).map(r => `<tr><td>${ICON[r.st]}</td><td>${esc(r.name)}${r.msg.trim() && r.st !== 'pass' ? `<details><summary class="ur-muted">подробнее</summary><pre>${esc(r.msg.trim().slice(0, 5000))}</pre></details>` : ''}</td><td class="ur-muted">${esc(r.suite)}</td><td>${r.time ? r.time.toFixed(3) + ' с' : ''}</td></tr>`).join('')}</tbody></table>`)
}

// ================= asciinema (.cast): запись терминала с проигрыванием =================
const ANSI16 = ['#000', '#c23621', '#25bc24', '#adad27', '#492ee1', '#d338d3', '#33bbc8', '#cbcccd', '#818383', '#fc391f', '#31e722', '#eaec23', '#5833ff', '#f935f8', '#14f0f0', '#e9ebeb']
const color256 = n => { if (n < 16) return ANSI16[n]; if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})` } n -= 16; const c = [Math.floor(n / 36), Math.floor(n / 6) % 6, n % 6].map(v => v ? v * 40 + 55 : 0); return `rgb(${c.join(',')})` }
class MiniTerm {
    constructor(w, h) { this.w = w; this.h = h; this.reset() }
    reset() { this.x = 0; this.y = 0; this.attr = {}; this.grid = Array.from({ length: this.h }, () => this.blank()); this.esc = '' }
    blank() { return Array.from({ length: this.w }, () => [' ', null]) }
    scroll() { this.grid.shift(); this.grid.push(this.blank()); this.y = this.h - 1 }
    put(ch) { if (this.x >= this.w) { this.x = 0; this.y++; if (this.y >= this.h) this.scroll() } this.grid[this.y][this.x++] = [ch, { ...this.attr }] }
    sgr(params) {
        const p = params.length ? params : [0]
        for (let i = 0; i < p.length; i++) {
            const v = p[i]
            if (v === 0) this.attr = {}; else if (v === 1) this.attr.b = 1; else if (v === 3) this.attr.i = 1; else if (v === 4) this.attr.u = 1; else if (v === 7) this.attr.inv = 1; else if (v === 22) delete this.attr.b; else if (v === 27) delete this.attr.inv
            else if (v >= 30 && v <= 37) this.attr.fg = ANSI16[v - 30]; else if (v >= 90 && v <= 97) this.attr.fg = ANSI16[v - 82]; else if (v === 39) delete this.attr.fg
            else if (v >= 40 && v <= 47) this.attr.bg = ANSI16[v - 40]; else if (v >= 100 && v <= 107) this.attr.bg = ANSI16[v - 92]; else if (v === 49) delete this.attr.bg
            else if ((v === 38 || v === 48) && p[i + 1] === 5) { this.attr[v === 38 ? 'fg' : 'bg'] = color256(p[i + 2]); i += 2 }
            else if ((v === 38 || v === 48) && p[i + 1] === 2) { this.attr[v === 38 ? 'fg' : 'bg'] = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`; i += 4 }
        }
    }
    write(s) {
        for (const ch of s) {
            if (this.esc) {
                this.esc += ch
                if (this.esc[1] === '[') { if (/[@-~]/.test(ch) && this.esc.length > 2) { this.csi(this.esc.slice(2, -1), ch); this.esc = '' } }
                else if (this.esc[1] === ']') { if (ch === '\x07' || this.esc.endsWith('\x1b\\')) this.esc = '' }
                else if (this.esc.length >= 2 && this.esc[1] !== '[' && this.esc[1] !== ']' && this.esc[1] !== '(' && this.esc[1] !== ')') this.esc = ''
                else if ((this.esc[1] === '(' || this.esc[1] === ')') && this.esc.length >= 3) this.esc = ''
                continue
            }
            if (ch === '\x1b') { this.esc = ch; continue }
            if (ch === '\r') this.x = 0
            else if (ch === '\n') { this.y++; if (this.y >= this.h) this.scroll() }
            else if (ch === '\b') this.x = Math.max(0, this.x - 1)
            else if (ch === '\t') this.x = Math.min(this.w - 1, (this.x + 8) & ~7)
            else if (ch === '\x07') { /* звонок */ }
            else if (ch >= ' ') this.put(ch)
        }
    }
    csi(param, f) {
        const priv = param.startsWith('?')
        const p = param.replace(/^\?/, '').split(';').filter(x => x !== '').map(Number)
        const n = p[0] || 1
        if (priv) { if ((f === 'h' || f === 'l') && [1049, 47, 1047].includes(p[0])) { this.grid = Array.from({ length: this.h }, () => this.blank()); this.x = this.y = 0 } return }
        switch (f) {
            case 'm': this.sgr(p); break
            case 'A': this.y = Math.max(0, this.y - n); break
            case 'B': this.y = Math.min(this.h - 1, this.y + n); break
            case 'C': this.x = Math.min(this.w - 1, this.x + n); break
            case 'D': this.x = Math.max(0, this.x - n); break
            case 'G': this.x = Math.min(this.w - 1, n - 1); break
            case 'd': this.y = Math.min(this.h - 1, n - 1); break
            case 'H': case 'f': this.y = Math.min(this.h - 1, (p[0] || 1) - 1); this.x = Math.min(this.w - 1, (p[1] || 1) - 1); break
            case 'J': { const m = p[0] || 0; if (m === 2 || m === 3) this.grid = Array.from({ length: this.h }, () => this.blank()); else if (m === 0) { for (let x = this.x; x < this.w; x++) this.grid[this.y][x] = [' ', null]; for (let y = this.y + 1; y < this.h; y++) this.grid[y] = this.blank() } else { for (let y = 0; y < this.y; y++) this.grid[y] = this.blank(); for (let x = 0; x <= this.x; x++) this.grid[this.y][x] = [' ', null] } break }
            case 'K': { const m = p[0] || 0; const [a, b] = m === 0 ? [this.x, this.w] : m === 1 ? [0, this.x + 1] : [0, this.w]; for (let x = a; x < b; x++) this.grid[this.y][x] = [' ', null]; break }
            case 'P': { const row = this.grid[this.y]; row.splice(this.x, n); while (row.length < this.w) row.push([' ', null]); break }
            case 'X': for (let x = this.x; x < Math.min(this.w, this.x + n); x++) this.grid[this.y][x] = [' ', null]; break
            case 'L': for (let k = 0; k < n; k++) { this.grid.splice(this.y, 0, this.blank()); this.grid.pop() } break
            case 'M': for (let k = 0; k < n; k++) { this.grid.splice(this.y, 1); this.grid.push(this.blank()) } break
            case '@': { const row = this.grid[this.y]; for (let k = 0; k < n; k++) row.splice(this.x, 0, [' ', null]); row.length = this.w; break }
        }
    }
    html() {
        return this.grid.map((row, y) => row.map(([c, a], x) => {
            const cur = y === this.y && x === this.x
            if (!a && !cur) return esc(c)
            let fg = a?.fg, bg = a?.bg; if (a?.inv) [fg, bg] = [bg ?? '#ddd', fg ?? '#111']
            const st = [fg && `color:${fg}`, bg && `background:${bg}`, a?.b && 'font-weight:bold', a?.i && 'font-style:italic', a?.u && 'text-decoration:underline'].filter(Boolean).join(';')
            return `<span${st ? ` style="${st}"` : ''}${cur ? ' class="ur-cast-cur"' : ''}>${esc(c)}</span>`
        }).join('')).join('\n')
    }
}
export const castView = (ctx, text) => {
    const lines = text.split(/\r?\n/).filter(Boolean)
    let head
    try { head = JSON.parse(lines[0]) } catch { throw new ReaderError('Это не запись asciinema (.cast).') }
    let events
    if (head.version === 1 || Array.isArray(head.stdout)) { events = []; let t = 0; for (const [d, s] of head.stdout ?? []) { t += d; events.push([t, 'o', s]) } }
    else { events = lines.slice(1).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(e => Array.isArray(e) && e[1] === 'o'); if (head.version === 3) { let t = 0; events = events.map(e => [t += e[0], e[1], e[2]]) } }
    const w = head.width ?? head.term?.cols ?? 80, h = head.height ?? head.term?.rows ?? 24
    const dur = events.length ? events[events.length - 1][0] : 0
    const term = new MiniTerm(w, h)
    const wrap = el('div', 'ur-cast', `${head.title ? `<h2>${esc(head.title)}</h2>` : ''}<div class="ur-meta">Запись терминала ${w}×${h} · ${Math.floor(dur / 60)}:${String(Math.round(dur % 60)).padStart(2, '0')}${head.timestamp ? ' · ' + new Date(head.timestamp * 1000).toLocaleString('ru-RU') : ''}${head.env?.SHELL ? ' · ' + esc(head.env.SHELL) : ''}</div>`)
    const screen = el('pre', 'ur-cast-screen')
    const ctl = el('div', 'ur-sci-controls ur-nosearch')
    const play = el('button', '', '▶ Играть'), speed = el('select', '', [1, 2, 4, 8].map(s => `<option value="${s}">×${s}</option>`).join(''))
    const pos = el('input'); pos.type = 'range'; pos.min = 0; pos.max = Math.max(1, Math.ceil(dur * 10)); pos.value = 0; pos.style.flex = '1'
    ctl.append(play, speed, pos); wrap.append(ctl, screen)
    let idx = 0, t = 0, timer = null, playing = false
    const seek = target => { if (target < t) { term.reset(); idx = 0 } while (idx < events.length && events[idx][0] <= target) term.write(events[idx++][2]); t = target; screen.innerHTML = term.html(); pos.value = Math.round(t * 10) }
    const tick = () => { if (!playing) return; const next = idx < events.length ? events[idx][0] : null; if (next == null) { playing = false; play.textContent = '▶ Играть'; return } const wait = Math.min(2, Math.max(0, next - t)) * 1000 / +speed.value; timer = setTimeout(() => { seek(next); tick() }, wait) }
    play.onclick = () => { playing = !playing; play.textContent = playing ? '⏸ Пауза' : '▶ Играть'; clearTimeout(timer); if (playing) { if (idx >= events.length) seek(0); tick() } }
    pos.oninput = () => { clearTimeout(timer); seek(+pos.value / 10); if (playing) tick() }
    seek(dur) // сразу показываем итоговый экран
    ctx.cleanups.push(() => clearTimeout(timer))
    return wrap
}
