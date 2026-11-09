// Карты без интернета: GPX, KML/KMZ, GeoJSON/TopoJSON, Shapefile.
// Рисуем линии и точки на пустом фоне с координатной сеткой, считаем расстояние, время и перепад высот.
import JSZip from 'jszip'
import { escapeHtml as esc, decodeText, ReaderError } from '../util.js'
import { readDbf } from './datasets.js'
import { panZoom } from './graphics.js'

// Объект: { kind: 'point' | 'line' | 'poly', coords: [[lon, lat, ele?, time?]] | rings, name, desc, color, props }
const kids = (el, name) => Array.from(el?.children ?? []).filter(c => c.localName === name)
const kid = (el, name) => kids(el, name)[0]
const txt = (el, name) => kid(el, name)?.textContent?.trim() ?? ''

// ---------- GPX ----------
export const parseGpx = text => {
    const d = new DOMParser().parseFromString(text, 'application/xml')
    if (d.querySelector('parsererror')) throw new ReaderError('Файл GPX повреждён (ошибка XML).')
    const feats = []
    const pt = p => [+p.getAttribute('lon'), +p.getAttribute('lat'), kid(p, 'ele') ? +txt(p, 'ele') : undefined, kid(p, 'time') ? Date.parse(txt(p, 'time')) : undefined]
    for (const w of d.getElementsByTagName('wpt')) feats.push({ kind: 'point', coords: [pt(w)], name: txt(w, 'name'), desc: txt(w, 'desc') || txt(w, 'cmt') })
    for (const t of d.getElementsByTagName('trk')) {
        const segs = kids(t, 'trkseg').map(s => kids(s, 'trkpt').map(pt)).filter(s => s.length)
        for (const [i, s] of segs.entries()) feats.push({ kind: 'line', coords: s, name: txt(t, 'name') + (segs.length > 1 ? ` (часть ${i + 1})` : ''), desc: txt(t, 'desc'), track: true })
    }
    for (const r of d.getElementsByTagName('rte')) feats.push({ kind: 'line', coords: kids(r, 'rtept').map(pt), name: txt(r, 'name') || 'Маршрут', desc: txt(r, 'desc'), track: true })
    const meta = d.querySelector('metadata')
    return { feats, title: meta ? txt(meta, 'name') : '' }
}

// ---------- KML / KMZ ----------
const kmlColor = c => { if (!c || c.length !== 8) return null; return `#${c.slice(6, 8)}${c.slice(4, 6)}${c.slice(2, 4)}` }
export const parseKml = text => {
    const d = new DOMParser().parseFromString(text, 'application/xml')
    if (d.querySelector('parsererror')) throw new ReaderError('Файл KML повреждён (ошибка XML).')
    const styles = new Map()
    for (const s of d.getElementsByTagName('Style')) {
        const id = s.getAttribute('id'); if (!id) continue
        styles.set('#' + id, { line: kmlColor(s.querySelector('LineStyle > color')?.textContent?.trim()), poly: kmlColor(s.querySelector('PolyStyle > color')?.textContent?.trim()), icon: kmlColor(s.querySelector('IconStyle > color')?.textContent?.trim()) })
    }
    for (const m of d.getElementsByTagName('StyleMap')) {
        const id = m.getAttribute('id'); const pair = Array.from(m.getElementsByTagName('Pair')).find(p => txt(p, 'key') === 'normal')
        if (id && pair) styles.set('#' + id, styles.get(txt(pair, 'styleUrl')))
    }
    const coordsOf = el => (el?.textContent ?? '').trim().split(/\s+/).filter(Boolean).map(s => s.split(',').map(Number)).filter(c => c.length >= 2 && isFinite(c[0]) && isFinite(c[1]))
    const feats = []
    for (const pm of d.getElementsByTagName('Placemark')) {
        const name = txt(pm, 'name')
        const descHtml = kid(pm, 'description')?.textContent ?? ''
        const desc = new DOMParser().parseFromString(descHtml, 'text/html').body.textContent.trim()
        const st = styles.get(txt(pm, 'styleUrl')) ?? {}
        const folder = pm.parentElement?.localName === 'Folder' ? txt(pm.parentElement, 'name') : ''
        const walk = g => {
            switch (g.localName) {
                case 'Point': feats.push({ kind: 'point', coords: coordsOf(kid(g, 'coordinates')), name, desc, color: st.icon, folder }); break
                case 'LineString': case 'LinearRing': feats.push({ kind: 'line', coords: coordsOf(kid(g, 'coordinates')), name, desc, color: st.line, folder, track: true }); break
                case 'Polygon': { const outer = g.querySelector('outerBoundaryIs coordinates'); const inner = Array.from(g.querySelectorAll('innerBoundaryIs coordinates')); feats.push({ kind: 'poly', coords: [coordsOf(outer), ...inner.map(coordsOf)], name, desc, color: st.poly, stroke: st.line, folder }); break }
                case 'MultiGeometry': case 'MultiTrack': for (const c of g.children) walk(c); break
                case 'Track': {
                    const when = Array.from(g.getElementsByTagName('when')).map(w => Date.parse(w.textContent))
                    const pts = Array.from(g.getElementsByTagNameNS('*', 'coord')).map((c, i) => { const [lon, lat, ele] = c.textContent.trim().split(/\s+/).map(Number); return [lon, lat, ele, when[i]] })
                    feats.push({ kind: 'line', coords: pts, name, desc, color: st.line, folder, track: true }); break
                }
            }
        }
        for (const c of pm.children) walk(c)
    }
    return { feats, title: d.querySelector('Document > name')?.textContent?.trim() ?? '' }
}
export const kmzText = async buf => {
    const zip = await JSZip.loadAsync(buf)
    const name = Object.keys(zip.files).find(n => /(^|\/)doc\.kml$/i.test(n)) ?? Object.keys(zip.files).find(n => /\.kml$/i.test(n))
    if (!name) throw new ReaderError('В архиве KMZ нет файла KML.')
    return decodeText(await zip.file(name).async('uint8array'))
}

// ---------- GeoJSON / TopoJSON ----------
const fromGeometry = (g, base, out) => {
    if (!g) return
    const p = { ...base }
    switch (g.type) {
        case 'Point': out.push({ ...p, kind: 'point', coords: [g.coordinates] }); break
        case 'MultiPoint': for (const c of g.coordinates) out.push({ ...p, kind: 'point', coords: [c] }); break
        case 'LineString': out.push({ ...p, kind: 'line', coords: g.coordinates }); break
        case 'MultiLineString': for (const c of g.coordinates) out.push({ ...p, kind: 'line', coords: c }); break
        case 'Polygon': out.push({ ...p, kind: 'poly', coords: g.coordinates }); break
        case 'MultiPolygon': for (const c of g.coordinates) out.push({ ...p, kind: 'poly', coords: c }); break
        case 'GeometryCollection': for (const x of g.geometries) fromGeometry(x, base, out); break
    }
}
const nameOfProps = pr => pr ? String(pr.name ?? pr.NAME ?? pr.Name ?? pr.title ?? pr.label ?? pr.id ?? '') : ''
export const parseGeojson = text => {
    let j
    try { j = JSON.parse(text) } catch (e) { throw new ReaderError('Ошибка в JSON: ' + e.message) }
    const feats = []
    if (j.type === 'Topology') return parseTopojson(j)
    const add = f => fromGeometry(f.geometry, { name: nameOfProps(f.properties), props: f.properties, color: f.properties?.stroke || f.properties?.['marker-color'], fillColor: f.properties?.fill }, feats)
    if (j.type === 'FeatureCollection') j.features.forEach(add)
    else if (j.type === 'Feature') add(j)
    else fromGeometry(j, {}, feats)
    return { feats, title: j.name ?? '' }
}
const parseTopojson = topo => {
    const t = topo.transform
    const arcs = topo.arcs.map(arc => {
        let x = 0, y = 0
        return arc.map(p => t ? (x += p[0], y += p[1], [x * t.scale[0] + t.translate[0], y * t.scale[1] + t.translate[1]]) : p)
    })
    const arcCoords = idx => { const a = idx < 0 ? arcs[~idx].slice().reverse() : arcs[idx]; return a }
    const line = ids => ids.flatMap((i, k) => k ? arcCoords(i).slice(1) : arcCoords(i))
    const point = p => t ? [p[0] * t.scale[0] + t.translate[0], p[1] * t.scale[1] + t.translate[1]] : p
    const geom = g => {
        switch (g.type) {
            case 'Point': return { type: 'Point', coordinates: point(g.coordinates) }
            case 'MultiPoint': return { type: 'MultiPoint', coordinates: g.coordinates.map(point) }
            case 'LineString': return { type: 'LineString', coordinates: line(g.arcs) }
            case 'MultiLineString': return { type: 'MultiLineString', coordinates: g.arcs.map(line) }
            case 'Polygon': return { type: 'Polygon', coordinates: g.arcs.map(line) }
            case 'MultiPolygon': return { type: 'MultiPolygon', coordinates: g.arcs.map(p => p.map(line)) }
            case 'GeometryCollection': return { type: 'GeometryCollection', geometries: g.geometries.map(geom) }
        }
        return null
    }
    const feats = []
    for (const [name, obj] of Object.entries(topo.objects)) {
        const list = obj.type === 'GeometryCollection' ? obj.geometries : [obj]
        for (const g of list) fromGeometry(geom(g), { name: nameOfProps(g.properties), props: g.properties, folder: name }, feats)
    }
    return { feats, title: '' }
}

// ---------- Shapefile ----------
export const parseShp = (buf, dbfRows) => {
    const dv = new DataView(buf)
    if (dv.getInt32(0, false) !== 9994) throw new ReaderError('Это не файл Shapefile (.shp).')
    const feats = []
    let p = 100, n = 0
    const head = dbfRows?.[0]
    while (p + 8 <= buf.byteLength) {
        const len = dv.getInt32(p + 4, false) * 2
        const o = p + 8
        const type = dv.getInt32(o, true)
        const props = head && dbfRows[n + 1] ? Object.fromEntries(head.map((h, i) => [h, dbfRows[n + 1][i]])) : null
        const name = props ? nameOfProps(props) || Object.values(props).find(v => v && isNaN(+v)) || '' : ''
        const base = { props, name }
        const xy = (q, k) => [dv.getFloat64(q + k * 16, true), dv.getFloat64(q + k * 16 + 8, true)]
        if ([1, 11, 21].includes(type)) feats.push({ ...base, kind: 'point', coords: [xy(o + 4, 0)] })
        else if ([8, 18, 28].includes(type)) { const np = dv.getInt32(o + 36, true); for (let k = 0; k < np; k++) feats.push({ ...base, kind: 'point', coords: [xy(o + 40, k)] }) }
        else if ([3, 13, 23, 5, 15, 25].includes(type)) {
            const nparts = dv.getInt32(o + 36, true), npts = dv.getInt32(o + 40, true)
            const parts = Array.from({ length: nparts }, (_, k) => dv.getInt32(o + 44 + k * 4, true))
            const ptsOff = o + 44 + nparts * 4
            const rings = parts.map((s, k) => { const e = parts[k + 1] ?? npts; return Array.from({ length: e - s }, (_, i) => xy(ptsOff, s + i)) })
            if ([5, 15, 25].includes(type)) feats.push({ ...base, kind: 'poly', coords: rings })
            else for (const r of rings) feats.push({ ...base, kind: 'line', coords: r })
        }
        p = o + len; n++
    }
    return { feats, title: '' }
}

// ---------- расчёты ----------
const R = 6371008.8
const hav = (a, b) => { const r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r; const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)) }
const fmtKm = m => m >= 1000 ? `${(m / 1000).toFixed(m >= 100000 ? 0 : 2).replace('.', ',')} км` : `${Math.round(m)} м`
const fmtTime = ms => { const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} ч ${m} мин` : `${m} мин ${s % 60} с` }
const trackStats = (c, geo) => {
    let dist = 0, up = 0, down = 0
    for (let i = 1; i < c.length; i++) {
        dist += geo ? hav(c[i - 1], c[i]) : Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1])
        if (c[i][2] != null && c[i - 1][2] != null) { const d = c[i][2] - c[i - 1][2]; if (d > 0) up += d; else down -= d }
    }
    const times = c.map(x => x[3]).filter(Number.isFinite)
    const dur = times.length > 1 ? times[times.length - 1] - times[0] : 0
    const eles = c.map(x => x[2]).filter(Number.isFinite)
    return { dist, up, down, dur, minEle: eles.length ? Math.min(...eles) : null, maxEle: eles.length ? Math.max(...eles) : null, hasEle: eles.length > 1, start: times[0] }
}

// ---------- отрисовка ----------
const PALETTE = ['#e6194b', '#4363d8', '#3cb44b', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#469990', '#800000']
export const mapView = (ctx, { feats, title }) => {
    if (!feats.length) throw new ReaderError('В файле нет ни точек, ни линий.')
    const all = feats.flatMap(f => f.kind === 'poly' ? f.coords.flat() : f.coords)
    const geo = all.every(c => Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90)
    const proj = geo
        ? c => [c[0] * Math.PI / 180 * R, -Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, c[1])) * Math.PI / 360)) * R]
        : c => [c[0], -c[1]]
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const c of all) { const [x, y] = proj(c); if (!isFinite(x) || !isFinite(y)) continue; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
    let w = maxX - minX, h = maxY - minY
    if (!(w > 0) && !(h > 0)) { w = h = geo ? 2000 : 1; minX -= w / 2; minY -= h / 2 }
    w = w || h; h = h || w
    const pad = Math.max(w, h) * 0.06
    const vb = [minX - pad, minY - pad, w + 2 * pad, h + 2 * pad]
    const fg = ctx.themeColors().text
    const unit = Math.max(vb[2], vb[3]) / 800 // примерно 1 пиксель
    let svg = ''
    // сетка широт и долгот
    if (geo) {
        const [lon0, lat1] = [minX / R * 180 / Math.PI, (2 * Math.atan(Math.exp(-minY / R)) - Math.PI / 2) * 180 / Math.PI]
        const [lon1, lat0] = [maxX / R * 180 / Math.PI, (2 * Math.atan(Math.exp(-maxY / R)) - Math.PI / 2) * 180 / Math.PI]
        const span = Math.max(lon1 - lon0, lat1 - lat0)
        const step = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30].find(s => span / s < 8) ?? 30
        let grid = ''
        for (let lo = Math.floor(lon0 / step) * step; lo <= lon1 + step; lo += step) { const [x] = proj([lo, 0]); grid += `<line x1="${x}" y1="${vb[1]}" x2="${x}" y2="${vb[1] + vb[3]}"/><text x="${x + 3 * unit}" y="${vb[1] + vb[3] - 4 * unit}">${+lo.toFixed(4)}°</text>` }
        for (let la = Math.floor(lat0 / step) * step; la <= lat1 + step; la += step) { const [, y] = proj([0, la]); grid += `<line x1="${vb[0]}" y1="${y}" x2="${vb[0] + vb[2]}" y2="${y}"/><text x="${vb[0] + 3 * unit}" y="${y - 3 * unit}">${+la.toFixed(4)}°</text>` }
        svg += `<g class="ur-map-grid" stroke="${fg}" stroke-opacity=".12" fill="${fg}" fill-opacity=".45" font-size="${11 * unit}" stroke-width="${unit}">${grid}</g>`
    }
    let ci = 0
    const tracks = []
    for (const f of feats) {
        if (f.kind === 'poly') {
            const d = f.coords.map(r => 'M' + r.map(c => proj(c).join(',')).join('L') + 'Z').join('')
            const color = f.stroke || f.color || PALETTE[ci++ % PALETTE.length]
            svg += `<path d="${d}" fill="${f.fillColor || f.color || color}" fill-opacity=".25" stroke="${color}" stroke-width="${1.5 * unit}" fill-rule="evenodd"><title>${esc(f.name)}</title></path>`
        } else if (f.kind === 'line' && f.coords.length > 1) {
            const color = f.color || PALETTE[ci++ % PALETTE.length]
            f.drawColor = color
            svg += `<polyline points="${f.coords.map(c => proj(c).join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="${3 * unit}" stroke-linejoin="round" stroke-linecap="round"><title>${esc(f.name)}</title></polyline>`
            const [sx, sy] = proj(f.coords[0]), [ex, ey] = proj(f.coords[f.coords.length - 1])
            if (f.track) svg += `<circle cx="${sx}" cy="${sy}" r="${5 * unit}" fill="#2a2" stroke="#fff" stroke-width="${unit}"/><circle cx="${ex}" cy="${ey}" r="${5 * unit}" fill="#d22" stroke="#fff" stroke-width="${unit}"/>`
            tracks.push(f)
        }
    }
    const points = feats.filter(f => f.kind === 'point' && f.coords[0])
    points.forEach((f, i) => {
        const [x, y] = proj(f.coords[0])
        svg += `<g class="ur-map-pt" data-i="${i}"><circle cx="${x}" cy="${y}" r="${5 * unit}" fill="${f.color || '#d22'}" stroke="#fff" stroke-width="${1.5 * unit}"/>${f.name && points.length <= 300 ? `<text x="${x + 7 * unit}" y="${y + 4 * unit}" font-size="${12 * unit}" fill="${fg}" paint-order="stroke" stroke="${ctx.themeColors().bg}" stroke-width="${3 * unit}">${esc(f.name)}</text>` : ''}<title>${esc(f.name)}</title></g>`
    })
    // масштабная линейка
    if (geo) {
        const latMid = (2 * Math.atan(Math.exp(-(minY + h / 2) / R)) - Math.PI / 2)
        const metersPerUnit = Math.cos(latMid)
        const target = vb[2] * 0.2 * metersPerUnit
        const nice = [1, 2, 5].flatMap(k => [1, 10, 100, 1000, 10000, 100000, 1000000].map(m => k * m)).filter(v => v <= target).pop() || 1
        const len = nice / metersPerUnit, x0 = vb[0] + vb[2] * 0.04, y0 = vb[1] + vb[3] * 0.95
        svg += `<g class="ur-map-scale" stroke="${fg}" stroke-width="${2 * unit}" fill="${fg}" font-size="${11 * unit}"><line x1="${x0}" y1="${y0}" x2="${x0 + len}" y2="${y0}"/><line x1="${x0}" y1="${y0 - 4 * unit}" x2="${x0}" y2="${y0}"/><line x1="${x0 + len}" y1="${y0 - 4 * unit}" x2="${x0 + len}" y2="${y0}"/><text x="${x0}" y="${y0 - 6 * unit}" stroke="none">${fmtKm(nice)}</text></g>`
    }
    const wrap = document.createElement('div')
    if (title) wrap.insertAdjacentHTML('beforeend', `<h2>${esc(title)}</h2>`)
    const box = document.createElement('div'); box.className = 'ur-diagram-box ur-map-box'
    box.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="ur-diagram ur-map" viewBox="${vb.join(' ')}" preserveAspectRatio="xMidYMid meet">${svg}</svg>`
    wrap.append(box)
    const svgEl = box.querySelector('svg')
    panZoom(svgEl, wrap)
    if (!geo) wrap.insertAdjacentHTML('beforeend', '<div class="ur-meta">Координаты не в градусах (карта в проекции) — показываем как есть, без расчёта расстояний в километрах.</div>')
    // сведения о треках
    for (const t of tracks) {
        const s = trackStats(t.coords, geo)
        const facts = [['Расстояние', geo ? fmtKm(s.dist) : (+s.dist.toPrecision(4)).toString()], ['Время в пути', s.dur ? fmtTime(s.dur) : ''], ['Средняя скорость', s.dur && geo ? `${(s.dist / (s.dur / 1000) * 3.6).toFixed(1).replace('.', ',')} км/ч` : ''],
            ['Начало', s.start ? new Date(s.start).toLocaleString('ru-RU') : ''], ['Набор высоты', s.hasEle ? `${Math.round(s.up)} м` : ''], ['Спуск', s.hasEle ? `${Math.round(s.down)} м` : ''], ['Высота', s.hasEle ? `${Math.round(s.minEle)}–${Math.round(s.maxEle)} м` : ''], ['Точек', t.coords.length]].filter(x => x[1])
        const sec = document.createElement('section'); sec.className = 'ur-map-track'
        sec.innerHTML = `<h3><span class="ur-swatch" style="background:${t.drawColor}"></span> ${esc(t.name || 'Трек')}</h3>${t.desc ? `<p class="ur-muted">${esc(t.desc)}</p>` : ''}<table class="ur-font-facts">${facts.map(([k, v]) => `<tr><td class="ur-muted">${k}</td><td>${esc(String(v))}</td></tr>`).join('')}</table>`
        if (s.hasEle && geo) {
            // профиль высоты
            let d = 0
            const prof = t.coords.map((c, i) => { if (i) d += hav(t.coords[i - 1], c); return [d, c[2]] }).filter(p => Number.isFinite(p[1]))
            const W = 600, H = 120, eMin = s.minEle, eMax = Math.max(s.maxEle, s.minEle + 1)
            const pts = prof.map(([x, e]) => `${(x / (d || 1) * W).toFixed(1)},${(H - (e - eMin) / (eMax - eMin) * (H - 10) - 5).toFixed(1)}`).join(' ')
            sec.insertAdjacentHTML('beforeend', `<div class="ur-meta">Профиль высоты</div><svg class="ur-elev" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polygon points="0,${H} ${pts} ${W},${H}" fill="${t.drawColor}" fill-opacity=".2"/><polyline points="${pts}" fill="none" stroke="${t.drawColor}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg><div class="ur-elev-axis ur-muted"><span>0</span><span>${fmtKm(d)}</span></div>`)
        }
        wrap.append(sec)
    }
    // точки и объекты списком
    const listed = [...points, ...feats.filter(f => f.kind === 'poly' && f.name)]
    if (listed.length) {
        const sec = document.createElement('section')
        sec.innerHTML = `<h3>${points.length ? 'Точки' : 'Объекты'} (${listed.length})</h3>`
        const table = document.createElement('table'); table.className = 'ur-arc-table ur-map-list'
        const tb = document.createElement('tbody')
        listed.slice(0, 5000).forEach(f => {
            const c = f.kind === 'point' ? f.coords[0] : f.coords[0][0]
            const tr = document.createElement('tr')
            const extra = f.props ? Object.entries(f.props).filter(([k, v]) => v !== '' && v != null && typeof v !== 'object' && k !== 'name').slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(' · ') : ''
            tr.innerHTML = `<td>${esc(f.name || '—')}${f.folder ? ` <span class="ur-muted">(${esc(f.folder)})</span>` : ''}${f.desc || extra ? `<div class="ur-muted">${esc((f.desc || extra).slice(0, 300))}</div>` : ''}</td><td class="ur-muted">${geo ? `${c[1].toFixed(5)}, ${c[0].toFixed(5)}` : `${+c[0].toFixed(2)}, ${+c[1].toFixed(2)}`}${c[2] != null && f.kind === 'point' ? ` · ${Math.round(c[2])} м` : ''}</td>`
            tr.onclick = () => {
                const [x, y] = proj(c), v = svgEl.viewBox.baseVal
                const s = Math.min(v.width, v.height, Math.max(vb[2], vb[3]) / 8)
                v.x = x - s / 2; v.y = y - s / 2; v.width = s; v.height = s
                box.scrollIntoView({ block: 'nearest' })
            }
            tb.append(tr)
        })
        table.append(tb); sec.append(table); wrap.append(sec)
    }
    return wrap
}

// Shapefile: рядом лежащий .dbf с подписями
export const openShp = async (ctx, file, buf) => {
    const base = file.path.replace(/\.shp$/i, '')
    let rows = null
    for (const ext of ['.dbf', '.DBF']) {
        try { if (await ctx.app.vault.adapter.exists(base + ext)) { const b = await ctx.app.vault.adapter.readBinary(base + ext); rows = readDbf(b)[0].rows; break } } catch { /* без подписей */ }
    }
    return parseShp(buf, rows)
}
