// Карты и треки версии 0.6: Garmin FIT, OpenStreetMap (.osm, .osm.pbf), GML, MapInfo (.mif), Sigma (.slf),
// выгрузка «Здоровья» Apple (export.xml), таблицы CSV со столбцами широты и долготы
import { ReaderError } from '../util.js'
import { inflateSync } from './compress.js'
import { unzlibSync } from 'fflate'

const latin = new TextDecoder('latin1')
const utf8 = new TextDecoder()
const xmlDoc = (text, what) => { const d = new DOMParser().parseFromString(text, 'application/xml'); if (d.querySelector('parsererror')) throw new ReaderError(`Не удалось прочитать ${what} (ошибка XML).`); return d }

// ================= Garmin FIT =================
const FIT_BASE = { 0: [1, 'getUint8'], 1: [1, 'getInt8'], 2: [1, 'getUint8'], 0x83: [2, 'getInt16'], 0x84: [2, 'getUint16'], 0x85: [4, 'getInt32'], 0x86: [4, 'getUint32'], 7: [1, null], 0x88: [4, 'getFloat32'], 0x89: [8, 'getFloat64'], 0x0A: [1, 'getUint8'], 0x8B: [2, 'getUint16'], 0x8C: [4, 'getUint32'], 0x0D: [1, null], 0x8E: [8, 'getBigInt64'], 0x8F: [8, 'getBigUint64'], 0x90: [8, 'getBigUint64'] }
const INVALID = new Set([0xFF, 0x7F, 0x7FFF, 0xFFFF, 0x7FFFFFFF, 0xFFFFFFFF])
const SPORT = { 0: 'другое', 1: 'бег', 2: 'велосипед', 3: 'переход', 4: 'фитнес', 5: 'плавание', 6: 'баскетбол', 7: 'футбол', 8: 'теннис', 10: 'тренировка', 11: 'ходьба', 12: 'беговые лыжи', 13: 'горные лыжи', 14: 'сноуборд', 15: 'гребля', 17: 'поход', 37: 'SUP', 53: 'дайвинг' }
export const parseFit = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const hs = u8[0]
    if (latin.decode(u8.subarray(8, 12)) !== '.FIT') throw new ReaderError('Это не файл тренировки FIT.')
    const end = hs + dv.getUint32(4, true)
    const defs = {}
    const records = [], laps = [], sessions = []
    let p = hs, lastTs = 0
    while (p < end && p < u8.length) {
        const h = u8[p++]
        if (h & 0x80) { // сжатый заголовок времени
            const local = (h >> 5) & 3, off = h & 31
            const ts = (lastTs & ~31) + off + (off < (lastTs & 31) ? 32 : 0)
            p = readData(local, p, ts)
            continue
        }
        const local = h & 15
        if (h & 0x40) {
            const le = u8[p + 1] === 0, gm = le ? dv.getUint16(p + 2, true) : dv.getUint16(p + 2), n = u8[p + 4]
            const fields = []; let q = p + 5
            for (let i = 0; i < n; i++) { fields.push({ num: u8[q], size: u8[q + 1], type: u8[q + 2] }); q += 3 }
            let dev = 0; if (h & 0x20) { const nd = u8[q]; q++; for (let i = 0; i < nd; i++) { dev += u8[q + 1]; q += 3 } }
            defs[local] = { le, gm, fields, dev }
            p = q
        } else p = readData(local, p, null)
    }
    function readData(local, p, compTs) {
        const d = defs[local]; if (!d) throw new ReaderError('Файл FIT повреждён.')
        const v = {}
        for (const f of d.fields) {
            const t = FIT_BASE[f.type] ?? FIT_BASE[f.type & 0x9F]
            if (t?.[1] && f.size === t[0]) { let x = dv[t[1]](p, d.le); if (typeof x === 'bigint') x = Number(x); if (!INVALID.has(x)) v[f.num] = x }
            else if (f.type === 7) v[f.num] = utf8.decode(u8.subarray(p, p + f.size)).replace(/\0.*$/s, '')
            p += f.size
        }
        p += d.dev
        if (v[253] != null) lastTs = v[253]; else if (compTs != null) { v[253] = compTs; lastTs = compTs }
        const date = v[253] != null ? new Date((v[253] + 631065600) * 1000) : null
        const semi = x => x * 180 / 2 ** 31
        if (d.gm === 20) records.push({ t: date, lat: v[0] != null ? semi(v[0]) : null, lon: v[1] != null ? semi(v[1]) : null, alt: v[78] != null ? v[78] / 5 - 500 : v[2] != null ? v[2] / 5 - 500 : null, hr: v[3], cad: v[4], dist: v[5] != null ? v[5] / 100 : null, speed: v[73] != null ? v[73] / 1000 : v[6] != null ? v[6] / 1000 : null, power: v[7], temp: v[13] })
        else if (d.gm === 19) laps.push({ start: v[2], time: v[7] / 1000, dist: v[9] / 100 })
        else if (d.gm === 18) sessions.push({ sport: SPORT[v[5]] ?? '', time: v[7] / 1000, dist: v[9] / 100, kcal: v[11], avgHr: v[16], maxHr: v[17], ascent: v[22] })
        return p
    }
    if (!records.length) throw new ReaderError('В файле FIT нет записей тренировки.')
    const pts = records.filter(r => r.lat != null && r.lon != null && Math.abs(r.lat) <= 90)
    const feats = pts.length ? [{ kind: 'line', coords: pts.map(r => [r.lon, r.lat]), name: 'Трек' }] : []
    const x = r => r.t ? r.t.getTime() : 0
    const mk = (name, unit, color, f) => ({ name, unit, color, time: true, points: records.filter(r => f(r) != null && r.t).map(r => [x(r), f(r)]) })
    const series = [mk('Пульс', 'уд/мин', '#e0245e', r => r.hr), mk('Скорость', 'км/ч', '#1d9bf0', r => r.speed != null ? r.speed * 3.6 : null), mk('Высота', 'м', '#17bf63', r => r.alt), mk('Каденс', 'об/мин', '#f5a623', r => r.cad), mk('Мощность', 'Вт', '#794bc4', r => r.power), mk('Температура', '°C', '#ff7a00', r => r.temp)].filter(s => s.points.length > 1)
    const s = sessions[0]
    const dur = s?.time ?? (records.length > 1 ? (x(records[records.length - 1]) - x(records[0])) / 1000 : 0)
    const title = [s?.sport ? s.sport[0].toUpperCase() + s.sport.slice(1) : 'Тренировка', records[0].t?.toLocaleString('ru-RU'), s?.dist ? `${(s.dist / 1000).toFixed(2)} км` : '', dur ? `${Math.floor(dur / 3600) ? Math.floor(dur / 3600) + ' ч ' : ''}${Math.floor(dur % 3600 / 60)} мин` : '', s?.kcal ? `${s.kcal} ккал` : ''].filter(Boolean).join(' · ')
    return { feats, series, title }
}

// ================= OpenStreetMap XML =================
export const parseOsmXml = text => {
    const d = xmlDoc(text, 'выгрузку OpenStreetMap')
    const nodes = new Map(), feats = []
    for (const n of d.getElementsByTagName('node')) {
        const c = [+n.getAttribute('lon'), +n.getAttribute('lat')]
        nodes.set(n.getAttribute('id'), c)
        const tags = tagsOf(n)
        if (tags.name || tags.amenity || tags.shop || tags.tourism) feats.push({ kind: 'point', coords: [c], name: tags.name || tags.amenity || tags.shop || tags.tourism })
    }
    for (const w of d.getElementsByTagName('way')) {
        const coords = [...w.getElementsByTagName('nd')].map(nd => nodes.get(nd.getAttribute('ref'))).filter(Boolean)
        if (coords.length < 2) continue
        const tags = tagsOf(w)
        const closed = coords.length > 3 && coords[0] === coords[coords.length - 1]
        feats.push(closed && (tags.building || tags.landuse || tags.natural || tags.leisure || tags.area === 'yes' || tags.amenity) ? { kind: 'poly', coords: [coords], name: tags.name ?? '' } : { kind: 'line', coords, name: tags.name ?? '' })
    }
    if (!feats.length) throw new ReaderError('В выгрузке OpenStreetMap нет объектов.')
    return { feats, title: '' }
}
const tagsOf = n => Object.fromEntries([...n.getElementsByTagName('tag')].map(t => [t.getAttribute('k'), t.getAttribute('v')]))

// ================= OpenStreetMap PBF (.osm.pbf) =================
const pbf = (u8, start = 0, end = u8.length) => {
    let p = start
    const varint = () => { let r = 0, s = 1, b; do { b = u8[p++]; r += (b & 0x7F) * s; s *= 128 } while (b & 0x80); return r }
    const fields = []
    while (p < end) {
        const key = varint(), f = Math.floor(key / 8), w = key & 7
        if (w === 0) fields.push([f, varint()])
        else if (w === 2) { const len = varint(); fields.push([f, u8.subarray(p, p + len)]); p += len }
        else if (w === 1) { fields.push([f, u8.subarray(p, p + 8)]); p += 8 }
        else if (w === 5) { fields.push([f, u8.subarray(p, p + 4)]); p += 4 }
        else break
    }
    return fields
}
const packed = (b, zigzag) => { const out = []; let p = 0; while (p < b.length) { let r = 0, s = 1, x; do { x = b[p++]; r += (x & 0x7F) * s; s *= 128 } while (x & 0x80); out.push(zigzag ? (r % 2 ? -(r + 1) / 2 : r / 2) : r) } return out }
const zz = v => v % 2 ? -(v + 1) / 2 : v / 2
export const parseOsmPbf = buf => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const nodes = new Map(), feats = [], ways = []
    let p = 0, blocks = 0
    while (p + 4 <= u8.length && blocks < 100000) {
        const hl = dv.getUint32(p); p += 4
        const hdr = pbf(u8, p, p + hl); p += hl
        const type = utf8.decode(hdr.find(f => f[0] === 1)?.[1] ?? new Uint8Array()), size = hdr.find(f => f[0] === 3)?.[1] ?? 0
        const blob = pbf(u8, p, p + size); p += size; blocks++
        if (type !== 'OSMData') continue
        const raw = blob.find(f => f[0] === 1)?.[1], z = blob.find(f => f[0] === 3)?.[1]
        let data = raw
        if (!data && z) { try { data = unzlibSync(z) } catch { data = inflateSync(z.subarray(2)) } }
        if (!data) throw new ReaderError('Сжатие блоков в этом файле .osm.pbf (LZMA/zstd) пока не поддерживается.')
        const pb = pbf(data)
        const strings = pbf(pb.find(f => f[0] === 1)?.[1] ?? new Uint8Array()).filter(f => f[0] === 1).map(f => utf8.decode(f[1]))
        const gran = pb.find(f => f[0] === 17)?.[1] ?? 100, latOff = pb.find(f => f[0] === 19)?.[1] ?? 0, lonOff = pb.find(f => f[0] === 20)?.[1] ?? 0
        const coord = (lat, lon) => [1e-9 * (lonOff + gran * lon), 1e-9 * (latOff + gran * lat)]
        for (const [k, g] of pb) {
            if (k !== 2) continue
            for (const [gk, gv] of pbf(g)) {
                if (gk === 2) { // DenseNodes
                    const dn = pbf(gv)
                    const ids = packed(dn.find(f => f[0] === 1)?.[1] ?? [], true), lats = packed(dn.find(f => f[0] === 8)?.[1] ?? [], true), lons = packed(dn.find(f => f[0] === 9)?.[1] ?? [], true)
                    const kv = packed(dn.find(f => f[0] === 10)?.[1] ?? [])
                    let id = 0, lat = 0, lon = 0, ki = 0
                    for (let i = 0; i < ids.length; i++) {
                        id += ids[i]; lat += lats[i]; lon += lons[i]
                        const c = coord(lat, lon); nodes.set(id, c)
                        let name = null; while (ki < kv.length && kv[ki] !== 0) { if (strings[kv[ki]] === 'name') name = strings[kv[ki + 1]]; ki += 2 } ki++
                        if (name) feats.push({ kind: 'point', coords: [c], name })
                    }
                } else if (gk === 1) { // обычные узлы
                    const n = pbf(gv); const id = zz(n.find(f => f[0] === 1)?.[1] ?? 0)
                    nodes.set(id, coord(zz(n.find(f => f[0] === 8)?.[1] ?? 0), zz(n.find(f => f[0] === 9)?.[1] ?? 0)))
                } else if (gk === 3) { // линии
                    const w = pbf(gv)
                    const refs = packed(w.find(f => f[0] === 8)?.[1] ?? [], true); let id = 0
                    const keys = packed(w.find(f => f[0] === 2)?.[1] ?? []), vals = packed(w.find(f => f[0] === 3)?.[1] ?? [])
                    const tags = Object.fromEntries(keys.map((k2, i) => [strings[k2], strings[vals[i]]]))
                    ways.push({ refs: refs.map(r => (id += r)), tags })
                }
            }
        }
    }
    for (const w of ways) {
        const coords = w.refs.map(r => nodes.get(r)).filter(Boolean)
        if (coords.length < 2) continue
        const closed = w.refs[0] === w.refs[w.refs.length - 1] && coords.length > 3
        feats.push(closed && (w.tags.building || w.tags.landuse || w.tags.natural || w.tags.leisure || w.tags.area === 'yes') ? { kind: 'poly', coords: [coords], name: w.tags.name ?? '' } : { kind: 'line', coords, name: w.tags.name ?? '' })
        if (feats.length > 200000) break
    }
    if (!feats.length && nodes.size) for (const [, c] of [...nodes].slice(0, 20000)) feats.push({ kind: 'point', coords: [c], name: '' })
    if (!feats.length) throw new ReaderError('В файле .osm.pbf нет объектов.')
    return { feats, title: '' }
}

// ================= GML =================
export const parseGml = text => {
    const d = xmlDoc(text, 'геоданные GML')
    const feats = []
    const nums = s => s.trim().split(/[\s,]+/).map(Number)
    const ll = el => { // порядок осей: для EPSG:4326 сначала широта
        let srs = ''; for (let e = el; e && e.getAttribute; e = e.parentNode) { srs = e.getAttribute('srsName') ?? ''; if (srs) break }
        return /urn:ogc:def:crs:EPSG::4326|opengis\.net\/def\/crs\/EPSG\/0\/4326/.test(srs)
    }
    const posList = (el, dim = +(el.getAttribute('srsDimension') || el.closest?.('[srsDimension]')?.getAttribute('srsDimension') || 2)) => {
        const pl = [...el.getElementsByTagNameNS('*', 'posList')][0]
        let a
        if (pl) a = nums(pl.textContent)
        else { const ps = [...el.getElementsByTagNameNS('*', 'pos')]; if (ps.length) a = ps.flatMap(x => nums(x.textContent).slice(0, dim)); else { const c = [...el.getElementsByTagNameNS('*', 'coordinates')][0]; a = c ? c.textContent.trim().split(/\s+/).flatMap(t => t.split(',').map(Number).slice(0, 2)) : []; dim = 2 } }
        const out = []; for (let i = 0; i + 1 < a.length; i += dim) out.push(ll(el) ? [a[i + 1], a[i]] : [a[i], a[i + 1]])
        return out
    }
    const nameOf = g => { let f = g; while (f && f.parentNode && f.parentNode.localName && !/featureMember|member/.test(f.parentNode.localName)) f = f.parentNode; const n = f?.getElementsByTagNameNS?.('*', 'name')?.[0]?.textContent ?? [...(f?.children ?? [])].find(c => /name|название|title/i.test(c.localName))?.textContent; return n ?? '' }
    for (const g of d.getElementsByTagNameNS('*', 'Point')) feats.push({ kind: 'point', coords: posList(g), name: nameOf(g) })
    for (const g of d.getElementsByTagNameNS('*', 'LineString')) feats.push({ kind: 'line', coords: posList(g), name: nameOf(g) })
    for (const g of [...d.getElementsByTagNameNS('*', 'Polygon'), ...d.getElementsByTagNameNS('*', 'Surface')]) {
        const rings = [...g.getElementsByTagNameNS('*', 'LinearRing')].map(r => posList(r))
        if (rings.length) feats.push({ kind: 'poly', coords: rings, name: nameOf(g) })
    }
    const ok = feats.filter(f => f.coords.length && f.coords.flat().every(Number.isFinite))
    if (!ok.length) throw new ReaderError('В файле GML нет геометрии.')
    return { feats: ok, title: '' }
}

// ================= MapInfo Interchange (.mif + .mid) =================
export const parseMif = (text, midText) => {
    const lines = text.replace(/\r/g, '').split('\n')
    let i = lines.findIndex(l => /^\s*Data\s*$/i.test(l)) + 1
    if (i <= 0) throw new ReaderError('Это не файл MapInfo (.mif) — нет раздела Data.')
    const cols = []
    const ci = lines.findIndex(l => /^\s*Columns\s+\d+/i.test(l))
    if (ci >= 0) for (let k = 1; k <= +/\d+/.exec(lines[ci])[0]; k++) cols.push(lines[ci + k].trim().split(/\s+/)[0])
    const mid = midText ? midText.replace(/\r/g, '').split('\n').filter(Boolean).map(r => r.split(',').map(s => s.trim().replace(/^"|"$/g, ''))) : []
    const nameCol = cols.findIndex(c => /name|назв|наим/i.test(c))
    const feats = []
    const xy = l => { const v = l.trim().split(/\s+/).map(Number); return [v[0], v[1]] }
    let obj = 0
    while (i < lines.length) {
        const l = lines[i].trim(); i++
        if (!l) continue
        const name = nameCol >= 0 ? mid[obj]?.[nameCol] ?? '' : ''
        const m = /^(\w+)\s*(.*)$/.exec(l); if (!m) continue
        const kw = m[1].toUpperCase(), rest = m[2]
        if (kw === 'POINT') { feats.push({ kind: 'point', coords: [xy(rest)], name }); obj++ }
        else if (kw === 'LINE') { const v = rest.split(/\s+/).map(Number); feats.push({ kind: 'line', coords: [[v[0], v[1]], [v[2], v[3]]], name }); obj++ }
        else if (kw === 'PLINE') {
            let parts = 1, n
            if (/^MULTIPLE/i.test(rest)) { parts = +rest.split(/\s+/)[1]; n = +lines[i++].trim() } else n = +rest || +lines[i++].trim()
            for (let pt = 0; pt < parts; pt++) { if (pt > 0) n = +lines[i++].trim(); const c = []; for (let k = 0; k < n; k++) c.push(xy(lines[i++])); feats.push({ kind: 'line', coords: c, name }) }
            obj++
        } else if (kw === 'REGION') {
            const parts = +rest; const rings = []
            for (let pt = 0; pt < parts; pt++) { const n = +lines[i++].trim(); const c = []; for (let k = 0; k < n; k++) c.push(xy(lines[i++])); rings.push(c) }
            feats.push({ kind: 'poly', coords: rings, name }); obj++
        } else if (['TEXT', 'ARC', 'ELLIPSE', 'RECT', 'ROUNDRECT', 'MULTIPOINT', 'COLLECTION', 'NONE'].includes(kw)) obj++
    }
    if (!feats.length) throw new ReaderError('В файле MapInfo нет объектов.')
    return { feats, title: '' }
}

// ================= Sigma (.slf) =================
export const parseSlf = text => {
    const d = xmlDoc(text, 'тренировку Sigma')
    const entries = [...d.getElementsByTagName('Entry'), ...d.getElementsByTagName('LogEntry')]
    if (!entries.length) throw new ReaderError('В файле Sigma нет записей.')
    let t = 0
    const pts = entries.map(e => { const a = k => { const v = e.getAttribute(k); return v == null || v === '' ? null : +v }; t += (a('trainingTimeAbsolute') == null ? (a('trainingTime') ?? 100) / 100 : 0); return { t: a('trainingTimeAbsolute') != null ? a('trainingTimeAbsolute') / 100 : t, lat: a('latitude'), lon: a('longitude'), hr: a('heartrate'), speed: a('speed'), alt: a('altitude'), cad: a('cadence') } })
    const mk = (name, unit, color, f) => ({ name, unit, color, time: true, points: pts.filter(p => f(p) != null).map(p => [p.t * 1000, f(p)]) })
    const series = [mk('Пульс', 'уд/мин', '#e0245e', p => p.hr || null), mk('Скорость', 'км/ч', '#1d9bf0', p => p.speed), mk('Высота', 'м', '#17bf63', p => p.alt != null ? p.alt / 1000 : null), mk('Каденс', 'об/мин', '#f5a623', p => p.cad || null)].filter(s => s.points.length > 1)
    const geo = pts.filter(p => p.lat && p.lon)
    const feats = geo.length ? [{ kind: 'line', coords: geo.map(p => [p.lon, p.lat]), name: 'Трек' }] : []
    const g = d.querySelector('GeneralInformation')
    return { series, feats, title: [g?.querySelector('sport')?.textContent, g?.querySelector('startDate')?.textContent, g?.querySelector('name')?.textContent].filter(Boolean).join(' · ') }
}

// ================= Apple «Здоровье» (export.xml) =================
export const isAppleHealth = head => /<HealthData[\s>]/.test(head)
const HK = { StepCount: ['Шаги', 'сумма'], HeartRate: ['Пульс', 'среднее'], DistanceWalkingRunning: ['Расстояние пешком и бегом', 'сумма'], ActiveEnergyBurned: ['Активные калории', 'сумма'], BasalEnergyBurned: ['Калории покоя', 'сумма'], FlightsClimbed: ['Пролёты лестниц', 'сумма'],
    BodyMass: ['Вес', 'среднее'], Height: ['Рост', 'среднее'], RestingHeartRate: ['Пульс в покое', 'среднее'], HeartRateVariabilitySDNN: ['Вариабельность пульса', 'среднее'], OxygenSaturation: ['Кислород в крови', 'среднее'], AppleExerciseTime: ['Минуты упражнений', 'сумма'], AppleStandTime: ['Время стоя', 'сумма'], WalkingSpeed: ['Скорость ходьбы', 'среднее'], DistanceCycling: ['Расстояние на велосипеде', 'сумма'], RespiratoryRate: ['Частота дыхания', 'среднее'], VO2Max: ['VO₂ max', 'среднее'], SleepAnalysis: ['Сон', 'записи'], EnvironmentalAudioExposure: ['Шум вокруг', 'среднее'], HeadphoneAudioExposure: ['Громкость в наушниках', 'среднее'] }
export const parseAppleHealth = text => {
    const types = new Map()
    const re = /<Record\s([^>]*?)\/?>/g
    const attr = (s, k) => new RegExp(`\\b${k}="([^"]*)"`).exec(s)?.[1]
    let m, n = 0
    while ((m = re.exec(text))) {
        const s = m[1]; n++
        const type = (attr(s, 'type') ?? '').replace(/^HK(Quantity|Category)TypeIdentifier/, '')
        const day = (attr(s, 'startDate') ?? '').slice(0, 10)
        const v = parseFloat(attr(s, 'value') ?? '')
        let t = types.get(type); if (!t) { t = { unit: attr(s, 'unit') ?? '', days: new Map(), count: 0, sources: new Set() }; types.set(type, t) }
        t.count++; if (t.sources.size < 10) t.sources.add(attr(s, 'sourceName') ?? '')
        const dd = t.days.get(day) ?? { sum: 0, n: 0 }; if (Number.isFinite(v)) { dd.sum += v; dd.n++ } else dd.n++
        t.days.set(day, dd)
    }
    const workouts = []
    for (const w of text.matchAll(/<Workout\s([^>]*?)>/g)) workouts.push([(attr(w[1], 'workoutActivityType') ?? '').replace(/^HKWorkoutActivityType/, ''), (attr(w[1], 'startDate') ?? '').slice(0, 16), attr(w[1], 'duration') ? `${(+attr(w[1], 'duration')).toFixed(1)} ${attr(w[1], 'durationUnit') ?? ''}` : '', attr(w[1], 'totalDistance') ? `${(+attr(w[1], 'totalDistance')).toFixed(2)} ${attr(w[1], 'totalDistanceUnit') ?? ''}` : '', attr(w[1], 'totalEnergyBurned') ? `${Math.round(+attr(w[1], 'totalEnergyBurned'))} ${attr(w[1], 'totalEnergyBurnedUnit') ?? ''}` : '', attr(w[1], 'sourceName') ?? ''])
    if (!n && !workouts.length) throw new ReaderError('В выгрузке «Здоровья» нет записей.')
    const list = [...types].sort((a, b) => b[1].count - a[1].count)
    const sheets = [{ name: 'Показатели', rows: [['Показатель', 'Записей', 'Единицы', 'Дней', 'С', 'По', 'Источники'], ...list.map(([k, t]) => { const days = [...t.days.keys()].sort(); return [HK[k]?.[0] ?? k, String(t.count), t.unit, String(days.length), days[0] ?? '', days[days.length - 1] ?? '', [...t.sources].join(', ')] })] }]
    if (workouts.length) sheets.push({ name: `Тренировки (${workouts.length})`, rows: [['Вид', 'Начало', 'Длительность', 'Расстояние', 'Энергия', 'Источник'], ...workouts.slice(-5000).reverse()] })
    for (const [k, t] of list.slice(0, 12)) {
        const agg = HK[k]?.[1] ?? 'среднее'
        const days = [...t.days].sort((a, b) => b[0].localeCompare(a[0]))
        sheets.push({ name: HK[k]?.[0] ?? k, rows: [['День', agg === 'сумма' ? `Всего, ${t.unit}` : agg === 'записи' ? 'Записей' : `В среднем, ${t.unit}`, 'Записей'], ...days.map(([d, v]) => [d, agg === 'записи' ? String(v.n) : String(+(agg === 'сумма' ? v.sum : v.sum / (v.n || 1)).toFixed(2)), String(v.n)])] })
    }
    return sheets
}

// ================= Таблицы с координатами =================
export const coordColumns = header => {
    const h = header.map(c => String(c).trim().toLowerCase())
    const lat = h.findIndex(c => /^(lat|latitude|широта|y_?wgs|lat_?deg|y)$/.test(c)), lon = h.findIndex(c => /^(lon|lng|long|longitude|долгота|x_?wgs|lon_?deg|x)$/.test(c))
    if (lat < 0 || lon < 0 || (h[lat] === 'y' && h[lon] !== 'x')) return null
    return { lat, lon, name: h.findIndex(c => /^(name|title|название|имя|label|город|city)$/.test(c)) }
}
export const csvToFeats = (rows, cc) => {
    const feats = []
    for (const r of rows.slice(1)) { const la = parseFloat(String(r[cc.lat]).replace(',', '.')), lo = parseFloat(String(r[cc.lon]).replace(',', '.')); if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) feats.push({ kind: 'point', coords: [[lo, la]], name: cc.name >= 0 ? String(r[cc.name] ?? '') : '' }) }
    return feats
}
