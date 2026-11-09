// Схемы, чертежи, 3D, музыка, программы: draw.io, Graphviz, BPMN, DXF, 3D-модели, MIDI, MusicXML, HWP, EXE/DLL
import { escapeHtml as esc, decodeText, ReaderError, MIME, extOf } from '../util.js'
import { inflateRaw, inflateSync as inflateSyncRaw } from './compress.js'
import { fmtSize } from './archives.js'
import { buildMeshes } from './heavy.js'

const latin = new TextDecoder('latin1')
const SVGNS = 'http://www.w3.org/2000/svg'

// Масштаб колесом и перетаскивание для SVG-рисунков
export const panZoom = (svg, box) => {
    const vb = svg.viewBox.baseVal
    const init = [vb.x, vb.y, vb.width, vb.height]
    svg.addEventListener('wheel', e => {
        if (!e.ctrlKey && !e.metaKey && !e.altKey) return
        e.preventDefault()
        const r = svg.getBoundingClientRect()
        const k = e.deltaY > 0 ? 1.15 : 1 / 1.15
        const mx = vb.x + (e.clientX - r.left) / r.width * vb.width, my = vb.y + (e.clientY - r.top) / r.height * vb.height
        vb.x = mx - (mx - vb.x) * k; vb.y = my - (my - vb.y) * k; vb.width *= k; vb.height *= k
    }, { passive: false })
    let drag = null
    svg.addEventListener('pointerdown', e => { if (e.button !== 0 || e.target.closest('a, foreignObject')) return; drag = [e.clientX, e.clientY, vb.x, vb.y]; svg.setPointerCapture(e.pointerId); svg.style.cursor = 'grabbing' })
    svg.addEventListener('pointermove', e => { if (!drag) return; const r = svg.getBoundingClientRect(); vb.x = drag[2] - (e.clientX - drag[0]) / r.width * vb.width; vb.y = drag[3] - (e.clientY - drag[1]) / r.height * vb.height })
    svg.addEventListener('pointerup', () => { drag = null; svg.style.cursor = '' })
    svg.addEventListener('dblclick', () => { [vb.x, vb.y, vb.width, vb.height] = init })
    if (box) box.insertAdjacentHTML('afterbegin', '<div class="ur-meta ur-nosearch">Масштаб: Ctrl + колесо мыши, сдвиг — перетаскиванием, двойной щелчок — исходный вид.</div>')
}

// ================= draw.io =================
const parseStyle = s => {
    const o = {}
    for (const part of (s || '').split(';')) { if (!part) continue; const i = part.indexOf('='); if (i < 0) o[part] = '1'; else o[part.slice(0, i)] = part.slice(i + 1) }
    return o
}
const decodeDiagram = async el => {
    const model = el.querySelector('mxGraphModel')
    if (model) return model
    const txt = el.textContent.trim()
    if (!txt) return null
    const bin = Uint8Array.from(atob(txt), c => c.charCodeAt(0))
    const xmlText = decodeURIComponent(new TextDecoder('latin1').decode(await inflateRaw(bin)))
    return new DOMParser().parseFromString(xmlText, 'application/xml').querySelector('mxGraphModel')
}
const drawioPage = (model, theme) => {
    const cells = new Map()
    for (const c of model.getElementsByTagName('mxCell')) cells.set(c.getAttribute('id'), c)
    // объекты с пользовательскими свойствами: <object label="..."><mxCell .../></object>
    for (const o of model.querySelectorAll('object, UserObject')) { const c = o.querySelector('mxCell'); if (c) { c.setAttribute('id', o.getAttribute('id')); if (!c.getAttribute('value')) c.setAttribute('value', o.getAttribute('label') ?? ''); cells.set(o.getAttribute('id'), c) } }
    const geom = c => { const g = c.querySelector(':scope > mxGeometry'); return g ? { x: +(g.getAttribute('x') || 0), y: +(g.getAttribute('y') || 0), w: +(g.getAttribute('width') || 0), h: +(g.getAttribute('height') || 0), g } : null }
    const abs = new Map()
    const absPos = id => {
        if (abs.has(id)) return abs.get(id)
        const c = cells.get(id)
        const g = c && geom(c)
        let res = { x: 0, y: 0 }
        if (g && c.getAttribute('vertex') === '1') {
            const p = c.getAttribute('parent')
            const pc = cells.get(p)
            const off = pc && pc.getAttribute('vertex') === '1' ? absPos(p) : { x: 0, y: 0 }
            res = { x: off.x + g.x, y: off.y + g.y }
        }
        abs.set(id, res)
        return res
    }
    const shapes = [], edges = []
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const grow = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
    const fg = theme.text
    const col = (v, d) => !v || v === 'none' ? (d === undefined ? 'none' : d) : v === 'default' ? d : v
    const label = (c, st) => {
        let v = c.getAttribute('value') || ''
        if (st.html !== '1') v = esc(v).replace(/\n/g, '<br>')
        return v
    }
    for (const [id, c] of cells) {
        const g = geom(c)
        const st = parseStyle(c.getAttribute('style'))
        if (c.getAttribute('vertex') === '1' && g) {
            const p = absPos(id)
            const r = { x: p.x, y: p.y, w: g.w, h: g.h }
            grow(r.x, r.y); grow(r.x + r.w, r.y + r.h)
            shapes.push({ r, st, label: label(c, st), id })
        } else if (c.getAttribute('edge') === '1') edges.push({ c, st, g, label: label(c, st) })
    }
    const center = id => { const s = shapes.find(x => x.id === id); return s ? { x: s.r.x + s.r.w / 2, y: s.r.y + s.r.h / 2, r: s.r } : null }
    const clip = (from, to) => {
        // точка на границе прямоугольника по направлению к цели
        if (!from.r) return from
        const dx = to.x - from.x, dy = to.y - from.y
        if (!dx && !dy) return from
        const sx = from.r.w / 2 / Math.abs(dx || 1e-9), sy = from.r.h / 2 / Math.abs(dy || 1e-9)
        const k = Math.min(sx, sy, 1)
        return { x: from.x + dx * k, y: from.y + dy * k }
    }
    let svg = ''
    for (const s of shapes) {
        const { r, st } = s
        const fill = col(st.fillColor, st.text === '1' || st.shape === 'text' || 'text' in st && !st.fillColor ? 'none' : theme.bg)
        const stroke = col(st.strokeColor, st.text === '1' || 'text' in st ? 'none' : fg)
        const sw = +(st.strokeWidth || 1)
        const dash = st.dashed === '1' ? ' stroke-dasharray="6 4"' : ''
        const a = `fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${sw}"${dash}${st.opacity ? ` opacity="${+st.opacity / 100}"` : ''}`
        const shape = st.shape || Object.keys(st).find(k => ['ellipse', 'rhombus', 'triangle', 'hexagon', 'cylinder', 'cloud', 'swimlane', 'text', 'image', 'label'].includes(k)) || 'rect'
        if (shape === 'ellipse' || 'ellipse' in st) svg += `<ellipse cx="${r.x + r.w / 2}" cy="${r.y + r.h / 2}" rx="${r.w / 2}" ry="${r.h / 2}" ${a}/>`
        else if (shape === 'rhombus') svg += `<polygon points="${r.x + r.w / 2},${r.y} ${r.x + r.w},${r.y + r.h / 2} ${r.x + r.w / 2},${r.y + r.h} ${r.x},${r.y + r.h / 2}" ${a}/>`
        else if (shape === 'triangle') svg += `<polygon points="${r.x},${r.y} ${r.x + r.w},${r.y + r.h / 2} ${r.x},${r.y + r.h}" ${a}/>`
        else if (shape === 'hexagon') svg += `<polygon points="${r.x + r.w * .25},${r.y} ${r.x + r.w * .75},${r.y} ${r.x + r.w},${r.y + r.h / 2} ${r.x + r.w * .75},${r.y + r.h} ${r.x + r.w * .25},${r.y + r.h} ${r.x},${r.y + r.h / 2}" ${a}/>`
        else if (/cylinder/.test(shape)) svg += `<path d="M${r.x},${r.y + 8} a${r.w / 2},8 0 0 0 ${r.w},0 a${r.w / 2},8 0 0 0 -${r.w},0 v${r.h - 16} a${r.w / 2},8 0 0 0 ${r.w},0 v-${r.h - 16}" ${a}/>`
        else if (shape === 'image' && st.image) svg += `<image href="${esc(st.image.startsWith('data:') ? st.image.replace(/^data:image\/(\w+),/, 'data:image/$1;base64,') : '')}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`
        else if (shape !== 'text' && !('text' in st)) svg += `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${st.rounded === '1' ? Math.min(10, r.h / 4) : 0}" ${a}/>`
        if (shape === 'swimlane') svg += `<line x1="${r.x}" y1="${r.y + (+st.startSize || 26)}" x2="${r.x + r.w}" y2="${r.y + (+st.startSize || 26)}" stroke="${esc(stroke)}"/>`
        if (s.label) {
            const tc = col(st.fontColor, fg)
            const align = st.align || 'center', valign = shape === 'swimlane' ? 'top' : st.verticalAlign || 'middle'
            const lh = shape === 'swimlane' ? (+st.startSize || 26) : r.h
            svg += `<foreignObject x="${r.x}" y="${r.y}" width="${Math.max(r.w, 1)}" height="${Math.max(lh, 1)}" overflow="visible"><div xmlns="http://www.w3.org/1999/xhtml" class="ur-drawio-label" style="justify-content:${valign === 'top' ? 'flex-start' : valign === 'bottom' ? 'flex-end' : 'center'};text-align:${align};color:${esc(tc)};font-size:${+(st.fontSize || 12)}px;${st.fontStyle & 1 ? 'font-weight:bold;' : ''}${st.fontStyle & 2 ? 'font-style:italic;' : ''}">${s.label}</div></foreignObject>`
        }
    }
    for (const e of edges) {
        const src = center(e.c.getAttribute('source')), tgt = center(e.c.getAttribute('target'))
        const pt = as => { const p = e.g?.g.querySelector(`mxPoint[as="${as}"]`); return p ? { x: +(p.getAttribute('x') || 0), y: +(p.getAttribute('y') || 0) } : null }
        const way = Array.from(e.g?.g.querySelectorAll('Array[as="points"] > mxPoint') ?? []).map(p => ({ x: +(p.getAttribute('x') || 0), y: +(p.getAttribute('y') || 0) }))
        let a = src ?? pt('sourcePoint'), b = tgt ?? pt('targetPoint')
        if (!a || !b) continue
        const first = way[0] ?? b, last = way[way.length - 1] ?? a
        const A = src ? clip(src, first) : a, B = tgt ? clip(tgt, last) : b
        const pts = [A, ...way, B]
        pts.forEach(p => grow(p.x, p.y))
        const stroke = col(e.st.strokeColor, fg)
        const arrow = e.st.endArrow !== 'none' ? ' marker-end="url(#ur-arrow)"' : ''
        const start = e.st.startArrow && e.st.startArrow !== 'none' ? ' marker-start="url(#ur-arrow-s)"' : ''
        svg += `<polyline points="${pts.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${esc(stroke)}" stroke-width="${+(e.st.strokeWidth || 1)}"${e.st.dashed === '1' ? ' stroke-dasharray="6 4"' : ''}${arrow}${start}/>`
        if (e.label) { const m = pts[Math.floor(pts.length / 2) - (pts.length % 2 ? 0 : 1)], n = pts[Math.floor(pts.length / 2)]; const mx = (m.x + n.x) / 2, my = (m.y + n.y) / 2; svg += `<foreignObject x="${mx - 75}" y="${my - 12}" width="150" height="24" overflow="visible"><div xmlns="http://www.w3.org/1999/xhtml" class="ur-drawio-label is-edge" style="color:${esc(fg)}">${e.label}</div></foreignObject>` }
    }
    if (!isFinite(minX)) return null
    const pad = 20
    return `<svg xmlns="${SVGNS}" class="ur-diagram" viewBox="${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}" style="max-width:${maxX - minX + 2 * pad}px"><defs><marker id="ur-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${esc(fg)}"/></marker><marker id="ur-arrow-s" viewBox="0 0 10 10" refX="0" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M10,0 L0,5 L10,10 z" fill="${esc(fg)}"/></marker></defs>${svg}</svg>`
}
export const drawioView = async (ctx, text) => {
    const d = new DOMParser().parseFromString(text, 'application/xml')
    if (d.querySelector('parsererror')) throw new ReaderError('Файл draw.io повреждён (ошибка XML).')
    const diagrams = d.documentElement.localName === 'mxGraphModel' ? [d.documentElement] : Array.from(d.getElementsByTagName('diagram'))
    if (!diagrams.length) throw new ReaderError('В файле нет схем.')
    const theme = { text: ctx.themeColors().text, bg: ctx.themeColors().bg }
    const wrap = document.createElement('div')
    for (const [i, dg] of diagrams.entries()) {
        const model = dg.localName === 'mxGraphModel' ? dg : await decodeDiagram(dg)
        const sec = document.createElement('section')
        if (diagrams.length > 1) sec.innerHTML = `<h2>${esc(dg.getAttribute('name') || `Страница ${i + 1}`)}</h2>`
        const svg = model ? drawioPage(model, theme) : null
        if (svg) {
            const box = document.createElement('div'); box.className = 'ur-diagram-box'; box.innerHTML = svg
            for (const fo of box.querySelectorAll('foreignObject div')) { const clean = ctx.sanitize(fo.innerHTML); fo.innerHTML = ''; fo.append(clean) }
            sec.append(box); panZoom(box.querySelector('svg'), sec)
        } else sec.insertAdjacentHTML('beforeend', '<p class="ur-muted">Пустая страница.</p>')
        wrap.append(sec)
    }
    return wrap
}

// ================= Graphviz =================
export const dotView = async (ctx, text) => {
    const { instance } = await ctx.loadLib('viz')
    const viz = await instance()
    const wrap = document.createElement('div')
    let svg
    try { svg = viz.renderSVGElement(text) } catch (e) { throw new ReaderError('Ошибка в схеме Graphviz: ' + (e?.message || e)) }
    svg.classList.add('ur-diagram', 'ur-dot')
    svg.removeAttribute('width'); svg.removeAttribute('height')
    const box = document.createElement('div'); box.className = 'ur-diagram-box'; box.append(svg)
    wrap.append(box)
    panZoom(svg, wrap)
    return wrap
}

// ================= BPMN =================
export const bpmnView = async (ctx, text) => {
    const { Viewer, css } = await ctx.loadLib('bpmn')
    if (!document.getElementById('ur-bpmn-css')) { const st = document.createElement('style'); st.id = 'ur-bpmn-css'; st.textContent = css; document.head.append(st) }
    const box = document.createElement('div'); box.className = 'ur-bpmn'
    const viewer = new Viewer({ container: box })
    ctx.cleanups.push(() => viewer.destroy())
    requestAnimationFrame(async () => {
        try { await viewer.importXML(text); viewer.get('canvas').zoom('fit-viewport', 'auto') }
        catch (e) { box.textContent = 'Ошибка в схеме BPMN: ' + (e?.message || e) }
    })
    return box
}

// ================= DXF (чертежи) =================
const ACI = { 1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff', 8: '#808080', 9: '#c0c0c0' }
export const dxfView = async (ctx, text) => {
    const { DxfParser } = await ctx.loadLib('dxf')
    let dxf
    try { dxf = new DxfParser().parseSync(text) } catch (e) { throw new ReaderError('Не удалось прочитать чертёж DXF: ' + (e?.message || e)) }
    const layers = dxf.tables?.layer?.layers ?? {}
    const fg = ctx.themeColors().text
    const colorOf = e => { const c = e.colorIndex ?? layers[e.layer]?.colorIndex; return c && ACI[c] ? ACI[c] : fg }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const grow = (x, y) => { if (!isFinite(x) || !isFinite(y)) return; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
    let count = 0
    const draw = (ents, T, depth = 0) => {
        let out = ''
        const tp = p => { const x = T.sx * p.x, y = T.sy * p.y; const c = Math.cos(T.r), s = Math.sin(T.r); const X = T.x + x * c - y * s, Y = T.y + x * s + y * c; grow(X, Y); return [X, -Y] }
        for (const e of ents) {
            if (count > 200000) break
            count++
            const st = `stroke="${colorOf(e)}"`
            switch (e.type) {
                case 'LINE': { const [a, b] = e.vertices.map(tp); out += `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" ${st}/>`; break }
                case 'LWPOLYLINE': case 'POLYLINE': { const pts = (e.vertices || []).map(tp); if (pts.length) out += `<${e.shape || e.closed ? 'polygon' : 'polyline'} points="${pts.map(p => p.join(',')).join(' ')}" fill="none" ${st}/>`; break }
                case 'CIRCLE': { const [cx, cy] = tp(e.center); const r = e.radius * Math.abs(T.sx); grow(T.x + e.center.x * T.sx - r, T.y + e.center.y * T.sy - r); grow(T.x + e.center.x * T.sx + r, T.y + e.center.y * T.sy + r); out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" ${st}/>`; break }
                case 'ARC': {
                    const n = 32, a0 = e.startAngle, a1 = e.endAngle < e.startAngle ? e.endAngle + 2 * Math.PI : e.endAngle
                    const pts = Array.from({ length: n + 1 }, (_, i) => { const a = a0 + (a1 - a0) * i / n; return tp({ x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) }) })
                    out += `<polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" ${st}/>`; break
                }
                case 'ELLIPSE': {
                    const n = 48, mx = e.majorAxisEndPoint.x, my = e.majorAxisEndPoint.y, R = Math.hypot(mx, my), rot = Math.atan2(my, mx), r2 = R * e.axisRatio
                    const a0 = e.startAngle ?? 0, a1 = (e.endAngle ?? 2 * Math.PI) < a0 ? e.endAngle + 2 * Math.PI : (e.endAngle ?? 2 * Math.PI)
                    const pts = Array.from({ length: n + 1 }, (_, i) => { const a = a0 + (a1 - a0) * i / n; const x = R * Math.cos(a), y = r2 * Math.sin(a); return tp({ x: e.center.x + x * Math.cos(rot) - y * Math.sin(rot), y: e.center.y + x * Math.sin(rot) + y * Math.cos(rot) }) })
                    out += `<polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" ${st}/>`; break
                }
                case 'SPLINE': { const pts = (e.fitPoints?.length ? e.fitPoints : e.controlPoints || []).map(tp); if (pts.length) out += `<polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" ${st}/>`; break }
                case 'SOLID': case '3DFACE': { const pts = (e.points || e.vertices || []).map(tp); if (pts.length >= 3) out += `<polygon points="${(pts.length === 4 && e.type === 'SOLID' ? [pts[0], pts[1], pts[3], pts[2]] : pts).map(p => p.join(',')).join(' ')}" fill="${colorOf(e)}" fill-opacity=".5" ${st}/>`; break }
                case 'POINT': { const [x, y] = tp(e.position); out += `<circle cx="${x}" cy="${y}" r="0.5" fill="${colorOf(e)}"/>`; break }
                case 'TEXT': case 'MTEXT': case 'ATTRIB': {
                    const p = e.startPoint ?? e.position; if (!p) break
                    const [x, y] = tp(p)
                    const h = (e.textHeight ?? e.height ?? 2.5) * Math.abs(T.sy)
                    const t = String(e.text ?? '').replace(/\\P/g, '\n').replace(/\\[A-Za-z][^;]*;/g, '').replace(/[{}]/g, '')
                    out += `<text x="${x}" y="${y}" font-size="${h}" fill="${colorOf(e)}"${e.rotation ? ` transform="rotate(${-e.rotation} ${x} ${y})"` : ''}>${t.split('\n').map((l, i) => `<tspan x="${x}" dy="${i ? h * 1.2 : 0}">${esc(l)}</tspan>`).join('')}</text>`
                    break
                }
                case 'INSERT': {
                    const b = dxf.blocks?.[e.name]
                    if (!b || depth > 8) break
                    const sx = e.xScale ?? 1, sy = e.yScale ?? 1, r = (e.rotation ?? 0) * Math.PI / 180
                    const bp = b.position ?? { x: 0, y: 0 }
                    const [ox, oy] = [e.position.x, e.position.y]
                    const c = Math.cos(T.r), s = Math.sin(T.r)
                    const NT = { x: T.x + T.sx * ox * c - T.sy * oy * s - (sx * bp.x * Math.cos(r + T.r) - sy * bp.y * Math.sin(r + T.r)) * T.sx, y: T.y + T.sx * ox * s + T.sy * oy * c - (sx * bp.x * Math.sin(r + T.r) + sy * bp.y * Math.cos(r + T.r)) * T.sy, sx: T.sx * sx, sy: T.sy * sy, r: T.r + r }
                    out += draw(b.entities || [], NT, depth + 1)
                    break
                }
                case 'DIMENSION': { const b = dxf.blocks?.[e.block]; if (b && depth < 8) out += draw(b.entities || [], T, depth + 1); break }
            }
        }
        return out
    }
    const body = draw(dxf.entities || [], { x: 0, y: 0, sx: 1, sy: 1, r: 0 })
    if (!isFinite(minX)) throw new ReaderError('В чертеже нет поддерживаемых объектов.')
    const w = maxX - minX || 1, h = maxY - minY || 1, pad = Math.max(w, h) * 0.02
    const wrap = document.createElement('div')
    wrap.innerHTML = `<div class="ur-meta">Объектов: ${count} · слоёв: ${Object.keys(layers).length} · размер: ${+w.toPrecision(4)} × ${+h.toPrecision(4)}</div><div class="ur-diagram-box"><svg xmlns="${SVGNS}" class="ur-diagram ur-dxf" viewBox="${minX - pad} ${-maxY - pad} ${w + 2 * pad} ${h + 2 * pad}" stroke-width="1" vector-effect="non-scaling-stroke">${body}</svg></div>`
    wrap.querySelectorAll('svg *').forEach(el => el.setAttribute('vector-effect', 'non-scaling-stroke'))
    panZoom(wrap.querySelector('svg'), wrap)
    return wrap
}

// ================= 3D-модели =================

// Остальные форматы через загрузчики three.js (текстуры из соседних файлов не подгружаем)
const PLAIN_MAT = THREE => new THREE.MeshStandardMaterial({ color: 0x8aa4c8, metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide })
const meshOf = (THREE, geo) => {
    if (!geo.attributes.normal && geo.index) geo.computeVertexNormals()
    if (!geo.index && !geo.attributes.normal && geo.attributes.position.count % 3) return new THREE.Points(geo, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: !!geo.attributes.color }))
    if (!geo.attributes.normal) geo.computeVertexNormals()
    return new THREE.Mesh(geo, geo.attributes.color ? new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide }) : PLAIN_MAT(THREE))
}
const parseOff = (THREE, text) => {
    const lines = text.replace(/#.*$/gm, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    let li = 0
    if (/^[A-Z]*OFF/i.test(lines[0])) { const rest = lines[0].replace(/^[A-Z]*OFF/i, '').trim(); if (rest) lines[0] = rest; else li++ }
    const [nv, nf] = lines[li++].split(/\s+/).map(Number)
    if (!(nv > 0)) throw new ReaderError('Файл OFF повреждён.')
    const pos = new Float32Array(nv * 3)
    for (let v = 0; v < nv; v++) { const c = lines[li++].split(/\s+/).map(Number); pos.set([c[0], c[1], c[2]], v * 3) }
    const idx = []
    for (let f = 0; f < nf && li < lines.length; f++) {
        const t = lines[li++].split(/\s+/).map(Number), n = t[0]
        for (let k = 2; k < n; k++) idx.push(t[1], t[k], t[k + 1])
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    if (idx.length) geo.setIndex(idx)
    return geo
}
// Текстуры из соседних файлов не грузим: любой адрес заменяем пустой картинкой (и никаких запросов в сеть)
const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='

// Молекулы: атомы шариками (цвета CPK), связи — по расстоянию между атомами
const CPK = { H: 0xffffff, C: 0x909090, N: 0x3050f8, O: 0xff0d0d, S: 0xffff30, P: 0xff8000, F: 0x90e050, CL: 0x1ff01f, BR: 0xa62929, I: 0x940094, FE: 0xe06633, CA: 0x3dff00, NA: 0xab5cf2, MG: 0x8aff00, ZN: 0x7d80b0, K: 0x8f40d4, CU: 0xc88033, SI: 0xf0c8a0, B: 0xffb5b5 }
const RADIUS = { H: 0.31, C: 0.76, N: 0.71, O: 0.66, S: 1.05, P: 1.07, F: 0.57, CL: 1.02, BR: 1.2, I: 1.39, FE: 1.32, ZN: 1.22, CA: 1.76, NA: 1.66, MG: 1.41, K: 2.03, CU: 1.32, SI: 1.11, B: 0.84 }
export const moleculeObject = (THREE, atoms) => {
    const group = new THREE.Group()
    const n = atoms.length
    const big = n > 20000
    const sphere = new THREE.SphereGeometry(1, big ? 6 : 14, big ? 4 : 10)
    const mesh = new THREE.InstancedMesh(sphere, new THREE.MeshStandardMaterial({ roughness: 0.5 }), n)
    const m4 = new THREE.Matrix4(), col = new THREE.Color()
    atoms.forEach((a, i) => {
        const e = a.el.toUpperCase()
        const r = (RADIUS[e] ?? 0.8) * 0.45
        m4.makeScale(r, r, r).setPosition(a.x, a.y, a.z)
        mesh.setMatrixAt(i, m4)
        mesh.setColorAt(i, col.setHex(CPK[e] ?? 0xff1493))
    })
    group.add(mesh)
    // связи: соседей ищем по сетке, чтобы не сравнивать все пары
    if (n <= 200000) {
        const cell = 2.2, grid = new Map(), key = (x, y, z) => `${x},${y},${z}`
        atoms.forEach((a, i) => { const k = key(Math.floor(a.x / cell), Math.floor(a.y / cell), Math.floor(a.z / cell)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i) })
        const pos = []
        atoms.forEach((a, i) => {
            const cx = Math.floor(a.x / cell), cy = Math.floor(a.y / cell), cz = Math.floor(a.z / cell)
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (const j of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
                if (j <= i) continue
                const b = atoms[j]
                const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
                const lim = ((RADIUS[a.el.toUpperCase()] ?? 0.8) + (RADIUS[b.el.toUpperCase()] ?? 0.8)) * 1.15
                if (d > 0.4 && d < lim) pos.push(a.x, a.y, a.z, b.x, b.y, b.z)
            }
        })
        if (pos.length) {
            const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
            group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x888888 })))
        }
    }
    group.userData.atoms = n
    return group
}
// CIF и mmCIF: таблицы loop_ с координатами атомов (декартовыми или долями ячейки)
export const cifAtoms = text => {
    const toks = []
    const re = /'([^']*)'(?=\s|$)|"([^"]*)"(?=\s|$)|^;([\s\S]*?)^;|(\S+)/gm
    let m
    const clean = text.replace(/^#.*$/gm, '')
    while ((m = re.exec(clean))) toks.push(m[1] ?? m[2] ?? m[3] ?? m[4])
    const vals = {}, loops = []
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i]
        if (/^loop_$/i.test(t)) {
            const cols = []; i++
            while (i < toks.length && toks[i].startsWith('_')) cols.push(toks[i++].toLowerCase())
            const rows = []
            while (i < toks.length && !toks[i].startsWith('_') && !/^(loop_|data_)/i.test(toks[i])) { const r = []; for (let k = 0; k < cols.length && i < toks.length; k++) r.push(toks[i++]); rows.push(r) }
            i--; loops.push({ cols, rows })
        } else if (t.startsWith('_')) { vals[t.toLowerCase()] = toks[i + 1]; i++ }
        else if (/^data_/i.test(t) && loops.length) break // только первый блок
    }
    const n = v => parseFloat(String(v).replace(/\(.*\)/, ''))
    const L = loops.find(l => l.cols.some(c => /^_atom_site[._](cartn_x|fract_x)$/.test(c)))
    if (!L) return []
    const ci = name => L.cols.findIndex(c => c === `_atom_site.${name}` || c === `_atom_site_${name}`)
    const el = r => { const t = r[ci('type_symbol')] ?? r[ci('label')] ?? 'C'; return String(t).replace(/[^A-Za-z].*$/, '').replace(/^([A-Z][a-z]?).*$/, '$1') || 'C' }
    if (ci('cartn_x') >= 0) {
        const model = ci('pdbx_pdb_model_num')
        const first = model >= 0 ? L.rows[0][model] : null
        return L.rows.filter(r => model < 0 || r[model] === first).map(r => ({ el: el(r), x: n(r[ci('cartn_x')]), y: n(r[ci('cartn_y')]), z: n(r[ci('cartn_z')]) }))
    }
    const a = n(vals._cell_length_a), b = n(vals._cell_length_b), c = n(vals._cell_length_c)
    const al = n(vals._cell_angle_alpha) * Math.PI / 180, be = n(vals._cell_angle_beta) * Math.PI / 180, ga = n(vals._cell_angle_gamma) * Math.PI / 180
    const cx = c * Math.cos(be), cy = c * (Math.cos(al) - Math.cos(be) * Math.cos(ga)) / Math.sin(ga), cz = Math.sqrt(Math.max(0, c * c - cx * cx - cy * cy))
    return L.rows.map(r => { const fx = n(r[ci('fract_x')]), fy = n(r[ci('fract_y')]), fz = n(r[ci('fract_z')]); return { el: el(r), x: fx * a + fy * b * Math.cos(ga) + fz * cx, y: fy * b * Math.sin(ga) + fz * cy, z: fz * cz } }).filter(p => Number.isFinite(p.x))
}
const parseMoreModels = (L, THREE, buf, ext) => {
    const text = () => decodeText(buf)
    const manager = new THREE.LoadingManager()
    manager.setURLModifier(u => u.startsWith('data:') || u.startsWith('blob:') ? u : BLANK_PNG)
    const fixMats = o => { o.traverse(m => { if (m.isMesh && m.material && !Array.isArray(m.material) && m.material.map && !m.material.map.image) m.material.map = null }); return o }
    try {
        switch (ext) {
            case 'fbx': return fixMats(new L.FBXLoader(manager).parse(buf, ''))
            case 'dae': return fixMats(new L.ColladaLoader(manager).parse(text(), '').scene)
            case '3ds': return fixMats(new L.TDSLoader(manager).parse(buf, ''))
            case 'wrl': case 'vrml': return new L.VRMLLoader(manager).parse(text(), '')
            case 'amf': return new L.AMFLoader().parse(buf)
            case 'vox': return new L.VOXLoader().parse(buf).scene
            case 'pcd': { const pts = new L.PCDLoader().parse(buf); if (!pts.geometry.attributes.color) pts.material.color.set(0x5577aa); pts.material.size = 2; pts.material.sizeAttenuation = false; return pts }
            case 'vtk': case 'vtp': return meshOf(THREE, new L.VTKLoader().parse(buf, ''))
            case 'md2': return meshOf(THREE, new L.MD2Loader().parse(buf))
            case 'off': return meshOf(THREE, parseOff(THREE, text()))
            case 'pdbmol': {
                const r = new L.PDBLoader().parse(text())
                const pos = r.geometryAtoms.attributes.position.array
                const atoms = r.json.atoms.map((a, i) => ({ x: pos[i * 3], y: pos[i * 3 + 1], z: pos[i * 3 + 2], el: a[4] }))
                if (!atoms.length) throw new ReaderError('В файле PDB нет атомов.')
                return moleculeObject(THREE, atoms)
            }
            case 'xyzmol': {
                const lines = text().replace(/\r/g, '').split('\n'); const nAt = +lines[0]
                const atoms = lines.slice(2, 2 + nAt).map(l => l.trim().split(/\s+/)).filter(f => f.length >= 4).map(f => ({ el: f[0], x: +f[1], y: +f[2], z: +f[3] }))
                return moleculeObject(THREE, atoms)
            }
            case 'usdz': case 'usda': case 'usdc': case 'usd': {
                const o = new L.USDLoader(manager).parse(ext === 'usda' ? text() : buf)
                if (!o) throw new ReaderError('Не удалось прочитать модель USD.')
                return o
            }
            case 'lwo': {
                const r = new L.LWOLoader(manager).parse(buf, '', ''); const g = new THREE.Group(); for (const m of r.meshes) g.add(m)
                // материалы LightWave бывают с настройками, которые не собираются в шейдер — упрощаем
                const simple = m => new THREE.MeshStandardMaterial({ color: m.color ?? 0xcccccc, map: m.map?.image ? m.map : null, roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide, transparent: m.transparent, opacity: m.opacity ?? 1 })
                g.traverse(o => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(simple) : simple(o.material) })
                return g
            }
            case 'bvh': {
                const r = new L.BVHLoader().parse(text())
                const g = new THREE.Group(); const bone = r.skeleton.bones[0]
                g.add(bone); const helper = new THREE.SkeletonHelper(bone); helper.material.linewidth = 2; g.add(helper)
                g.userData.clip = r.clip; g.userData.animRoot = bone; g.userData.bones = r.skeleton.bones.length
                // габариты по суставам в первой позе (у скелета нет сетки)
                bone.updateMatrixWorld(true); const box = new THREE.Box3(); const v = new THREE.Vector3()
                for (const b of r.skeleton.bones) box.expandByPoint(b.getWorldPosition(v))
                g.userData.box = box
                return g
            }
            case 'pmd': case 'pmx': {
                const P = new L.MMDParser.Parser()
                const d = ext === 'pmd' ? P.parsePmd(buf, true) : P.parsePmx(buf, true)
                const pos = [], nor = [], idx = []
                for (const v of d.vertices) { pos.push(...v.position); nor.push(...v.normal) }
                for (const fc of d.faces) idx.push(...fc.indices)
                const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); geo.setIndex(idx)
                const mats = []; let start = 0
                d.materials.forEach((m, i) => { const n = m.faceCount; geo.addGroup(start, n, i); start += n; const c = m.diffuse; mats.push(new THREE.MeshLambertMaterial({ color: new THREE.Color(c[0], c[1], c[2]), side: THREE.DoubleSide, transparent: c[3] < 1, opacity: c[3] })) })
                const mesh = new THREE.Mesh(geo, mats.length ? mats : new THREE.MeshLambertMaterial({ color: 0xcccccc }))
                mesh.userData.title = d.metadata?.modelName
                return mesh
            }
            case 'tilt': return tiltObject(THREE, buf)
            case 'mol': case 'sdf': {
                const t = text().replace(/\r/g, '')
                const rec = t.split(/^\$\$\$\$\s*$/m)[0]
                const lines = rec.split('\n')
                const atoms = []
                if (/V3000/.test(lines[3] ?? '')) {
                    let on = false
                    for (const l of lines) { if (/BEGIN ATOM/.test(l)) { on = true; continue } if (/END ATOM/.test(l)) break; if (on) { const f = l.replace(/^M\s+V30\s+/, '').trim().split(/\s+/); if (f.length >= 5) atoms.push({ el: f[1], x: +f[2], y: +f[3], z: +f[4] }) } }
                } else {
                    const n = +(lines[3] ?? '').slice(0, 3)
                    for (let i = 0; i < n; i++) { const l = lines[4 + i] ?? ''; atoms.push({ x: +l.slice(0, 10), y: +l.slice(10, 20), z: +l.slice(20, 30), el: l.slice(31, 34).trim() }) }
                }
                if (!atoms.length) throw new ReaderError('В файле нет атомов.')
                const g = moleculeObject(THREE, atoms); g.userData.title = lines[0].trim(); return g
            }
            case 'cif': {
                const atoms = cifAtoms(text())
                if (!atoms.length) throw new ReaderError('В файле CIF нет координат атомов.')
                return moleculeObject(THREE, atoms)
            }
            case 'xyz': { const g = new L.XYZLoader().parse(text()); return new THREE.Points(g, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: !!g.attributes.color, color: g.attributes.color ? 0xffffff : 0x5577aa })) }
            case 'gcode': { const g = new L.GCodeLoader().parse(text()); g.rotation.x = -Math.PI / 2; return g }
        }
    } catch (e) {
        if (e instanceof ReaderError) throw e
        throw new ReaderError(`Не удалось прочитать модель .${ext}: ` + (e?.message || e))
    }
    throw new ReaderError('Неизвестный формат модели.')
}

export const modelView = async (ctx, file, buf, ext) => {
    const L = await ctx.loadLib('three')
    const { THREE } = L
    const wrap = document.createElement('div'); wrap.className = 'ur-3d'
    const info = document.createElement('div'); info.className = 'ur-meta ur-nosearch'
    const host = document.createElement('div'); host.className = 'ur-3d-canvas'
    wrap.append(info, host)
    let obj
    if (ext === 'stl' || ext === 'ply') {
        const geo = (ext === 'stl' ? new L.STLLoader() : new L.PLYLoader()).parse(buf)
        geo.computeVertexNormals?.()
        const mat = geo.hasAttribute?.('color') ? new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false }) : new THREE.MeshStandardMaterial({ color: 0x8aa4c8, metalness: 0.1, roughness: 0.6 })
        obj = geo.index || geo.attributes.normal ? new THREE.Mesh(geo, mat) : new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.01, vertexColors: geo.hasAttribute?.('color') }))
    } else if (ext === 'obj') {
        obj = new L.OBJLoader().parse(decodeText(buf))
        obj.traverse(o => { if (o.isMesh && (!o.material || Array.isArray(o.material) ? false : !o.material.map)) o.material = new THREE.MeshStandardMaterial({ color: 0x8aa4c8, roughness: 0.6 }) })
    } else if (ext === '3mf') {
        obj = new L.ThreeMFLoader().parse(buf)
    } else if (ext === 'drc') {
        const d = L.makeDraco()
        const geo = await new Promise((res, rej) => d.parse(buf, res, e => rej(new ReaderError('Не удалось распаковать сетку Draco: ' + (e?.message || e)))))
        d.dispose()
        geo.computeVertexNormals?.()
        obj = geo.index ? new THREE.Mesh(geo, geo.hasAttribute('color') ? new THREE.MeshStandardMaterial({ vertexColors: true }) : new THREE.MeshStandardMaterial({ color: 0x8aa4c8, roughness: 0.6 })) : new THREE.Points(geo, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: geo.hasAttribute('color'), color: geo.hasAttribute('color') ? 0xffffff : 0x5577aa }))
    } else if (ext === 'meshes') {
        obj = buildMeshes(L, THREE, buf) // готовые сетки из STEP, Rhino, IFC
        obj.userData.info = buf.info
    } else if (ext !== 'gltf' && ext !== 'glb') {
        obj = parseMoreModels(L, THREE, buf, ext)
    } else {
        // glTF: внешние файлы (.bin, текстуры) читаем из той же папки хранилища
        const manager = new THREE.LoadingManager()
        const dir = file.parent?.path && file.parent.path !== '/' ? file.parent.path + '/' : ''
        const blobs = new Map()
        if (ext === 'gltf') {
            const json = JSON.parse(decodeText(buf))
            for (const r of [...(json.buffers || []), ...(json.images || [])]) {
                if (!r.uri || r.uri.startsWith('data:')) continue
                try { const b = await ctx.app.vault.adapter.readBinary(dir + decodeURIComponent(r.uri)); const u = URL.createObjectURL(new Blob([b], { type: MIME[extOf(r.uri)] || '' })); ctx.urls.push(u); blobs.set(r.uri, u) } catch { /* файла нет — покажем что сможем */ }
            }
        }
        manager.setURLModifier(u => { for (const [k, v] of blobs) if (u.endsWith(k) || u.endsWith(encodeURI(k))) return v; return u })
        const loader = new L.GLTFLoader(manager)
        obj = await new Promise((res, rej) => loader.parse(ext === 'gltf' ? decodeText(buf) : buf, 'https://model.local/', g => res(g.scene), e => rej(new ReaderError('Не удалось прочитать модель glTF: ' + (e?.message || e)))))
    }
    const scene = new THREE.Scene()
    const dark = ctx.isDark()
    scene.background = new THREE.Color(ctx.themeColors().bg)
    scene.add(new THREE.HemisphereLight(0xffffff, dark ? 0x222233 : 0x888899, 1.6))
    const dir = new THREE.DirectionalLight(0xffffff, 1.8); dir.position.set(1, 2, 3); scene.add(dir)
    if (ext === 'stl' || ext === '3mf') obj.rotation.x = -Math.PI / 2 // в 3D-печати ось Z смотрит вверх
    scene.add(obj)
    const box = obj.userData?.box ?? new THREE.Box3().setFromObject(obj)
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(size.x, size.y, size.z) || 1
    const camera = new THREE.PerspectiveCamera(45, 1, radius / 1000, radius * 100)
    camera.position.copy(center).add(new THREE.Vector3(radius * 0.9, radius * 0.7, radius * 1.3))
    let renderer
    try { renderer = new THREE.WebGLRenderer({ antialias: true }) } catch { throw new ReaderError('Не удалось включить 3D-графику (WebGL недоступен).') }
    renderer.setPixelRatio(window.devicePixelRatio || 1)
    host.append(renderer.domElement)
    const controls = new L.OrbitControls(camera, renderer.domElement)
    controls.target.copy(center); controls.update()
    const grid = new THREE.GridHelper(radius * 2, 20, dark ? 0x555566 : 0xbbbbcc, dark ? 0x333344 : 0xddddee); grid.position.set(center.x, box.min.y, center.z); scene.add(grid)
    let tris = 0, pts = 0; obj.traverse(o => { if (o.isMesh) { const g = o.geometry; tris += g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3 } else if (o.isPoints || o.isLine) pts += o.geometry?.attributes.position?.count ?? 0 })
    info.textContent = `${obj.userData?.info ? obj.userData.info + ' · ' : ''}${obj.userData?.bones ? `Костей: ${obj.userData.bones}, длительность ${obj.userData.clip?.duration?.toFixed(1)} с` : obj.userData?.atoms ? `Атомов: ${obj.userData.atoms.toLocaleString('ru-RU')}` : tris ? `Треугольников: ${Math.round(tris).toLocaleString('ru-RU')}` : `Точек: ${pts.toLocaleString('ru-RU')}`} · габариты: ${+size.x.toPrecision(4)} × ${+size.y.toPrecision(4)} × ${+size.z.toPrecision(4)} · вращайте мышью, колесо — масштаб, правая кнопка — сдвиг`
    let raf = 0
    const resize = () => { const w = host.clientWidth || 600, h = host.clientHeight || 400; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix() }
    let mixer = null; const clock = new THREE.Clock()
    if (obj.userData?.clip) { mixer = new THREE.AnimationMixer(obj.userData.animRoot ?? obj); mixer.clipAction(obj.userData.clip).play() }
    const loop = () => { raf = requestAnimationFrame(loop); if (mixer) mixer.update(clock.getDelta()); controls.update(); renderer.render(scene, camera) }
    const ro = new ResizeObserver(resize); ro.observe(host)
    requestAnimationFrame(() => { resize(); loop() })
    ctx.cleanups.push(() => { cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); renderer.forceContextLoss?.() })
    return wrap
}

// ================= MIDI =================
const GM_FAMILIES = ['Фортепиано', 'Хроматические ударные', 'Орган', 'Гитара', 'Бас', 'Струнные', 'Ансамбль', 'Медные', 'Язычковые', 'Флейты', 'Синтезатор (соло)', 'Синтезатор (фон)', 'Синтезатор (эффекты)', 'Этнические', 'Ударные', 'Звуковые эффекты']
const MAJORS = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#']
const MINORS = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#']
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
export const parseMidi = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    let off = 0
    if (latin.decode(u8.subarray(0, 4)) === 'RIFF') { const i = latin.decode(u8).indexOf('MThd'); if (i < 0) throw new ReaderError('В файле RMI нет MIDI.'); off = i }
    if (latin.decode(u8.subarray(off, off + 4)) !== 'MThd') throw new ReaderError('Это не файл MIDI.')
    const format = dv.getUint16(off + 8), ntr = dv.getUint16(off + 10), div = dv.getUint16(off + 12)
    let p = off + 8 + dv.getUint32(off + 4)
    const tracks = [], tempos = [[0, 500000]]
    let lyrics = [], meta = { time: '', key: '' }
    for (let t = 0; t < ntr && p + 8 <= u8.length; t++) {
        if (latin.decode(u8.subarray(p, p + 4)) !== 'MTrk') break
        const len = dv.getUint32(p + 4), end = p + 8 + len
        let q = p + 8, tick = 0, status = 0
        const tr = { name: '', notes: [], programs: new Set(), channels: new Set(), text: [] }
        const open = new Map()
        const vlq = () => { let v = 0, b; do { b = u8[q++]; v = (v << 7) | (b & 0x7F) } while (b & 0x80 && q < end); return v }
        while (q < end) {
            tick += vlq()
            let s = u8[q]
            if (s & 0x80) { q++; if (s < 0xF0) status = s } else s = status
            if (s === 0xFF) {
                const type = u8[q++], l = vlq(), data = u8.subarray(q, q + l); q += l
                const txt = () => { const d = new TextDecoder('utf-8', { fatal: true }); try { return d.decode(data) } catch { return new TextDecoder('windows-1251').decode(data) } }
                if (type === 0x03 && !tr.name) tr.name = txt()
                else if (type === 0x51) tempos.push([tick, (data[0] << 16) | (data[1] << 8) | data[2]])
                else if (type === 0x58 && !meta.time) meta.time = `${data[0]}/${2 ** data[1]}`
                else if (type === 0x59 && !meta.key) { const sf = (data[0] << 24) >> 24; meta.key = (data[1] ? MINORS[sf + 7] && MINORS[sf + 7] + ' минор' : MAJORS[sf + 7] && MAJORS[sf + 7] + ' мажор') || '' }
                else if (type === 0x05) lyrics.push(txt())
                else if (type === 0x01 && t === 0) tr.text.push(txt())
                if (type === 0x2F) break
            } else if (s === 0xF0 || s === 0xF7) { const l = vlq(); q += l }
            else {
                const ch = s & 0x0F, kind = s & 0xF0
                const a = u8[q++], b = kind === 0xC0 || kind === 0xD0 ? 0 : u8[q++]
                if (kind === 0x90 && b > 0) { open.set(ch * 128 + a, [tick, b]); tr.channels.add(ch) }
                else if (kind === 0x80 || (kind === 0x90 && b === 0)) { const o = open.get(ch * 128 + a); if (o) { tr.notes.push({ start: o[0], end: tick, pitch: a, vel: o[1], ch }); open.delete(ch * 128 + a) } }
                else if (kind === 0xC0) tr.programs.add(ch === 9 ? 'drums' : a)
            }
        }
        for (const [k, o] of open) tr.notes.push({ start: o[0], end: tick, pitch: k % 128, vel: o[1], ch: Math.floor(k / 128) })
        tracks.push(tr)
        p = end
    }
    tempos.sort((a, b) => a[0] - b[0])
    const toSec = tick => {
        if (div & 0x8000) return tick / ((-(div >> 8) << 24 >> 24) * (div & 0xFF))
        let sec = 0, last = 0, tempo = 500000
        for (const [tk, tp] of tempos) { if (tk > tick) break; sec += (tk - last) * tempo / div / 1e6; last = tk; tempo = tp }
        return sec + (tick - last) * tempo / div / 1e6
    }
    for (const tr of tracks) for (const n of tr.notes) { n.t0 = toSec(n.start); n.t1 = toSec(n.end) }
    const bpm = Math.round(60e6 / (tempos.find(t => t[0] > 0 || tempos.length === 1)?.[1] ?? tempos[tempos.length - 1][1]))
    return { format, tracks, lyrics, meta, bpm, duration: Math.max(0, ...tracks.flatMap(t => t.notes.map(n => n.t1))) }
}
export const midiView = (ctx, buf) => {
    const m = parseMidi(buf)
    const wrap = document.createElement('div')
    const dur = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
    const used = m.tracks.filter(t => t.notes.length || t.name)
    const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#469990', '#9a6324', '#800000', '#808000', '#000075', '#a9a9a9']
    wrap.innerHTML = `<div class="ur-meta">Длительность ${dur(m.duration)} · темп ≈ ${m.bpm} уд/мин${m.meta.time ? ' · размер ' + m.meta.time : ''}${m.meta.key ? ' · тональность ' + esc(m.meta.key) : ''} · дорожек: ${used.length}</div>
    <table class="ur-po-table"><thead><tr><th></th><th>Дорожка</th><th>Инструмент</th><th>Нот</th></tr></thead><tbody>${m.tracks.map((t, i) => (t.notes.length || t.name) ? `<tr><td><span class="ur-swatch" style="background:${COLORS[i % COLORS.length]}"></span></td><td>${esc(t.name || `Дорожка ${i + 1}`)}</td><td>${esc([...t.programs].map(p => p === 'drums' ? 'Ударные' : GM_FAMILIES[Math.floor(p / 8)] + ` (${p + 1})`).join(', ') || (t.channels.has(9) ? 'Ударные' : ''))}</td><td>${t.notes.length}</td></tr>` : '').join('')}</tbody></table>`
    // «пианоролл»
    const notes = m.tracks.flatMap((t, i) => t.notes.map(n => ({ ...n, color: COLORS[i % COLORS.length] })))
    if (notes.length) {
        const lo = Math.min(...notes.map(n => n.pitch)), hi = Math.max(...notes.map(n => n.pitch))
        const pxs = 60, rowH = Math.max(3, Math.min(8, 480 / (hi - lo + 1)))
        const W = Math.min(30000, Math.ceil(m.duration * pxs) + 40), H = (hi - lo + 1) * rowH + 20
        const c = document.createElement('canvas'); c.width = W; c.height = H; c.className = 'ur-pianoroll'
        const g = c.getContext('2d')
        const fg = ctx.themeColors().text
        g.globalAlpha = 0.12; g.fillStyle = fg
        for (let p = lo; p <= hi; p++) if ([1, 3, 6, 8, 10].includes(p % 12)) g.fillRect(0, (hi - p) * rowH, W, rowH)
        g.globalAlpha = 0.35
        for (let s = 0; s * pxs < W; s += 5) { g.fillRect(30 + s * pxs, 0, 1, H - 20) }
        g.globalAlpha = 1; g.font = '10px sans-serif'
        for (let s = 0; s * pxs < W; s += 10) g.fillText(dur(s), 32 + s * pxs, H - 6)
        for (let p = lo; p <= hi; p++) if (p % 12 === 0) g.fillText(NOTE_NAMES[0] + (p / 12 - 1), 2, (hi - p + 1) * rowH)
        for (const n of notes) { g.fillStyle = n.color; g.globalAlpha = 0.45 + n.vel / 254; g.fillRect(30 + n.t0 * pxs, (hi - n.pitch) * rowH, Math.max(2, (n.t1 - n.t0) * pxs - 1), rowH - 1) }
        const sc = document.createElement('div'); sc.className = 'ur-pianoroll-box'; sc.append(c)
        wrap.insertAdjacentHTML('beforeend', '<h3>Ноты</h3>')
        wrap.append(sc)
    }
    // простое проигрывание: синтезатор браузера (без настоящих инструментов)
    if (notes.length) {
        const bar = document.createElement('div'); bar.className = 'ur-sci-controls ur-nosearch'
        const btn = Object.assign(document.createElement('button'), { textContent: '▶ Проиграть' }), info = Object.assign(document.createElement('span'), { className: 'ur-muted', textContent: ' простой синтезатор — звучит не как настоящие инструменты' })
        bar.append(btn, info); wrap.prepend(bar)
        let ac = null, timer = null
        const stop = () => { clearTimeout(timer); ac?.close(); ac = null; btn.textContent = '▶ Проиграть' }
        btn.onclick = () => {
            if (ac) return stop()
            ac = new AudioContext(); btn.textContent = '■ Остановить'
            const master = ac.createGain(); master.gain.value = 0.25; master.connect(ac.destination)
            const t0 = ac.currentTime + 0.1
            const noise = ac.createBuffer(1, ac.sampleRate * 0.2, ac.sampleRate); const nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1
            for (const n of notes.slice(0, 20000)) {
                const g = ac.createGain(), v = n.vel / 127 * 0.3
                const st = t0 + n.t0, en = t0 + Math.max(n.t1, n.t0 + 0.05)
                g.gain.setValueAtTime(0, st); g.gain.linearRampToValueAtTime(v, st + 0.01); g.gain.setTargetAtTime(v * 0.6, st + 0.05, 0.2); g.gain.setTargetAtTime(0, en, 0.05)
                g.connect(master)
                if (n.ch === 9) { const s = ac.createBufferSource(); s.buffer = noise; const f = ac.createBiquadFilter(); f.type = n.pitch < 40 ? 'lowpass' : 'highpass'; f.frequency.value = n.pitch < 40 ? 200 : 5000; s.connect(f); f.connect(g); s.start(st); s.stop(st + 0.2) }
                else { const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = 440 * 2 ** ((n.pitch - 69) / 12); o.connect(g); o.start(st); o.stop(en + 0.3) }
            }
            timer = setTimeout(stop, (m.duration + 1) * 1000)
        }
        ctx.cleanups.push(stop)
    }
    const text = m.lyrics.join('').replace(/[\\/]/g, '\n').replace(/\r/g, '\n').trim() || m.tracks[0]?.text.join('\n')
    if (text) wrap.insertAdjacentHTML('beforeend', `<h3>Текст</h3><div class="ur-mail-text">${esc(text).replace(/\n/g, '<br>')}</div>`)
    return wrap
}

// ================= MusicXML =================
export const musicxmlView = async (ctx, buf, ext) => {
    const { OpenSheetMusicDisplay } = await ctx.loadLib('osmd')
    const box = document.createElement('div'); box.className = 'ur-osmd'
    const u8 = new Uint8Array(buf)
    const content = u8[0] === 0x50 && u8[1] === 0x4B ? Array.from(u8, b => String.fromCharCode(b)).join('') : decodeText(u8)
    requestAnimationFrame(async () => {
        try {
            const osmd = new OpenSheetMusicDisplay(box, { autoResize: true, backend: 'svg', drawTitle: true, darkMode: ctx.isDark() })
            await osmd.load(content)
            osmd.render()
            ctx.cleanups.push(() => { try { osmd.clear() } catch { /* ignore */ } })
        } catch (e) { box.textContent = 'Не удалось показать ноты: ' + (e?.message || e) }
    })
    return box
}

// ================= HWP =================
export const hwpView = async (ctx, buf) => {
    const { Viewer } = await ctx.loadLib('hwp')
    const box = document.createElement('div'); box.className = 'ur-hwp'
    try { new Viewer(box, new Uint8Array(buf), { type: 'array' }) } catch (e) { throw new ReaderError('Не удалось прочитать документ HWP (поддерживается HWP 5): ' + (e?.message || e)) }
    return box
}

// ================= Программы Windows (EXE, DLL) =================
const MACHINES = { 0x14c: 'x86 (32 бит)', 0x8664: 'x64 (64 бит)', 0xaa64: 'ARM64', 0x1c0: 'ARM', 0x1c4: 'ARM (Thumb-2)', 0x200: 'Itanium' }
export const peView = (ctx, buf) => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    if (u8[0] !== 0x4D || u8[1] !== 0x5A) throw new ReaderError('Это не программа Windows.')
    const pe = dv.getUint32(0x3C, true)
    if (pe + 24 > u8.length || latin.decode(u8.subarray(pe, pe + 4)) !== 'PE\0\0') {
        const ne = latin.decode(u8.subarray(pe, pe + 2))
        throw new ReaderError(ne === 'NE' ? 'Это 16-битная программа Windows 3.x — сведения о ней не показываются.' : 'Это программа для DOS.')
    }
    const machine = dv.getUint16(pe + 4, true), nsec = dv.getUint16(pe + 6, true), stamp = dv.getUint32(pe + 8, true), optSize = dv.getUint16(pe + 20, true), chars = dv.getUint16(pe + 22, true)
    const opt = pe + 24, magic = dv.getUint16(opt, true), plus = magic === 0x20B
    const subsystem = dv.getUint16(opt + 68, true)
    const ddOff = opt + (plus ? 112 : 96), ndd = dv.getUint32(opt + (plus ? 108 : 92), true)
    const dd = i => i < ndd ? [dv.getUint32(ddOff + i * 8, true), dv.getUint32(ddOff + i * 8 + 4, true)] : [0, 0]
    const secs = []
    for (let i = 0; i < nsec; i++) { const s = opt + optSize + i * 40; secs.push({ name: latin.decode(u8.subarray(s, s + 8)).replace(/\0.*/, ''), vsize: dv.getUint32(s + 8, true), va: dv.getUint32(s + 12, true), rsize: dv.getUint32(s + 16, true), raw: dv.getUint32(s + 20, true) }) }
    const rva = r => { for (const s of secs) if (r >= s.va && r < s.va + Math.max(s.vsize, s.rsize)) return r - s.va + s.raw; return -1 }
    const cstr = o => { let e = o; while (e < u8.length && u8[e]) e++; return latin.decode(u8.subarray(o, e)) }
    // импорт
    const imports = []
    const [impRva] = dd(1)
    if (impRva) { let o = rva(impRva); while (o > 0 && o + 20 <= u8.length && imports.length < 200) { const nameRva = dv.getUint32(o + 12, true); if (!nameRva) break; const n = rva(nameRva); if (n > 0) imports.push(cstr(n)); o += 20 } }
    // ресурсы
    const [resRva] = dd(2)
    const resBase = resRva ? rva(resRva) : -1
    const res = {}
    const readDir = (o, depth, path) => {
        const named = dv.getUint16(o + 12, true), ids = dv.getUint16(o + 14, true)
        for (let i = 0; i < named + ids; i++) {
            const e = o + 16 + i * 8
            const id = dv.getUint32(e, true), off = dv.getUint32(e + 4, true)
            const key = id & 0x80000000 ? 'n' + i : id
            if (off & 0x80000000) { if (depth < 2) readDir(resBase + (off & 0x7FFFFFFF), depth + 1, [...path, key]) }
            else { const d = resBase + off; const [type, name] = path; ((res[type] ??= {})[name ?? key] ??= []).push({ rva: dv.getUint32(d, true), size: dv.getUint32(d + 4, true) }) }
        }
    }
    if (resBase > 0) { try { readDir(resBase, 0, []) } catch (e) { console.warn('[Читалка] ресурсы PE', e) } }
    const resData = r => { const o = rva(r.rva); return o >= 0 ? u8.subarray(o, o + r.size) : null }
    // сведения о версии
    const ver = {}
    const vRes = res[16] && Object.values(res[16])[0]?.[0]
    if (vRes) {
        const d = resData(vRes)
        if (d) {
            const s = new TextDecoder('utf-16le').decode(d)
            for (const k of ['CompanyName', 'FileDescription', 'FileVersion', 'ProductName', 'ProductVersion', 'LegalCopyright', 'OriginalFilename', 'InternalName', 'Comments']) {
                const i = s.indexOf(k + '\0')
                if (i >= 0) { let j = i + k.length + 1; while (s[j] === '\0') j++; const v = s.slice(j, s.indexOf('\0', j)); if (v) ver[k] = v }
            }
        }
    }
    // значок: собираем .ico из группы значков
    let icoUrl = null
    const grp = res[14] && Object.values(res[14])[0]?.[0]
    if (grp && res[3]) {
        const g = resData(grp)
        if (g) {
            const gd = new DataView(g.buffer, g.byteOffset, g.byteLength)
            const n = gd.getUint16(4, true)
            const imgs = []
            for (let i = 0; i < n; i++) { const e = 6 + i * 14; const id = gd.getUint16(e + 12, true); const r = res[3][id]?.[0]; const data = r && resData(r); if (data) imgs.push({ head: g.subarray(e, e + 8), data }) }
            if (imgs.length) {
                const total = 6 + imgs.length * 16 + imgs.reduce((s, x) => s + x.data.length, 0)
                const ico = new Uint8Array(total), id2 = new DataView(ico.buffer)
                id2.setUint16(2, 1, true); id2.setUint16(4, imgs.length, true)
                let off = 6 + imgs.length * 16
                imgs.forEach((im, i) => { ico.set(im.head, 6 + i * 16); id2.setUint32(6 + i * 16 + 8, im.data.length, true); id2.setUint32(6 + i * 16 + 12, off, true); ico.set(im.data, off); off += im.data.length })
                icoUrl = URL.createObjectURL(new Blob([ico], { type: 'image/x-icon' })); ctx.urls.push(icoUrl)
            }
        }
    }
    const isDll = !!(chars & 0x2000)
    const dotnet = dd(14)[0] !== 0
    const signed = dd(4)[0] !== 0
    const facts = [
        ['Описание', ver.FileDescription], ['Продукт', ver.ProductName], ['Компания', ver.CompanyName], ['Версия файла', ver.FileVersion], ['Версия продукта', ver.ProductVersion],
        ['Права', ver.LegalCopyright], ['Исходное имя', ver.OriginalFilename], ['Комментарий', ver.Comments],
        ['Тип', isDll ? 'Библиотека (DLL)' : subsystem === 2 ? 'Программа с окнами' : subsystem === 3 ? 'Консольная программа' : subsystem === 1 ? 'Драйвер' : 'Программа'],
        ['Платформа', (MACHINES[machine] || '0x' + machine.toString(16)) + (dotnet ? ', .NET' : '')],
        ['Собрана', stamp > 0x20000000 && stamp < 0x7FFFFFFF ? new Date(stamp * 1000).toLocaleString('ru-RU') : ''],
        ['Цифровая подпись', signed ? 'есть (проверить её здесь нельзя)' : 'нет'],
        ['Размер', fmtSize(u8.length)],
    ].filter(x => x[1])
    return `<div class="ur-pe-head">${icoUrl ? `<img src="${icoUrl}" class="ur-pe-icon">` : '<div class="ur-shortcut-icon">⚙️</div>'}<h2>${esc(ver.FileDescription || ver.ProductName || ctx.file?.name || 'Программа')}</h2></div>
        <table class="ur-font-facts">${facts.map(([k, v]) => `<tr><td class="ur-muted">${k}</td><td>${esc(v)}</td></tr>`).join('')}</table>
        <p class="ur-muted">Читалка только показывает сведения о файле и никогда его не запускает.</p>
        ${imports.length ? `<details><summary>Использует библиотеки (${imports.length})</summary><ul>${imports.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
        <details><summary>Разделы (${secs.length})</summary><table class="ur-arc-table"><tbody>${secs.map(s => `<tr><td>${esc(s.name)}</td><td>${fmtSize(s.rsize)}</td></tr>`).join('')}</tbody></table></details>`
}

// ================= Tilt Brush / Open Brush (.tilt): мазки в объёме =================
export const tiltObject = (THREE, buf) => {
    const u8 = new Uint8Array(buf)
    let zip = u8
    if (new TextDecoder('latin1').decode(u8.subarray(0, 4)) === 'tilT') zip = u8.subarray(new DataView(buf).getUint16(4, true))
    const sk = zipEntry(zip, 'data.sketch')
    if (!sk) throw new ReaderError('В рисунке Tilt Brush нет мазков (data.sketch).')
    const dv = new DataView(sk.buffer, sk.byteOffset, sk.byteLength)
    let p = 0
    const u32 = () => { const v = dv.getUint32(p, true); p += 4; return v }, i32 = () => { const v = dv.getInt32(p, true); p += 4; return v }, f32 = () => { const v = dv.getFloat32(p, true); p += 4; return v }
    if (u32() !== 0xc576a5cd) throw new ReaderError('Неизвестная версия рисунка Tilt Brush.')
    u32(); u32(); const extra = u32(); p += extra
    const nStrokes = i32()
    const pos = [], col = []
    const bits = m => { let n = 0; while (m) { n += m & 1; m >>>= 1 } return n }
    for (let s = 0; s < nStrokes && p < sk.length; s++) {
        i32(); const c = [f32(), f32(), f32(), f32()]; f32()
        const sMask = u32(), cpMask = u32()
        p += bits(sMask) * 4 // расширения мазка: флаги, масштаб, группа, зерно — по 4 байта
        const n = i32()
        let prev = null
        for (let k = 0; k < n; k++) {
            const x = f32(), y = f32(), z = f32(); p += 16 + bits(cpMask) * 4
            if (prev) { pos.push(...prev, x, y, z); col.push(c[0], c[1], c[2], c[0], c[1], c[2]) }
            prev = [x, y, z]
        }
    }
    if (!pos.length) throw new ReaderError('В рисунке Tilt Brush нет мазков.')
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }))
}
// простой поиск файла в zip без сжатия или с deflate (синхронно)
const zipEntry = (u8, name) => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    for (let i = u8.length - 22; i >= 0 && i > u8.length - 70000; i--) {
        if (dv.getUint32(i, true) !== 0x06054b50) continue
        let p = dv.getUint32(i + 16, true); const n = dv.getUint16(i + 10, true)
        for (let k = 0; k < n; k++) {
            const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true)
            const nm = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl))
            if (nm === name) { const lo = dv.getUint32(p + 42, true), method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true); const ds = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true); const raw = u8.subarray(ds, ds + size); return method === 0 ? raw : inflateSyncRaw(raw) }
            p += 46 + nl + el + cl
        }
    }
    return null
}
