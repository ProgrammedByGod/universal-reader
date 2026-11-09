// Наброски: Excalidraw (.excalidraw) и tldraw (.tldr) — свой рисунок в SVG с «рисованными» линиями (roughjs)
import { escapeHtml as esc, ReaderError } from '../util.js'
import { panZoom } from './graphics.js'

const SVGNS = 'http://www.w3.org/2000/svg'
const num = v => Number.isFinite(+v) ? +(+v).toFixed(2) : 0

// Общая часть: превращаем фигуры roughjs в строки <path>
const makeDrawer = rough => {
    const gen = rough.generator()
    const paths = (drawable, extra = '') => gen.toPaths(drawable).map(p => `<path d="${p.d}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" fill="${p.fill || 'none'}"${extra}/>`).join('')
    return { gen, paths }
}
const textBlock = ({ x, y, w, h, text, size, color, align = 'left', valign = 'top', font, lineHeight = 1.25 }) => {
    const lines = String(text ?? '').split('\n')
    const lh = size * lineHeight
    const total = lines.length * lh
    const top = valign === 'middle' ? y + (h - total) / 2 : valign === 'bottom' ? y + h - total : y
    const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'
    const tx = align === 'center' ? x + w / 2 : align === 'right' ? x + w : x
    return `<text x="${num(tx)}" y="${num(top)}" font-size="${num(size)}" fill="${color}" text-anchor="${anchor}" font-family="${font}" dominant-baseline="hanging">${lines.map((l, i) => `<tspan x="${num(tx)}" dy="${i ? num(lh) : 0}">${esc(l) || ' '}</tspan>`).join('')}</text>`
}
const bounds = () => {
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
    b.add = (x, y) => { if (!Number.isFinite(x) || !Number.isFinite(y)) return; b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y) }
    return b
}
const arrowHead = (from, to, kind, color, sw) => {
    if (!kind || kind === 'none') return ''
    const a = Math.atan2(to[1] - from[1], to[0] - from[0])
    const len = Math.max(10, sw * 6)
    const p1 = [to[0] - len * Math.cos(a - 0.45), to[1] - len * Math.sin(a - 0.45)]
    const p2 = [to[0] - len * Math.cos(a + 0.45), to[1] - len * Math.sin(a + 0.45)]
    if (kind === 'triangle' || kind === 'triangle_outline') return `<polygon points="${to.map(num)} ${p1.map(num)} ${p2.map(num)}" fill="${kind === 'triangle' ? color : 'none'}" stroke="${color}" stroke-width="${sw}"/>`
    if (kind === 'dot' || kind === 'circle' || kind === 'circle_outline') return `<circle cx="${num(to[0])}" cy="${num(to[1])}" r="${len / 3}" fill="${kind === 'circle_outline' ? 'none' : color}" stroke="${color}"/>`
    if (kind === 'bar') { const q1 = [to[0] + len / 2 * Math.sin(a), to[1] - len / 2 * Math.cos(a)], q2 = [to[0] - len / 2 * Math.sin(a), to[1] + len / 2 * Math.cos(a)]; return `<line x1="${num(q1[0])}" y1="${num(q1[1])}" x2="${num(q2[0])}" y2="${num(q2[1])}" stroke="${color}" stroke-width="${sw}"/>` }
    return `<polyline points="${p1.map(num)} ${to.map(num)} ${p2.map(num)}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`
}
const freehand = (pts, color, sw, opacity = 1) => pts.length ? `<path d="M${pts.map(p => p.map(num).join(' ')).join(' L')}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"/>` : ''
const finish = (svgBody, b, bg, title) => {
    if (!Number.isFinite(b.x0)) return null
    const pad = 30
    return `<svg xmlns="${SVGNS}" class="ur-diagram ur-sketch" viewBox="${num(b.x0 - pad)} ${num(b.y0 - pad)} ${num(b.x1 - b.x0 + 2 * pad)} ${num(b.y1 - b.y0 + 2 * pad)}" style="max-width:${num(b.x1 - b.x0 + 2 * pad)}px;background:${bg}">${title ? `<title>${esc(title)}</title>` : ''}${svgBody}</svg>`
}
const mount = (sections) => {
    const wrap = document.createElement('div')
    for (const { title, svg } of sections) {
        const sec = document.createElement('section')
        if (sections.length > 1) sec.insertAdjacentHTML('beforeend', `<h2>${esc(title)}</h2>`)
        if (svg) {
            const box = document.createElement('div'); box.className = 'ur-diagram-box ur-sketch-box'; box.innerHTML = svg
            sec.append(box); panZoom(box.querySelector('svg'), sec)
        } else sec.insertAdjacentHTML('beforeend', '<p class="ur-muted">Пустая страница.</p>')
        wrap.append(sec)
    }
    return wrap
}

// ================= Excalidraw =================
const EX_FONTS = { 1: '"Virgil", "Comic Sans MS", "Segoe Print", cursive', 2: 'Helvetica, Arial, sans-serif', 3: '"Cascadia Code", Consolas, monospace', 5: '"Excalifont", "Comic Sans MS", cursive', 6: '"Nunito", sans-serif', 7: '"Lilita One", sans-serif', 8: '"Comic Shanns", monospace' }
export const excalidrawView = async (ctx, text) => {
    let j
    try { j = JSON.parse(text) } catch (e) { throw new ReaderError('Файл Excalidraw повреждён: ' + e.message) }
    if (j.type !== 'excalidraw' && !Array.isArray(j.elements)) throw new ReaderError('Это не рисунок Excalidraw.')
    const { rough } = await ctx.loadLib('rough')
    const { gen, paths } = makeDrawer(rough)
    const els = (j.elements || []).filter(e => !e.isDeleted)
    const byId = new Map(els.map(e => [e.id, e]))
    const files = j.files || {}
    const b = bounds()
    let out = ''
    for (const e of els) {
        const x = +e.x || 0, y = +e.y || 0, w = +e.width || 0, h = +e.height || 0
        const color = e.strokeColor && e.strokeColor !== 'transparent' ? e.strokeColor : '#1e1e1e'
        const fill = e.backgroundColor && e.backgroundColor !== 'transparent' ? e.backgroundColor : undefined
        const sw = +e.strokeWidth || 1
        const opt = { stroke: color, strokeWidth: sw, roughness: e.roughness ?? 1, seed: e.seed || 1, fill, fillStyle: e.fillStyle === 'cross-hatch' ? 'cross-hatch' : e.fillStyle === 'solid' ? 'solid' : e.fillStyle === 'zigzag' ? 'zigzag' : 'hachure',
            strokeLineDash: e.strokeStyle === 'dashed' ? [8, 8 + sw] : e.strokeStyle === 'dotted' ? [1.5, 6 + sw] : undefined, hachureGap: sw * 4, fillWeight: sw / 2, disableMultiStroke: e.strokeStyle !== 'solid' }
        const cx = x + w / 2, cy = y + h / 2
        const rot = e.angle ? ` transform="rotate(${num(e.angle * 180 / Math.PI)} ${num(cx)} ${num(cy)})"` : ''
        const op = e.opacity != null && e.opacity < 100 ? ` opacity="${e.opacity / 100}"` : ''
        let s = ''
        switch (e.type) {
            case 'rectangle': case 'embeddable': case 'iframe':
                s = paths(e.roundness ? gen.path(roundRect(x, y, w, h, Math.min(w, h) * 0.25), opt) : gen.rectangle(x, y, w, h, opt)); break
            case 'diamond': s = paths(gen.polygon([[cx, y], [x + w, cy], [cx, y + h], [x, cy]], opt)); break
            case 'ellipse': s = paths(gen.ellipse(cx, cy, w, h, opt)); break
            case 'line': case 'arrow': {
                const pts = (e.points || []).map(p => [x + p[0], y + p[1]])
                if (pts.length < 2) break
                const closed = e.type === 'line' && pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1
                s = paths(e.roundness && pts.length > 2 ? gen.curve(pts, { ...opt, fill: closed ? fill : undefined }) : closed ? gen.polygon(pts, opt) : gen.linearPath(pts, { ...opt, fill: undefined }))
                if (e.type === 'arrow') {
                    s += arrowHead(pts[pts.length - 2], pts[pts.length - 1], e.endArrowhead === undefined ? 'arrow' : e.endArrowhead, color, sw)
                    s += arrowHead(pts[1], pts[0], e.startArrowhead, color, sw)
                }
                pts.forEach(p => b.add(p[0], p[1]))
                break
            }
            case 'freedraw': { const pts = (e.points || []).map(p => [x + p[0], y + p[1]]); s = freehand(pts, color, sw * 1.6); pts.forEach(p => b.add(p[0], p[1])); break }
            case 'text': {
                const cont = e.containerId && byId.get(e.containerId)
                s = textBlock({ x, y, w, h, text: e.text ?? e.originalText, size: +e.fontSize || 20, color, align: e.textAlign || 'left', valign: 'top', font: EX_FONTS[e.fontFamily] || EX_FONTS[1], lineHeight: +e.lineHeight || 1.25 })
                if (cont) b.add(cont.x, cont.y)
                break
            }
            case 'image': {
                const f = files[e.fileId]
                s = f?.dataURL ? `<image href="${esc(f.dataURL)}" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" preserveAspectRatio="none"/>` : paths(gen.rectangle(x, y, w, h, { ...opt, strokeLineDash: [6, 6] }))
                break
            }
            case 'frame': case 'magicframe':
                s = `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="8" fill="none" stroke="#bbb" stroke-dasharray="6 4"/><text x="${num(x)}" y="${num(y - 6)}" font-size="14" fill="#888" font-family="sans-serif">${esc(e.name || 'Фрейм')}</text>`
                break
        }
        if (!s) continue
        if (!['line', 'arrow', 'freedraw'].includes(e.type)) { b.add(x, y); b.add(x + w, y + h) }
        out += `<g${rot}${op}>${s}</g>`
    }
    const bg = j.appState?.viewBackgroundColor || '#ffffff'
    return mount([{ title: '', svg: finish(out, b, bg) }])
}
const roundRect = (x, y, w, h, r) => { r = Math.min(r, 32); return `M${x + r} ${y} L${x + w - r} ${y} Q${x + w} ${y} ${x + w} ${y + r} L${x + w} ${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} L${x + r} ${y + h} Q${x} ${y + h} ${x} ${y + h - r} L${x} ${y + r} Q${x} ${y} ${x + r} ${y}` }

// ================= tldraw =================
const TL_COLORS = { black: '#1d1d1d', grey: '#9fa8b2', gray: '#9fa8b2', 'light-violet': '#e085f4', violet: '#ae3ec9', blue: '#4465e9', 'light-blue': '#4ba1f1', yellow: '#f1ac4b', orange: '#e16919', green: '#099268', 'light-green': '#4cb05e', 'light-red': '#f87777', red: '#e03131', white: '#ffffff',
    lightGray: '#ced4da', cyan: '#15aabf', indigo: '#4263eb' }
const TL_STROKE = { s: 2, m: 3.5, l: 5, xl: 10, small: 2, medium: 3.5, large: 5 }
const TL_FONT = { s: 18, m: 24, l: 36, xl: 44, small: 18, medium: 24, large: 36 }
const TL_FAMILY = { draw: '"Shantell Sans", "Comic Sans MS", cursive', sans: 'Inter, Helvetica, Arial, sans-serif', serif: 'Georgia, serif', mono: '"IBM Plex Mono", monospace', script: 'cursive' }
const richToText = rt => {
    if (!rt) return ''
    if (typeof rt === 'string') return rt
    const walk = n => n.type === 'text' ? (n.text || '') : (n.content || []).map(walk).join(n.type === 'doc' ? '\n' : n.type === 'bulletList' || n.type === 'orderedList' ? '\n' : '')
    return walk(rt)
}
const lighten = hex => { const n = parseInt(hex.slice(1), 16); const m = c => Math.round(c + (255 - c) * 0.75); return `rgb(${m(n >> 16)},${m((n >> 8) & 255)},${m(n & 255)})` }
const polygonOf = (geo, x, y, w, h) => {
    const cx = x + w / 2, cy = y + h / 2
    switch (geo) {
        case 'diamond': case 'rhombus-2': return [[cx, y], [x + w, cy], [cx, y + h], [x, cy]]
        case 'triangle': return [[cx, y], [x + w, y + h], [x, y + h]]
        case 'rhombus': return [[x + w * 0.25, y], [x + w, y], [x + w * 0.75, y + h], [x, y + h]]
        case 'trapezoid': return [[x + w * 0.2, y], [x + w * 0.8, y], [x + w, y + h], [x, y + h]]
        case 'hexagon': return [[x + w * 0.25, y], [x + w * 0.75, y], [x + w, cy], [x + w * 0.75, y + h], [x + w * 0.25, y + h], [x, cy]]
        case 'pentagon': return Array.from({ length: 5 }, (_, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / 5; return [cx + w / 2 * Math.cos(a), cy + h / 2 * Math.sin(a)] })
        case 'octagon': return Array.from({ length: 8 }, (_, i) => { const a = Math.PI / 8 + i * Math.PI / 4; return [cx + w / 2 * Math.cos(a), cy + h / 2 * Math.sin(a)] })
        case 'star': return Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 0.4 : 1; return [cx + w / 2 * r * Math.cos(a), cy + h / 2 * r * Math.sin(a)] })
        case 'arrow-right': return [[x, y + h * 0.25], [x + w * 0.6, y + h * 0.25], [x + w * 0.6, y], [x + w, cy], [x + w * 0.6, y + h], [x + w * 0.6, y + h * 0.75], [x, y + h * 0.75]]
        case 'arrow-left': return [[x + w, y + h * 0.25], [x + w * 0.4, y + h * 0.25], [x + w * 0.4, y], [x, cy], [x + w * 0.4, y + h], [x + w * 0.4, y + h * 0.75], [x + w, y + h * 0.75]]
        case 'arrow-up': return [[x + w * 0.25, y + h], [x + w * 0.25, y + h * 0.4], [x, y + h * 0.4], [cx, y], [x + w, y + h * 0.4], [x + w * 0.75, y + h * 0.4], [x + w * 0.75, y + h]]
        case 'arrow-down': return [[x + w * 0.25, y], [x + w * 0.25, y + h * 0.6], [x, y + h * 0.6], [cx, y + h], [x + w, y + h * 0.6], [x + w * 0.75, y + h * 0.6], [x + w * 0.75, y]]
    }
    return null
}

// Приводим старый формат tldraw 1.x к общему виду
const fromV1 = j => {
    const pages = Object.values(j.document?.pages || {}).sort((a, b) => (a.childIndex ?? 0) - (b.childIndex ?? 0))
    return pages.map(p => ({
        title: p.name || 'Страница',
        shapes: Object.values(p.shapes || {}).sort((a, b) => (a.childIndex ?? 0) - (b.childIndex ?? 0)).map(s => {
            const [x, y] = s.point || [0, 0]
            const st = s.style || {}
            // в tldraw 1.x «white» — это цвет линий по умолчанию (тёмный на светлом фоне)
            const base = { x, y, rotation: s.rotation || 0, color: st.color === 'white' ? 'black' : st.color, size: st.size, fill: st.isFilled ? 'semi' : 'none', dash: st.dash }
            switch (s.type) {
                case 'rectangle': return { ...base, kind: 'geo', geo: 'rectangle', w: s.size[0], h: s.size[1], text: s.label }
                case 'triangle': return { ...base, kind: 'geo', geo: 'triangle', w: s.size[0], h: s.size[1], text: s.label }
                case 'ellipse': return { ...base, kind: 'geo', geo: 'ellipse', w: s.radius[0] * 2, h: s.radius[1] * 2, text: s.label }
                case 'sticky': return { ...base, kind: 'note', w: s.size?.[0] || 200, h: s.size?.[1] || 200, text: s.text }
                case 'text': return { ...base, kind: 'text', text: s.text }
                case 'arrow': return { ...base, kind: 'arrow', start: s.handles.start.point, end: s.handles.end.point, bend: s.bend || 0, headEnd: s.decorations?.end ? 'arrow' : 'none', headStart: s.decorations?.start ? 'arrow' : 'none', text: s.label }
                case 'draw': return { ...base, kind: 'draw', lines: [s.points.map(p => [p[0], p[1]])] }
                default: return null
            }
        }).filter(Boolean),
    }))
}
// Новые форматы tldraw 2.x–3.x (records)
const fromRecords = j => {
    const recs = j.records || []
    const byId = new Map(recs.map(r => [r.id, r]))
    const pages = recs.filter(r => r.typeName === 'page').sort((a, b) => String(a.index).localeCompare(String(b.index)))
    const shapes = recs.filter(r => r.typeName === 'shape')
    const bindings = recs.filter(r => r.typeName === 'binding' && r.type === 'arrow')
    // абсолютные координаты с учётом родителей (фреймы, группы)
    const absCache = new Map()
    const abs = s => {
        if (absCache.has(s.id)) return absCache.get(s.id)
        const parent = byId.get(s.parentId)
        let r = { x: s.x || 0, y: s.y || 0 }
        if (parent?.typeName === 'shape') {
            const p = abs(parent), a = parent.rotation || 0
            r = { x: p.x + r.x * Math.cos(a) - r.y * Math.sin(a), y: p.y + r.x * Math.sin(a) + r.y * Math.cos(a) }
        }
        absCache.set(s.id, r)
        return r
    }
    const pageOf = s => { let cur = s; while (cur && cur.typeName === 'shape') cur = byId.get(cur.parentId); return cur?.id }
    const sizeOf = s => ({ w: s.props?.w ?? 0, h: s.props?.h ?? (s.type === 'note' ? 200 : 0) })
    const anchorPoint = (shapeId, na) => { const t = byId.get(shapeId); if (!t) return null; const p = abs(t); const { w, h } = sizeOf(t); const nx = na?.x ?? 0.5, ny = na?.y ?? 0.5; return [p.x + nx * (w || 0), p.y + ny * (h || (t.type === 'note' ? 200 : 0))] }
    const asset = id => byId.get(id)?.props?.src
    return pages.map(pg => ({
        title: pg.name || 'Страница',
        shapes: shapes.filter(s => pageOf(s) === pg.id).sort((a, b) => String(a.index).localeCompare(String(b.index))).map(s => {
            const p = s.props || {}
            const a = abs(s)
            const base = { x: a.x, y: a.y, rotation: s.rotation || 0, color: p.color, size: p.size, fill: p.fill, dash: p.dash, font: p.font, opacity: +(p.opacity ?? s.opacity ?? 1) }
            const text = p.richText ? richToText(p.richText) : p.text
            switch (s.type) {
                case 'geo': return { ...base, kind: 'geo', geo: p.geo, w: p.w, h: p.h + (p.growY || 0), text, align: p.align, valign: p.verticalAlign, labelColor: p.labelColor }
                case 'note': return { ...base, kind: 'note', w: 200 * (p.scale || 1), h: (200 + (p.growY || 0)) * (p.scale || 1), text, align: p.align }
                case 'text': return { ...base, kind: 'text', text, w: p.w, align: p.textAlign || p.align, scale: p.scale }
                case 'frame': return { ...base, kind: 'frame', w: p.w, h: p.h, name: p.name }
                case 'image': case 'video': return { ...base, kind: 'image', w: p.w, h: p.h, src: asset(p.assetId) }
                case 'line': {
                    const pts = Array.isArray(p.points) ? p.points : Object.values(p.points || p.handles || {}).sort((u, v) => String(u.index).localeCompare(String(v.index)))
                    return { ...base, kind: 'line', pts: pts.map(q => [a.x + q.x, a.y + q.y]), spline: p.spline }
                }
                case 'draw': case 'highlight': {
                    const lines = (p.segments || []).map(seg => Array.isArray(seg.points) ? seg.points.map(q => [a.x + q.x, a.y + q.y]) : []).filter(l => l.length)
                    return { ...base, kind: 'draw', lines, highlight: s.type === 'highlight', closed: p.isClosed }
                }
                case 'arrow': {
                    const end = term => {
                        const t = p[term]
                        const bnd = bindings.find(x => x.fromId === s.id && x.props?.terminal === term)
                        if (bnd) return anchorPoint(bnd.toId, bnd.props.normalizedAnchor)
                        if (t?.type === 'binding') return anchorPoint(t.boundShapeId, t.normalizedAnchor)
                        if (t && Number.isFinite(t.x)) return [a.x + t.x, a.y + t.y]
                        return null
                    }
                    return { ...base, kind: 'arrow', absStart: end('start'), absEnd: end('end'), bend: p.bend || 0, headEnd: p.arrowheadEnd ?? 'arrow', headStart: p.arrowheadStart ?? 'none', text, labelColor: p.labelColor }
                }
            }
            return null
        }).filter(Boolean),
    }))
}
export const tldrView = async (ctx, text) => {
    let j
    try { j = JSON.parse(text) } catch (e) { throw new ReaderError('Файл tldraw повреждён: ' + e.message) }
    const pages = j.records ? fromRecords(j) : j.document ? fromV1(j) : null
    if (!pages) throw new ReaderError('Это не рисунок tldraw (или неизвестная версия формата).')
    const { rough } = await ctx.loadLib('rough')
    const { gen, paths } = makeDrawer(rough)
    const sections = pages.map(pg => {
        const b = bounds()
        let out = ''
        for (const s of pg.shapes) {
            const color = TL_COLORS[s.color] || TL_COLORS.black
            const sw = TL_STROKE[s.size] || 2
            const fs = TL_FONT[s.size] || 24
            const font = TL_FAMILY[s.font] || TL_FAMILY.draw
            const fillColor = s.fill === 'solid' ? lighten(color) : s.fill === 'semi' ? '#f5f5f5' : s.fill === 'pattern' ? color : s.fill === 'fill' ? color : undefined
            const opt = { stroke: color, strokeWidth: sw, roughness: s.dash === 'draw' ? 1.2 : 0, seed: 7, fill: fillColor, fillStyle: s.fill === 'pattern' ? 'hachure' : 'solid', hachureGap: 8, strokeLineDash: s.dash === 'dashed' ? [sw * 3, sw * 3] : s.dash === 'dotted' ? [1, sw * 3] : undefined, disableMultiStroke: true }
            let g = ''
            const { x, y } = s
            const w = s.w || 0, h = s.h || 0
            const rot = s.rotation ? ` transform="rotate(${num(s.rotation * 180 / Math.PI)} ${num(x)} ${num(y)})"` : ''
            switch (s.kind) {
                case 'geo': {
                    const poly = polygonOf(s.geo, x, y, w, h)
                    if (s.geo === 'ellipse' || s.geo === 'oval') g = paths(gen.ellipse(x + w / 2, y + h / 2, w, h, opt))
                    else if (s.geo === 'cloud') g = paths(gen.ellipse(x + w / 2, y + h / 2, w, h, { ...opt, roughness: 2.5 }))
                    else if (poly) g = paths(gen.polygon(poly, opt))
                    else { g = paths(gen.rectangle(x, y, w, h, opt)); if (s.geo === 'x-box') g += paths(gen.line(x, y, x + w, y + h, opt)) + paths(gen.line(x + w, y, x, y + h, opt)); if (s.geo === 'check-box') g += paths(gen.linearPath([[x + w * 0.25, y + h * 0.5], [x + w * 0.45, y + h * 0.7], [x + w * 0.75, y + h * 0.3]], opt)) }
                    if (s.text) g += textBlock({ x: x + 8, y: y + 8, w: w - 16, h: h - 16, text: s.text, size: fs, color: TL_COLORS[s.labelColor] || color, align: s.align === 'start' ? 'left' : s.align === 'end' ? 'right' : 'center', valign: s.valign === 'start' ? 'top' : s.valign === 'end' ? 'bottom' : 'middle', font })
                    b.add(x, y); b.add(x + w, y + h)
                    break
                }
                case 'note': {
                    g = `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="4" fill="${lighten(color)}" stroke="none" filter="drop-shadow(0 2px 3px rgba(0,0,0,.2))"/>`
                    g += textBlock({ x: x + 14, y: y + 14, w: w - 28, h: h - 28, text: s.text, size: fs * 0.85, color: '#1d1d1d', align: s.align === 'start' ? 'left' : s.align === 'end' ? 'right' : 'center', valign: 'middle', font })
                    b.add(x, y); b.add(x + w, y + h)
                    break
                }
                case 'text': {
                    const size = fs * (s.scale || 1)
                    const lines = String(s.text || '').split('\n')
                    const tw = s.w || Math.max(...lines.map(l => l.length)) * size * 0.55
                    g = textBlock({ x, y, w: tw, h: lines.length * size * 1.35, text: s.text, size, color, align: s.align === 'middle' ? 'center' : s.align === 'end' ? 'right' : 'left', font, lineHeight: 1.35 })
                    b.add(x, y); b.add(x + tw, y + lines.length * size * 1.35)
                    break
                }
                case 'frame':
                    g = `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="#fff" stroke="#bbb"/><text x="${num(x)}" y="${num(y - 6)}" font-size="13" fill="#777" font-family="sans-serif">${esc(s.name || 'Фрейм')}</text>`
                    b.add(x, y - 20); b.add(x + w, y + h)
                    break
                case 'image':
                    g = s.src ? `<image href="${esc(s.src)}" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" preserveAspectRatio="none"/>` : `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="none" stroke="#bbb" stroke-dasharray="6 6"/>`
                    b.add(x, y); b.add(x + w, y + h)
                    break
                case 'line': if (s.pts.length > 1) { g = paths(s.spline === 'cubic' && s.pts.length > 2 ? gen.curve(s.pts, { ...opt, fill: undefined }) : gen.linearPath(s.pts, { ...opt, fill: undefined })); s.pts.forEach(p => b.add(...p)) } break
                case 'draw': for (const l of s.lines) { g += freehand(l, color, s.highlight ? sw * 6 : sw * 1.3, s.highlight ? 0.35 : 1); l.forEach(p => b.add(...p)) } break
                case 'arrow': {
                    let A = s.absStart, B = s.absEnd
                    if (!A && s.start) A = [x + s.start[0], y + s.start[1]]
                    if (!B && s.end) B = [x + s.end[0], y + s.end[1]]
                    if (!A || !B) break
                    const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2, len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1
                    const nx = -(B[1] - A[1]) / len, ny = (B[0] - A[0]) / len
                    const C = [mx + nx * s.bend, my + ny * s.bend]
                    const ctrl = [2 * C[0] - mx, 2 * C[1] - my]
                    g = s.bend ? `<path d="M${A.map(num).join(' ')} Q${ctrl.map(num).join(' ')} ${B.map(num).join(' ')}" fill="none" stroke="${color}" stroke-width="${sw}"${opt.strokeLineDash ? ` stroke-dasharray="${opt.strokeLineDash.join(' ')}"` : ''}/>` : paths(gen.line(A[0], A[1], B[0], B[1], { ...opt, fill: undefined }))
                    g += arrowHead(s.bend ? ctrl : A, B, s.headEnd, color, sw) + arrowHead(s.bend ? ctrl : B, A, s.headStart, color, sw)
                    if (s.text) g += textBlock({ x: C[0] - 100, y: C[1] - fs / 2, w: 200, h: fs, text: s.text, size: fs * 0.8, color: TL_COLORS[s.labelColor] || color, align: 'center', font })
                    b.add(...A); b.add(...B); b.add(...C)
                    break
                }
            }
            if (g) out += `<g${rot}${s.opacity < 1 ? ` opacity="${s.opacity}"` : ''}>${g}</g>`
        }
        return { title: pg.title, svg: finish(out, b, '#ffffff') }
    })
    return mount(sections)
}
