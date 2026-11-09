// Платы и схемы версии 0.6: Gerber (RS-274X) и KiCad (.kicad_pcb, .kicad_sch) — рисуем в SVG
import { escapeHtml as esc, ReaderError } from '../util.js'

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e }
const f = v => +(+v).toFixed(4)
// масштабирование и сдвиг колесом/мышью для SVG
const zoomable = (svg, vb) => {
    const wrap = el('div', 'ur-cad-view')
    wrap.innerHTML = svg
    const s = wrap.firstElementChild
    let [x, y, w, h] = vb
    const set = () => s.setAttribute('viewBox', `${x} ${y} ${w} ${h}`)
    s.addEventListener('wheel', e => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); const r = s.getBoundingClientRect(); const k = e.deltaY > 0 ? 1.2 : 1 / 1.2; const px = x + (e.clientX - r.left) / r.width * w, py = y + (e.clientY - r.top) / r.height * h; x = px - (px - x) * k; y = py - (py - y) * k; w *= k; h *= k; set() }, { passive: false })
    let drag = null
    s.addEventListener('pointerdown', e => { drag = [e.clientX, e.clientY, x, y]; s.setPointerCapture(e.pointerId) })
    s.addEventListener('pointermove', e => { if (!drag) return; const r = s.getBoundingClientRect(); x = drag[2] - (e.clientX - drag[0]) / r.width * w; y = drag[3] - (e.clientY - drag[1]) / r.height * h; set() })
    s.addEventListener('pointerup', () => { drag = null })
    s.addEventListener('dblclick', () => { [x, y, w, h] = vb; set() })
    return wrap
}

// ================= Gerber =================
export const gerberView = (ctx, text, name = '') => {
    if (!/%FS|%MO|G04|D0?[123]\*/.test(text)) throw new ReaderError('Это не файл Gerber.')
    let scale = 1 / 1e6, inch = false, zeroOmit = 'L', intD = 2, decD = 4
    const aps = {}, macros = {}
    let moved = false, cur = null, x = 0, y = 0, mode = 1, multi = false, region = null, dark = true
    const out = [] // [{d, dark, fill}] — порядок важен для «очищающей» полярности
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const ext = (px, py, r = 0) => { minX = Math.min(minX, px - r); minY = Math.min(minY, py - r); maxX = Math.max(maxX, px + r); maxY = Math.max(maxY, py + r) }
    const num = (s, last) => {
        if (s == null) return last
        if (s.includes('.')) return +s
        const neg = s.startsWith('-'); let d = s.replace(/[+-]/, '')
        if (zeroOmit === 'T') d = d.padEnd(intD + decD, '0'); else d = d.padStart(intD + decD, '0')
        return (neg ? -1 : 1) * (+d.slice(0, intD) + +d.slice(intD) / 10 ** decD)
    }
    const flash = (ap, px, py) => {
        if (!ap) return
        ext(px, py, ap.r ?? Math.max(ap.w ?? 0, ap.h ?? 0) / 2)
        if (ap.t === 'C') out.push({ d: `M${f(px - ap.r)} ${f(py)}a${f(ap.r)} ${f(ap.r)} 0 1 0 ${f(2 * ap.r)} 0a${f(ap.r)} ${f(ap.r)} 0 1 0 ${f(-2 * ap.r)} 0Z`, dark })
        else if (ap.t === 'R') out.push({ d: `M${f(px - ap.w / 2)} ${f(py - ap.h / 2)}h${f(ap.w)}v${f(ap.h)}h${f(-ap.w)}Z`, dark })
        else if (ap.t === 'O') { const r = Math.min(ap.w, ap.h) / 2; out.push({ d: ap.w > ap.h ? `M${f(px - ap.w / 2 + r)} ${f(py - r)}h${f(ap.w - 2 * r)}a${f(r)} ${f(r)} 0 0 1 0 ${f(2 * r)}h${f(-(ap.w - 2 * r))}a${f(r)} ${f(r)} 0 0 1 0 ${f(-2 * r)}Z` : `M${f(px - r)} ${f(py - ap.h / 2 + r)}a${f(r)} ${f(r)} 0 0 1 ${f(2 * r)} 0v${f(ap.h - 2 * r)}a${f(r)} ${f(r)} 0 0 1 ${f(-2 * r)} 0Z`, dark }) }
        else if (ap.t === 'P') { const n = ap.n, rot = (ap.rot ?? 0) * Math.PI / 180; let d = ''; for (let i = 0; i < n; i++) { const a = rot + 2 * Math.PI * i / n; d += `${i ? 'L' : 'M'}${f(px + ap.r * Math.cos(a))} ${f(py + ap.r * Math.sin(a))}` } out.push({ d: d + 'Z', dark }) }
        else if (ap.t === 'M') for (const prim of ap.prims) {
            const v = prim, rot = (deg, ax, ay) => { const a = deg * Math.PI / 180; return [ax * Math.cos(a) - ay * Math.sin(a), ax * Math.sin(a) + ay * Math.cos(a)] }
            const pd = v[1] === 0 ? !dark : dark
            if (v[0] === 1) { const r = v[2] / 2, [cx, cy] = rot(v[5] ?? 0, v[3], v[4]); out.push({ d: `M${f(px + cx - r)} ${f(py + cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`, dark: pd }) }
            else if (v[0] === 21) { const [w, h, cx, cy, deg] = v.slice(2); const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([a, b]) => rot(deg ?? 0, cx + a, cy + b)); out.push({ d: pts.map((q, i) => `${i ? 'L' : 'M'}${f(px + q[0])} ${f(py + q[1])}`).join('') + 'Z', dark: pd }) }
            else if (v[0] === 20) { const [w, x1, y1, x2, y2, deg] = v.slice(2); const a = rot(deg ?? 0, x1, y1), b = rot(deg ?? 0, x2, y2); out.push({ d: `M${f(px + a[0])} ${f(py + a[1])}L${f(px + b[0])} ${f(py + b[1])}`, dark: pd, stroke: w, cap: 'butt' }) }
            else if (v[0] === 4) { const n = v[2]; const pts = []; for (let i = 0; i <= n; i++) pts.push(rot(v[5 + 2 * n] ?? 0, v[3 + 2 * i], v[4 + 2 * i])); out.push({ d: pts.map((q, i) => `${i ? 'L' : 'M'}${f(px + q[0])} ${f(py + q[1])}`).join('') + 'Z', dark: pd }) }
            else if (v[0] === 5) flash({ t: 'P', n: v[2], r: v[5] / 2, rot: v[6] }, px + v[3], py + v[4])
        }
    }
    const evalMacro = (body, args) => {
        const vars = {}; args.forEach((a, i) => { vars[i + 1] = a })
        const prims = []
        for (const stmt of body) {
            if (/^0/.test(stmt)) continue
            const asg = /^\$(\d+)=(.*)$/.exec(stmt)
            const ev = e => { const js = e.replace(/\$(\d+)/g, (m, k) => `(${vars[k] ?? 0})`).replace(/x/gi, '*'); try { return Function(`return (${js})`)() } catch { return 0 } }
            if (asg) { vars[asg[1]] = ev(asg[2]); continue }
            prims.push(stmt.split(',').map(ev))
        }
        return prims
    }
    // разбор: команды разделены «*», расширенные — внутри %...%
    const tokens = []
    const re = /%([^%]*)%|([^*%]+)\*/g
    let m
    while ((m = re.exec(text))) { if (m[1] != null) for (const c of m[1].split('*').map(s => s.trim()).filter(Boolean)) tokens.push(['X', c]); else tokens.push(['C', m[2].trim()]) }
    let pendingMacro = null
    for (const [kind, t] of tokens) {
        if (kind === 'X') {
            if (pendingMacro && !/^AM/.test(t)) { if (/^(AD|FS|MO|LP|SR|AB|TA|TD|TF|TO|IP|OF|SF|LM|LR|LS)/.test(t)) pendingMacro = null; else { pendingMacro.push(t); continue } }
            if (/^FS/.test(t)) { const q = /FS([LTD])?A?X(\d)(\d)Y(\d)(\d)/.exec(t); if (q) { zeroOmit = q[1] === 'T' ? 'T' : 'L'; intD = +q[2]; decD = +q[3] } }
            else if (/^MO/.test(t)) inch = t === 'MOIN'
            else if (/^LP/.test(t)) dark = t !== 'LPC'
            else if (/^AM/.test(t)) { pendingMacro = []; macros[t.slice(2)] = pendingMacro }
            else if (/^AD/.test(t)) {
                const q = /^ADD(\d+)([A-Za-z_.$][\w.$-]*),?(.*)$/.exec(t); if (!q) continue
                const params = q[3] ? q[3].split('X').map(Number) : []
                const id = +q[1], typ = q[2]
                aps[id] = typ === 'C' ? { t: 'C', r: params[0] / 2 } : typ === 'R' ? { t: 'R', w: params[0], h: params[1] } : typ === 'O' ? { t: 'O', w: params[0], h: params[1] } : typ === 'P' ? { t: 'P', r: params[0] / 2, n: params[1], rot: params[2] } : macros[typ] ? { t: 'M', prims: evalMacro(macros[typ], params), r: 0 } : { t: 'C', r: 0.1 }
                if (aps[id].t === 'M') { const A = Math.abs; const sizes = aps[id].prims.map(p => p[0] === 1 || p[0] === 5 ? (p[2] ?? 0) / 2 + A(p[3] ?? 0) + A(p[4] ?? 0) : p[0] === 21 ? Math.hypot(p[2] ?? 0, p[3] ?? 0) / 2 + A(p[4] ?? 0) + A(p[5] ?? 0) : p[0] === 20 ? Math.max(A(p[3] ?? 0), A(p[4] ?? 0), A(p[5] ?? 0), A(p[6] ?? 0)) + (p[2] ?? 0) / 2 : p[0] === 4 ? Math.max(0, ...p.slice(3, 5 + 2 * (p[2] ?? 0)).map(A)) : 0); aps[id].r = Math.max(0, ...sizes.filter(Number.isFinite)) }
            }
            continue
        }
        let c = t
        if (/^G04/.test(c) || /^M0[02]/.test(c)) continue
        if (/^G36/.test(c)) { region = []; continue }
        if (/^G37/.test(c)) { if (region?.length) out.push({ d: region.join('') + 'Z', dark }); region = null; continue }
        if (/^G75/.test(c)) { multi = true; continue }
        if (/^G74/.test(c)) { multi = false; continue }
        const g = /^G0?([123])(?=\D|$)/.exec(c); if (g) { mode = +g[1]; c = c.slice(g[0].length) }
        const sel = /^(?:G54)?D(\d+)$/.exec(c); if (sel && +sel[1] >= 10) { cur = aps[+sel[1]]; continue }
        const q = /(?:X([+-]?[\d.]+))?(?:Y([+-]?[\d.]+))?(?:I([+-]?[\d.]+))?(?:J([+-]?[\d.]+))?D0?([123])$/.exec(c)
        if (!q) { const mv = /^(?:X([+-]?[\d.]+))?(?:Y([+-]?[\d.]+))?$/.exec(c); if (mv && (mv[1] || mv[2])) { x = num(mv[1], x); y = num(mv[2], y) } continue }
        const nx = num(q[1], x), ny = num(q[2], y), i = num(q[3], 0) || 0, j = num(q[4], 0) || 0, op = +q[5]
        if (op === 2) { moved = true; x = nx; y = ny; if (region) region.push(`${region.length ? 'Z' : ''}M${f(x)} ${f(y)}`); continue }
        if (op === 3) { moved = true; flash(cur, nx, ny); x = nx; y = ny; continue }
        // D01 — рисуем линию или дугу
        let seg
        if (mode === 1) seg = `L${f(nx)} ${f(ny)}`
        else {
            const cx = x + i, cy = y + j, r = Math.hypot(nx - cx, ny - cy) || Math.hypot(i, j)
            const a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx)
            let sweep = mode === 3 ? a1 - a0 : a0 - a1; if (sweep <= 0) sweep += 2 * Math.PI; if (multi && Math.abs(nx - x) < 1e-9 && Math.abs(ny - y) < 1e-9) sweep = 2 * Math.PI
            if (sweep >= 2 * Math.PI - 1e-9) { const mx = 2 * cx - x, my = 2 * cy - y; seg = `A${f(r)} ${f(r)} 0 0 ${mode === 3 ? 1 : 0} ${f(mx)} ${f(my)}A${f(r)} ${f(r)} 0 0 ${mode === 3 ? 1 : 0} ${f(nx)} ${f(ny)}` }
            else seg = `A${f(r)} ${f(r)} 0 ${sweep > Math.PI ? 1 : 0} ${mode === 3 ? 1 : 0} ${f(nx)} ${f(ny)}`
        }
        if (region) { if (!region.length) region.push(`M${f(x)} ${f(y)}`); region.push(seg) }
        else if (cur) { out.push({ d: `M${f(x)} ${f(y)}${seg}`, dark, stroke: cur.t === 'C' ? cur.r * 2 : Math.min(cur.w ?? 0.1, cur.h ?? 0.1) }); if (moved) ext(x, y, cur.r ?? 0) }
        x = nx; y = ny; ext(x, y, cur?.r ?? 0); moved = true
    }
    if (!out.length) throw new ReaderError('В файле Gerber нет рисунка.')
    const unit = inch ? 'дюйм' : 'мм'
    void scale
    const pad = (maxX - minX) * 0.03 || 1
    const vb = [minX - pad, -(maxY + pad), maxX - minX + 2 * pad, maxY - minY + 2 * pad]
    const copper = '#c8a03c', bg = '#0d3b24'
    // «очищающая» полярность — рисуем фоном поверх
    const body = out.map(o => o.stroke != null ? `<path d="${o.d}" fill="none" stroke="${o.dark ? copper : bg}" stroke-width="${f(o.stroke)}" stroke-linecap="${o.cap ?? 'round'}" stroke-linejoin="round"/>` : `<path d="${o.d}" fill="${o.dark ? copper : bg}"/>`).join('')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" class="ur-cad-svg" style="background:${bg}"><g transform="scale(1,-1)">${body}</g></svg>`
    const wrap = el('div', 'ur-gerber', `<div class="ur-meta">${esc(name)} · ${f(maxX - minX)} × ${f(maxY - minY)} ${unit} · масштаб: Ctrl + колесо, сдвиг — перетаскиванием, двойной щелчок — исходный вид</div>`)
    wrap.append(zoomable(svg, vb))
    return wrap
}

// ================= KiCad: S-выражения =================
export const sexpr = text => {
    let i = 0
    const parse = () => {
        const list = []
        while (i < text.length) {
            const c = text[i]
            if (c === '(') { i++; list.push(parse()) }
            else if (c === ')') { i++; return list }
            else if (c === '"') { let s = ''; i++; while (i < text.length && text[i] !== '"') { if (text[i] === '\\') { i++; s += text[i] === 'n' ? '\n' : text[i] } else s += text[i]; i++ } i++; list.push({ s }) }
            else if (/\s/.test(c)) i++
            else { let s = ''; while (i < text.length && !/[\s()]/.test(text[i])) s += text[i++]; list.push(s) }
        }
        return list
    }
    return parse()[0]
}
const k = (node, name) => node?.find?.(x => Array.isArray(x) && x[0] === name)
const ks = (node, name) => node?.filter?.(x => Array.isArray(x) && x[0] === name) ?? []
const str = v => typeof v === 'object' && v ? v.s : v
const xy = n => n ? [+n[1], +n[2]] : [0, 0]
const LAYER_COLORS = { 'F.Cu': '#c83434', 'B.Cu': '#4d7fc4', 'In1.Cu': '#c2c200', 'In2.Cu': '#c200c2', 'F.SilkS': '#f2eda1', 'B.SilkS': '#e8b2a7', 'F.Silkscreen': '#f2eda1', 'B.Silkscreen': '#e8b2a7', 'Edge.Cuts': '#d0d2cd', 'F.Fab': '#afafaf', 'B.Fab': '#585d84', 'F.CrtYd': '#ff26e2', 'B.CrtYd': '#26e9ff', 'F.Mask': '#d864ff', 'B.Mask': '#02ffee', 'Dwgs.User': '#c2c2c2', 'Cmts.User': '#5999c9' }
export const kicadPcbView = (ctx, text) => {
    const root = sexpr(text)
    if (root?.[0] !== 'kicad_pcb') throw new ReaderError('Это не плата KiCad.')
    const items = [] // {layer, svg}
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const ext = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
    const tf = (tx, ty, rot) => (x, y) => { const a = -rot * Math.PI / 180; return [tx + x * Math.cos(a) - y * Math.sin(a), ty + x * Math.sin(a) + y * Math.cos(a)] }
    const graphics = (n, T = (x, y) => [x, y], layerOverride) => {
        const kind = n[0].replace(/^(fp|gr)_/, ''), layer = layerOverride ?? str(k(n, 'layer')?.[1]) ?? ''
        const w = +(k(n, 'stroke') ? k(k(n, 'stroke'), 'width')?.[1] : k(n, 'width')?.[1]) || 0.12
        const fill = (str(k(n, 'fill')?.[1]) ?? '') === 'solid' || str(k(n, 'fill')?.[1]) === 'yes'
        const P = node => { const p = T(...xy(node)); ext(...p); return p }
        if (kind === 'line') { const a = P(k(n, 'start')), b = P(k(n, 'end')); items.push({ layer, svg: `<line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b[0])}" y2="${f(b[1])}" stroke-width="${w}"/>` }) }
        else if (kind === 'rect') { const a = P(k(n, 'start')), b = P(k(n, 'end')); items.push({ layer, svg: `<path d="M${f(a[0])} ${f(a[1])}H${f(b[0])}V${f(b[1])}H${f(a[0])}Z" stroke-width="${w}"${fill ? ' class="fill"' : ''}/>` }) }
        else if (kind === 'circle') { const c = P(k(n, 'center')), e = T(...xy(k(n, 'end'))); const r = Math.hypot(e[0] - c[0], e[1] - c[1]); items.push({ layer, svg: `<circle cx="${f(c[0])}" cy="${f(c[1])}" r="${f(r)}" stroke-width="${w}"${fill ? ' class="fill"' : ''}/>` }) }
        else if (kind === 'arc') {
            if (k(n, 'mid')) { const a = P(k(n, 'start')), m = P(k(n, 'mid')), b = P(k(n, 'end')); items.push({ layer, svg: `<path d="${arc3(a, m, b)}" stroke-width="${w}"/>` }) }
            else { const c = T(...xy(k(n, 'start'))), s = T(...xy(k(n, 'end'))), ang = +k(n, 'angle')[1]; const r = Math.hypot(s[0] - c[0], s[1] - c[1]); const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]), a1 = a0 + ang * Math.PI / 180; const e = [c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1)]; ext(...s); ext(...e); items.push({ layer, svg: `<path d="M${f(s[0])} ${f(s[1])}A${f(r)} ${f(r)} 0 ${Math.abs(ang) > 180 ? 1 : 0} ${ang > 0 ? 1 : 0} ${f(e[0])} ${f(e[1])}" stroke-width="${w}"/>` }) }
        }
        else if (kind === 'poly') { const pts = ks(k(n, 'pts'), 'xy').map(P); items.push({ layer, svg: `<polygon points="${pts.map(p => `${f(p[0])},${f(p[1])}`).join(' ')}" stroke-width="${w}"${fill || n[0] === 'fp_poly' ? ' class="fill"' : ''}/>` }) }
        else if (kind === 'text' && !/hide/.test(JSON.stringify(n))) {
            const at = k(n, 'at'); const p = T(+at[1], +at[2]); const size = +(k(k(k(n, 'effects'), 'font'), 'size')?.[1]) || 1
            const label = str(n[1] === 'reference' || n[1] === 'value' || n[1] === 'user' ? n[2] : n[1])
            items.push({ layer, svg: `<text x="${f(p[0])}" y="${f(p[1])}" font-size="${size}" text-anchor="middle" dominant-baseline="central" class="txt">${esc(label)}</text>` })
        }
    }
    for (const n of root) {
        if (!Array.isArray(n)) continue
        if (/^gr_/.test(n[0])) graphics(n)
        else if (n[0] === 'segment') { const a = xy(k(n, 'start')), b = xy(k(n, 'end')); ext(...a); ext(...b); items.push({ layer: str(k(n, 'layer')[1]), svg: `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke-width="${k(n, 'width')[1]}" stroke-linecap="round"/>` }) }
        else if (n[0] === 'arc') { const a = xy(k(n, 'start')), m = xy(k(n, 'mid')), b = xy(k(n, 'end')); items.push({ layer: str(k(n, 'layer')[1]), svg: `<path d="${arc3(a, m, b)}" stroke-width="${k(n, 'width')[1]}" stroke-linecap="round"/>` }) }
        else if (n[0] === 'via') { const a = xy(k(n, 'at')); const s = +k(n, 'size')[1], d = +(k(n, 'drill')?.[1] ?? s / 2); items.push({ layer: 'Via', svg: `<circle cx="${a[0]}" cy="${a[1]}" r="${s / 2}" class="via"/><circle cx="${a[0]}" cy="${a[1]}" r="${d / 2}" class="hole"/>` }) }
        else if (n[0] === 'zone') { const layer = str(k(n, 'layer')?.[1]) ?? str(k(n, 'layers')?.[1]); for (const fp of ks(n, 'filled_polygon')) { const pts = ks(k(fp, 'pts'), 'xy').map(xy); items.push({ layer: str(k(fp, 'layer')?.[1]) ?? layer, svg: `<polygon points="${pts.map(p => p.join(',')).join(' ')}" class="fill zone"/>` }) } }
        else if (n[0] === 'footprint' || n[0] === 'module') {
            const at = k(n, 'at'); const T = tf(+at[1], +at[2], +(at[3] ?? 0))
            for (const c of n) {
                if (!Array.isArray(c)) continue
                if (/^fp_/.test(c[0])) graphics(c, T)
                else if (c[0] === 'property' && /Reference/.test(str(c[1])) && !k(c, 'hide') && !/hide/.test(JSON.stringify(k(c, 'effects') ?? []))) { const pa = k(c, 'at'); if (pa) { const p = T(+pa[1], +pa[2]); items.push({ layer: str(k(c, 'layer')?.[1]) ?? 'F.SilkS', svg: `<text x="${f(p[0])}" y="${f(p[1])}" font-size="1" text-anchor="middle" dominant-baseline="central" class="txt">${esc(str(c[2]))}</text>` }) } }
                else if (c[0] === 'pad') {
                    const shape = c[3], pa = k(c, 'at'), sz = k(c, 'size'); const [px, py] = T(+pa[1], +pa[2]); const rot = +(pa[3] ?? 0); const w = +sz[1], h = +sz[2]
                    const layers = (k(c, 'layers') ?? []).slice(1).map(str); const layer = layers.find(l => /Cu/.test(l))?.replace('*.Cu', 'F.Cu') ?? 'F.Cu'
                    ext(px - w / 2, py - h / 2); ext(px + w / 2, py + h / 2)
                    const tr = `transform="rotate(${-rot} ${f(px)} ${f(py)})"`
                    let s = shape === 'circle' ? `<circle cx="${f(px)}" cy="${f(py)}" r="${w / 2}" class="pad"/>` : shape === 'oval' ? `<rect x="${f(px - w / 2)}" y="${f(py - h / 2)}" width="${w}" height="${h}" rx="${Math.min(w, h) / 2}" class="pad" ${tr}/>` : `<rect x="${f(px - w / 2)}" y="${f(py - h / 2)}" width="${w}" height="${h}" rx="${shape === 'roundrect' ? Math.min(w, h) * (+(k(c, 'roundrect_rratio')?.[1] ?? 0.25)) : 0}" class="pad" ${tr}/>`
                    const dr = k(c, 'drill'); if (dr && c[2] !== 'smd') { const d = +(dr[1] === 'oval' ? dr[2] : dr[1]); if (d) s += `<circle cx="${f(px)}" cy="${f(py)}" r="${d / 2}" class="hole"/>` }
                    items.push({ layer: layers.includes('*.Cu') ? 'F.Cu' : layer, svg: s })
                }
            }
        }
    }
    if (!items.length) throw new ReaderError('На плате нет ни одного элемента.')
    const order = ['B.Fab', 'B.CrtYd', 'B.Cu', 'B.SilkS', 'B.Silkscreen', 'In2.Cu', 'In1.Cu', 'F.Cu', 'Via', 'F.Fab', 'F.CrtYd', 'F.SilkS', 'F.Silkscreen', 'Edge.Cuts']
    const layers = [...new Set(items.map(i => i.layer))].sort((a, b) => (order.indexOf(a) + 100) % 115 - (order.indexOf(b) + 100) % 115)
    const pad = (maxX - minX) * 0.03 || 1
    const vb = [minX - pad, minY - pad, maxX - minX + 2 * pad, maxY - minY + 2 * pad]
    const g = layers.map(l => { const c = LAYER_COLORS[l] ?? (l === 'Via' ? '#b8b8b8' : '#8a8a8a'); return `<g data-layer="${esc(l)}" stroke="${c}" fill="none" color="${c}" opacity="${/Cu/.test(l) ? 0.85 : 1}">${items.filter(i => i.layer === l).map(i => i.svg).join('')}</g>` }).join('')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" class="ur-cad-svg ur-kicad-pcb"><style>.fill{fill:currentColor}.pad{fill:currentColor;stroke:none}.via{fill:#b8b8b8;stroke:none}.hole{fill:#222;stroke:none}.txt{fill:currentColor;stroke:none;font-family:sans-serif}.zone{opacity:.35}</style>${g}</svg>`
    const wrap = el('div', 'ur-kicad', `<div class="ur-meta">${f(maxX - minX)} × ${f(maxY - minY)} мм · масштаб: Ctrl + колесо, сдвиг — перетаскиванием</div>`)
    const view = zoomable(svg, vb)
    const toggles = el('div', 'ur-sci-controls ur-nosearch')
    for (const l of layers) { const lab = el('label', '', `<input type="checkbox" checked> <span style="color:${LAYER_COLORS[l] ?? '#999'}">■</span> ${esc(l)}`); lab.querySelector('input').onchange = e => { view.querySelector(`g[data-layer="${CSS.escape(l)}"]`).style.display = e.target.checked ? '' : 'none' }; toggles.append(lab) }
    wrap.append(toggles, view)
    return wrap
}
const arc3 = (a, m, b) => { // дуга по трём точкам
    const ax = a[0], ay = a[1], bx = m[0], by = m[1], cx = b[0], cy = b[1]
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)); if (Math.abs(d) < 1e-12) return `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    const r = Math.hypot(ax - ux, ay - uy)
    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    const ang = (p) => Math.atan2(p[1] - uy, p[0] - ux)
    let sweep = ang(b) - ang(a); if (cross > 0) { if (sweep < 0) sweep += 2 * Math.PI } else if (sweep > 0) sweep -= 2 * Math.PI
    return `M${f(ax)} ${f(ay)}A${f(r)} ${f(r)} 0 ${Math.abs(sweep) > Math.PI ? 1 : 0} ${cross > 0 ? 1 : 0} ${f(cx)} ${f(cy)}`
}
export const kicadSchView = (ctx, text) => {
    const root = sexpr(text)
    if (root?.[0] !== 'kicad_sch') throw new ReaderError('Это не схема KiCad (новый формат .kicad_sch). Старые схемы .sch пока не поддерживаются.')
    const libs = new Map()
    for (const s of ks(k(root, 'lib_symbols'), 'symbol')) libs.set(str(s[1]), s)
    const out = []
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const ext = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
    const pts = n => ks(k(n, 'pts'), 'xy').map(xy)
    for (const n of root) {
        if (!Array.isArray(n)) continue
        if (n[0] === 'wire' || n[0] === 'bus' || n[0] === 'polyline') { const p = pts(n); p.forEach(q => ext(...q)); out.push(`<polyline points="${p.map(q => q.join(',')).join(' ')}" class="${n[0]}"/>`) }
        else if (n[0] === 'junction') { const p = xy(k(n, 'at')); out.push(`<circle cx="${p[0]}" cy="${p[1]}" r="0.45" class="junc"/>`) }
        else if (n[0] === 'no_connect') { const [x, y] = xy(k(n, 'at')); out.push(`<path d="M${x - 0.6} ${y - 0.6}L${x + 0.6} ${y + 0.6}M${x - 0.6} ${y + 0.6}L${x + 0.6} ${y - 0.6}" class="nc"/>`) }
        else if (/label|^text$/.test(n[0])) { const at = k(n, 'at'); const [x, y] = [+at[1], +at[2]]; ext(x, y); const rot = +(at[3] ?? 0); out.push(`<text x="${x}" y="${y}" transform="rotate(${-rot} ${x} ${y})" class="${n[0] === 'text' ? 'note' : 'label'}">${esc(str(n[1]))}</text>`) }
        else if (n[0] === 'symbol') {
            const lib = libs.get(str(k(n, 'lib_id')?.[1]))
            const at = k(n, 'at'); const X = +at[1], Y = +at[2], rot = +(at[3] ?? 0)
            const mir = k(n, 'mirror')?.[1]
            const unit = +(k(n, 'unit')?.[1] ?? 1)
            // символы рисуются в своих координатах (ось Y вверх) — переносим на лист
            const T = `translate(${X} ${Y}) rotate(${-rot})${mir === 'x' ? ' scale(1 -1)' : mir === 'y' ? ' scale(-1 1)' : ''} scale(1 -1)`
            let g = ''
            for (const sub of ks(lib, 'symbol')) {
                const m = /_(\d+)_(\d+)$/.exec(str(sub[1])); if (m && +m[1] !== 0 && +m[1] !== unit) continue
                for (const p of sub) {
                    if (!Array.isArray(p)) continue
                    const fill = /outline|background/.test(str(k(k(p, 'fill'), 'type')?.[1]) ?? '') ? ` class="${str(k(k(p, 'fill'), 'type')[1])}"` : ''
                    if (p[0] === 'rectangle') { const a = xy(k(p, 'start')), b = xy(k(p, 'end')); g += `<rect x="${Math.min(a[0], b[0])}" y="${Math.min(a[1], b[1])}" width="${Math.abs(b[0] - a[0])}" height="${Math.abs(b[1] - a[1])}"${fill}/>` }
                    else if (p[0] === 'polyline') g += `<polyline points="${pts(p).map(q => q.join(',')).join(' ')}"${fill}/>`
                    else if (p[0] === 'circle') { const c = xy(k(p, 'center')); g += `<circle cx="${c[0]}" cy="${c[1]}" r="${k(p, 'radius')[1]}"${fill}/>` }
                    else if (p[0] === 'arc') g += `<path d="${arc3(xy(k(p, 'start')), xy(k(p, 'mid')), xy(k(p, 'end')))}"/>`
                    else if (p[0] === 'pin') { const pa = k(p, 'at'); const len = +k(p, 'length')[1], a = +(pa[3] ?? 0) * Math.PI / 180; const x1 = +pa[1], y1 = +pa[2]; g += `<line x1="${x1}" y1="${y1}" x2="${f(x1 + len * Math.cos(a))}" y2="${f(y1 + len * Math.sin(a))}" class="pin"/>` }
                }
            }
            ext(X - 5, Y - 5); ext(X + 5, Y + 5)
            out.push(`<g transform="${T}" class="sym">${g}</g>`)
            for (const pr of ks(n, 'property')) {
                const name = str(pr[1]); if (!/^(Reference|Value)$/.test(name)) continue
                if (k(pr, 'hide') || /\bhide\b/.test(JSON.stringify(k(pr, 'effects') ?? []))) continue
                const pa = k(pr, 'at'); if (!pa) continue
                out.push(`<text x="${pa[1]}" y="${pa[2]}" class="${name === 'Reference' ? 'ref' : 'val'}">${esc(str(pr[2]))}</text>`)
            }
        }
    }
    if (!out.length) throw new ReaderError('На схеме нет элементов.')
    const pad = 5
    const vb = [minX - pad, minY - pad, maxX - minX + 2 * pad, maxY - minY + 2 * pad]
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" class="ur-cad-svg ur-kicad-sch"><style>
        polyline,line,rect,circle,path{fill:none;stroke:#840000;stroke-width:.15}.wire{stroke:#008400}.bus{stroke:#0000c8;stroke-width:.4}.junc{fill:#008400;stroke:none}.nc{stroke:#0000c8}
        .outline{fill:#840000}.background{fill:#ffffc2}.pin{stroke:#840000}text{font:1.27px sans-serif;fill:#008484}.label{fill:#000}.ref{fill:#008484}.val{fill:#008484}.note{fill:#000080}</style>${out.join('')}</svg>`
    const wrap = el('div', 'ur-kicad', '<div class="ur-meta">Масштаб: Ctrl + колесо, сдвиг — перетаскиванием, двойной щелчок — исходный вид</div>')
    wrap.append(zoomable(svg, vb))
    return wrap
}
