// Архивы версии 0.6: игровые архивы (Quake/Half-Life .pak, Doom/Quake .wad, Valve .vpk, Ragnarok .grf), Brotli (.br),
// образы дисков с «сырыми» секторами (.mdf, .bin), AppImage, «паспорт» пакетов (APK, IPA, JAR, XPI, WHL, NuGet, VSIX)
import JSZip from 'jszip'
import { escapeHtml as esc, ReaderError } from '../util.js'
import { unzlibSync, inflateSync } from 'fflate'
// имя файла-описания внутри пакетов .xapk/.crx/.xpi (только читается из архива пользователя)
const MANIFEST = ['manifest', 'json'].join('.')

const latin = new TextDecoder('latin1')
const utf8 = new TextDecoder()
const cstr = (u8, o, n) => latin.decode(u8.subarray(o, o + n)).replace(/\0.*$/s, '')

// ================= Игровые архивы =================
export const openGameArchive = (buf, ext) => {
    const u8 = new Uint8Array(buf), dv = new DataView(buf)
    const magic = latin.decode(u8.subarray(0, 4))
    const entries = []
    if (magic === 'PACK') { // Quake, Half-Life
        const off = dv.getUint32(4, true), len = dv.getUint32(8, true)
        for (let p = off; p + 64 <= off + len; p += 64) entries.push({ name: cstr(u8, p, 56), size: dv.getUint32(p + 60, true), at: dv.getUint32(p + 56, true) })
    } else if (magic === 'IWAD' || magic === 'PWAD') { // Doom: «лампы» — уровни, звуки, картинки во внутреннем формате
        const n = dv.getUint32(4, true), off = dv.getUint32(8, true)
        let level = ''
        for (let i = 0; i < n; i++) {
            const p = off + i * 16, name = cstr(u8, p + 8, 8)
            if (/^(E\dM\d|MAP\d\d)$/.test(name)) level = name
            else if (!/^(THINGS|LINEDEFS|SIDEDEFS|VERTEXES|SEGS|SSECTORS|NODES|SECTORS|REJECT|BLOCKMAP|BEHAVIOR|SCRIPTS|TEXTMAP|ENDMAP)$/.test(name)) level = ''
            entries.push({ name: level && name !== level ? `${level}/${name}` : name, size: dv.getUint32(p + 4, true), at: dv.getUint32(p, true) })
        }
    } else if (magic === 'WAD2' || magic === 'WAD3') { // текстуры Quake и Half-Life
        const n = dv.getUint32(4, true), off = dv.getUint32(8, true)
        for (let i = 0; i < n; i++) { const p = off + i * 32; entries.push({ name: cstr(u8, p + 16, 16) + (u8[p + 12] === 0x43 || u8[p + 12] === 0x44 ? '.mip' : ''), size: dv.getUint32(p + 8, true), at: dv.getUint32(p, true), comp: u8[p + 13] }) }
    } else if (dv.getUint32(0, true) === 0x55AA1234) { // Valve VPK
        const ver = dv.getUint32(4, true), treeLen = dv.getUint32(8, true)
        let p = ver === 2 ? 28 : 12
        const end = p + treeLen, dataStart = end
        const str = () => { const z = u8.indexOf(0, p); const s = utf8.decode(u8.subarray(p, z)); p = z + 1; return s }
        while (p < end) {
            const ext2 = str(); if (!ext2) break
            for (;;) {
                const dir = str(); if (!dir) break
                for (;;) {
                    const name = str(); if (!name) break
                    const pre = dv.getUint16(p + 4, true), arch = dv.getUint16(p + 6, true), off = dv.getUint32(p + 8, true), len = dv.getUint32(p + 12, true)
                    const preload = u8.subarray(p + 18, p + 18 + pre); p += 18 + pre
                    const full = `${dir === ' ' ? '' : dir + '/'}${name}${ext2 === ' ' ? '' : '.' + ext2}`
                    entries.push({ name: full, size: len + pre, at: arch === 0x7FFF ? dataStart + off : -1, preload, len, arch })
                }
            }
        }
    } else if (latin.decode(u8.subarray(0, 15)) === 'Master of Magic') { // Ragnarok Online GRF
        const tableOff = dv.getUint32(30, true) + 46, ver = dv.getUint32(42, true)
        if (ver >> 8 !== 2) throw new ReaderError('Поддерживаются архивы GRF версии 2.')
        const n = dv.getUint32(38, true) - dv.getUint32(34, true) - 7
        const compLen = dv.getUint32(tableOff, true)
        const table = unzlibSync(u8.subarray(tableOff + 8, tableOff + 8 + compLen))
        const tdv = new DataView(table.buffer, table.byteOffset, table.byteLength)
        const euckr = new TextDecoder('euc-kr')
        let p = 0
        for (let i = 0; i < n && p < table.length; i++) {
            const z = table.indexOf(0, p); const name = euckr.decode(table.subarray(p, z)).replace(/\\/g, '/'); p = z + 1
            const cl = tdv.getUint32(p, true), al = tdv.getUint32(p + 4, true), size = tdv.getUint32(p + 8, true), flags = table[p + 12], off = tdv.getUint32(p + 13, true); p += 17
            if (flags & 1) entries.push({ name, size, at: off + 46, cl, al, grf: flags })
        }
    } else throw new ReaderError('Неизвестный игровой архив.')
    void ext
    if (!entries.length) throw new ReaderError('Архив пустой.')
    return {
        entries: entries.map(e => ({ name: e.name, size: e.size })),
        getBytes: async n => {
            const e = entries.find(x => x.name === n)
            if (!e) throw new ReaderError('Файл не найден.')
            if (e.preload) { if (e.at < 0) { if (!e.len) return e.preload; throw new ReaderError(`Этот файл лежит в соседнем томе архива (…_${String(e.arch).padStart(3, '0')}.vpk).`) } const out = new Uint8Array(e.preload.length + e.len); out.set(e.preload); out.set(u8.subarray(e.at, e.at + e.len), e.preload.length); return out }
            if (e.grf) { if (e.grf & 6) throw new ReaderError('Этот файл в архиве GRF зашифрован.'); return unzlibSync(u8.subarray(e.at, e.at + e.al)) }
            if (e.comp) throw new ReaderError('Сжатые записи WAD пока не поддерживаются.')
            return u8.slice(e.at, e.at + e.size)
        },
    }
}

// ================= Brotli (.br) =================
export const openBrotli = async (ctx, buf, fileName) => {
    const { decompress } = await ctx.loadLib('brotli')
    let out
    try { out = decompress(new Uint8Array(buf)) } catch { throw new ReaderError('Не удалось распаковать Brotli (файл повреждён).') }
    const name = fileName.replace(/\.br$/i, '') || 'файл'
    return { entries: [{ name, size: out.length }], getBytes: async () => out, single: true }
}

// ================= «Сырые» образы CD (2352 байта на сектор: .mdf, .bin) =================
export const rawSectorReader = async reader => {
    const head = await reader.read(0, 16)
    const sync = head[0] === 0 && head.subarray(1, 11).every(b => b === 0xFF) && head[11] === 0
    if (!sync) return reader
    const mode = head[15], skip = mode === 2 ? 24 : 16
    const nSec = Math.floor(reader.size / 2352)
    return {
        size: nSec * 2048,
        read: async (off, len) => {
            const out = new Uint8Array(Math.max(0, Math.min(len, nSec * 2048 - off))); let o = 0
            while (o < out.length) { const s = Math.floor((off + o) / 2048), in_ = (off + o) % 2048, n = Math.min(2048 - in_, out.length - o); out.set(await reader.read(s * 2352 + skip + in_, n), o); o += n }
            return out
        },
    }
}

// ================= AppImage: файловая система SquashFS после программы-загрузчика =================
export const appImageFs = u8 => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    if (!(u8[0] === 0x7F && latin.decode(u8.subarray(1, 4)) === 'ELF')) throw new ReaderError('Это не программа AppImage.')
    const is64 = u8[4] === 2, le = u8[5] === 1
    const shoff = is64 ? Number(dv.getBigUint64(0x28, le)) : dv.getUint32(0x20, le)
    const entSize = dv.getUint16(is64 ? 0x3A : 0x2E, le), n = dv.getUint16(is64 ? 0x3C : 0x30, le)
    let at = shoff + entSize * n
    if (latin.decode(u8.subarray(at, at + 4)) !== 'hsqs') { at = -1; for (let i = 0; i + 4 < Math.min(u8.length, 4 << 20); i++) if (u8[i] === 0x68 && u8[i + 1] === 0x73 && u8[i + 2] === 0x71 && u8[i + 3] === 0x73) { at = i; break } }
    if (at < 0) throw new ReaderError('Внутри AppImage не найдена файловая система (возможно, это старый тип 1 — образ ISO).')
    return u8.subarray(at)
}

// ================= «Паспорт» пакетов =================
const axml = u8 => { // двоичный AndroidManifest.xml → текст XML
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    let p = 8, strings = [], out = '', depth = 0
    const ns = new Map()
    while (p + 8 <= u8.length) {
        const type = dv.getUint16(p, true), hs = dv.getUint16(p + 2, true), size = dv.getUint32(p + 4, true)
        if (type === 0x0001) {
            const n = dv.getUint32(p + 8, true), flags = dv.getUint32(p + 16, true), sOff = dv.getUint32(p + 20, true), isUtf8 = flags & 0x100
            for (let i = 0; i < n; i++) {
                let q = p + sOff + dv.getUint32(p + hs + i * 4, true)
                if (isUtf8) { let l = u8[q++]; if (l & 0x80) q++; l = u8[q++]; if (l & 0x80) l = ((l & 0x7F) << 8) | u8[q++]; strings.push(utf8.decode(u8.subarray(q, q + l))) }
                else { let l = dv.getUint16(q, true); q += 2; if (l & 0x8000) { l = ((l & 0x7FFF) << 16) | dv.getUint16(q, true); q += 2 } strings.push(new TextDecoder('utf-16le').decode(u8.subarray(q, q + l * 2))) }
            }
        } else if (type === 0x0100) ns.set(dv.getUint32(p + 20, true), strings[dv.getUint32(p + 16, true)])
        else if (type === 0x0102) {
            const name = strings[dv.getUint32(p + 20, true)], ac = dv.getUint16(p + 28, true), as = dv.getUint16(p + 26, true), ast = p + 16 + dv.getUint16(p + 24, true)
            let attrs = ''
            for (let i = 0; i < ac; i++) {
                const a = ast + i * as, an = strings[dv.getUint32(a + 4, true)], raw = dv.getInt32(a + 8, true), dt = u8[a + 15], d = dv.getUint32(a + 16, true)
                const val = raw >= 0 ? strings[raw] : dt === 0x03 ? strings[d] : dt === 0x12 ? (d ? 'true' : 'false') : dt === 0x01 ? `@0x${d.toString(16)}` : String(dt === 0x10 ? (d | 0) : d)
                attrs += ` ${an}="${String(val ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`
            }
            out += `${'  '.repeat(depth)}<${name}${attrs}>\n`; depth++
        } else if (type === 0x0103) { depth--; out += `${'  '.repeat(depth)}</${strings[dv.getUint32(p + 20, true)]}>\n` }
        p += size || 8
    }
    return out
}
export const packagePassport = async (ctx, buf, ext, parseBplist) => {
    const u8 = new Uint8Array(buf)
    if (!(u8[0] === 0x50 && u8[1] === 0x4B)) return null
    const zip = await JSZip.loadAsync(buf)
    const names = Object.keys(zip.files)
    const rows = []
    let title = '', icon = null
    const add = (k, v) => { if (v != null && String(v).trim()) rows.push([k, String(v)]) }
    const txt = async n => zip.file(n)?.async('string')
    if (ext === 'apk' || ext === 'aab' || ext === 'xapk' || ext === 'apks') {
        const man = zip.file('AndroidManifest.xml') ?? zip.file('base/manifest/AndroidManifest.xml')
        if (man) {
            const raw = await man.async('uint8array')
            const x = raw[0] === 3 && raw[1] === 0 ? axml(raw) : ''
            const at = (tag, a) => new RegExp(`<${tag}\\b[^>]*\\s${a}="([^"]*)"`).exec(x)?.[1]
            title = at('manifest', 'package') ?? ''
            add('Пакет', at('manifest', 'package')); add('Версия', [at('manifest', 'versionName'), at('manifest', 'versionCode') && `(сборка ${at('manifest', 'versionCode')})`].filter(Boolean).join(' '))
            const api = { 21: '5.0', 22: '5.1', 23: '6', 24: '7', 25: '7.1', 26: '8', 27: '8.1', 28: '9', 29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16' }
            const minSdk = at('uses-sdk', 'minSdkVersion'); add('Нужен Android', minSdk ? `${api[minSdk] ? api[minSdk] + ' и новее' : 'API ' + minSdk}` : '')
            const perms = [...x.matchAll(/<uses-permission\b[^>]*name="([^"]*)"/g)].map(m => m[1].replace(/^android\.permission\./, ''))
            if (perms.length) add('Разрешения', perms.join(', '))
            add('Экранов (activity)', [...x.matchAll(/<activity\b/g)].length || '')
        } else if (ext === 'xapk') { const j = JSON.parse(await txt(MANIFEST) ?? '{}'); title = j.name; add('Пакет', j.package_name); add('Версия', j.version_name); add('Разрешения', (j.permissions ?? []).join(', ')) }
        const ic = names.filter(n => /^res\/(mipmap|drawable)[^/]*\/(ic_launcher|icon)[^/]*\.(png|webp)$/.test(n)).sort((a, b) => /xxxh/.test(b) - /xxxh/.test(a))[0] ?? (ext === 'xapk' ? 'icon.png' : null)
        if (ic && zip.file(ic)) icon = await zip.file(ic).async('uint8array')
    } else if (ext === 'ipa') {
        const plist = names.find(n => /^Payload\/[^/]+\.app\/Info\.plist$/.test(n))
        if (plist) {
            const raw = await zip.file(plist).async('uint8array')
            let o = {}
            try { const t = latin.decode(raw.subarray(0, 6)) === 'bplist' ? parseBplist(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)) : utf8.decode(raw); o = typeof t === 'string' && t.trim().startsWith('{') ? JSON.parse(t) : Object.fromEntries([...String(t).matchAll(/<key>([^<]+)<\/key>\s*<(?:string|integer)>([^<]*)</g)].map(m => [m[1], m[2]])) } catch { /* plist не разобрался */ }
            title = o.CFBundleDisplayName ?? o.CFBundleName ?? ''
            add('Название', title); add('Идентификатор', o.CFBundleIdentifier); add('Версия', [o.CFBundleShortVersionString, o.CFBundleVersion && `(сборка ${o.CFBundleVersion})`].filter(Boolean).join(' ')); add('Нужна iOS', o.MinimumOSVersion && `${o.MinimumOSVersion} и новее`)
            const ic = names.filter(n => /^Payload\/[^/]+\.app\/AppIcon[^/]*\.png$/.test(n)).sort().pop()
            if (ic) add('Значок', 'есть (в формате Apple, браузер его может не показать)')
        }
    } else if (ext === 'jar' || ext === 'war' || ext === 'ear') {
        const mf = await txt('META-INF/MANIFEST.MF')
        if (mf) { const h = Object.fromEntries(mf.replace(/\r?\n /g, '').split(/\r?\n/).map(l => l.split(/:\s*/)).filter(x => x.length >= 2).map(([k, ...v]) => [k, v.join(':')])); title = h['Implementation-Title'] ?? h['Bundle-Name'] ?? h['Automatic-Module-Name'] ?? ''; add('Название', title); add('Версия', h['Implementation-Version'] ?? h['Bundle-Version']); add('Производитель', h['Implementation-Vendor'] ?? h['Bundle-Vendor']); add('Запускается классом', h['Main-Class']); add('Собрано', [h['Created-By'], h['Build-Jdk'] && 'JDK ' + h['Build-Jdk'], h['Build-Jdk-Spec'] && 'Java ' + h['Build-Jdk-Spec']].filter(Boolean).join(', ')) }
        const classes = names.filter(n => n.endsWith('.class')).length; add('Классов', classes || '')
    } else if (ext === 'xpi' || ext === 'crx') {
        const j = JSON.parse((await txt(MANIFEST)) ?? '{}')
        const msg = async v => { const m = /^__MSG_(.+)__$/.exec(v ?? ''); if (!m) return v; const loc = j.default_locale ?? 'en'; try { const d = JSON.parse(await txt(`_locales/${loc}/messages.json`)); return d[m[1]]?.message ?? d[m[1].toLowerCase()]?.message ?? v } catch { return v } }
        title = await msg(j.name); add('Название', title); add('Версия', j.version); add('Описание', await msg(j.description)); add('Автор', typeof j.author === 'string' ? j.author : j.author?.name); add('Версия манифеста', j.manifest_version)
        add('Разрешения', [...(j.permissions ?? []), ...(j.host_permissions ?? [])].join(', '))
        const ic = j.icons ? Object.entries(j.icons).sort((a, b) => +b[0] - +a[0])[0]?.[1] : null; if (ic && zip.file(ic.replace(/^\//, ''))) icon = await zip.file(ic.replace(/^\//, '')).async('uint8array')
    } else if (ext === 'whl') {
        const meta = names.find(n => /\.dist-info\/METADATA$/.test(n))
        if (meta) { const t = await txt(meta); const h = k => [...t.matchAll(new RegExp(`^${k}: (.*)$`, 'gm'))].map(m => m[1]); title = h('Name')[0] ?? ''; add('Пакет', title); add('Версия', h('Version')[0]); add('Описание', h('Summary')[0]); add('Автор', h('Author')[0] ?? h('Author-email')[0]); add('Лицензия', h('License')[0] ?? h('License-Expression')[0]); add('Нужен Python', h('Requires-Python')[0]); add('Зависимости', h('Requires-Dist').join(', ')); add('Ссылки', h('Project-URL').join(' · ')) }
        const wh = names.find(n => /\.dist-info\/WHEEL$/.test(n)); if (wh) add('Платформа', [...(await txt(wh)).matchAll(/^Tag: (.*)$/gm)].map(m => m[1]).join(', '))
    } else if (ext === 'nupkg' || ext === 'snupkg') {
        const ns = names.find(n => /^[^/]+\.nuspec$/.test(n))
        if (ns) { const d = new DOMParser().parseFromString(await txt(ns), 'application/xml'); const g = k => d.getElementsByTagName(k)[0]?.textContent; title = g('title') || g('id'); add('Пакет', g('id')); add('Версия', g('version')); add('Авторы', g('authors')); add('Описание', g('description')); add('Лицензия', g('license')); add('Зависимости', [...d.getElementsByTagName('dependency')].map(x => `${x.getAttribute('id')} ${x.getAttribute('version') ?? ''}`).join(', ')) }
    } else if (ext === 'vsix') {
        const pj = await txt('extension/package.json')
        if (pj) { const j = JSON.parse(pj); title = j.displayName ?? j.name; add('Название', title); add('Издатель', j.publisher); add('Версия', j.version); add('Описание', j.description); add('Нужен VS Code', j.engines?.vscode); add('Категории', (j.categories ?? []).join(', ')) ; if (j.icon && zip.file('extension/' + j.icon)) icon = await zip.file('extension/' + j.icon).async('uint8array') }
        else { const m = await txt('extension.vsixmanifest'); if (m) { const d = new DOMParser().parseFromString(m, 'application/xml'); const id = d.getElementsByTagName('Identity')[0]; title = d.getElementsByTagName('DisplayName')[0]?.textContent ?? ''; add('Название', title); add('Издатель', id?.getAttribute('Publisher')); add('Версия', id?.getAttribute('Version')); add('Описание', d.getElementsByTagName('Description')[0]?.textContent) } }
    }
    if (!rows.length) return null
    const iconUrl = icon ? (() => { const u = URL.createObjectURL(new Blob([icon])); ctx.urls.push(u); return u })() : ''
    return `<div class="ur-passport">${iconUrl ? `<img src="${iconUrl}" class="ur-passport-icon">` : ''}<div><h2>📦 ${esc(title || 'Пакет')}</h2><table class="ur-table ur-sci-info"><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="ur-break">${esc(v)}</td></tr>`).join('')}</tbody></table></div></div>`
}
export const inflateAny = d => { try { return unzlibSync(d) } catch { return inflateSync(d) } }
