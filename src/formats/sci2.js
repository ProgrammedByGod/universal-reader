// Наука и медицина версии 0.6: DICOM (.dcm), NIfTI (.nii), ЭЭГ EDF/BDF (.edf, .bdf), проточная цитометрия (.fcs),
// масс-спектрометрия (.mzML), тайлы карт (.mbtiles), GeoPackage (.gpkg)
import { escapeHtml as esc, ReaderError } from '../util.js'
import { inflateRaw, gunzip } from './compress.js'

const latin = new TextDecoder('latin1')
const utf8 = new TextDecoder()
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e }
const num = v => typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(+v.toPrecision(6))) : String(v ?? '')
const slider = (label, min, max, value, step = 1) => {
    const w = el('label', 'ur-sci-slider', `<span>${esc(label)}</span><input type="range" min="${min}" max="${max}" value="${value}" step="${step}"><output>${value}</output>`)
    const inp = w.querySelector('input'), out = w.querySelector('output')
    inp.addEventListener('input', () => { out.textContent = inp.value })
    return { el: w, inp, out, set: v => { inp.value = v; out.textContent = v } }
}
const infoTable = rows => `<table class="ur-table ur-sci-info"><tbody>${rows.filter(r => r[1] !== '' && r[1] != null).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join('')}</tbody></table>`
// автоматическая яркость: 1-й и 99-й процентили по выборке
const autoRange = (get, n) => {
    const step = Math.max(1, Math.floor(n / 20000)); const s = []
    for (let i = 0; i < n; i += step) { const v = get(i); if (Number.isFinite(v)) s.push(v) }
    if (!s.length) return [0, 1]
    s.sort((a, b) => a - b)
    const lo = s[Math.floor(s.length * 0.01)], hi = s[Math.min(s.length - 1, Math.floor(s.length * 0.995))]
    return hi > lo ? [lo, hi] : [s[0], s[s.length - 1] > s[0] ? s[s.length - 1] : s[0] + 1]
}

// ================= DICOM =================
const DICT = {
    '00100010': 'Пациент', '00100020': 'ID пациента', '00100030': 'Дата рождения', '00100040': 'Пол', '00101010': 'Возраст', '00101030': 'Вес',
    '00080020': 'Дата исследования', '00080030': 'Время исследования', '00080060': 'Модальность', '00080070': 'Производитель', '00080080': 'Учреждение',
    '00081030': 'Исследование', '0008103E': 'Серия', '00081090': 'Модель аппарата', '00180015': 'Область тела', '00180050': 'Толщина среза', '00200011': 'Номер серии',
    '00200013': 'Номер снимка', '00280010': 'Строк', '00280011': 'Столбцов', '00280008': 'Кадров', '00280004': 'Цвет', '00280100': 'Бит на точку', '00281050': 'Центр окна', '00281051': 'Ширина окна',
    '00080016': 'Тип объекта', '00020010': 'Способ записи', '00080090': 'Направивший врач', '00321060': 'Процедура', '00180088': 'Шаг срезов', '00280030': 'Размер пикселя', '00200032': 'Положение', '00080008': 'Тип снимка',
}
const TS_NAME = { '1.2.840.10008.1.2': 'без сжатия (неявный)', '1.2.840.10008.1.2.1': 'без сжатия', '1.2.840.10008.1.2.2': 'без сжатия (big-endian)', '1.2.840.10008.1.2.1.99': 'сжатие deflate',
    '1.2.840.10008.1.2.4.50': 'JPEG', '1.2.840.10008.1.2.4.51': 'JPEG 12 бит', '1.2.840.10008.1.2.4.57': 'JPEG без потерь', '1.2.840.10008.1.2.4.70': 'JPEG без потерь', '1.2.840.10008.1.2.4.80': 'JPEG-LS', '1.2.840.10008.1.2.4.81': 'JPEG-LS',
    '1.2.840.10008.1.2.4.90': 'JPEG 2000', '1.2.840.10008.1.2.4.91': 'JPEG 2000', '1.2.840.10008.1.2.5': 'RLE', '1.2.840.10008.1.2.4.100': 'MPEG-2', '1.2.840.10008.1.2.4.102': 'MPEG-4' }
const MODALITY = { CT: 'КТ', MR: 'МРТ', CR: 'рентген', DX: 'рентген', US: 'УЗИ', XA: 'ангиография', MG: 'маммография', PT: 'ПЭТ', NM: 'радиоизотопное', OT: 'другое', SC: 'снимок экрана', RTPLAN: 'план лучевой терапии', RTSTRUCT: 'контуры лучевой терапии', SR: 'структурированный отчёт', ES: 'эндоскопия', XC: 'фото', OP: 'фото глазного дна', IO: 'снимок зубов', PX: 'панорамный снимок зубов', DOC: 'документ' }
const LONG_VR = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UT', 'UN', 'UC', 'UR', 'SV', 'UV'])
const IMPLICIT_VR = { '00280010': 'US', '00280011': 'US', '00280100': 'US', '00280101': 'US', '00280102': 'US', '00280103': 'US', '00280002': 'US', '00280006': 'US', '00281050': 'DS', '00281051': 'DS', '00281052': 'DS', '00281053': 'DS', '00280008': 'IS', '7FE00010': 'OW', '00280004': 'CS' }
export const isDicom = u8 => latin.decode(u8.subarray(128, 132)) === 'DICM'
export const parseDicom = async buf => {
    let u8 = new Uint8Array(buf)
    let p = isDicom(u8) ? 132 : 0
    if (!p && !(u8[0] === 8 && u8[1] === 0 || u8[0] === 2 && u8[1] === 0)) throw new ReaderError('Это не снимок DICOM.')
    const tags = new Map()
    let ts = '1.2.840.10008.1.2.1'
    const read = (bytes, start, end, le, explicit, out, depth = 0) => {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        let q = start
        while (q + 8 <= end) {
            const metaLe = dv.getUint16(q, true) === 2 // группа 0002 всегда little-endian и с явным VR
            const L = metaLe || le
            const g = dv.getUint16(q, L), e = dv.getUint16(q + 2, L)
            const tag = g.toString(16).padStart(4, '0').toUpperCase() + e.toString(16).padStart(4, '0').toUpperCase()
            if (g === 0xFFFE) { // элементы последовательностей
                const len = dv.getUint32(q + 4, L); q += 8
                if (e === 0xE0DD || e === 0xE00D) return q
                if (e === 0xE000) { const item = new Map(); if (len === 0xFFFFFFFF) q = read(bytes, q, end, le, explicit, item, depth + 1); else { read(bytes, q, q + len, le, explicit, item, depth + 1); q += len } out.items?.push(item) }
                continue
            }
            let vr, len
            const ex = metaLe || explicit
            const vr2 = latin.decode(bytes.subarray(q + 4, q + 6))
            if (ex && /^[A-Z]{2}$/.test(vr2)) { vr = vr2; if (LONG_VR.has(vr)) { len = dv.getUint32(q + 8, L); q += 12 } else { len = dv.getUint16(q + 6, L); q += 8 } }
            else { vr = IMPLICIT_VR[tag] ?? (tag === '7FE00010' ? 'OW' : 'UN'); len = dv.getUint32(q + 4, L); q += 8 }
            if (tag === '7FE00010') {
                if (len === 0xFFFFFFFF) { // сжатые кадры: таблица смещений + фрагменты
                    const frags = []
                    while (q + 8 <= end) { const ge = dv.getUint16(q + 2, L); const fl = dv.getUint32(q + 4, L); q += 8; if (ge === 0xE0DD) break; frags.push(bytes.subarray(q, q + fl)); q += fl }
                    out.set(tag, { vr, frags })
                } else { out.set(tag, { vr, bytes: bytes.subarray(q, q + len) }); q += len }
                continue
            }
            if (vr === 'SQ' || (len === 0xFFFFFFFF && vr === 'UN')) {
                const seq = { vr: 'SQ', items: [] }
                if (len === 0xFFFFFFFF) q = read(bytes, q, end, le, explicit, seq, depth + 1)
                else { read(bytes, q, q + len, le, explicit, seq, depth + 1); q += len }
                out.set(tag, seq)
                continue
            }
            if (len === 0xFFFFFFFF) break
            out.set(tag, { vr, bytes: bytes.subarray(q, q + len), le: L })
            q += len
            if (tag === '00020010') {
                ts = latin.decode(bytes.subarray(q - len, q)).replace(/[\0 ]+$/, '')
                if (depth === 0) { // дальше — основной набор данных в нужном порядке байтов
                    const metaEnd = q
                    // дочитываем остальные элементы группы 0002
                    while (q + 8 <= end && dv.getUint16(q, true) === 2) { const vr3 = latin.decode(bytes.subarray(q + 4, q + 6)); const l3 = LONG_VR.has(vr3) ? dv.getUint32(q + 8, true) : dv.getUint16(q + 6, true); const h3 = LONG_VR.has(vr3) ? 12 : 8; out.set(dv.getUint16(q + 2, true).toString(16).padStart(4, '0').toUpperCase().padStart(8, '0002'), { vr: vr3, bytes: bytes.subarray(q + h3, q + h3 + l3), le: true }); q += h3 + l3 }
                    void metaEnd
                    return { switchAt: q }
                }
            }
        }
        return q
    }
    let r = read(u8, p, u8.length, true, true, tags)
    if (r?.switchAt) {
        let start = r.switchAt
        if (ts === '1.2.840.10008.1.2.1.99') { u8 = await inflateRaw(u8.subarray(start)); start = 0 }
        read(u8, start, u8.length, ts !== '1.2.840.10008.1.2.2', ts !== '1.2.840.10008.1.2', tags)
    } else if (!isDicom(new Uint8Array(buf))) {
        // файл без преамбулы: пробуем неявный VR
        tags.clear(); read(u8, 0, u8.length, true, false, tags); ts = '1.2.840.10008.1.2'
    }
    const str = t => { const x = tags.get(t); if (!x?.bytes) return ''; return (x.vr === 'PN' || x.vr === 'LO' || x.vr === 'SH' || x.vr === 'ST' || x.vr === 'LT' || x.vr === 'UT' ? utf8 : latin).decode(x.bytes).replace(/[\0 ]+$/, '').trim() }
    const us = t => { const x = tags.get(t); if (!x?.bytes || x.bytes.length < 2) return 0; return new DataView(x.bytes.buffer, x.bytes.byteOffset).getUint16(0, x.le ?? true) }
    const ds = t => str(t).split('\\').map(Number)
    return { tags, ts, str, us, ds }
}
const dicomDate = s => /^\d{8}$/.test(s) ? `${s.slice(6, 8)}.${s.slice(4, 6)}.${s.slice(0, 4)}` : s
const packBits = (src, outLen) => {
    const out = new Uint8Array(outLen); let i = 0, o = 0
    while (i < src.length && o < outLen) { const n = (src[i] << 24) >> 24; i++; if (n >= 0) { out.set(src.subarray(i, i + n + 1), o); o += n + 1; i += n + 1 } else if (n !== -128) { out.fill(src[i], o, o + 1 - n); o += 1 - n; i++ } }
    return out
}
export const dicomView = async (ctx, buf) => {
    const d = await parseDicom(buf)
    const { tags, ts, str, us, ds } = d
    const rows = us('00280010'), cols = us('00280011'), bits = us('00280100') || 16, spp = us('00280002') || 1
    const signed = us('00280103') === 1, planar = us('00280006') === 1
    const photo = str('00280004'), nFrames = +str('00280008') || 1
    const slope = ds('00281053')[0] || 1, inter = ds('00281052')[0] || 0
    const wrap = el('div', 'ur-dicom')
    const mod = str('00080060')
    const info = [['Пациент', str('00100010').replace(/\^/g, ' ')], ['ID пациента', str('00100020')], ['Дата рождения', dicomDate(str('00100030'))], ['Пол', { M: 'мужской', F: 'женский', O: 'другой' }[str('00100040')] ?? str('00100040')],
        ['Исследование', str('00081030')], ['Серия', str('0008103E')], ['Вид', mod ? `${MODALITY[mod] ?? mod} (${mod})` : ''], ['Дата', dicomDate(str('00080020'))], ['Учреждение', str('00080080')], ['Аппарат', [str('00080070'), str('00081090')].filter(Boolean).join(' ')],
        ['Область тела', str('00180015')], ['Размер', rows ? `${cols}×${rows}${nFrames > 1 ? `, кадров: ${nFrames}` : ''}` : ''], ['Сжатие', TS_NAME[d.ts] ?? d.ts]]
    const px = tags.get('7FE00010')
    const head = el('div', 'ur-dicom-head')
    wrap.append(head)
    if (!px || !rows) { wrap.append(el('p', 'ur-muted', 'В файле нет изображения — показаны только сведения.')) }
    else {
        const frameSize = rows * cols * spp * (bits / 8)
        let decodeFrame, isJpeg = false
        if (px.frags) {
            // фрагменты по кадрам: если фрагментов больше, чем кадров, склеиваем всё в один кадр
            const frags = px.frags.slice(1)
            const frames = frags.length === nFrames ? frags : nFrames === 1 ? [concat(frags)] : frags.slice(0, nFrames)
            if (ts === '1.2.840.10008.1.2.5') decodeFrame = i => { const f = frames[i]; const fdv = new DataView(f.buffer, f.byteOffset); const nSeg = fdv.getUint32(0, true); const bpp = bits / 8; const out = new Uint8Array(frameSize); const n = rows * cols; for (let s = 0; s < nSeg; s++) { const a = fdv.getUint32(4 + s * 4, true), b = s + 1 < nSeg ? fdv.getUint32(8 + s * 4, true) : f.length; const plane = packBits(f.subarray(a, b), n); const sample = Math.floor(s / bpp), byte = bpp - 1 - s % bpp; for (let k = 0; k < n; k++) out[(k * spp + sample) * bpp + byte] = plane[k] } return out }
            else if (ts === '1.2.840.10008.1.2.4.50' || ts === '1.2.840.10008.1.2.4.51' && bits === 8) { isJpeg = true; decodeFrame = i => frames[i] }
            else if (ts === '1.2.840.10008.1.2.4.90' || ts === '1.2.840.10008.1.2.4.91') { const { decode } = await ctx.loadLib('openjpeg'); decodeFrame = async i => (await decode(frames[i])).data }
            else if (ts === '1.2.840.10008.1.2.4.57' || ts === '1.2.840.10008.1.2.4.70') { const { decode } = await ctx.loadLib('jpegll'); decodeFrame = i => decode(frames[i]).data }
            else { wrap.append(el('p', 'ur-error', `Снимок сжат способом «${esc(TS_NAME[ts] ?? ts)}» — такое сжатие читалка пока не распаковывает. Ниже — сведения об исследовании.`)); decodeFrame = null }
        } else decodeFrame = i => px.bytes.subarray(i * frameSize, (i + 1) * frameSize)
        if (decodeFrame) {
            const canvas = el('canvas', 'ur-dicom-canvas'); canvas.width = cols; canvas.height = rows
            const g = canvas.getContext('2d')
            const controls = el('div', 'ur-sci-controls ur-nosearch')
            const frame = nFrames > 1 ? slider('Кадр', 1, nFrames, 1) : null
            const center = slider('Яркость (центр окна)', 0, 1, 0, 1), width = slider('Контраст (ширина окна)', 1, 2, 1, 1)
            const reset = el('button', '', 'Сбросить')
            let values = null
            const big = new DataView(new ArrayBuffer(2)); void big
            const le = ts !== '1.2.840.10008.1.2.2'
            const load = async i => {
                const raw = await decodeFrame(i)
                if (isJpeg) { const bmp = await createImageBitmap(new Blob([raw], { type: 'image/jpeg' })); g.drawImage(bmp, 0, 0, cols, rows); values = null; return }
                if (spp === 3) { // цветной снимок
                    const im = g.createImageData(cols, rows); const n = rows * cols
                    for (let k = 0; k < n; k++) { for (let c = 0; c < 3; c++) im.data[k * 4 + c] = planar ? raw[c * n + k] : raw[k * 3 + c]; im.data[k * 4 + 3] = 255 }
                    if (photo.startsWith('YBR')) for (let k = 0; k < n; k++) { const y = im.data[k * 4], cb = im.data[k * 4 + 1] - 128, cr = im.data[k * 4 + 2] - 128; im.data[k * 4] = y + 1.402 * cr; im.data[k * 4 + 1] = y - 0.344136 * cb - 0.714136 * cr; im.data[k * 4 + 2] = y + 1.772 * cb }
                    g.putImageData(im, 0, 0); values = null; return
                }
                const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
                const n = rows * cols
                values = new Float32Array(n)
                for (let k = 0; k < n; k++) values[k] = (bits === 8 ? (signed ? dv.getInt8(k) : raw[k]) : bits === 32 ? (signed ? dv.getInt32(k * 4, le) : dv.getUint32(k * 4, le)) : (signed ? dv.getInt16(k * 2, le) : dv.getUint16(k * 2, le))) * slope + inter
            }
            const paint = () => {
                if (!values) return
                const c = +center.inp.value, w = +width.inp.value
                const im = g.createImageData(cols, rows), lo = c - w / 2
                const inv = photo === 'MONOCHROME1'
                for (let k = 0; k < values.length; k++) { let v = (values[k] - lo) / w * 255; v = v < 0 ? 0 : v > 255 ? 255 : v; if (inv) v = 255 - v; im.data[k * 4] = im.data[k * 4 + 1] = im.data[k * 4 + 2] = v; im.data[k * 4 + 3] = 255 }
                g.putImageData(im, 0, 0)
            }
            const setDefaults = () => {
                if (!values) return
                const [lo, hi] = autoRange(i => values[i], values.length)
                let mn = Infinity, mx = -Infinity; for (let k = 0; k < values.length; k += 7) { if (values[k] < mn) mn = values[k]; if (values[k] > mx) mx = values[k] }
                center.inp.min = Math.floor(mn); center.inp.max = Math.ceil(mx); width.inp.max = Math.max(2, Math.ceil(mx - mn) * 2)
                const wc = ds('00281050')[0], ww = ds('00281051')[0]
                center.set(Number.isFinite(wc) && ww > 0 ? Math.round(wc) : Math.round((lo + hi) / 2)); width.set(Number.isFinite(ww) && ww > 0 ? Math.round(ww) : Math.max(1, Math.round(hi - lo)))
            }
            await load(0); setDefaults(); paint()
            center.inp.addEventListener('input', paint); width.inp.addEventListener('input', paint)
            reset.onclick = () => { setDefaults(); paint() }
            if (frame) frame.inp.addEventListener('input', async () => { await load(+frame.inp.value - 1); paint() })
            if (values) controls.append(center.el, width.el, reset)
            if (frame) controls.prepend(frame.el)
            // колесо мыши — листать кадры
            if (frame) canvas.addEventListener('wheel', async e => { e.preventDefault(); const v = Math.max(1, Math.min(nFrames, +frame.inp.value + Math.sign(e.deltaY))); frame.set(v); await load(v - 1); paint() }, { passive: false })
            const stage = el('div', 'ur-dicom-stage'); stage.append(canvas); wrap.append(controls, stage)
        }
    }
    head.innerHTML = infoTable(info)
    // все элементы — в раскрывающемся списке
    const all = el('details', 'ur-dicom-tags', '<summary>Все поля файла</summary>')
    const tr = []
    const walk = (m, depth) => {
        for (const [t, x] of m) {
            if (t === '7FE00010') continue
            const label = DICT[t] ?? ''
            let v = ''
            if (x.items) { tr.push(`<tr><td>${'&nbsp;'.repeat(depth * 4)}(${t.slice(0, 4)},${t.slice(4)})</td><td>${esc(label)}</td><td>SQ</td><td>элементов: ${x.items.length}</td></tr>`); x.items.slice(0, 20).forEach(it => walk(it, depth + 1)); continue }
            if (['OB', 'OW', 'UN', 'OF', 'OD'].includes(x.vr)) v = `[двоичные данные, ${x.bytes.length} байт]`
            else if (x.vr === 'US' || x.vr === 'SS' || x.vr === 'UL' || x.vr === 'SL' || x.vr === 'FL' || x.vr === 'FD') { const dv = new DataView(x.bytes.buffer, x.bytes.byteOffset, x.bytes.byteLength); const sz = { US: 2, SS: 2, UL: 4, SL: 4, FL: 4, FD: 8 }[x.vr]; const a = []; for (let i = 0; i + sz <= x.bytes.length && a.length < 16; i += sz) a.push(num(x.vr === 'US' ? dv.getUint16(i, x.le) : x.vr === 'SS' ? dv.getInt16(i, x.le) : x.vr === 'UL' ? dv.getUint32(i, x.le) : x.vr === 'SL' ? dv.getInt32(i, x.le) : x.vr === 'FL' ? dv.getFloat32(i, x.le) : dv.getFloat64(i, x.le))); v = a.join('\\') }
            else if (x.vr === 'AT') v = `[${x.bytes.length / 4} тегов]`
            else v = utf8.decode(x.bytes.subarray(0, 400)).replace(/[\0 ]+$/, '')
            tr.push(`<tr><td>${'&nbsp;'.repeat(depth * 4)}(${t.slice(0, 4)},${t.slice(4)})</td><td>${esc(label)}</td><td>${esc(x.vr)}</td><td>${esc(v)}</td></tr>`)
        }
    }
    walk(tags, 0)
    all.append(el('table', 'ur-table', `<thead><tr><th>Тег</th><th>Название</th><th>Тип</th><th>Значение</th></tr></thead><tbody>${tr.join('')}</tbody>`))
    wrap.append(all)
    return wrap
}
const concat = arrs => { const n = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(n); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length } return o }

// ================= NIfTI (.nii, .nii.gz, а также .hdr/.img из Analyze — только .nii) =================
export const niftiView = async (ctx, buf) => {
    let u8 = new Uint8Array(buf)
    if (u8[0] === 0x1F && u8[1] === 0x8B) u8 = await gunzip(u8)
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    let le = dv.getInt32(0, true) === 348 || dv.getInt32(0, true) === 540
    const hs = dv.getInt32(0, le)
    if (hs !== 348 && hs !== 540) { le = !le; if (![348, 540].includes(dv.getInt32(0, le))) throw new ReaderError('Это не снимок NIfTI.') }
    const v2 = dv.getInt32(0, le) === 540
    const dim = [], pix = []
    let type, voxOff, slope, inter, descr
    if (!v2) { for (let i = 0; i < 8; i++) { dim.push(dv.getInt16(40 + i * 2, le)); pix.push(dv.getFloat32(76 + i * 4, le)) } type = dv.getInt16(70, le); voxOff = Math.floor(dv.getFloat32(108, le)); slope = dv.getFloat32(112, le); inter = dv.getFloat32(116, le); descr = latin.decode(u8.subarray(148, 228)).replace(/\0.*$/s, '') }
    else { for (let i = 0; i < 8; i++) { dim.push(Number(dv.getBigInt64(16 + i * 8, le))); pix.push(dv.getFloat64(104 + i * 8, le)) } type = dv.getInt16(12, le); voxOff = Number(dv.getBigInt64(168, le)); slope = dv.getFloat64(176, le); inter = dv.getFloat64(184, le); descr = latin.decode(u8.subarray(240, 320)).replace(/\0.*$/s, '') }
    if (!voxOff) voxOff = v2 ? 544 : 352
    if (!slope) { slope = 1; inter = 0 }
    const nd = dim[0], X = dim[1], Y = Math.max(1, nd >= 2 ? dim[2] : 1), Z = Math.max(1, nd >= 3 ? dim[3] : 1), T = Math.max(1, nd >= 4 ? dim[4] : 1)
    const T_ = { 2: [1, 'getUint8'], 4: [2, 'getInt16'], 8: [4, 'getInt32'], 16: [4, 'getFloat32'], 64: [8, 'getFloat64'], 256: [1, 'getInt8'], 512: [2, 'getUint16'], 768: [4, 'getUint32'] }[type]
    const rgb = type === 128
    if (!T_ && !rgb) throw new ReaderError(`Тип данных NIfTI (${type}) пока не поддерживается.`)
    const bpv = rgb ? 3 : T_[0]
    const volSize = X * Y * Z
    if (voxOff + volSize * bpv > u8.length) throw new ReaderError('Файл NIfTI обрезан или данные лежат в отдельном файле .img.')
    const get = (t, i) => rgb ? u8[voxOff + (t * volSize + i) * 3] : dv[T_[1]](voxOff + (t * volSize + i) * bpv, le) * slope + inter
    return volumeView(ctx, { X, Y, Z, T, get, pix, descr })
}
export const volumeView = (ctx, { X, Y, Z, T = 1, get, pix = [0, 1, 1, 1], descr = '' }) => {
    const volSize = X * Y * Z
    const wrap = el('div', 'ur-nifti')
    wrap.append(el('div', 'ur-meta', esc([`${X}×${Y}×${Z}${T > 1 ? ` × ${T} объёмов` : ''}`, `вокселы ${pix.slice(1, 4).map(v => +v.toFixed(2)).join('×')} мм`, descr].filter(Boolean).join(' · '))))
    const [lo, hi] = autoRange(i => get(0, i), volSize)
    const controls = el('div', 'ur-sci-controls ur-nosearch')
    const vol = T > 1 ? slider('Объём (время)', 1, T, 1) : null
    const contrast = slider('Контраст', 10, 300, 100)
    if (vol) controls.append(vol.el)
    controls.append(contrast.el)
    wrap.append(controls)
    const grid = el('div', 'ur-nifti-grid'); wrap.append(grid)
    // три среза: аксиальный (z), корональный (y), сагиттальный (x)
    const views = [['Аксиальный (сверху)', Z, (s, a, b) => a + b * X + s * X * Y, X, Y, pix[1], pix[2]], ['Корональный (спереди)', Y, (s, a, b) => a + s * X + b * X * Y, X, Z, pix[1], pix[3]], ['Сагиттальный (сбоку)', X, (s, a, b) => s + a * X + b * X * Y, Y, Z, pix[2], pix[3]]]
    const paints = []
    for (const [label, n, idx, W, H, sw, sh] of views) {
        if (n < 1 || W < 2 || H < 2) continue
        const box = el('figure', 'ur-nifti-view')
        const c = el('canvas'); c.width = W; c.height = H
        // учитываем размер вокселов, чтобы срез не был сплюснут
        c.style.aspectRatio = `${W * (Math.abs(sw) || 1)} / ${H * (Math.abs(sh) || 1)}`
        const s = slider(label, 1, n, Math.ceil(n / 2))
        box.append(c, s.el)
        grid.append(box)
        const g = c.getContext('2d')
        const paint = () => {
            const t = vol ? +vol.inp.value - 1 : 0, sl = +s.inp.value - 1, k = +contrast.inp.value / 100
            const mid = (lo + hi) / 2, half = (hi - lo) / 2 / k
            const im = g.createImageData(W, H)
            for (let b = 0; b < H; b++) for (let a = 0; a < W; a++) {
                let v = (get(t, idx(sl, a, b)) - (mid - half)) / (2 * half) * 255; v = v < 0 ? 0 : v > 255 ? 255 : v
                const o = ((H - 1 - b) * W + a) * 4 // в NIfTI ось вверх — переворачиваем
                im.data[o] = im.data[o + 1] = im.data[o + 2] = v; im.data[o + 3] = 255
            }
            g.putImageData(im, 0, 0)
        }
        s.inp.addEventListener('input', paint)
        paints.push(paint); paint()
    }
    contrast.inp.addEventListener('input', () => paints.forEach(f => f()))
    vol?.inp.addEventListener('input', () => paints.forEach(f => f()))
    return wrap
}

// ================= EDF, EDF+, BDF: записи ЭЭГ, ЭКГ, сна =================
export const parseEdf = buf => {
    const u8 = new Uint8Array(buf)
    const s = (o, n) => latin.decode(u8.subarray(o, o + n)).trim()
    const bdf = u8[0] === 0xFF && s(1, 7) === 'BIOSEMI'
    if (!bdf && s(0, 8) !== '0') throw new ReaderError('Это не запись EDF/BDF.')
    const ns = +s(252, 4), nrec = +s(236, 8), dur = +s(244, 8) || 1
    const hb = +s(184, 8)
    const at = (field, len, i) => s(256 + field * ns + i * len, len)
    const off = []; { let acc = 0; for (const l of [16, 80, 8, 8, 8, 8, 8, 80, 8, 32]) { off.push(acc); acc += l * ns } }
    const sig = []
    for (let i = 0; i < ns; i++) {
        const f = (k, len) => s(256 + off[k] + i * len, len)
        sig.push({ label: f(0, 16), transducer: f(1, 80), unit: f(2, 8), pmin: +f(3, 8), pmax: +f(4, 8), dmin: +f(5, 8), dmax: +f(6, 8), filter: f(7, 80), n: +f(8, 8) })
    }
    void at
    const bps = bdf ? 3 : 2
    const recBytes = sig.reduce((a, x) => a + x.n * bps, 0)
    let pos = 0; for (const x of sig) { x.off = pos; pos += x.n * bps; x.gain = (x.pmax - x.pmin) / ((x.dmax - x.dmin) || 1); x.fs = x.n / dur }
    const nRec = nrec > 0 ? nrec : Math.floor((u8.length - hb) / recBytes)
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    const sample = (x, k) => { const r = Math.floor(k / x.n), j = k % x.n; const o = hb + r * recBytes + x.off + j * bps; if (o + bps > u8.length) return NaN; const d = bdf ? ((u8[o] | u8[o + 1] << 8 | u8[o + 2] << 16) << 8 >> 8) : dv.getInt16(o, true); return (d - x.dmin) * x.gain + x.pmin }
    const ann = []
    for (const x of sig.filter(x => /Annotations/i.test(x.label))) {
        for (let r = 0; r < nRec; r++) {
            const o = hb + r * recBytes + x.off
            const txt = utf8.decode(u8.subarray(o, o + x.n * bps))
            for (const tal of txt.split('\0')) {
                const m = /^([+-][\d.]+)(?:\x15([\d.]+))?\x14(.*)$/s.exec(tal); if (!m) continue
                for (const t of m[3].split('\x14').filter(Boolean)) ann.push({ t: +m[1], d: +(m[2] ?? 0), text: t })
            }
        }
    }
    const start = (() => { const d = s(168, 8), t = s(176, 8); const m = /(\d+)\.(\d+)\.(\d+)/.exec(d); const n = /(\d+)\.(\d+)\.(\d+)/.exec(t); return m ? `${m[1]}.${m[2]}.${+m[3] < 85 ? 2000 + +m[3] : 1900 + +m[3]}${n ? ` ${n[1]}:${n[2]}:${n[3]}` : ''}` : '' })()
    return { patient: s(8, 80), recording: s(88, 80), start, total: nRec * dur, signals: sig.filter(x => !/Annotations/i.test(x.label)), ann, sample, bdf, plus: /EDF\+/.test(s(192, 44)) }
}
export const edfView = (ctx, buf) => {
    const e = parseEdf(buf)
    if (!e.signals.length) throw new ReaderError('В записи нет сигналов.')
    const wrap = el('div', 'ur-edf')
    const fmtT = t => { const s = Math.floor(t); return `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ':' : ''}${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
    wrap.append(el('div', 'ur-meta', esc([e.bdf ? 'BDF' : e.plus ? 'EDF+' : 'EDF', e.start, `длительность ${fmtT(e.total)}`, `каналов: ${e.signals.length}`, e.patient && e.patient !== 'X X X X' ? `пациент: ${e.patient}` : ''].filter(Boolean).join(' · '))))
    const controls = el('div', 'ur-sci-controls ur-nosearch')
    const win = el('select', '', [5, 10, 30, 60, 300].map(v => `<option value="${v}"${v === 10 ? ' selected' : ''}>${v < 60 ? v + ' с' : v / 60 + ' мин'}</option>`).join(''))
    const pos = slider('Время', 0, Math.max(0, Math.ceil(e.total - 1)), 0, 1)
    const sel = el('label', '', 'Окно: '); sel.append(win)
    controls.append(sel, pos.el)
    const canvas = el('canvas', 'ur-edf-canvas')
    const H = Math.min(80, Math.max(40, 600 / e.signals.length))
    canvas.width = 1100; canvas.height = H * Math.min(e.signals.length, 64) + 24
    wrap.append(controls, canvas)
    const g = canvas.getContext('2d')
    const draw = () => {
        const t0 = +pos.inp.value, w = +win.value
        pos.out.textContent = fmtT(t0)
        const fg = ctx.themeColors?.().text ?? '#333'
        g.clearRect(0, 0, canvas.width, canvas.height)
        g.font = '11px sans-serif'
        const L = 110, W = canvas.width - L - 6
        e.signals.slice(0, 64).forEach((x, i) => {
            const y0 = i * H
            const k0 = Math.floor(t0 * x.fs), k1 = Math.min(Math.floor((t0 + w) * x.fs), Math.floor(e.total * x.fs))
            const step = Math.max(1, Math.floor((k1 - k0) / (W * 2)))
            let mn = Infinity, mx = -Infinity
            const vals = []
            for (let k = k0; k < k1; k += step) { const v = x.sample(x, k); vals.push([k, v]); if (v < mn) mn = v; if (v > mx) mx = v }
            g.fillStyle = fg; g.globalAlpha = 0.8; g.fillText(x.label.slice(0, 16), 4, y0 + H / 2); g.globalAlpha = 0.5; g.fillText(x.unit, 4, y0 + H / 2 + 13); g.globalAlpha = 1
            g.strokeStyle = `hsl(${(i * 47) % 360} 60% 45%)`; g.lineWidth = 1; g.beginPath()
            const span = mx - mn || 1
            vals.forEach(([k, v], j) => { const px = L + (k - k0) / ((w * x.fs) || 1) * W, py = y0 + 4 + (1 - (v - mn) / span) * (H - 8); j ? g.lineTo(px, py) : g.moveTo(px, py) })
            g.stroke()
        })
        // отметки времени и аннотации
        g.fillStyle = fg; g.globalAlpha = 0.6
        for (let k = 0; k <= 5; k++) g.fillText(fmtT(t0 + w * k / 5), L + W * k / 5 - (k === 5 ? 40 : 0), canvas.height - 6)
        g.globalAlpha = 1
        for (const a of e.ann) if (a.t >= t0 && a.t <= t0 + w) { const px = L + (a.t - t0) / w * W; g.strokeStyle = '#e44'; g.beginPath(); g.moveTo(px, 0); g.lineTo(px, canvas.height - 20); g.stroke(); g.fillStyle = '#e44'; g.fillText(a.text.slice(0, 30), px + 3, 12) }
    }
    e.signals.forEach(x => { x.sample = e.sample })
    win.onchange = draw; pos.inp.addEventListener('input', draw)
    draw()
    if (e.ann.length) {
        const list = el('div', 'ur-edf-ann', `<h3>Отметки (${e.ann.length})</h3>`)
        const ul = el('ul')
        for (const a of e.ann.slice(0, 2000)) { const li = el('li', '', `<a href="#">${fmtT(a.t)}</a> ${esc(a.text)}`); li.querySelector('a').onclick = ev => { ev.preventDefault(); pos.set(Math.max(0, Math.floor(a.t - 1))); draw() }; ul.append(li) }
        list.append(ul); wrap.append(list)
    }
    wrap.append(el('details', '', `<summary>Каналы</summary>${`<table class="ur-table"><thead><tr><th>Канал</th><th>Единицы</th><th>Частота, Гц</th><th>Диапазон</th><th>Фильтры</th><th>Датчик</th></tr></thead><tbody>${e.signals.map(x => `<tr><td>${esc(x.label)}</td><td>${esc(x.unit)}</td><td>${num(x.fs)}</td><td>${num(x.pmin)} … ${num(x.pmax)}</td><td>${esc(x.filter)}</td><td>${esc(x.transducer)}</td></tr>`).join('')}</tbody></table>`}`))
    return wrap
}

// ================= Проточная цитометрия (.fcs) =================
export const parseFcs = buf => {
    const u8 = new Uint8Array(buf)
    const h = latin.decode(u8.subarray(0, 58))
    if (!/^FCS\d\.\d/.test(h)) throw new ReaderError('Это не файл проточной цитометрии FCS.')
    const n = i => +h.slice(10 + i * 8, 18 + i * 8).trim()
    const t0 = n(0), t1 = n(1)
    const raw = utf8.decode(u8.subarray(t0, t1 + 1))
    const delim = raw[0]
    const kw = {}
    let parts = [], cur = ''
    for (let i = 1; i < raw.length; i++) { if (raw[i] === delim) { if (raw[i + 1] === delim) { cur += delim; i++; continue } parts.push(cur); cur = '' } else cur += raw[i] }
    if (cur) parts.push(cur)
    for (let i = 0; i + 1 < parts.length; i += 2) kw[parts[i].toUpperCase()] = parts[i + 1]
    const d0 = n(2) || +kw.$BEGINDATA, d1 = n(3) || +kw.$ENDDATA
    const P = +kw.$PAR, N = +kw.$TOT
    const type = kw.$DATATYPE, le = (kw.$BYTEORD ?? '1,2,3,4').startsWith('1')
    const params = Array.from({ length: P }, (_, i) => ({ name: kw[`$P${i + 1}N`] ?? `P${i + 1}`, label: kw[`$P${i + 1}S`] ?? '', bits: +kw[`$P${i + 1}B`], range: +kw[`$P${i + 1}R`] }))
    const dv = new DataView(u8.buffer, u8.byteOffset)
    const data = params.map(() => new Float32Array(N))
    let p = d0
    if (type === 'F' || type === 'D') { const sz = type === 'F' ? 4 : 8; for (let e = 0; e < N; e++) for (let k = 0; k < P; k++) { data[k][e] = sz === 4 ? dv.getFloat32(p, le) : dv.getFloat64(p, le); p += sz } }
    else if (type === 'I') {
        for (let e = 0; e < N; e++) for (let k = 0; k < P; k++) { const b = params[k].bits; const v = b === 8 ? u8[p] : b === 16 ? dv.getUint16(p, le) : b === 32 ? dv.getUint32(p, le) : 0; const mask = params[k].range > 0 && (params[k].range & (params[k].range - 1)) === 0 ? params[k].range - 1 : 0xFFFFFFFF; data[k][e] = v & mask; p += b / 8 }
    } else throw new ReaderError(`Вид данных FCS «${type}» пока не поддерживается.`)
    void d1
    return { kw, params, data, N, version: h.slice(0, 6) }
}
export const fcsView = (ctx, buf) => {
    const f = parseFcs(buf)
    const wrap = el('div', 'ur-fcs')
    wrap.append(el('div', 'ur-meta', esc([f.version, `событий: ${f.N}`, `параметров: ${f.params.length}`, f.kw.$DATE, f.kw.$CYT, f.kw.$FIL].filter(Boolean).join(' · '))))
    const opts = f.params.map((p, i) => `<option value="${i}">${esc(p.name)}${p.label ? ` (${esc(p.label)})` : ''}</option>`).join('')
    const controls = el('div', 'ur-sci-controls ur-nosearch', `<label>X: <select class="x">${opts}</select></label> <label>Y: <select class="y">${opts}</select></label> <label><input type="checkbox" class="log"> логарифмическая шкала</label>`)
    const sx = controls.querySelector('.x'), sy = controls.querySelector('.y'), lg = controls.querySelector('.log')
    sy.value = String(Math.min(1, f.params.length - 1))
    const canvas = el('canvas', 'ur-fcs-canvas'); canvas.width = 560; canvas.height = 560
    wrap.append(controls, canvas)
    const g = canvas.getContext('2d')
    const draw = () => {
        const X = f.data[+sx.value], Y = f.data[+sy.value], log = lg.checked
        const tr = v => log ? Math.log10(Math.max(1, v)) : v
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
        for (let i = 0; i < f.N; i++) { const a = tr(X[i]), b = tr(Y[i]); if (a < x0) x0 = a; if (a > x1) x1 = a; if (b < y0) y0 = b; if (b > y1) y1 = b }
        const S = 256, bins = new Uint32Array(S * S)
        for (let i = 0; i < f.N; i++) { const a = Math.min(S - 1, Math.floor((tr(X[i]) - x0) / ((x1 - x0) || 1) * S)), b = Math.min(S - 1, Math.floor((tr(Y[i]) - y0) / ((y1 - y0) || 1) * S)); bins[(S - 1 - b) * S + a]++ }
        let mx = 0; for (const v of bins) if (v > mx) mx = v
        const off = new OffscreenCanvas(S, S), og = off.getContext('2d'), im = og.createImageData(S, S)
        for (let k = 0; k < bins.length; k++) { if (!bins[k]) continue; const t = Math.log(1 + bins[k]) / Math.log(1 + mx); const hue = 240 - t * 240; const [r, gg, b] = hsl(hue, 0.9, 0.5); im.data.set([r, gg, b, 255], k * 4) }
        og.putImageData(im, 0, 0)
        g.clearRect(0, 0, canvas.width, canvas.height)
        g.imageSmoothingEnabled = false
        g.drawImage(off, 40, 10, 510, 510)
        const fg = ctx.themeColors?.().text ?? '#333'
        g.fillStyle = fg; g.font = '12px sans-serif'
        g.fillText(f.params[+sx.value].name, 280, 552); g.save(); g.translate(14, 280); g.rotate(-Math.PI / 2); g.fillText(f.params[+sy.value].name, 0, 0); g.restore()
        g.globalAlpha = 0.6; g.fillText(num(log ? 10 ** x0 : x0), 40, 535); g.fillText(num(log ? 10 ** x1 : x1), 500, 535); g.globalAlpha = 1
    }
    sx.onchange = sy.onchange = lg.onchange = draw
    draw()
    const show = Math.min(f.N, 500)
    wrap.append(el('details', '', `<summary>События (первые ${show})</summary><table class="ur-table"><thead><tr>${f.params.map(p => `<th>${esc(p.name)}</th>`).join('')}</tr></thead><tbody>${Array.from({ length: show }, (_, e) => `<tr>${f.data.map(col => `<td>${num(col[e])}</td>`).join('')}</tr>`).join('')}</tbody></table>`))
    wrap.append(el('details', '', `<summary>Все сведения файла</summary><table class="ur-table"><tbody>${Object.entries(f.kw).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`))
    return wrap
}
const hsl = (h, s, l) => { const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l); const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return [f(0) * 255, f(8) * 255, f(4) * 255] }

// ================= Масс-спектрометрия (.mzML) =================
export const mzmlView = async (ctx, buf) => {
    const text = utf8.decode(new Uint8Array(buf))
    if (!/<mzML[\s>]/.test(text)) throw new ReaderError('Это не файл mzML.')
    const spectra = []
    const re = /<spectrum\s[^>]*>[\s\S]*?<\/spectrum>/g
    let m
    while ((m = re.exec(text)) && spectra.length < 200000) {
        const s = m[0]
        const cv = acc => new RegExp(`accession="${acc}"[^>]*?value="([^"]*)"`).exec(s)?.[1]
        const rtUnit = /accession="MS:1000016"[^>]*unitName="([^"]*)"/.exec(s)?.[1]
        let rt = +cv('MS:1000016'); if (rtUnit === 'second') rt /= 60
        spectra.push({ id: /id="([^"]*)"/.exec(s)?.[1] ?? '', level: +cv('MS:1000511') || 1, rt, bp: +cv('MS:1000504'), tic: +cv('MS:1000285'), prec: +(/<selectedIon>[\s\S]*?accession="MS:1000744"[^>]*?value="([^"]*)"/.exec(s)?.[1] ?? NaN), at: m.index, len: s.length })
    }
    if (!spectra.length) throw new ReaderError('В файле нет спектров.')
    const decodeArr = async b => {
        const raw = Uint8Array.from(atob(/<binary>([^<]*)<\/binary>/.exec(b)?.[1] ?? ''), c => c.charCodeAt(0))
        const data = /MS:1000574/.test(b) ? await inflateZlibSafe(raw) : raw
        const f64 = /MS:1000523/.test(b)
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
        const n = data.length / (f64 ? 8 : 4)
        const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = f64 ? dv.getFloat64(i * 8, true) : dv.getFloat32(i * 4, true)
        return a
    }
    const spectrumOf = async sp => {
        const s = text.substr(sp.at, sp.len)
        let mz = null, it = null
        for (const b of s.match(/<binaryDataArray[\s\S]*?<\/binaryDataArray>/g) ?? []) { if (/MS:1000514/.test(b)) mz = await decodeArr(b); else if (/MS:1000515/.test(b)) it = await decodeArr(b) }
        return { mz: mz ?? [], it: it ?? [] }
    }
    const fg = ctx.themeColors?.().text ?? '#333'
    const wrap = el('div', 'ur-mzml')
    const ms1 = spectra.filter(s => s.level === 1 && Number.isFinite(s.rt))
    wrap.append(el('div', 'ur-meta', `Спектров: ${spectra.length} (MS1: ${spectra.filter(s => s.level === 1).length}, MS2: ${spectra.filter(s => s.level === 2).length})`))
    if (ms1.length > 1 && ms1.some(s => s.tic)) {
        const W = 900, H = 160, x0 = ms1[0].rt, x1 = ms1[ms1.length - 1].rt, y1 = Math.max(...ms1.map(s => s.tic || 0))
        const d = ms1.map((s, i) => `${i ? 'L' : 'M'}${(40 + (s.rt - x0) / ((x1 - x0) || 1) * (W - 50)).toFixed(1)} ${(H - 20 - (s.tic || 0) / (y1 || 1) * (H - 30)).toFixed(1)}`).join('')
        wrap.append(el('section', '', `<h3>Хроматограмма (сумма ионов)</h3><svg viewBox="0 0 ${W} ${H}" class="ur-chart"><path d="${d}" fill="none" stroke="#3a7" stroke-width="1.3"/><g fill="${fg}" font-size="11" opacity="0.7"><text x="40" y="${H - 4}">${num(x0)} мин</text><text x="${W - 10}" y="${H - 4}" text-anchor="end">${num(x1)} мин</text></g></svg>`))
    }
    const plot = el('section', 'ur-mz-plot', '<p class="ur-muted">Нажмите на строку таблицы, чтобы увидеть спектр.</p>')
    wrap.append(plot)
    const table = el('table', 'ur-table ur-arc-table', '<thead><tr><th>№</th><th>Уровень</th><th>Время, мин</th><th>Главный пик m/z</th><th>Прекурсор m/z</th><th>Сумма ионов</th></tr></thead>')
    const tb = el('tbody')
    spectra.slice(0, 5000).forEach((sp, i) => {
        const tr = el('tr', '', `<td>${i + 1}</td><td>MS${sp.level}</td><td>${Number.isFinite(sp.rt) ? num(sp.rt) : ''}</td><td>${Number.isFinite(sp.bp) ? num(sp.bp) : ''}</td><td>${Number.isFinite(sp.prec) ? num(sp.prec) : ''}</td><td>${Number.isFinite(sp.tic) ? num(sp.tic) : ''}</td>`)
        tr.onclick = async () => {
            const { mz, it } = await spectrumOf(sp)
            if (!mz.length) { plot.innerHTML = '<p>В спектре нет точек.</p>'; return }
            const W = 900, H = 260
            let x0 = Infinity, x1 = -Infinity, y1 = 0; for (let k = 0; k < mz.length; k++) { x0 = Math.min(x0, mz[k]); x1 = Math.max(x1, mz[k]); y1 = Math.max(y1, it[k] ?? 0) }
            const sx = x => 40 + (x - x0) / ((x1 - x0) || 1) * (W - 50), sy = y => H - 22 - y / (y1 || 1) * (H - 40)
            let lines = ''; for (let k = 0; k < mz.length; k++) lines += `M${sx(mz[k]).toFixed(1)} ${H - 22}V${sy(it[k] ?? 0).toFixed(1)}`
            const top = [...mz.keys()].sort((a, b) => (it[b] ?? 0) - (it[a] ?? 0)).slice(0, 8)
            plot.innerHTML = `<h3>Спектр ${i + 1}: MS${sp.level}${Number.isFinite(sp.rt) ? `, ${num(sp.rt)} мин` : ''} — ${mz.length} пиков</h3><svg viewBox="0 0 ${W} ${H}" class="ur-chart"><path d="${lines}" stroke="#36c" stroke-width="1"/><g fill="${fg}" font-size="10">${top.map(k => `<text x="${sx(mz[k])}" y="${sy(it[k]) - 3}" text-anchor="middle">${num(+mz[k].toFixed(3))}</text>`).join('')}<text x="40" y="${H - 6}" opacity="0.7">${num(x0)}</text><text x="${W - 10}" y="${H - 6}" text-anchor="end" opacity="0.7">${num(x1)} m/z</text></g></svg>`
            tb.querySelectorAll('tr').forEach(r => r.classList.toggle('is-active', r === tr))
        }
        tb.append(tr)
    })
    table.append(tb); wrap.append(table)
    tb.firstChild?.click()
    return wrap
}
const inflateZlibSafe = async raw => { const { inflateZlib, inflateSync } = await import('./compress.js'); try { return await inflateZlib(raw) } catch { return inflateSync(raw.subarray(2)) } }

// ================= Тайлы карт (.mbtiles) =================
export const mbtilesView = async (ctx, buf) => {
    const { initSqlJs } = await ctx.loadLib('sqlite')
    const SQL = await initSqlJs(); const db = new SQL.Database(new Uint8Array(buf))
    try {
        const meta = Object.fromEntries(db.exec('SELECT name, value FROM metadata')[0]?.values ?? [])
        const zooms = db.exec('SELECT zoom_level, COUNT(*), MIN(tile_column), MAX(tile_column), MIN(tile_row), MAX(tile_row) FROM tiles GROUP BY zoom_level ORDER BY zoom_level')[0]?.values ?? []
        if (!zooms.length) throw new ReaderError('В архиве нет тайлов.')
        const wrap = el('div', 'ur-mbtiles')
        const vector = /pbf|mvt/.test(meta.format ?? '')
        wrap.append(el('div', '', `<h2>${esc(meta.name ?? 'Тайлы карты')}</h2>${meta.description ? `<p>${esc(meta.description)}</p>` : ''}` + infoTable([['Формат', meta.format ?? ''], ['Масштабы', `${zooms[0][0]}–${zooms[zooms.length - 1][0]}`], ['Тайлов', String(zooms.reduce((s, z) => s + z[1], 0))], ['Границы', meta.bounds ?? ''], ['Авторство', (meta.attribution ?? '').replace(/<[^>]+>/g, '')]])))
        if (vector) { wrap.append(el('p', 'ur-muted', 'Это векторные тайлы — их отрисовка пока не поддерживается, показаны только сведения.')); return wrap }
        const usable = zooms.filter(z => (z[3] - z[2] + 1) * (z[5] - z[4] + 1) <= 256)
        if (!usable.length) { wrap.append(el('p', 'ur-muted', 'Слишком много тайлов на каждом масштабе, чтобы собрать картинку.')); return wrap }
        const sel = el('select', '', usable.map(z => `<option value="${z[0]}">Масштаб ${z[0]} (${z[1]} тайлов)</option>`).join(''))
        sel.value = String(usable[usable.length - 1][0])
        const box = el('div', 'ur-mbtiles-mosaic')
        const ctl = el('div', 'ur-sci-controls ur-nosearch'); ctl.append(sel)
        wrap.append(ctl, box)
        const urls = []
        const draw = async () => {
            urls.forEach(u => URL.revokeObjectURL(u)); urls.length = 0
            const z = usable.find(x => x[0] === +sel.value)
            const [, , c0, c1, r0, r1] = z
            const res = db.exec(`SELECT tile_column, tile_row, tile_data FROM tiles WHERE zoom_level = ${+sel.value}`)[0]?.values ?? []
            const grid = el('div', 'ur-mbtiles-grid'); grid.style.gridTemplateColumns = `repeat(${c1 - c0 + 1}, minmax(0, 256px))`
            const cells = new Map(res.map(([c, r, d]) => [`${c},${r}`, d]))
            for (let r = r1; r >= r0; r--) for (let c = c0; c <= c1; c++) { // строки в MBTiles идут снизу вверх
                const d = cells.get(`${c},${r}`)
                if (d) { const u = URL.createObjectURL(new Blob([d])); urls.push(u); ctx.urls.push(u); grid.append(el('img', '', null)); grid.lastChild.src = u } else grid.append(el('div', 'ur-mbtiles-empty'))
            }
            box.replaceChildren(grid)
        }
        sel.onchange = draw
        await draw()
        return wrap
    } finally { /* база нужна для смены масштаба — не закрываем */ }
}

// ================= GeoPackage (.gpkg): таблицы и карта =================
export const wkbToFeats = (u8, feats = []) => {
    let p = 0
    const read = () => {
        const le = u8[p] === 1; p++
        const dv = new DataView(u8.buffer, u8.byteOffset)
        let type = dv.getUint32(p, le); p += 4
        let dims = 2
        if (type & 0x80000000) dims++; if (type & 0x40000000) dims++
        if (type & 0x20000000) p += 4 // SRID в EWKB
        type &= 0xFFFF
        if (type > 3000) { dims = 4; type -= 3000 } else if (type > 2000) { dims = 3; type -= 2000 } else if (type > 1000) { dims = 3; type -= 1000 }
        const pt = () => { const c = [dv.getFloat64(p, le), dv.getFloat64(p + 8, le)]; p += dims * 8; return c }
        const n = () => { const v = dv.getUint32(p, le); p += 4; return v }
        const ring = () => Array.from({ length: n() }, pt)
        switch (type) {
            case 1: feats.push({ kind: 'point', coords: [pt()] }); break
            case 2: feats.push({ kind: 'line', coords: ring() }); break
            case 3: feats.push({ kind: 'poly', coords: Array.from({ length: n() }, ring) }); break
            case 4: case 5: case 6: case 7: { const k = n(); for (let i = 0; i < k; i++) read(); break }
            default: throw new Error('geom ' + type)
        }
    }
    read()
    return feats
}
export const gpkgGeom = u8 => {
    if (!(u8[0] === 0x47 && u8[1] === 0x50)) return null
    const flags = u8[3]
    const env = [0, 32, 48, 48, 64][(flags >> 1) & 7] ?? 0
    return u8.subarray(8 + env)
}
export const readGpkg = async (ctx, buf) => {
    const { initSqlJs } = await ctx.loadLib('sqlite')
    const SQL = await initSqlJs(); const db = new SQL.Database(new Uint8Array(buf))
    try {
        const geomCols = new Map((db.exec('SELECT table_name, column_name FROM gpkg_geometry_columns')[0]?.values ?? []).map(r => [r[0], r[1]]))
        const contents = db.exec("SELECT table_name, data_type, identifier FROM gpkg_contents")[0]?.values ?? []
        const sheets = [], feats = []
        for (const [t, kind, ident] of contents) {
            const q = `"${String(t).replace(/"/g, '""')}"`
            if (kind === 'tiles' || kind === '2d-gridded-coverage') { sheets.push({ name: `${ident || t} (тайлы)`, rows: [['Сведения'], ['Растровые тайлы GeoPackage — показаны только как часть списка.']] }); continue }
            const res = db.exec(`SELECT * FROM ${q} LIMIT 5000`)[0]
            if (!res) { sheets.push({ name: String(ident || t), rows: [['(пусто)']] }); continue }
            const gc = geomCols.get(t)
            const gi = res.columns.indexOf(gc)
            const nameCol = res.columns.findIndex((c, i) => i !== gi && /^(name|название|title|label)$/i.test(c))
            const rows = [res.columns, ...res.values.map(r => r.map((v, i) => {
                if (v instanceof Uint8Array) {
                    if (i === gi) { const w = gpkgGeom(v); if (w) { try { const f = wkbToFeats(w); f.forEach(x => { x.name = nameCol >= 0 ? String(r[nameCol]) : `${ident || t}` }); feats.push(...f); return f.map(x => x.kind === 'point' ? `ТОЧКА (${x.coords[0].map(c => +c.toFixed(6)).join(' ')})` : x.kind === 'line' ? `ЛИНИЯ (${x.coords.length} точек)` : `МНОГОУГОЛЬНИК (${x.coords[0]?.length ?? 0} точек)`).join('; ') } catch { /* необычная геометрия */ } } }
                    return `[данные, ${v.length} байт]`
                }
                return v == null ? '' : String(v)
            }))]
            sheets.push({ name: String(ident || t), rows })
        }
        if (!sheets.length) throw new ReaderError('В GeoPackage нет таблиц.')
        return { sheets, feats }
    } finally { db.close() }
}

// ================= NRRD: объёмные данные (медицина, наука) =================
export const nrrdView = async (ctx, buf) => {
    const u8 = new Uint8Array(buf)
    if (latin.decode(u8.subarray(0, 4)) !== 'NRRD') throw new ReaderError('Это не файл NRRD.')
    let he = -1; for (let i = 0; i + 1 < Math.min(u8.length, 1 << 20); i++) if (u8[i] === 10 && (u8[i + 1] === 10 || u8[i + 1] === 13 && u8[i + 2] === 10)) { he = i + (u8[i + 1] === 10 ? 2 : 3); break }
    if (he < 0) throw new ReaderError('Не найден конец заголовка NRRD.')
    const head = {}
    for (const l of latin.decode(u8.subarray(0, he)).split(/\r?\n/)) { const m = /^([^#:][^:]*):=?\s*(.*)$/.exec(l); if (m) head[m[1].trim().toLowerCase()] = m[2].trim() }
    if (head['data file'] || head.datafile) throw new ReaderError('Данные этого NRRD лежат в отдельном файле — откройте его заголовок вместе с данными нельзя.')
    const sizes = head.sizes.split(/\s+/).map(Number)
    const type = head.type.toLowerCase()
    const T_ = /^(uchar|unsigned char|uint8|uint8_t)$/.test(type) ? [1, 'getUint8'] : /^(signed char|int8|int8_t|char)$/.test(type) ? [1, 'getInt8'] : /^(short|short int|signed short|int16|int16_t)/.test(type) ? [2, 'getInt16'] : /^(ushort|unsigned short|uint16|uint16_t)/.test(type) ? [2, 'getUint16'] : /^(int|signed int|int32|int32_t)$/.test(type) ? [4, 'getInt32'] : /^(uint|unsigned int|uint32|uint32_t)$/.test(type) ? [4, 'getUint32'] : type === 'float' ? [4, 'getFloat32'] : type === 'double' ? [8, 'getFloat64'] : null
    if (!T_) throw new ReaderError(`Тип данных NRRD «${type}» пока не поддерживается.`)
    let data = u8.subarray(he)
    const enc = (head.encoding ?? 'raw').toLowerCase()
    if (enc === 'gzip' || enc === 'gz') data = await gunzip(data)
    else if (enc === 'ascii' || enc === 'text' || enc === 'txt') { const v = latin.decode(data).trim().split(/\s+/).map(Number); const f = new Float64Array(v); data = new Uint8Array(f.buffer); T_[0] = 8; T_[1] = 'getFloat64' }
    else if (enc !== 'raw') throw new ReaderError(`Кодировка NRRD «${enc}» пока не поддерживается.`)
    const le = (head.endian ?? 'little') !== 'big' || enc === 'ascii'
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
    // первое измерение может быть каналами (вектор/цвет) — берём первый канал
    let comps = 1, dims = sizes
    if (sizes.length === 4 || (sizes.length === 3 && sizes[0] <= 4 && /vector|rgb|color|list/i.test(head.kinds ?? ''))) { comps = sizes[0]; dims = sizes.slice(1) }
    const [X, Y = 1, Z = 1] = dims
    const sp = head['space directions'] ? [...head['space directions'].matchAll(/\(([^)]*)\)/g)].map(m => Math.hypot(...m[1].split(',').map(Number))) : head.spacings ? head.spacings.split(/\s+/).map(Number) : [1, 1, 1]
    const get = (t, i) => { const o = i * comps * T_[0]; return o + T_[0] <= data.length ? dv[T_[1]](o, le) : 0 }
    return volumeView(ctx, { X, Y, Z, T: 1, get, pix: [0, ...sp.slice(-3)], descr: head.content ?? '' })
}
