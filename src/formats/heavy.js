// Форматы на больших библиотеках: HDF5, ноты MEI/Humdrum, STEP/IGES/BREP, Rhino 3DM, IFC, Flash SWF
import { escapeHtml as esc, decodeText, ReaderError } from '../util.js'
import { unzlibSync } from 'fflate'
import { midiView } from './graphics.js'

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e }
const num = v => typeof v === 'bigint' ? Number(v) : v
const fmtVal = v => {
    if (v == null) return ''
    if (typeof v === 'bigint') return v.toString()
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toPrecision(7))
    if (ArrayBuffer.isView(v) || Array.isArray(v)) { const a = Array.from(v, fmtVal); return a.length > 12 ? `[${a.slice(0, 12).join(', ')}, … всего ${a.length}]` : `[${a.join(', ')}]` }
    if (v instanceof Uint8Array) return `${v.length} байт`
    if (typeof v === 'object') return JSON.stringify(v, (k, x) => typeof x === 'bigint' ? x.toString() : x)
    return String(v)
}

// ================= HDF5 =================
const DT = { '<f8': 'дробные 64 бит', '<f4': 'дробные 32 бит', '<f2': 'дробные 16 бит', '<i8': 'целые 64 бит', '<i4': 'целые 32 бит', '<i2': 'целые 16 бит', '<i1': 'целые 8 бит', '<B': 'байты', '<b': 'целые 8 бит', '<H': 'целые 16 бит без знака', '<I': 'целые 32 бит без знака', '<Q': 'целые 64 бит без знака', '<h': 'целые 16 бит', '<i': 'целые 32 бит', '<q': 'целые 64 бит', '<d': 'дробные 64 бит', '<f': 'дробные 32 бит', S: 'строки' }
const dtypeName = (d, md) => md?.compound_type ? 'записи: ' + md.compound_type.members.map(m => m.name).join(', ') : typeof d === 'string' ? (DT[d] ?? DT[d.replace(/^[<>=|]/, '<')] ?? (/^S|^U/.test(d) ? 'строки' : d)) : d?.compound_type ? 'записи (несколько полей)' : 'сложный тип'

export const hdf5View = async (ctx, buf, fileName) => {
    const L = await ctx.loadLib('h5')
    const M = await L.ready()
    const { h5wasm } = L
    const FS = M.FS
    const path = `/ur-${Date.now()}-${Math.random().toString(36).slice(2)}.h5`
    FS.writeFile(path, new Uint8Array(buf))
    let f
    try { f = new h5wasm.File(path, 'r') } catch (e) { try { FS.unlink(path) } catch { /* уже нет */ } throw new ReaderError('Это не файл HDF5 или он повреждён.') }
    ctx.cleanups.push(() => { try { f.close() } catch { /* закрыт */ } try { FS.unlink(path) } catch { /* удалён */ } })
    // обход дерева
    const items = []
    const walk = (g, p, depth) => {
        let keys = []
        try { keys = g.keys() } catch { return }
        for (const k of keys) {
            if (items.length > 5000) return
            const full = p === '/' ? '/' + k : p + '/' + k
            let o; try { o = f.get(full) } catch { o = null }
            const kind = o?.type === 'Group' || o?.constructor?.name === 'Group' || typeof o?.keys === 'function' && !o?.shape ? 'group' : o?.shape ? 'dataset' : 'link'
            items.push({ path: full, name: k, depth, kind, obj: o })
            if (kind === 'group') walk(o, full, depth + 1)
        }
    }
    walk(f, '/', 0)
    const wrap = el('div', 'ur-h5')
    const tree = el('div', 'ur-h5-tree ur-nosearch')
    const pane = el('div', 'ur-h5-pane ur-article')
    wrap.append(tree, pane)
    const attrsTable = o => {
        let a = {}; try { a = o.attrs ?? {} } catch { /* без атрибутов */ }
        const rows = Object.keys(a).map(k => { let v; try { v = a[k].value } catch { v = '?' } return `<tr><td>${esc(k)}</td><td>${esc(fmtVal(v))}</td></tr>` })
        return rows.length ? `<h3>Атрибуты</h3><table class="ur-kv">${rows.join('')}</table>` : ''
    }
    const show = it => {
        for (const b of tree.querySelectorAll('.is-active')) b.classList.remove('is-active')
        it?.btn?.classList.add('is-active')
        pane.innerHTML = ''
        if (!it) { pane.innerHTML = `<h2>${esc(fileName)}</h2><p>Групп: ${items.filter(i => i.kind === 'group').length}, наборов данных: ${items.filter(i => i.kind === 'dataset').length}.</p>${attrsTable(f)}<p class="ur-muted">Выберите набор данных слева.</p>`; return }
        const o = it.obj
        if (it.kind !== 'dataset') { pane.innerHTML = `<h2>${esc(it.path)}</h2><p>${it.kind === 'group' ? 'Группа' : 'Ссылка'}</p>${o ? attrsTable(o) : ''}`; return }
        const shape = (o.shape ?? []).map(num)
        const total = shape.reduce((a, b) => a * b, 1)
        pane.insertAdjacentHTML('beforeend', `<h2>${esc(it.path)}</h2><table class="ur-kv"><tr><td>Размерность</td><td>${shape.length ? shape.join(' × ') : 'одно значение'}</td></tr><tr><td>Тип</td><td>${esc(dtypeName(o.dtype, o.metadata))}</td></tr><tr><td>Значений</td><td>${total.toLocaleString('ru-RU')}</td></tr></table>${attrsTable(o)}`)
        // значения: не больше ~200 000 за раз
        let data, sh = shape
        try {
            if (shape.length <= 1 && total <= 200000) data = o.value
            else if (shape.length === 1) { data = o.slice([[0, 200000]]); sh = [Math.min(shape[0], 200000)] }
            else {
                const rows = Math.min(shape[0], 2000), cols = Math.min(shape[1], 200)
                const sel = [[0, rows], [0, cols], ...shape.slice(2).map(() => [0, 1])]
                data = o.slice(sel); sh = [rows, cols]
                if (shape.length > 2) pane.insertAdjacentHTML('beforeend', `<p class="ur-muted">Показан первый срез [:, :, ${shape.slice(2).map(() => '0').join(', ')}].</p>`)
            }
        } catch (e) { pane.insertAdjacentHTML('beforeend', `<p class="ur-muted">Не удалось прочитать значения: ${esc(e.message || e)}</p>`); return }
        const arr = data == null ? [] : ArrayBuffer.isView(data) || Array.isArray(data) ? Array.from(data) : [data]
        const comp = (o.metadata?.compound_type ?? o.dtype?.compound_type)?.members?.map(m => m.name)
        // двумерный числовой набор — можно посмотреть картинкой
        if (sh.length === 2 && sh[0] > 1 && sh[1] > 1 && arr.length && typeof num(arr[0]) === 'number' && !comp) {
            const b = el('button', 'ur-nosearch', 'Показать картинкой'); pane.append(b)
            b.onclick = () => {
                const [h, w] = sh; let lo = Infinity, hi = -Infinity
                for (const v of arr) { const x = num(v); if (Number.isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x } }
                const c = document.createElement('canvas'); c.width = w; c.height = h; c.className = 'ur-h5-img'
                const g = c.getContext('2d'), img = g.createImageData(w, h)
                for (let i = 0; i < w * h; i++) { const x = num(arr[i]); const t = hi > lo ? (x - lo) / (hi - lo) : 0; const [r, gg, bb] = viridis(Number.isFinite(t) ? t : 0); img.data.set([r, gg, bb, 255], i * 4) }
                g.putImageData(img, 0, 0); b.replaceWith(c)
            }
        }
        const t = el('table', 'ur-h5-table')
        let html = ''
        if (comp) {
            html = `<tr><th>#</th>${comp.map(n => `<th>${esc(n)}</th>`).join('')}</tr>`
            arr.slice(0, 2000).forEach((r, i) => { html += `<tr><td>${i}</td>${(Array.isArray(r) ? r : [r]).map(v => `<td>${esc(fmtVal(v))}</td>`).join('')}</tr>` })
        } else if (sh.length === 2) {
            const [h, w] = sh
            html = `<tr><th></th>${Array.from({ length: w }, (_, j) => `<th>${j}</th>`).join('')}</tr>`
            for (let i = 0; i < Math.min(h, 2000); i++) { html += `<tr><th>${i}</th>`; for (let j = 0; j < w; j++) html += `<td>${esc(fmtVal(arr[i * w + j]))}</td>`; html += '</tr>' }
        } else {
            html = '<tr><th>#</th><th>значение</th></tr>'
            arr.slice(0, 5000).forEach((v, i) => { html += `<tr><td>${i}</td><td>${esc(fmtVal(v))}</td></tr>` })
        }
        t.innerHTML = html
        pane.append(t)
        if (arr.length > 5000 || (sh.length === 2 && sh[0] > 2000)) pane.insertAdjacentHTML('beforeend', '<p class="ur-muted">Показано начало: файл слишком большой, чтобы вывести всё.</p>')
    }
    const root = el('button', 'ur-h5-item', `📁 ${esc(fileName)}`); root.onclick = () => show(null); tree.append(root)
    for (const it of items) {
        const b = el('button', 'ur-h5-item', `${it.kind === 'group' ? '📁' : it.kind === 'dataset' ? '🔢' : '🔗'} ${esc(it.name)}`)
        b.style.paddingLeft = `${8 + (it.depth + 1) * 14}px`
        b.onclick = () => show(it); it.btn = b; tree.append(b)
    }
    show(items.find(i => i.kind === 'dataset') ?? null)
    return wrap
}
const viridis = t => {
    const C = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]]
    const x = Math.max(0, Math.min(1, t)) * 4, i = Math.min(3, Math.floor(x)), f = x - i
    return C[i].map((v, k) => Math.round(v + (C[i + 1][k] - v) * f))
}
export const isHdf5 = u8 => { for (const off of [0, 512, 1024, 2048]) if (u8[off] === 0x89 && u8[off + 1] === 0x48 && u8[off + 2] === 0x44 && u8[off + 3] === 0x46) return true; return false }

// ================= Ноты MEI и Humdrum (Verovio) =================
export const notationView = async (ctx, text) => {
    const L = await ctx.loadLib('verovio')
    const tk = await L.toolkit()
    tk.setOptions({ pageWidth: 1400, pageHeight: 2000, adjustPageHeight: true, scale: 45, footer: 'none', breaks: 'auto', svgViewBox: true })
    if (!tk.loadData(text)) throw new ReaderError('Verovio не смог прочитать ноты: ' + (tk.getLog?.() || 'неизвестная ошибка'))
    const wrap = el('div', 'ur-notation')
    const n = tk.getPageCount()
    for (let p = 1; p <= Math.min(n, 60); p++) { const page = el('div', 'ur-notation-page', tk.renderToSVG(p)); wrap.append(page) }
    if (n > 60) wrap.append(el('p', 'ur-muted', `Показаны первые 60 страниц из ${n}.`))
    // проигрывание: Verovio отдаёт MIDI, а для MIDI у читалки уже есть синтезатор
    try {
        const b64 = tk.renderToMIDI()
        if (b64) {
            const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
            const m = await midiView(ctx, u8.buffer)
            const box = el('details', 'ur-notation-midi ur-nosearch', '<summary>Послушать (простой синтезатор)</summary>'); box.append(m)
            wrap.prepend(box)
        }
    } catch { /* без звука */ }
    return wrap
}

// ================= 3D: общий вид для готовых сеток =================
// data: { meshes: [{ pos, nrm?, idx?, color: [r,g,b,a], matrix? }], lines: [{ pts, color }], points: Float32Array, zUp, info }
export const buildMeshes = (L, THREE, data) => {
    const grp = new THREE.Group()
    const mats = new Map()
    const matOf = c => {
        const key = (c ?? [0.55, 0.64, 0.78, 1]).map(x => Math.round(x * 255)).join(',')
        if (!mats.has(key)) { const [r, g, b, a = 1] = c ?? [0.55, 0.64, 0.78, 1]; mats.set(key, new THREE.MeshStandardMaterial({ color: new THREE.Color(r, g, b), roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide, transparent: a < 0.99, opacity: a })) }
        return mats.get(key)
    }
    for (const m of data.meshes ?? []) {
        if (!m.pos?.length) continue
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.BufferAttribute(m.pos instanceof Float32Array ? m.pos : new Float32Array(m.pos), 3))
        if (m.nrm?.length === m.pos.length) g.setAttribute('normal', new THREE.BufferAttribute(m.nrm instanceof Float32Array ? m.nrm : new Float32Array(m.nrm), 3))
        if (m.idx?.length) g.setIndex(new THREE.BufferAttribute(m.idx instanceof Uint32Array ? m.idx : new Uint32Array(m.idx), 1))
        if (!g.attributes.normal) g.computeVertexNormals()
        if (m.groups) { for (const gr of m.groups) g.addGroup(gr.start, gr.count, gr.mat) }
        const mesh = new THREE.Mesh(g, m.groups ? m.groupColors.map(matOf) : matOf(m.color))
        if (m.matrix) { mesh.matrixAutoUpdate = false; mesh.matrix.fromArray(m.matrix) }
        if (m.name) mesh.name = m.name
        grp.add(mesh)
    }
    for (const l of data.lines ?? []) {
        if (l.pts.length < 6) continue
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(l.pts), 3))
        const c = l.color ?? [0.2, 0.25, 0.35]
        grp.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: new THREE.Color(c[0], c[1], c[2]) })))
    }
    if (data.points?.length) {
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(data.points), 3))
        grp.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, color: 0xd04040 })))
    }
    if (!grp.children.length) throw new ReaderError(data.empty ?? 'В модели нет видимой геометрии.')
    if (data.zUp) grp.rotation.x = -Math.PI / 2
    grp.updateMatrixWorld(true)
    return grp
}

// ================= STEP, IGES, BREP (OpenCascade) =================
export const cadMeshes = async (ctx, buf, ext) => {
    const L = await ctx.loadLib('occt')
    const occt = await L.init(await ctx.loadAsset('occt.wasm'))
    const u8 = new Uint8Array(buf)
    const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.5 }
    const r = ext === 'igs' || ext === 'iges' ? occt.ReadIgesFile(u8, params) : ext === 'brep' ? occt.ReadBrepFile(u8, params) : occt.ReadStepFile(u8, params)
    if (!r?.success) throw new ReaderError('OpenCascade не смог прочитать модель (файл повреждён или это не ' + ext.toUpperCase() + ').')
    const meshes = r.meshes.map(m => {
        const out = { pos: m.attributes.position.array, nrm: m.attributes.normal?.array, idx: m.index?.array, color: m.color ? [...m.color, 1] : null, name: m.name }
        // у отдельных граней бывает свой цвет
        if (m.brep_faces?.some(f => f.color)) {
            out.groups = []; out.groupColors = []
            const idx = (c) => { const k = c ? c.join(',') : 'base'; let i = out.groupColors.findIndex(x => (x ? x.join(',') : 'base') === (c ? [...c, 1].join(',') : 'base')); if (i < 0) { out.groupColors.push(c ? [...c, 1] : out.color); i = out.groupColors.length - 1 } return i }
            for (const f of m.brep_faces) out.groups.push({ start: f.first * 3, count: (f.last - f.first + 1) * 3, mat: idx(f.color) })
        }
        return out
    })
    const names = []; const walk = (n, d) => { if (n?.name && d < 4) names.push('  '.repeat(d) + n.name); for (const c of n?.children ?? []) walk(c, d + 1) }; walk(r.root, 0)
    return { meshes, zUp: true, tree: names }
}

// ================= Rhino 3DM =================
export const rhinoMeshes = async (ctx, buf) => {
    const L = await ctx.loadLib('rhino')
    const rh = await L.init(await ctx.loadAsset('rhino3dm.wasm'))
    const doc = rh.File3dm.fromByteArray(new Uint8Array(buf))
    if (!doc) throw new ReaderError('Это не файл Rhino 3DM или он повреждён.')
    const meshes = [], lines = [], points = []
    let noMesh = 0
    const layers = doc.layers(), objs = doc.objects()
    const colorOf = attr => {
        let c
        try { if (attr.colorSource === rh.ObjectColorSource.ColorFromObject) c = attr.objectColor; else { const ly = layers.get(attr.layerIndex); c = ly?.color } } catch { /* по умолчанию */ }
        return c ? [c.r / 255, c.g / 255, c.b / 255, 1] : null
    }
    const pushMesh = (m, color) => {
        if (!m) return false
        try {
            const j = m.toThreejsJSON(); const a = j.data.attributes
            meshes.push({ pos: a.position.array, nrm: a.normal?.array, idx: j.data.index?.array, color })
            return true
        } catch { return false }
    }
    const sampleCurve = (cv, color) => {
        try {
            const d = cv.domain, n = 64, pts = []
            for (let i = 0; i <= n; i++) { const p = cv.pointAt(d[0] + (d[1] - d[0]) * i / n); pts.push(p[0], p[1], p[2]) }
            lines.push({ pts, color })
        } catch { /* кривую пропускаем */ }
    }
    for (let i = 0; i < objs.count; i++) {
        const o = objs.get(i), g = o.geometry(), attr = o.attributes()
        if (attr?.visible === false) continue
        const color = colorOf(attr)
        const type = g.objectType
        const T = rh.ObjectType
        if (type === T.Mesh) pushMesh(g, color)
        else if (type === T.Brep) {
            let ok = false
            for (let f = 0; f < g.faces().count; f++) ok = pushMesh(g.faces().get(f).getMesh(rh.MeshType.Any), color) || ok
            if (!ok) { noMesh++; for (let e = 0; e < g.edges().count; e++) sampleCurve(g.edges().get(e), color) }
        } else if (type === T.Extrusion) { if (!pushMesh(g.getMesh(rh.MeshType.Any), color)) { noMesh++; try { const b = g.toBrep(true); for (let e = 0; e < b.edges().count; e++) sampleCurve(b.edges().get(e), color) } catch { /* без каркаса */ } } }
        else if (type === T.SubD) { try { pushMesh(rh.Mesh.createFromSubDControlNet(g, true), color) } catch { noMesh++ } }
        else if (type === T.Curve) sampleCurve(g, color)
        else if (type === T.Point) { const p = g.location; points.push(p[0], p[1], p[2]) }
        else if (type === T.PointSet) { for (let k = 0; k < g.count; k++) { const p = g.points?.().get?.(k); if (p) points.push(p[0], p[1], p[2]) } }
    }
    let info = `Объектов: ${objs.count}, слоёв: ${layers.count}`
    if (noMesh) info += ` · поверхностей без сохранённой сетки: ${noMesh} (показаны их края)`
    return { meshes, lines, points, zUp: true, info, empty: 'В файле нет сохранённых сеток. Rhino сохраняет их, если не включать «Сохранить только геометрию».' }
}

// ================= IFC (здания) =================
export const ifcMeshes = async (ctx, buf) => {
    const L = await ctx.loadLib('ifc')
    const wasm = await ctx.loadAsset('web-ifc.wasm')
    const url = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' })); ctx.urls?.push(url)
    const api = new L.IfcAPI()
    await api.Init(() => url, true)
    const id = api.OpenModel(new Uint8Array(buf), { COORDINATE_TO_ORIGIN: true })
    if (id < 0) throw new ReaderError('web-ifc не смог открыть модель.')
    const meshes = []
    try {
        api.StreamAllMeshes(id, mesh => {
            const gs = mesh.geometries
            for (let i = 0; i < gs.size(); i++) {
                const pg = gs.get(i)
                const geo = api.GetGeometry(id, pg.geometryExpressID)
                const v = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize())
                const idx = api.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize())
                const n = v.length / 6, pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3)
                for (let k = 0; k < n; k++) { pos[k * 3] = v[k * 6]; pos[k * 3 + 1] = v[k * 6 + 1]; pos[k * 3 + 2] = v[k * 6 + 2]; nrm[k * 3] = v[k * 6 + 3]; nrm[k * 3 + 1] = v[k * 6 + 4]; nrm[k * 3 + 2] = v[k * 6 + 5] }
                meshes.push({ pos, nrm, idx: new Uint32Array(idx), color: [pg.color.x, pg.color.y, pg.color.z, pg.color.w], matrix: Array.from(pg.flatTransformation) })
                geo.delete?.()
            }
        })
        // немного сведений: название проекта и сколько каких элементов
        let info = ''
        try {
            const proj = api.GetLineIDsWithType(id, L.IFCPROJECT ?? 103090709)
            if (proj.size()) { const p = api.GetLine(id, proj.get(0)); info = [p.LongName?.value, p.Name?.value].filter(Boolean).join(' — ') }
        } catch { /* без названия */ }
        return { meshes, zUp: false, info: (info ? `Проект: ${info} · ` : '') + `элементов с геометрией: ${meshes.length}` }
    } finally { try { api.CloseModel(id) } catch { /* закрыта */ } }
}

// ================= Flash SWF (Ruffle) =================
const swfHeader = u8 => {
    const sig = String.fromCharCode(u8[0], u8[1], u8[2])
    if (!['FWS', 'CWS', 'ZWS'].includes(sig)) return null
    const out = { version: u8[3], compressed: sig === 'CWS' ? 'zlib' : sig === 'ZWS' ? 'LZMA' : 'нет', size: new DataView(u8.buffer, u8.byteOffset).getUint32(4, true) }
    let body = null
    if (sig === 'FWS') body = u8.subarray(8)
    else if (sig === 'CWS') { try { body = unzlibSync(u8.subarray(8, Math.min(u8.length, 8 + 200000))) } catch { try { body = unzlibSync(u8.subarray(8)) } catch { body = null } } }
    if (body) {
        const nb = body[0] >> 3; let bit = 5
        const rd = n => { let v = 0; for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((body[bit >> 3] >> (7 - (bit & 7))) & 1); return v >= 1 << (n - 1) ? v - (1 << n) : v }
        const xmin = rd(nb), xmax = rd(nb), ymin = rd(nb), ymax = rd(nb)
        const p = Math.ceil(bit / 8)
        out.w = Math.round((xmax - xmin) / 20); out.h = Math.round((ymax - ymin) / 20)
        out.fps = body[p + 1] + body[p] / 256; out.frames = body[p + 2] | body[p + 3] << 8
    }
    return out
}
let rufflePromise = null
const loadRuffle = ctx => rufflePromise ??= (async () => {
    if (window.RufflePlayer?.newest) return window.RufflePlayer
    const base = ctx.assetBase('ruffle')
    window.RufflePlayer = window.RufflePlayer || {}
    window.RufflePlayer.config = { ...(window.RufflePlayer.config || {}), publicPath: base, polyfills: false, autoplay: 'on', unmuteOverlay: 'hidden', splashScreen: false, allowNetworking: 'none', openUrlMode: 'deny', warnOnUnsupportedContent: false, showSwfDownload: false, logLevel: 'error' }
    // код Ruffle читаем из папки libs и выполняем сами, без вставки <script> на страницу
    const code = new TextDecoder().decode(await ctx.loadAsset('ruffle/ruffle.js'))
    new Function(code)()
    if (!window.RufflePlayer?.newest) throw new Error('Ruffle не загрузился')
    return window.RufflePlayer
})().catch(e => { rufflePromise = null; throw e })

export const swfView = async (ctx, buf) => {
    const u8 = new Uint8Array(buf)
    const h = swfHeader(u8)
    if (!h) throw new ReaderError('Это не ролик Flash (SWF).')
    const R = await loadRuffle(ctx)
    const wrap = el('div', 'ur-swf')
    const info = el('div', 'ur-meta ur-nosearch', esc(`Flash ${h.version}` + (h.w ? ` · ${h.w}×${h.h}` : '') + (h.fps ? ` · ${+h.fps.toFixed(2)} кадр/с` : '') + (h.frames ? ` · кадров: ${h.frames}` : '') + ' · воспроизводит Ruffle, интернет для ролика отключён'))
    const stage = el('div', 'ur-swf-stage')
    wrap.append(info, stage)
    const player = R.newest().createPlayer()
    player.style.width = '100%'; player.style.height = '100%'
    stage.append(player)
    const api = typeof player.ruffle === 'function' ? player.ruffle() : player
    const opts = { data: u8, autoplay: 'on', unmuteOverlay: 'hidden', splashScreen: false, allowNetworking: 'none', openUrlMode: 'deny', warnOnUnsupportedContent: false, letterbox: 'on', backgroundColor: null }
    // Ruffle грузит ядро асинхронно: ошибку показываем, но окно не роняем
    // запускаем, только когда проигрыватель уже на странице (иначе Ruffle молча отказывается)
    let tries = 0
    const start = () => {
        if (!player.isConnected) { if (++tries < 200) setTimeout(start, 50); return }
        Promise.resolve(api.load(opts)).catch(e => { info.textContent = 'Ruffle не смог запустить ролик: ' + (e?.message || e) })
    }
    start()
    ctx.cleanups.push(() => { try { api.destroy?.() } catch { /* уже */ } player.remove() })
    return wrap
}

export { decodeText }
