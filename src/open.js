// Выбор просмотрщика по расширению файла
import { BookRenderer } from './renderers/book.js'
import { PagesRenderer } from './renderers/pages.js'
import { CodeRenderer, TableRenderer, WebRenderer, ArticleRenderer, NotebookRenderer, SlidesRenderer, MultiViewRenderer, ArchiveRenderer, parseCsv } from './renderers/dom.js'
import * as T from './formats/textual.js'
import * as X from './formats/extra.js'
import * as A from './formats/archives.js'
import * as H from './formats/heavy.js'
import * as I from './formats/images2.js'
import * as FN from './formats/fonts2.js'
import * as MW from './formats/mailweb.js'
import * as N from './formats/notes.js'
import * as MU from './formats/markups.js'
import * as DS from './formats/datasets.js'
import * as D2 from './formats/docs2.js'
import * as G from './formats/graphics.js'
import * as MAP from './formats/maps.js'
import * as SK from './formats/sketch.js'
import * as S1 from './formats/star1.js'
import * as SN from './formats/sniff.js'
import * as D3 from './formats/docs3.js'
import * as N3 from './formats/notes3.js'
import { isCfb } from './formats/cfb.js'
import * as DSC from './formats/datasci.js'
import * as SC from './formats/sci2.js'
import * as I3 from './formats/images3.js'
import * as GEO from './formats/geo2.js'
import * as CAD from './formats/cad2.js'
import * as M3 from './formats/media3.js'
import * as A2 from './formats/archives2.js'
import * as F3 from './formats/fonts3.js'
import * as DEV from './formats/devtools.js'
import * as SYS from './formats/sysinfo.js'
import { parseBplistObj } from './formats/extra.js'
import { makeHtmlBook, splitHtml } from './formats/htmlbook.js'
import { openFlowBook, openMarkdownAsBook, sniffZipBook } from './formats/books.js'
import { openComic, openTiff, openDjvu } from './formats/pages.js'
import { parseMhtml, readSheets, renderPptx, renderOdp, adocToHtml, orgToHtml } from './formats/misc.js'
import { decodeText, ReaderError, MIME, escapeHtml } from './util.js'
import { FORMAT_BY_EXT } from './registry.js'

export { ALL_EXTS, MOBILE_EXCLUDED } from './registry.js'

const startBook = async (ctx, book) => { const r = new BookRenderer(ctx); ctx.mount(r.el); await r.open(book); return r }
const startPages = async (ctx, src, opts) => { const r = new PagesRenderer(ctx, src, opts); ctx.mount(r.el); await r.open(); return r }
const startDom = async (ctx, r) => { ctx.mount(r.el); await r.open(); return r }
const showView = (ctx, label, fn, { text, ext, cls = '' } = {}) => startDom(ctx, new MultiViewRenderer(ctx, { views: [['rendered', label, fn]], text, ext, cls }))
const sheets = async (ctx, p) => startDom(ctx, new TableRenderer(ctx, await p))
const group = ext => FORMAT_BY_EXT.get(ext)?.id

// Чтение кусками с диска (для больших образов дисков на компьютере); иначе — целиком
const rangeReader = async (ctx, file) => {
    if (file._bytes) { const u8 = new Uint8Array(file._bytes); return { size: u8.length, read: async (off, len) => u8.subarray(off, off + len) } }
    const fs = window.require?.('fs')
    const full = ctx.app.vault.adapter.getFullPath?.(file.path)
    if (fs?.promises && full) {
        const fh = await fs.promises.open(full, 'r')
        ctx.cleanups.push(() => fh.close())
        const size = (await fh.stat()).size
        return { size, read: async (off, len) => { const b = new Uint8Array(Math.max(0, Math.min(len, size - off))); await fh.read(b, 0, b.length, off); return b } }
    }
    const u8 = new Uint8Array(await ctx.app.vault.readBinary(file))
    return { size: u8.length, read: async (off, len) => u8.subarray(off, off + len) }
}

// многотомные архивы: собираем все части из той же папки
const multiVolume = async (ctx, file) => {
    const folder = file.parent
    const sibs = (folder?.children ?? []).filter(f => f.extension != null)
    const name = file.name
    let parts, first
    let m
    if ((m = /^(.*)\.(\d{3})$/.exec(name))) { parts = sibs.filter(f => f.name.startsWith(m[1] + '.') && /^\d{3}$/.test(f.name.slice(m[1].length + 1))); first = m[1] + '.001' }
    else if ((m = /^(.*)\.z\d\d$/i.exec(name)) || (m = /^(.*)\.zip$/i.exec(name))) { parts = sibs.filter(f => f.name.replace(/\.[^.]+$/, '') === m[1] && /^(z\d\d|zip)$/i.test(f.extension)); first = parts.find(f => /^zip$/i.test(f.extension))?.name }
    else if ((m = /^(.*)\.r\d\d$/i.exec(name))) { parts = sibs.filter(f => f.name.replace(/\.[^.]+$/, '') === m[1] && /^(r\d\d|rar)$/i.test(f.extension)); first = m[1] + '.rar' }
    else if ((m = /^(.*)\.part\d+\.rar$/i.exec(name))) { parts = sibs.filter(f => new RegExp('^' + m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.part\\d+\\.rar$', 'i').test(f.name)); first = parts.map(f => f.name).sort()[0] }
    if (!parts?.length || !first || !parts.some(f => f.name === first)) throw new ReaderError('Не нашлись все части архива — они должны лежать в одной папке и называться одинаково.')
    const files = []
    for (const f of parts) files.push({ name: f.name, u8: new Uint8Array(await ctx.app.vault.readBinary(f)) })
    return A.open7z(ctx, files, first, file.name)
}

const saveNextTo = (ctx, file) => async a => {
    try {
        const vault = ctx.app.vault
        const dir = file.parent?.path && file.parent.path !== '/' ? file.parent.path + '/' : ''
        const safe = a.filename.replace(/[\\/:*?"<>|]/g, '_')
        let path = dir + safe, n = 1
        while (vault.getAbstractFileByPath(path)) { path = dir + safe.replace(/(\.[^.]*)?$/, ` (${n++})$1`) }
        await vault.createBinary(path, a.bytes.buffer.slice(a.bytes.byteOffset, a.bytes.byteOffset + a.bytes.byteLength))
        return 'Сохранено: ' + path.split('/').pop()
    } catch (e) { return 'Ошибка: ' + (e?.message || e) }
}

// Другие имена уже знакомых форматов: открываем тем же кодом
const CANON = { ibooks: 'epub', odm: 'odt', me: 'txt', '1st': 'txt', nws: 'eml', emltpl: 'eml', mbx: 'mbox', oft: 'msg', ical: 'ics', icalendar: 'ics', ifb: 'ics',
    inetloc: 'webloc', fileloc: 'webloc', roff: 'man', nroff: 'man', ms: 'man', jmd: 'rmd', kar: 'mid', rmi: 'mid', psb: 'psd', pdd: 'psd', ldjson: 'jsonl', jsonlines: 'jsonl', geojsonl: 'jsonl' }
// Файлы .lock бывают TOML, YAML и JSON; .m — Objective-C или MATLAB
const sniffLang = (t, ext) => {
    if (ext === 'lock') return /^\s*[{[]/.test(t) && !/^\s*\[\[?[\w.-]+\]/m.test(t.slice(0, 2000)) ? 'json' : /^\s*\[\[?[\w."-]+\]\]?\s*$/m.test(t.slice(0, 4000)) ? 'toml' : /^# yarn lockfile|^[\w@"].*:\s*$/m.test(t.slice(0, 2000)) ? 'yaml' : 'text'
    if (ext === 'm') return /^\s*(#import|#include|@interface|@implementation|@protocol)/m.test(t) ? 'objc' : 'matlab'
    return ext
}
const subsView = (ctx, cues, text, ext) => startDom(ctx, new MultiViewRenderer(ctx, { views: [['table', 'Таблица', () => T.subtitlesTable(cues)], ['text', 'Сплошной текст', () => T.subtitlesText(cues)]], text, ext, cls: 'subs' }))
const chatOrSheets = (ctx, data, text, ext) => data.calls ? sheets(ctx, data.calls) : startDom(ctx, new MultiViewRenderer(ctx, { views: [['chat', 'Переписка', () => SN.chatView(data)]], text: text.length < 3e6 ? text : undefined, ext, cls: 'chat' }))
// адрес файла рядом с открытым (картинки из выгрузок чатов)
const siblingUrl = (ctx, file) => rel => { if (!rel || /^https?:/.test(rel)) return null; const dir = file.parent?.path && file.parent.path !== '/' ? file.parent.path + '/' : ''; try { return ctx.app.vault.adapter.getResourcePath?.(dir + rel.replace(/^\.\//, '')) ?? null } catch { return null } }
const JSON_STRICT = new Set(['json', 'har', 'webmanifest', 'map', 'arb'])
const XML_STRICT = new Set(['xml', 'xsl', 'xslt', 'xsd', 'rdf', 'xaml', 'resx', 'csproj', 'vcxproj', 'nzb'])

export const openRenderer = async (ctx, file, ext, { asBook = false, asHex = false } = {}) => {
    const vault = ctx.app.vault
    const binary = () => file._bytes ? Promise.resolve(file._bytes) : vault.readBinary(file)
    const text = async () => { ctx.usedText = true; const b = await binary(); if (ctx.encoding) { try { return new TextDecoder(ctx.encoding).decode(b) } catch { /* неизвестная кодировка */ } } return decodeText(b) }
    if (asHex) { const b = await binary(); return showView(ctx, 'Байты', () => N.hexView(b), { cls: 'hex' }) }
    if (asBook || ext === 'md') return startBook(ctx, await openMarkdownAsBook(ctx, file))
    if (SN.BACKUP_EXTS.has(ext)) {
        const b = await binary(); const u8 = new Uint8Array(b)
        const real = SN.realExtOf(file.name, u8)
        if (real && real !== ext && !SN.BACKUP_EXTS.has(real)) {
            if (real === 'pdf') return showView(ctx, 'Документ', () => D2.pdfOfferView(ctx, file, u8, 'Это резервная копия PDF-документа. Её можно сохранить копией .pdf и открыть встроенным просмотрщиком.'))
            if (real === 'md') { const t = decodeText(b); return showView(ctx, 'Вид', () => X.markdownView(ctx, t), { text: t, ext: 'md', cls: 'md' }) }
            if (SN.isObsidianNative(real)) { const u = URL.createObjectURL(new Blob([b], { type: MIME[real] || '' })); ctx.urls.push(u); return showView(ctx, 'Вид', () => SN.nativeView(ctx, u, real), { cls: 'media' }) }
            if (real === 'ole') { try { return await sheets(ctx, readSheets(ctx, b)) } catch { throw new ReaderError('Внутри — старый документ Microsoft Office (Word, Excel или PowerPoint 97–2003). Переименуйте файл в .doc, .xls или .ppt.') } }
            if (FORMAT_BY_EXT.has(real)) return openRenderer(ctx, file, real)
        }
        if (!u8.subarray(0, 4000).includes(0)) return startDom(ctx, new CodeRenderer(ctx, decodeText(b), 'text'))
        return showView(ctx, 'Байты', () => N.hexView(b), { cls: 'hex' })
    }
    // одинаковые расширения у разных форматов: решаем по содержимому
    if (ext === 'dot' || ext === 'pot' || ext === 'bdf') {
        const b = new Uint8Array(await binary())
        if (ext === 'dot' && isCfb(b)) return startBook(ctx, D3.openDoc(b.buffer, file.basename))
        if (ext === 'pot' && isCfb(b)) return showView(ctx, 'Слайды', () => D3.pptView(ctx, b.buffer), { cls: 'ppt' })
        if (ext === 'bdf' && b[0] === 0xFF && new TextDecoder('latin1').decode(b.subarray(1, 8)) === 'BIOSEMI') return showView(ctx, 'Запись', () => SC.edfView(ctx, b.buffer), { cls: 'edf' })
    }
    const g = group(ext)
    const orig = ext
    ext = CANON[ext] ?? ext
    switch (g) {
        // ---------- книги и документы ----------
        case 'epub': case 'mobi': case 'fb2': case 'fb3': case 'txtz': case 'tcr': case 'docx': case 'odt': case 'rtf': {
            const b = await binary()
            // .pdb — книга Palm или структура белка (текст с записями HEADER/ATOM)
            if (ext === 'pdb' && /^(HEADER|ATOM  |HETATM|REMARK|CRYST1|COMPND|TITLE |MODEL )/m.test(decodeText(new Uint8Array(b).subarray(0, 4000))))
                return showView(ctx, '3D', () => G.modelView(ctx, file, b, 'pdbmol'), { text: decodeText(b), ext: 'text', cls: 'model' })
            return startBook(ctx, await openFlowBook(ctx, file, ext, b))
        }
        case 'txt': {
            ctx.usedText = true
            let buf = await binary()
            // выбранная вручную кодировка: перекодируем в UTF-8, дальше всё читается как обычно
            if (ctx.encoding) try { buf = new TextEncoder().encode(new TextDecoder(ctx.encoding).decode(buf)).buffer } catch { /* неизвестная кодировка */ }
            if (/clipping/i.test(file.name)) { const t = decodeText(buf); if (N.isClippings(file.name, t)) return startBook(ctx, N.openClippings(t, file.basename)) }
            const head = decodeText(new Uint8Array(buf).subarray(0, 8000))
            if (SN.is1C(head)) { const t = decodeText(buf); return startDom(ctx, new TableRenderer(ctx, SN.parse1C(t))) }
            if (SN.isWhatsapp(head)) { const t = decodeText(buf); return chatOrSheets(ctx, SN.parseWhatsapp(t, file.basename, siblingUrl(ctx, file)), t, 'text') }
            return startBook(ctx, await openFlowBook(ctx, file, ext, buf))
        }
        case 'opf': return startBook(ctx, await D2.openOpf(ctx, file))
        case 'doc': return startBook(ctx, D3.openDoc(await binary(), file.basename))
        case 'wri': return startBook(ctx, D3.openWri(await binary(), file.basename))
        case 'wps': return startBook(ctx, D3.openWorks(await binary(), file.basename))
        case 'ppt': { const b = await binary(); return showView(ctx, 'Слайды', () => D3.pptView(ctx, b), { cls: 'ppt' }) }
        case 'chm': return startBook(ctx, await D3.openChm(ctx, await binary(), file.basename))
        case 'docbook': case 'tei': case 'nxml': return startBook(ctx, D3.openXmlBook(await text(), file.basename, g === 'nxml' ? 'jats' : g))
        case 'info': { const t = await text(); if (DEV.isLcov(t)) return showView(ctx, 'Покрытие', () => DEV.lcovView(t), { text: t, ext: 'text', cls: 'lcov' }); if (!t.includes('\x1f')) return startDom(ctx, new CodeRenderer(ctx, t, 'text')); return startBook(ctx, D3.openInfo(t, file.basename)) }
        case 'texi': return startBook(ctx, D3.openTexinfo(await text(), file.basename))
        case 'kwd': case 'sla': case 'hwpx': case 'idml': case 'celtx': return startBook(ctx, await D3.openTextPackage(await binary(), g, file.basename))
        case 'odf': { const t = await D3.odfMath(await binary()); return showView(ctx, 'Формула', () => S1.mathmlView(t), { text: t, ext: 'xml', cls: 'mathml' }) }
        case 'ofd': { const b = await binary(); return showView(ctx, 'Страницы', () => D3.ofdView(ctx, b), { cls: 'ofd' }) }
        case 'xps': { const b = await binary(); return showView(ctx, 'Страницы', () => D3.xpsView(ctx, b), { cls: 'ofd' }) }
        case 'vsdx': { const b = await binary(); return showView(ctx, 'Схема', () => D3.vsdxView(ctx, b), { cls: 'diagram' }) }
        case 'xtc': return startPages(ctx, await S1.openXtc(await binary()), { invertByDefault: true })
        case 'ncx': { const t = await text(); return showView(ctx, 'Оглавление', () => S1.ncxView(t), { text: t, ext: 'xml', cls: 'ncx' }) }
        case 'gdoc': { const t = await text(); return showView(ctx, 'Ссылка', () => S1.gdocView(t, ext), { text: t, ext: 'json', cls: 'shortcut' }) }
        case 'mml': { const t = await text(); return showView(ctx, 'Формула', () => S1.mathmlView(t), { text: t, ext: 'xml', cls: 'mathml' }) }
        case 'umd': return startBook(ctx, await D2.openUmd(await binary(), file.basename))
        case 'abw': return startBook(ctx, await D2.openAbw(await binary(), file.basename, ext))
        case 'azw4': {
            const pdf = D2.findPdf(new Uint8Array(await binary()))
            if (!pdf) throw new ReaderError('Внутри книги не найден PDF.')
            return showView(ctx, 'Книга', () => D2.pdfOfferView(ctx, file, pdf, 'Это книга Kindle Print Replica — внутри неё PDF с макетом бумажного издания. Его можно сохранить отдельным файлом и открыть встроенным просмотрщиком PDF.'))
        }
        case 'hwp': { const b = await binary(); return showView(ctx, 'Документ', () => G.hwpView(ctx, b), { cls: 'hwp' }) }
        case 'pages': {
            const b = await binary()
            if (ext === 'numbers') { try { const sh = await readSheets(ctx, b); if (sh?.length && sh.some(x => x.rows?.length)) return startDom(ctx, new TableRenderer(ctx, sh)) } catch { /* нет — покажем превью */ } }
            const u8 = new Uint8Array(b)
            if (!(u8[0] === 0x50 && u8[1] === 0x4B)) {
                if (ext === 'key' && new TextDecoder('latin1').decode(u8.subarray(0, 64)).includes('-----BEGIN')) return showView(ctx, 'Ключ', () => N.certView(b), { text: decodeText(u8), ext: 'pem', cls: 'cert' })
                throw new ReaderError('Это не документ iWork (или старый формат, сохранённый как папка).')
            }
            const r = await D2.openIwork(b)
            if (r.pages) return startPages(ctx, r.pages)
            return showView(ctx, 'Документ', () => D2.pdfOfferView(ctx, file, r.pdf, 'В документе нет картинки-превью, но есть PDF-копия. Её можно сохранить отдельным файлом и открыть.'))
        }
        case 'fountain': {
            const ext2 = ext
            let res
            if (ext2 === 'fdx') res = D2.fdxToHtml(await text())
            else res = T.fountainToHtml(ext2 === 'highland' ? await D2.highlandText(await binary()) : await text())
            return startBook(ctx, D2.screenplayBook(res, file.basename))
        }

        // ---------- комиксы и сканы ----------
        case 'cbz': return startPages(ctx, await openComic(ctx, await binary()))
        case 'acbf': return startPages(ctx, D2.openAcbf(await binary(), ctx.urls))
        case 'tiff': return startPages(ctx, await openTiff(ctx, await binary()), { invertByDefault: true })
        case 'djvu': return startPages(ctx, await openDjvu(ctx, await binary()), { invertByDefault: true })

        // ---------- таблицы и базы данных ----------
        case 'csv': {
            const rows = parseCsv(await text(), ext)
            const cc = rows.length > 1 ? GEO.coordColumns(rows[0]) : null
            const feats = cc ? GEO.csvToFeats(rows, cc) : []
            if (feats.length >= Math.max(1, (rows.length - 1) * 0.5)) return startDom(ctx, new MultiViewRenderer(ctx, { views: [['table', 'Таблица', () => { const d = document.createElement('div'); const t = document.createElement('table'); t.className = 'ur-table'; t.innerHTML = rows.slice(0, 3000).map((r, i) => `<tr>${r.map(c => i ? `<td>${escapeHtml(c)}</td>` : `<th>${escapeHtml(c)}</th>`).join('')}</tr>`).join(''); d.append(t); return d }], ['map', 'Карта', () => MAP.mapView(ctx, { feats: feats.slice(0, 20000), title: file.basename })]], cls: 'map' }))
            return startDom(ctx, new TableRenderer(ctx, [{ name: file.basename, rows }]))
        }
        case 'xlsx': case 'ods': case 'wk1': return sheets(ctx, readSheets(ctx, await binary(), ['slk', 'dif'].includes(ext)))
        case 'ltsv': return sheets(ctx, S1.readLtsv(await text(), file.basename))
        case 'qif': return sheets(ctx, S1.readQif(await text(), file.basename))
        case 'npy': { const b = await binary(); return sheets(ctx, ext === 'npz' ? DSC.readNpz(b) : [DSC.parseNpy(new Uint8Array(b), file.basename)]) }
        case 'xpt': return sheets(ctx, DSC.readXpt(await binary()))
        case 'por': return sheets(ctx, DSC.readPor(await binary()))
        case 'rds': return sheets(ctx, DSC.readRData(ctx, await binary()))
        case 'mat': { const b = await binary(); if (H.isHdf5(new Uint8Array(b))) return showView(ctx, 'Данные', () => H.hdf5View(ctx, b, file.name), { cls: 'h5' }); return sheets(ctx, DSC.readMat(b)) }
        case 'nc': { const b = await binary(); if (H.isHdf5(new Uint8Array(b))) return showView(ctx, 'Данные', () => H.hdf5View(ctx, b, file.name), { cls: 'h5' }); return sheets(ctx, DSC.readNetcdf(b)) }
        case 'h5': { const b = await binary(); return showView(ctx, 'Данные', () => H.hdf5View(ctx, b, file.name), { cls: 'h5' }) }
        case 'mei': { const t = await text(); return showView(ctx, 'Ноты', () => H.notationView(ctx, t), { text: t, ext: ext === 'mei' ? 'xml' : 'text', cls: 'notation' }) }
        case 'step': { const b = await binary(); return showView(ctx, '3D', async () => G.modelView(ctx, file, await H.cadMeshes(ctx, b, ext), 'meshes'), { cls: 'model' }) }
        case '3dm': { const b = await binary(); return showView(ctx, '3D', async () => G.modelView(ctx, file, await H.rhinoMeshes(ctx, b), 'meshes'), { cls: 'model' }) }
        case 'ifc': { const b = await binary(); return showView(ctx, '3D', async () => G.modelView(ctx, file, await H.ifcMeshes(ctx, b), 'meshes'), { cls: 'model' }) }
        case 'swf': { const b = await binary(); return showView(ctx, 'Flash', () => H.swfView(ctx, b), { cls: 'swf' }) }
        case 'qvd': return sheets(ctx, DSC.readQvd(await binary()))
        case 'ofx': { const t = await text(); return sheets(ctx, DSC.readOfx(t)) }
        case 'odb': return sheets(ctx, DSC.readOdb(await binary()))
        case 'bed': { const t = await text(); T.assertText(t); return sheets(ctx, DSC.readGenomeTable(t, ext === 'bed' ? 'bed' : 'gff')) }
        case 'gb': { if (ext === 'gb') { const b = new Uint8Array(await binary()); if (!/^LOCUS/.test(new TextDecoder('latin1').decode(b.subarray(0, 10)))) return showView(ctx, 'Картридж', () => SYS.romView(b.buffer, 'gb'), { cls: 'sysinfo' }) } const t = await text(); return showView(ctx, 'Запись', () => DSC.genbankView(t), { text: t, ext: 'text', cls: 'genbank' }) }
        case 'gpkg': {
            const r = await SC.readGpkg(ctx, await binary())
            if (!r.feats.length) return sheets(ctx, r.sheets)
            return startDom(ctx, new MultiViewRenderer(ctx, { views: [['map', 'Карта', () => MAP.mapView(ctx, { feats: r.feats.slice(0, 20000), title: file.basename })], ['table', 'Таблицы', () => { const d = document.createElement('div'); for (const sh of r.sheets) { d.append(Object.assign(document.createElement('h3'), { textContent: sh.name })); const t = document.createElement('table'); t.className = 'ur-table'; t.innerHTML = sh.rows.slice(0, 1000).map((row, i) => `<tr>${row.map(c => i ? `<td>${escapeHtml(c)}</td>` : `<th>${escapeHtml(c)}</th>`).join('')}</tr>`).join(''); d.append(t) } return d }]], cls: 'map' }))
        }
        case 'mbtiles': { const b = await binary(); return showView(ctx, 'Карта', () => SC.mbtilesView(ctx, b), { cls: 'mbtiles' }) }
        case 'dcm': { const b = await binary(); return showView(ctx, 'Снимок', () => SC.dicomView(ctx, b), { cls: 'dicom' }) }
        case 'nii': { const b = await binary(); return showView(ctx, 'Срезы', () => SC.niftiView(ctx, b), { cls: 'nifti' }) }
        case 'edf': { const b = await binary(); return showView(ctx, 'Запись', () => SC.edfView(ctx, b), { cls: 'edf' }) }
        case 'fcs': { const b = await binary(); return showView(ctx, 'График', () => SC.fcsView(ctx, b), { cls: 'fcs' }) }
        case 'mzml': { const b = await binary(); return showView(ctx, 'Спектры', () => SC.mzmlView(ctx, b), { cls: 'mzml' }) }
        case 'mol': case 'cif': { const b = await binary(); return showView(ctx, '3D', () => G.modelView(ctx, file, b, g === 'mol' ? 'mol' : 'cif'), { text: decodeText(b).slice(0, 2e6), ext: 'text', cls: 'model' }) }
        case 'sqlite': { const b = await binary(); if (SN.isOle(new Uint8Array(b))) return showView(ctx, 'Миниатюры', () => SN.openThumbsDb(ctx, b), { cls: 'thumbs' }); return sheets(ctx, X.readSqlite(ctx, b)) }
        case 'mdb': return sheets(ctx, DS.readMdb(ctx, await binary()))
        case 'dbf': return sheets(ctx, DS.readDbf(await binary(), file.basename))
        case 'parquet': return sheets(ctx, DS.readParquet(ctx, await binary()))
        case 'arrow': return sheets(ctx, DS.readArrow(ctx, await binary()))
        case 'avro': return sheets(ctx, DS.readAvro(ctx, await binary()))
        case 'sav': {
            const b = await binary()
            return sheets(ctx, ext === 'sav' ? DS.readSav(b) : ext === 'dta' ? DS.readDta(b) : DS.readSas(b))
        }

        // ---------- презентации и рисунки LibreOffice ----------
        case 'pptx': ctx.buffer = await binary(); return startDom(ctx, new SlidesRenderer(ctx, renderPptx(ctx)))
        case 'odp': case 'odg': ctx.buffer = await binary(); return startDom(ctx, new SlidesRenderer(ctx, renderOdp(ctx)))

        // ---------- веб ----------
        case 'html': return startDom(ctx, new WebRenderer(ctx, { kind: 'html', text: await text(), url: vault.getResourcePath(file) }))
        case 'mhtml': return startDom(ctx, new WebRenderer(ctx, { kind: 'mhtml', srcdoc: parseMhtml(await binary(), ctx.urls) }))
        case 'webarchive': return startDom(ctx, new WebRenderer(ctx, { kind: 'mhtml', srcdoc: MW.parseWebarchive(await binary(), ctx.urls) }))
        case 'maff': { const r = await MW.parseMaff(await binary(), ctx.urls); return startDom(ctx, new WebRenderer(ctx, { kind: 'mhtml', srcdoc: r.html })) }
        case 'warc': { const arc = await MW.openWarc(await binary(), ext); return startDom(ctx, new ArchiveRenderer(ctx, arc, { list: MW.warcList, preview: MW.warcPreview(ctx.urls) })) }
        case 'rss': { const t = await text(); return showView(ctx, 'Вид', () => T.feedView(t, ctx.sanitize), { text: t, ext: 'xml', cls: 'feed' }) }
        case 'url': { const b = await binary(); return showView(ctx, 'Ссылка', () => MW.shortcutView(b, ext), { text: ext === 'webloc' ? undefined : decodeText(b), ext: 'ini', cls: 'shortcut' }) }

        // ---------- почта, контакты, календари ----------
        case 'eml': {
            let buf = await binary()
            if (ext === 'emlx') buf = MW.emlxToEml(buf)
            const mail = T.parseEml(buf)
            return showView(ctx, 'Письмо', () => T.emlView(mail, { onSave: saveNextTo(ctx, file) }), { text: decodeText(buf), ext: 'eml', cls: 'eml' })
        }
        case 'vnt': { const t = await text(); return showView(ctx, ext === 'vnt' ? 'Заметки' : 'Сообщения', () => S1.vnoteView(t, ext), { text: t, ext: 'text', cls: 'vnote' }) }
        case 'mbox': { const msgs = MW.parseMbox(await binary()); return startDom(ctx, new ArchiveRenderer(ctx, MW.mboxArchive(msgs), { list: MW.mboxList, preview: MW.mailPreview(saveNextTo(ctx, file)) })) }
        case 'olm': { const msgs = await N3.openOlm(await binary()); return startDom(ctx, new ArchiveRenderer(ctx, MW.mboxArchive(msgs), { list: MW.mboxList, preview: MW.mailPreview(saveNextTo(ctx, file)) })) }
        case 'pst': { const msgs = await N3.openPst(ctx, await binary()); return startDom(ctx, new ArchiveRenderer(ctx, MW.mboxArchive(msgs), { list: MW.mboxList, preview: MW.mailPreview(saveNextTo(ctx, file)) })) }
        case 'dbx': { const msgs = N3.openDbx(await binary()); return startDom(ctx, new ArchiveRenderer(ctx, MW.mboxArchive(msgs), { list: MW.mboxList, preview: MW.mailPreview(saveNextTo(ctx, file)) })) }
        case 'msg': { const mail = await MW.parseMsg(ctx, await binary()); return showView(ctx, 'Письмо', () => T.emlView(mail, { onSave: saveNextTo(ctx, file) }), { cls: 'eml' }) }
        case 'vcf': { const t = await text(); T.assertText(t); if (SN.isVcfGenomic(t)) return sheets(ctx, SN.readVcfGenomic(t, file.basename)); const cards = T.parseVcf(t); return showView(ctx, 'Вид', () => T.vcfView(cards), { text: t, ext, cls: 'vcf' }) }
        case 'pub': { const b = await binary(); return showView(ctx, 'Ключи', () => DEV.keysView(b, ext), { text: new TextDecoder('latin1').decode(new Uint8Array(b).subarray(0, 4)) === '-----' || ext !== 'gpg' ? decodeText(b) : undefined, ext: 'text', cls: 'keys' }) }
        case 'jwk': { const t = await text(); return showView(ctx, 'Ключи', () => DEV.jwkView(t), { text: ext === 'p8' ? undefined : t, ext: 'json', cls: 'keys' }) }
        case 'sha256': {
            const t = await text(); const items = DEV.parseChecksums(t, ext)
            const dir = file.parent?.path && file.parent.path !== '/' ? file.parent.path + '/' : ''
            return showView(ctx, 'Суммы', () => DEV.checksumView(items, ext.replace(/sum$/, ''), async n => { try { return new Uint8Array(await ctx.app.vault.adapter.readBinary(dir + n.replace(/^\.\//, ''))) } catch { return null } }), { text: t, ext: 'text', cls: 'sums' })
        }
        case 'sarif': { const t = await text(); return showView(ctx, 'Отчёт', () => DEV.sarifView(JSON.parse(t)), { text: t, ext: 'json', cls: 'sarif' }) }
        case 'lcov': { const t = await text(); return showView(ctx, 'Покрытие', () => DEV.lcovView(t), { text: t, ext: 'text', cls: 'lcov' }) }
        case 'cast': { const t = await text(); return showView(ctx, 'Запись', () => DEV.castView(ctx, t), { text: t.slice(0, 2e6), ext: 'json', cls: 'cast' }) }
        case 'elf': { const b = await binary(); return showView(ctx, 'Сведения', () => SYS.elfView(b), { cls: 'sysinfo' }) }
        case 'dylib': { const b = await binary(); return showView(ctx, 'Сведения', () => SYS.machoView(b), { cls: 'sysinfo' }) }
        case 'class': { const b = await binary(); return showView(ctx, 'Сведения', () => ext === 'class' ? SYS.classView(b) : ext === 'dex' ? SYS.dexView(b) : ext === 'wasm' ? SYS.wasmView(b) : ext === 'luac' ? SYS.luacView(b) : SYS.pycView(b), { cls: 'sysinfo' }) }
        case 'nes': { const b = await binary(); return showView(ctx, 'Картридж', () => SYS.romView(b, ext), { cls: 'sysinfo' }) }
        case 'lnk': { const b = await binary(); return showView(ctx, 'Ярлык', () => SYS.lnkView(b), { cls: 'sysinfo' }) }
        case 'evtx': return sheets(ctx, SYS.evtxSheets(SYS.parseEvtx(await binary())))
        case 'dmp': { const b = await binary(); return showView(ctx, 'Дамп', () => SYS.minidumpView(b), { cls: 'sysinfo' }) }
        case 'mobileconfig': { const b = await binary(); return showView(ctx, 'Профиль', () => SYS.mobileconfigView(b, X.parseBplist), { cls: 'sysinfo' }) }
        case 'p12': { const b = await binary(); return showView(ctx, 'Сертификаты', () => ext === 'crl' ? SYS.crlView(b) : ext === 'p7b' || ext === 'p7c' ? SYS.p7bView(b) : SYS.p12View(b), { cls: 'sysinfo' }) }
        case 'kdbx': { const b = await binary(); return showView(ctx, 'Сведения', () => SYS.kdbxView(b), { cls: 'sysinfo' }) }
        case 'qm': { const entries = SYS.parseQm(await binary()); return showView(ctx, 'Перевод', () => T.poView(entries), { cls: 'po' }) }
        case 'ttyrec': { const b = await binary(); const cast = ext === 'ttyrec' ? SYS.ttyrecToCast(b) : JSON.stringify({ version: 2, width: 100, height: 40 }) + '\n' + JSON.stringify([0, 'o', decodeText(b).replace(/\r?\n/g, '\r\n')]); return showView(ctx, 'Запись', () => DEV.castView(ctx, cast), { text: ext === 'typescript' ? decodeText(b) : undefined, ext: 'text', cls: 'cast' }) }
        case 'apnx': { const b = await binary(); return showView(ctx, 'Сведения', () => SYS.apnxView(b), { cls: 'sysinfo' }) }
        case 'lyx': { const t = await text(); const html = ext === 'lyx' ? SYS.lyxToHtml(t) : SYS.ditaToHtml(t); return startDom(ctx, new ArticleRenderer(ctx, { html, text: t, ext: ext === 'lyx' ? 'latex' : 'xml' })) }
        case 'p7m': {
            const b = await binary(); const u8 = new Uint8Array(b)
            if (ext === 'sig' && N3.isPgpSig(u8)) return showView(ctx, 'Подпись', () => N3.pgpSigView(b), { cls: 'sig' })
            const cms = N3.parseCms(b)
            const base = file.name.replace(/\.(p7m|p7s|sig)$/i, '')
            const innerName = cms.content ? (/\.\w{2,5}$/.test(base) ? base : base + '.bin') : null
            const detachedFor = !cms.content && /\.\w{2,5}$/.test(base) ? base : null
            return showView(ctx, 'Подпись', () => N3.signatureView(cms, { innerName, detachedFor, onOpenInner: () => saveNextTo(ctx, file)({ filename: innerName, bytes: cms.content }) }), { cls: 'sig' })
        }
        case 'ldif': { const t = await text(); T.assertText(t); const cards = MW.parseLdif(t); return showView(ctx, 'Вид', () => T.vcfView(cards), { text: t, ext, cls: 'vcf' }) }
        case 'ics': { const t = await text(); T.assertText(t); const ev = T.parseIcs(t); return showView(ctx, 'Вид', () => T.icsView(ev), { text: t, ext, cls: 'ics' }) }

        // ---------- заметки ----------
        case 'enex': return startBook(ctx, N.openEnex(await binary(), file.basename, []))
        case 'textpack': { const { text: md, map } = await N.openTextpack(await binary(), ctx.urls); return showView(ctx, 'Вид', () => X.markdownView(ctx, md, map), { text: md, ext: 'md', cls: 'md' }) }
        case 'note': { const t = await text(); return showView(ctx, 'Заметка', () => S1.tomboyView(t), { text: t, ext: 'xml', cls: 'note' }) }
        case 'tid': { const t = await text(); T.assertText(t); return showView(ctx, 'Запись', () => S1.tidView(t), { text: t, ext: 'text', cls: 'note' }) }
        case 'taskpaper': { const t = await text(); T.assertText(t); return showView(ctx, 'Задачи', () => S1.taskpaperView(t), { text: t, ext: 'text', cls: 'taskpaper' }) }
        case 'jex': return startBook(ctx, await N3.openJex(ctx, await binary(), file.basename, async md => { const d = document.createElement('div'); await ctx.renderMarkdown(md, d, file.path); return d.innerHTML }))
        case 'ctd': return startBook(ctx, await N3.openCherryTree(ctx, await binary(), file.basename, ext))
        case 'xopp': { const b = await binary(); return showView(ctx, 'Страницы', () => N3.xournalView(ctx, b), { cls: 'ofd' }) }
        case 'notebook': { const b = await binary(); return showView(ctx, 'Страницы', () => N3.smartNotebookView(ctx, b), { cls: 'ofd' }) }
        case 'goodnotes': { const b = await binary(); return showView(ctx, 'Блокнот', () => N3.goodnotesView(ctx, b), { cls: 'goodnotes' }) }
        case 'nb': { const t = await text(); return showView(ctx, 'Блокнот', () => N3.nbView(t), { text: t.length < 3e6 ? t : undefined, ext: 'text', cls: 'nb' }) }
        case 'sb3': { const b = await binary(); return showView(ctx, 'Проект', () => N3.scratchView(ctx, b), { cls: 'scratch' }) }
        case 'mm': { if (ext === 'mmap' || ext === 'smmx') { const sh = ext === 'mmap' ? await N3.parseMmap(await binary()) : await N3.parseSmmx(await binary()); return showView(ctx, 'Карта', () => N.mindmapView(sh), { cls: 'mindmap' }) }
            if (ext === 'mm') { const u8 = new Uint8Array(await binary()); const h = new TextDecoder('latin1').decode(u8.subarray(0, 300)).replace(/^\xEF\xBB\xBF/, ''); if (!/^\s*(<\?xml|<map)/.test(h)) return startDom(ctx, new CodeRenderer(ctx, decodeText(u8), 'objectivec')) }
            const sh = ext === 'km' ? S1.parseKm(await text()) : await N.parseMindmap(await binary(), ext); return showView(ctx, 'Карта', () => N.mindmapView(sh), { cls: 'mindmap' }) }
        case 'opml': { const t = await text(); return showView(ctx, 'Вид', () => T.opmlView(t), { text: t, ext: 'xml', cls: 'opml' }) }
        case 'apkg': { const b = await binary(); return showView(ctx, 'Карточки', () => N.openAnki(ctx, b, ctx.urls), { cls: 'anki' }) }
        case 'ged': { const t = await text(); T.assertText(t); const gd = N.parseGedcom(t); return showView(ctx, 'Люди', () => N.gedcomView(gd), { text: t, ext: 'ged', cls: 'ged' }) }

        // ---------- разметка ----------
        case 'markdown': case 'rmd': {
            const t = await text()
            // блоки кода R Markdown и Quarto: ```{r echo=FALSE} -> ```r
            const md = g === 'rmd' ? t.replace(/^(\s*```+)\s*\{\s*([\w.+-]+)[^}]*\}/gm, '$1$2') : t
            return showView(ctx, 'Вид', () => X.markdownView(ctx, md), { text: t, ext: 'md', cls: 'md' })
        }
        case 'adoc': { const t = await text(); return startDom(ctx, new ArticleRenderer(ctx, { html: await adocToHtml(ctx, t), text: t, ext: 'asciidoc' })) }
        case 'org': { const t = await text(); return startDom(ctx, new ArticleRenderer(ctx, { html: await orgToHtml(ctx, t), text: t, ext })) }
        case 'textile': case 'djot': case 'wiki': case 'creole': case 'bbcode': case 't2t': case 'rdoc': case 'man': {
            const t = await text(); T.assertText(t)
            const kind = ext === 'mediawiki' ? 'wiki' : /^\d$/.test(ext) ? 'man' : ext
            return startDom(ctx, new ArticleRenderer(ctx, { html: await MU.markupToHtml(ctx, kind, t), text: t, ext: kind === 'man' ? 'troff' : kind }))
        }
        case 'tex': case 'rst': case 'json': case 'yaml': case 'ini': case 'log': case 'py': case 'ex': case 'asp': {
            if (ext === 'ts') { const u8 = new Uint8Array(await binary()); if ((u8[0] === 0x47 && (u8.length <= 188 || u8[188] === 0x47)) || (u8[4] === 0x47 && u8[196] === 0x47)) return showView(ctx, 'Видео', () => M3.mpegtsView(ctx, u8.buffer, 'ts'), { cls: 'media' }) }
            const t = await text(); T.assertText(t)
            if (ext === 'gcode') return startDom(ctx, new MultiViewRenderer(ctx, { views: [['model', '3D-путь', () => G.modelView(ctx, file, new TextEncoder().encode(t).buffer, 'gcode')]], text: t, ext: 'gcode', cls: 'model' }))
            if (ext === 'lock' || ext === 'm') return startDom(ctx, new CodeRenderer(ctx, t, sniffLang(t, ext)))
            if (ext === 'json' && /^\s*[[{]/.test(t)) {
                let j = null
                try { j = JSON.parse(t) } catch { /* покажем как текст с ошибкой */ }
                if (DEV.isPostman(j)) return showView(ctx, 'Коллекция', () => DEV.postmanView(j), { text: t, ext: 'json', cls: 'postman' })
                if (SN.isTelegram(j)) return chatOrSheets(ctx, SN.parseTelegram(j, siblingUrl(ctx, file)), t, 'json')
                if (SN.isDiscord(j)) return chatOrSheets(ctx, SN.parseDiscord(j), t, 'json')
                if (SN.isLocationHistory(j)) { const m = SN.parseLocationHistory(j); return startDom(ctx, new MultiViewRenderer(ctx, { views: [['map', 'Карта', () => MAP.mapView(ctx, m)]], text: t.length < 3e6 ? t : undefined, ext: 'json', cls: 'map' })) }
            }
            if (ext === 'ts' && /^\s*(<\?xml[^>]*>\s*)?(<!DOCTYPE TS>\s*)?<TS[\s>]/.test(t)) { const entries = SN.parseQtTs(t); return showView(ctx, 'Вид', () => T.poView(entries), { text: t, ext: 'xml', cls: 'po' }) }
            if (g === 'json' && JSON_STRICT.has(ext)) return startDom(ctx, new CodeRenderer(ctx, t, ext === 'json' ? 'json' : ext))
            return startDom(ctx, new CodeRenderer(ctx, t, ext))
        }
        case 'xml': { const t = await text(); T.assertText(t); if (GEO.isAppleHealth(t.slice(0, 5000))) return sheets(ctx, GEO.parseAppleHealth(t)); if (DEV.isJunit(t.slice(0, 3000))) return showView(ctx, 'Тесты', () => DEV.junitView(t), { text: t, ext: 'xml', cls: 'junit' }); if (/<osm[\s>]/.test(t.slice(0, 2000))) return showView(ctx, 'Карта', () => MAP.mapView(ctx, GEO.parseOsmXml(t)), { cls: 'map' }); if (SN.isSmsBackup(t)) return chatOrSheets(ctx, SN.parseSmsBackup(t, ctx.urls), t, 'xml'); return startDom(ctx, new CodeRenderer(ctx, t, XML_STRICT.has(ext) ? 'xml' : ext)) }
        case 'plist': {
            const b = await binary()
            const isBin = new TextDecoder('latin1').decode(new Uint8Array(b, 0, 6)) === 'bplist'
            return startDom(ctx, new CodeRenderer(ctx, isBin ? X.parseBplist(b) : decodeText(b), isBin ? 'json' : 'xml'))
        }
        case 'textclipping': {
            const b = await binary()
            const isBin = new TextDecoder('latin1').decode(new Uint8Array(b, 0, 6)) === 'bplist'
            const t = isBin ? S1.textClippingText(parseBplistObj(b)) : decodeText(b)
            return showView(ctx, 'Текст', () => { const pre = document.createElement('pre'); pre.className = 'ur-plain-code'; pre.style.whiteSpace = 'pre-wrap'; pre.textContent = t; return pre }, { cls: 'clip' })
        }
        case 'fasta': { const t = await text(); T.assertText(t); return showView(ctx, 'Последовательности', () => S1.fastaView(t, ext), { text: t.length < 2e6 ? t : undefined, ext: 'text', cls: 'fasta' }) }
        case 'ipynb': {
            let nb
            try { nb = JSON.parse(await text()) } catch (e) { throw new ReaderError('Файл .ipynb повреждён: ' + e.message) }
            return startDom(ctx, new NotebookRenderer(ctx, nb))
        }

        // ---------- субтитры, песни, ноты, плейлисты ----------
        case 'srt': {
            if (ext === 'sub') { const b = await binary(); const u8 = new Uint8Array(b); if (u8[0] === 0 && u8[1] === 0 && u8[2] === 1 && u8[3] === 0xBA) { const dir = file.parent?.path && file.parent.path !== '/' ? file.parent.path + '/' : ''; let idx; try { idx = decodeText(await ctx.app.vault.adapter.readBinary(dir + file.basename + '.idx')) } catch { throw new ReaderError('Это субтитры-картинки VobSub, но рядом нет файла .idx с тем же именем.') } return showView(ctx, 'Субтитры', () => M3.vobsubView(b, idx), { cls: 'subs' }) } }
            const t = await text(); T.assertText(t, ext === 'sub' ? 'Похоже на субтитры-картинки VobSub (пара .sub + .idx) — их прочитать как текст нельзя.' : '')
            if (ext === 'smi' && !/<sami/i.test(t.slice(0, 3000))) return startDom(ctx, new CodeRenderer(ctx, t, 'text')) // SMILES — формулы молекул
            const cues = T.parseSubtitles(t, ext)
            return startDom(ctx, new MultiViewRenderer(ctx, { views: [['table', 'Таблица', () => T.subtitlesTable(cues)], ['text', 'Сплошной текст', () => T.subtitlesText(cues)]], text: t, ext, cls: 'subs' }))
        }
        case 'm4b': { const b = await binary(); return showView(ctx, 'Книга', () => M3.m4bView(ctx, b), { cls: 'media' }) }
        case 'aiff': { const b = await binary(); return showView(ctx, 'Звук', () => ext === 'caf' ? M3.cafView(ctx, b) : M3.aiffView(ctx, b), { cls: 'media' }) }
        case 'mka': { const b = await binary(); return showView(ctx, 'Звук', () => M3.mkaView(ctx, b), { cls: 'media' }) }
        case 'dsf': { const b = await binary(); return showView(ctx, 'Звук', () => M3.dsdView(ctx, b, ext), { cls: 'media' }) }
        case 'flv': { const b = await binary(); return showView(ctx, 'Видео', () => M3.mpegtsView(ctx, b, 'flv'), { cls: 'media' }) }
        case 'als': { const b = await binary(); return showView(ctx, 'Проект', () => M3.alsView(b), { cls: 'als' }) }
        case 'mod': { const b = await binary(); if (ext === 'mod' && /^\s*(\/\/.*\n\s*)*module\s+\S+/.test(decodeText(new Uint8Array(b).subarray(0, 2000)))) return startDom(ctx, new CodeRenderer(ctx, decodeText(b), 'go')); return showView(ctx, 'Сведения', () => M3.chipInfo(b, ext), { cls: 'chip' }) }
        case 'idx': {
            if (ext === 'sup') { const b = await binary(); return showView(ctx, 'Субтитры', () => M3.pgsView(b), { cls: 'subs' }) }
            if (ext === 'scc') { const t = await text(); return subsView(ctx, M3.parseScc(t), t, 'text') }
            const t = await text(); const dir = file.parent?.path && file.parent.path !== '/' ? file.parent.path + '/' : ''
            let sub; try { sub = await ctx.app.vault.adapter.readBinary(dir + file.basename + '.sub') } catch { throw new ReaderError('Рядом нет файла .sub с картинками субтитров (у него должно быть то же имя).') }
            return showView(ctx, 'Субтитры', () => M3.vobsubView(sub, t), { text: t, ext: 'text', cls: 'subs' })
        }
        case 'lrc': {
            const t = await text(); T.assertText(t)
            const lrc = T.parseLrc(t)
            return startDom(ctx, new MultiViewRenderer(ctx, { views: [['text', 'Текст', () => T.lrcView(lrc, false)], ['time', 'С временем', () => T.lrcView(lrc, true)]], text: t, ext, cls: 'lrc' }))
        }
        case 'chordpro': case 'tab': { const t = await text(); T.assertText(t); return showView(ctx, 'Песня', () => N.chordproView(t, ext), { text: t, ext: 'text', cls: 'chords' }) }
        case 'abc': { const t = await text(); return showView(ctx, 'Ноты', () => X.abcView(ctx, t), { text: t, ext, cls: 'abc' }) }
        case 'musicxml': { const b = await binary(); return showView(ctx, 'Ноты', () => G.musicxmlView(ctx, b, ext), { text: ext === 'musicxml' ? decodeText(b) : undefined, ext: 'xml', cls: 'osmd' }) }
        case 'mid': { const b = await binary(); return showView(ctx, 'MIDI', () => G.midiView(ctx, b), { cls: 'midi' }) }
        case 'mscz': { const b = await binary(); return showView(ctx, 'Ноты', () => S1.msczView(ctx, b), { cls: 'preview' }) }
        case 'aac': return showView(ctx, ext === 'aac' ? 'Звук' : 'Видео', () => S1.mediaPlayerView(vault.getResourcePath(file), ext), { cls: 'media' })
        case 'rpp': { const t = await text(); return showView(ctx, 'Проект', () => S1.rppView(t), { text: t, ext: 'text', cls: 'rpp' }) }
        case 'mpd': { const t = await text(); return showView(ctx, 'Поток', () => S1.mpdView(t), { text: t, ext: 'xml', cls: 'mpd' }) }
        case 'm3u': { const t = await text(); T.assertText(t); if (ext === 'cue' && !/^\s*(REM|FILE|TRACK|PERFORMER|TITLE|CATALOG|CDTEXTFILE|SONGWRITER)\b/mi.test(t.slice(0, 3000))) return startDom(ctx, new CodeRenderer(ctx, t, 'text')); const pl = ['asx', 'wpl', 'zpl'].includes(ext) ? S1.parseXmlPlaylist(t, ext) : N.parsePlaylist(t, ext); return showView(ctx, 'Список', () => N.playlistView(pl), { text: t, ext: ['xspf', 'asx', 'wpl', 'zpl'].includes(ext) ? 'xml' : 'text', cls: 'playlist' }) }

        // ---------- схемы и чертежи ----------
        case 'mmd': { const t = await text(); return showView(ctx, 'Диаграмма', () => X.mermaidView(ctx, t), { text: t, ext: 'mermaid', cls: 'mermaid' }) }
        case 'dot': { const t = await text(); return showView(ctx, 'Схема', () => G.dotView(ctx, t), { text: t, ext: 'dot', cls: 'diagram' }) }
        case 'drawio': { const t = await text(); return showView(ctx, 'Схема', () => G.drawioView(ctx, t), { text: t, ext: 'xml', cls: 'diagram' }) }
        case 'excalidraw': { const t = await text(); return showView(ctx, 'Рисунок', () => SK.excalidrawView(ctx, t), { text: t, ext: 'json', cls: 'diagram' }) }
        case 'tldr': { const t = await text(); return showView(ctx, 'Доска', () => SK.tldrView(ctx, t), { text: t, ext: 'json', cls: 'diagram' }) }
        case 'bpmn': { const t = await text(); return showView(ctx, 'Схема', () => G.bpmnView(ctx, t), { text: t, ext: 'xml', cls: 'bpmn' }) }
        case 'dxf': { const t = await text(); return showView(ctx, 'Чертёж', () => G.dxfView(ctx, t), { cls: 'diagram' }) }

        // ---------- карты ----------
        case 'gpx': { const t = await text(); const m = MAP.parseGpx(t); return showView(ctx, 'Карта', () => MAP.mapView(ctx, m), { text: t, ext: 'xml', cls: 'map' }) }
        case 'kml': { const t = ext === 'kmz' ? await MAP.kmzText(await binary()) : await text(); const m = MAP.parseKml(t); return showView(ctx, 'Карта', () => MAP.mapView(ctx, m), { text: t, ext: 'xml', cls: 'map' }) }
        case 'geojson': { const t = await text(); const m = MAP.parseGeojson(t); return showView(ctx, 'Карта', () => MAP.mapView(ctx, m), { text: t, ext: 'json', cls: 'map' }) }
        case 'shp': { const m = await MAP.openShp(ctx, file, await binary()); return showView(ctx, 'Карта', () => MAP.mapView(ctx, m), { cls: 'map' }) }
        case 'tcx': {
            const t = await text(); const m = S1.parseTcx(t)
            const views = []
            if (m.feats.length) views.push(['map', 'Карта', () => MAP.mapView(ctx, m)])
            if (m.hr.length > 1) views.push(['hr', 'Пульс', () => S1.chartView(ctx, [{ name: 'Пульс', unit: 'уд/мин', color: '#e6194b', time: true, points: m.hr }])])
            if (!views.length) throw new ReaderError('В тренировке нет ни маршрута, ни пульса.')
            return startDom(ctx, new MultiViewRenderer(ctx, { views, text: t, ext: 'xml', cls: 'map' }))
        }
        case 'pwx': {
            const t = await text(); const r = ext === 'hrm' ? S1.parseHrm(t) : S1.parsePwx(t)
            const views = [['chart', 'Графики', () => S1.chartView(ctx, r.series, { title: r.title })]]
            if (r.feats?.length) views.push(['map', 'Карта', () => MAP.mapView(ctx, r)])
            return startDom(ctx, new MultiViewRenderer(ctx, { views, text: t, ext: ext === 'pwx' ? 'xml' : 'ini', cls: 'chart' }))
        }
        case 'hpgl': { const t = await text(); return showView(ctx, 'Чертёж', () => SN.hpglView(ctx, t), { text: t, ext: 'text', cls: 'diagram' }) }
        case 'igc': case 'plt': case 'nmea': case 'loc': case 'wkt': {
            const t = await text()
            if (ext === 'plt' && SN.isHpgl(t)) return showView(ctx, 'Чертёж', () => SN.hpglView(ctx, t), { text: t, ext: 'text', cls: 'diagram' })
            T.assertText(t)
            const m = g === 'igc' ? S1.parseIgc(t) : g === 'plt' ? S1.parseOzi(t, ext) : g === 'nmea' ? S1.parseNmea(t) : g === 'loc' ? S1.parseLoc(t) : S1.parseWkt(t)
            return showView(ctx, 'Карта', () => MAP.mapView(ctx, m), { text: t, ext: g === 'loc' ? 'xml' : 'text', cls: 'map' })
        }
        case 'ov2': {
            if (ext === 'itn') { const t = await text(); const m = S1.parseItn(t); return showView(ctx, 'Карта', () => MAP.mapView(ctx, m), { text: t, ext: 'text', cls: 'map' }) }
            const m = S1.parseOv2(await binary()); return showView(ctx, 'Карта', () => MAP.mapView(ctx, m), { cls: 'map' })
        }

        // ---------- 3D ----------
        case 'stl': case 'fbx': case 'xyz': { const b = await binary()
            if (ext === 'stl' && SN.isEbuStl(new Uint8Array(b))) { const r = SN.parseEbuStl(new Uint8Array(b)); return subsView(ctx, r.cues, undefined, 'text') }
            if (ext === 'xyz') { const t = decodeText(b); return showView(ctx, '3D', () => G.modelView(ctx, file, b, SN.isXyzMolecule(t) ? 'xyzmol' : 'xyz'), { text: t.length < 2e6 ? t : undefined, ext: 'text', cls: 'model' }) } return showView(ctx, '3D', () => G.modelView(ctx, file, b, ext === 'vrml' ? 'wrl' : ext), { cls: 'model' }) }
        case 'usdz': case 'lwo': case 'bvh': { const b = await binary(); return showView(ctx, '3D', () => G.modelView(ctx, file, b, ext === 'usd' ? (new TextDecoder('latin1').decode(new Uint8Array(b, 0, 8)).startsWith('#usda') ? 'usda' : 'usdc') : ext), { text: ext === 'bvh' || ext === 'usda' ? decodeText(b).slice(0, 2e6) : undefined, ext: 'text', cls: 'model' }) }
        case 'blend': { const b = await binary(); if (ext === 'skp') return startPages(ctx, await I3.previewOf(ctx, b, ext)); return startPages(ctx, (await I3.blendThumb(ctx, b)).pages) }
        case 'nrrd': { const b = await binary(); if (ext === 'nhdr') throw new ReaderError('Это только заголовок NRRD — данные лежат в соседнем файле. Откройте файл .nrrd с данными внутри.'); return showView(ctx, 'Срезы', () => SC.nrrdView(ctx, b), { cls: 'nifti' }) }
        case 'gbr': {
            const t = await text()
            if (ext === 'gml' && /<\?xml|<gml:|FeatureCollection/.test(t.slice(0, 3000))) { const m = GEO.parseGml(t); return showView(ctx, 'Карта', () => MAP.mapView(ctx, m), { text: t, ext: 'xml', cls: 'map' }) }
            return showView(ctx, 'Плата', () => CAD.gerberView(ctx, t, file.name), { text: t, ext: 'text', cls: 'cad' })
        }
        case 'kicad_pcb': { const t = await text(); return showView(ctx, ext === 'kicad_sch' ? 'Схема' : 'Плата', () => ext === 'kicad_sch' ? CAD.kicadSchView(ctx, t) : CAD.kicadPcbView(ctx, t), { text: t, ext: 'lisp', cls: 'cad' }) }
        case 'fit': case 'slf': {
            const r = g === 'fit' ? GEO.parseFit(await binary()) : GEO.parseSlf(await text())
            const views = []
            if (r.series.length) views.push(['chart', 'Графики', () => S1.chartView(ctx, r.series, { title: r.title })])
            if (r.feats.length) views.push(['map', 'Карта', () => MAP.mapView(ctx, r)])
            if (!views.length) throw new ReaderError('В тренировке нет ни трека, ни графиков.')
            return startDom(ctx, new MultiViewRenderer(ctx, { views, cls: 'chart' }))
        }
        case 'osm': { const m = ext === 'pbf' ? GEO.parseOsmPbf(await binary()) : GEO.parseOsmXml(await text()); return showView(ctx, 'Карта', () => MAP.mapView(ctx, m), { cls: 'map' }) }
        case 'mif': {
            const t = await text(); let mid = null
            try { const dir = file.parent?.path && file.parent.path !== '/' ? file.parent.path + '/' : ''; mid = decodeText(await ctx.app.vault.adapter.readBinary(dir + file.basename + '.mid')) } catch { /* без .mid */ }
            const m = GEO.parseMif(t, mid); return showView(ctx, 'Карта', () => MAP.mapView(ctx, m), { text: t, ext: 'text', cls: 'map' })
        }
        case 'fcstd': { const { page } = await S1.zipPreview(await binary(), ext); return startPages(ctx, I.pagesOf([page])) }

        // ---------- картинки ----------
        case 'svg': {
            if (ext === 'svgz') {
                const { gunzip } = await import('./formats/compress.js')
                const t = new TextDecoder().decode(await gunzip(new Uint8Array(await binary())))
                const u = URL.createObjectURL(new Blob([t], { type: 'image/svg+xml' })); ctx.urls.push(u)
                return startDom(ctx, new WebRenderer(ctx, { kind: 'svg', text: t, url: u }))
            }
            return startDom(ctx, new WebRenderer(ctx, { kind: 'svg', text: await text(), url: vault.getResourcePath(file) }))
        }
        case 'heic': return startPages(ctx, await X.openHeic(ctx, await binary()))
        case 'jxl': return startPages(ctx, await I.openJxl(ctx, await binary()))
        case 'sgi': { const u8 = new Uint8Array(await binary()); const r = ext === 'ras' || ext === 'sun' ? I3.decodeSun(u8) : ['iff', 'ilbm', 'lbm'].includes(ext) ? I3.decodeIlbm(u8) : I3.decodeSgi(u8); return startPages(ctx, I.pagesOf([await I.rgbaToPage(r.w, r.h, r.rgba)])) }
        case 'ktx': { const b = await binary(); return startPages(ctx, ext === 'vtf' ? await I3.openVtf(b) : ext === 'blp' ? await I3.openBlp(b) : ext === 'pvr' ? await I3.openPvr(b) : await I3.openKtx(ctx, b)) }
        case 'mng': { const b = await binary(); return showView(ctx, 'Анимация', () => I3.mngView(ctx, b), { cls: 'mng' }) }
        case 'pict': return startPages(ctx, await I3.openPict(await binary()))
        case 'xcf': { const r = await I3.openXcf(await binary()); const p = await r.pages.getPage(0); return startDom(ctx, new MultiViewRenderer(ctx, { views: [['img', 'Картинка', () => { const d = document.createElement('div'); d.className = 'ur-xcf'; const im = document.createElement('img'); im.src = p.url; im.className = 'ur-xcf-img'; d.append(im); return d }], ['layers', 'Слои', () => I3.xcfLayersHtml(r)]], cls: 'xcf' })) }
        case 'jp2': return startPages(ctx, await I3.openJp2(ctx, await binary()))
        case 'eps': {
            const u8 = new Uint8Array(await binary()); const e = I3.epsInfo(u8)
            const meta = [e.title, e.creator, e.date].filter(Boolean).join(' · ')
            if (e.tiff) { try { return startPages(ctx, await openTiff(ctx, e.tiff.slice().buffer)) } catch { /* превью не прочиталось */ } }
            if (e.wmf) return showView(ctx, 'Превью', () => I.emfView(ctx, e.wmf.slice().buffer, 'wmf'), { text: e.text.slice(0, 2e6), ext: 'postscript', cls: 'image' })
            const pr = I3.epsiPreview(e.text); if (pr) return startPages(ctx, I.pagesOf([await I.rgbaToPage(pr.w, pr.h, pr.rgba)]))
            const x = I3.xmpThumb(u8); if (x) return startPages(ctx, I.pagesOf([await I.blobPage(x, 'image/jpeg')]))
            return showView(ctx, 'Сведения', () => { const d = document.createElement('div'); d.innerHTML = `<p>В этом рисунке нет встроенного превью, а сам PostScript читалка рисовать не умеет. Код рисунка — во вкладке «Код».</p>${meta ? `<p class="ur-muted">${escapeHtml(meta)}</p>` : ''}${e.bbox ? `<p class="ur-muted">Размер: ${escapeHtml(e.bbox)}</p>` : ''}`; return d }, { text: e.text.slice(0, 2e6), ext: 'postscript', cls: 'eps' })
        }
        case 'clip': return startPages(ctx, await I3.previewOf(ctx, await binary(), ext))
        case 'icc': { const b = await binary(); return showView(ctx, 'Профиль', () => I3.iccView(b), { cls: 'icc' }) }
        case 'cube': { const t = await text(); return showView(ctx, 'До и после', () => I3.lutView(t, ext), { text: t, ext: 'text', cls: 'lut' }) }
        case 'jfif': case 'qoi': return startPages(ctx, await I.openSimpleImage(ext, await binary()))
        case 'dng': return startPages(ctx, await I.openRaw(await binary()))
        case 'psd': return startPages(ctx, await X.openPsd(ctx, await binary()))
        case 'procreate': {
            if (ext === 'pdn') return startPages(ctx, await S1.openPdn(await binary()))
            const { page } = await S1.zipPreview(await binary(), ext)
            return startPages(ctx, I.pagesOf([page], [{ label: 'Картинка-превью, сохранённая программой (слои не показываются)', target: 0 }]))
        }
        case 'xmp': { const t = await text(); return showView(ctx, 'Метаданные', () => S1.xmpView(t), { text: t, ext: 'xml', cls: 'xmp' }) }
        case 'ase': { const b = await binary(); return showView(ctx, 'Палитра', () => S1.paletteView(S1.parsePalette(b, ext)), { cls: 'palette' }) }
        case 'ora': return startPages(ctx, await I.openOra(await binary()))
        case 'ico': {
            const b = await binary()
            if (ext === 'ani') return showView(ctx, 'Курсор', () => I.aniView(b, ctx.cleanups), { cls: 'ico' })
            return showView(ctx, ext === 'cur' ? 'Курсор' : 'Иконка', () => ext === 'cur' ? I.curView(b) : X.icoView(b), { cls: 'ico' })
        }
        case 'icns': return startPages(ctx, await I.openIcns(await binary()))
        case 'hdr': { const b = await binary(); return showView(ctx, 'Картинка', () => I.hdrView(ctx, b, ext), { cls: 'hdr' }) }
        case 'dds': return startPages(ctx, await I.openDds(await binary()))
        case 'emf': {
            let b = await binary(), e = ext
            if (ext === 'emz' || ext === 'wmz') { const { gunzip } = await import('./formats/compress.js'); const u = await gunzip(new Uint8Array(b)); b = u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); e = ext === 'emz' ? 'emf' : 'wmf' }
            return showView(ctx, 'Картинка', () => I.emfView(ctx, b, e), { cls: 'emf' })
        }
        case 'fits': { const b = await binary(); return showView(ctx, 'Снимок', () => I.fitsView(b), { cls: 'fits' }) }
        case 'ai': {
            const u8 = new Uint8Array(await binary())
            const pdf = D2.findPdf(u8)
            if (!pdf) throw new ReaderError('Это старый файл Illustrator в формате PostScript — показать его нельзя.')
            return showView(ctx, 'Рисунок', () => D2.pdfOfferView(ctx, file, pdf, 'Файл Adobe Illustrator хранит рисунок в формате PDF. Его можно сохранить копией .pdf и открыть встроенным просмотрщиком.'))
        }

        // ---------- шрифты ----------
        case 'ttf': {
            const b = await binary()
            if (ext === 'ttc' || ext === 'otc') return showView(ctx, 'Шрифты', () => FN.ttcView(ctx, b, file.basename), { cls: 'font' })
            return showView(ctx, 'Шрифт', () => X.fontView(ctx, b, ext, file.basename), { cls: 'font' })
        }
        case 'eot': { const b = FN.eotToSfnt(await binary()); return showView(ctx, 'Шрифт', () => X.fontView(ctx, b, 'ttf', file.basename), { cls: 'font' }) }
        case 'pfb': { const b = await binary(); return showView(ctx, 'Шрифт', () => FN.type1View(b), { cls: 'font' }) }
        case 'fon': {
            const b = await binary()
            if (ext === 'fnt' && F3.isBmFont(new Uint8Array(b))) {
                const f = F3.parseBmFont(new Uint8Array(b)); const dir = file.parent?.path && file.parent.path !== '/' ? file.parent.path + '/' : ''
                return showView(ctx, 'Шрифт', () => F3.bmFontView(f, async p => { try { const d = await ctx.app.vault.adapter.readBinary(dir + p); const u = URL.createObjectURL(new Blob([d])); ctx.urls.push(u); return u } catch { return null } }), { text: decodeText(b).slice(0, 1e6), ext: 'text', cls: 'font' })
            }
            return showView(ctx, 'Шрифт', () => FN.bitmapFontView(b, ext), { cls: 'font' })
        }
        case 'pcf': {
            const b = await binary()
            if (ext === 'pcf') return showView(ctx, 'Шрифт', () => FN.fontGlyphsView(F3.parsePcf(new Uint8Array(b))), { cls: 'font' })
            const fonts = F3.dfontSfnts(new Uint8Array(b))
            return showView(ctx, 'Шрифт', async () => { const d = document.createElement('div'); for (const f of fonts) { const v = await X.fontView(ctx, f.bytes.buffer, 'ttf', f.name || file.basename); d.append(v) } return d }, { cls: 'font' })
        }
        case 'sfd': {
            if (ext === 'vfc') throw new ReaderError('Двоичный формат FontLab .vfc закрыт. Сохраните проект в FontLab как .vfj — его читалка открывает.')
            const b = await binary()
            const r = ext === 'ufoz' ? await F3.parseUfoz(b) : ext === 'glyphs' ? F3.parseGlyphsApp(decodeText(b)) : ext === 'vfj' ? F3.parseVfj(decodeText(b)) : F3.parseSfd(decodeText(b))
            return showView(ctx, 'Шрифт', () => F3.outlineFontView(r), { text: ext === 'ufoz' ? undefined : decodeText(b).slice(0, 2e6), ext: ext === 'vfj' ? 'json' : 'text', cls: 'font' })
        }
        case 'jhf': { const b = await binary(); return showView(ctx, 'Шрифт', () => ext === 'chr' ? F3.bgiChrView(b, file.basename) : F3.jhfView(decodeText(b), file.basename), { text: ext === 'jhf' ? decodeText(b) : undefined, ext: 'text', cls: 'font' }) }
        case 'afm': { const b = await binary(); return showView(ctx, 'Метрики', () => S1.fontMetricsView(b, ext), { text: ext === 'afm' ? decodeText(b) : undefined, ext: 'text', cls: 'font' }) }

        // ---------- архивы ----------
        case 'zip': {
            if ((file.parent?.children ?? []).some(f => f.name === file.name.replace(/\.zip$/i, '.z01'))) return startDom(ctx, new ArchiveRenderer(ctx, await multiVolume(ctx, file), { list: A.archiveList, preview: A.archivePreview }))
            const buf = await binary()
            const kind = await sniffZipBook(buf)
            if (kind === 'comic') return startPages(ctx, await openComic(ctx, buf))
            if (kind) return startBook(ctx, await openFlowBook(ctx, file, 'zip', buf))
            return startDom(ctx, new ArchiveRenderer(ctx, await A.openArchive(ctx, buf, ext, file.name), { list: A.archiveList, preview: A.archivePreview }))
        }
        case 'uue': return startDom(ctx, new ArchiveRenderer(ctx, S1.openEncoded(await binary(), ext, file.name), { list: A.archiveList, preview: A.archivePreview }))
        case 'rar': case '7z': case 'tar': case 'jar': case 'deb': case 'cab': case 'lzma': {
            if (/\.nii\.gz$/i.test(file.name)) { const b = await binary(); return showView(ctx, 'Срезы', () => SC.niftiView(ctx, b), { cls: 'nifti' }) }
            if (/\.pcf\.gz$/i.test(file.name)) { const { gunzip } = await import('./formats/compress.js'); const u = await gunzip(new Uint8Array(await binary())); return showView(ctx, 'Шрифт', () => FN.fontGlyphsView(F3.parsePcf(u)), { cls: 'font' }) }
            if (/\.part0*1\.rar$/i.test(file.name)) return startDom(ctx, new ArchiveRenderer(ctx, await multiVolume(ctx, file), { list: A.archiveList, preview: A.archivePreview }))
            const b = await binary()
            const arc = await A.openArchive(ctx, b, ext, file.name)
            if (g === 'jar') { try { const info = await A2.packagePassport(ctx, b, ext, X.parseBplist); if (info) arc.info = info } catch { /* без паспорта */ } }
            return startDom(ctx, new ArchiveRenderer(ctx, arc, { list: A.archiveList, preview: A.archivePreview }))
        }
        case 'iso': { let r = await rangeReader(ctx, file); if (ext === 'mdf') r = await A2.rawSectorReader(r); return startDom(ctx, new ArchiveRenderer(ctx, await A.openIso(r), { list: A.archiveList, preview: A.archivePreview })) }
        case 'snap': {
            let b = await binary()
            if (b.byteLength > 1.8e9) throw new ReaderError('Образ слишком большой, чтобы открыть его целиком.')
            const arc = ext === 'appimage' ? await A.open7z(ctx, [{ name: 'a.squashfs', u8: A2.appImageFs(new Uint8Array(b)) }], 'a.squashfs') : await A.openArchive(ctx, b, ext, file.name)
            return startDom(ctx, new ArchiveRenderer(ctx, arc, { list: A.archiveList, preview: A.archivePreview }))
        }
        case '001': return startDom(ctx, new ArchiveRenderer(ctx, await multiVolume(ctx, file), { list: A.archiveList, preview: A.archivePreview }))
        case 'br': return startDom(ctx, new ArchiveRenderer(ctx, await A2.openBrotli(ctx, await binary(), file.name), { list: A.archiveList, preview: A.archivePreview }))
        case 'pak': return startDom(ctx, new ArchiveRenderer(ctx, A2.openGameArchive(await binary(), ext), { list: A.archiveList, preview: A.archivePreview }))

        // ---------- прочее ----------
        case 'diff': { const t = await text(); T.assertText(t); return showView(ctx, 'Вид', () => T.diffView(t), { text: t, ext: 'diff', cls: 'diff' }) }
        case 'nfo': {
            const b = await binary()
            if (ext === 'ans') return showView(ctx, 'Рисунок', () => N.ansiView(b), { cls: 'nfo' })
            const t = T.decodeNfo(b)
            return showView(ctx, 'Вид', () => { const pre = document.createElement('pre'); pre.textContent = t; return pre }, { cls: 'nfo' })
        }
        case 'bib': { const t = await text(); const r = ext === 'bib' ? T.parseBib(t) : T.parseRis(t); return showView(ctx, 'Вид', () => T.refsView(r), { text: t, ext: ext === 'bib' ? 'bibtex' : ext, cls: 'refs' }) }
        case 'po': {
            const b = await binary()
            const entries = ext === 'po' || ext === 'pot' ? T.parsePo(decodeText(b)) : N.parseTranslations(b, ext)
            return showView(ctx, 'Вид', () => T.poView(entries), { text: ext === 'mo' ? undefined : decodeText(b), ext: ext === 'po' || ext === 'pot' ? ext : 'xml', cls: 'po' })
        }
        case 'torrent': { const b = await binary(); return showView(ctx, 'Торрент', () => N.torrentView(b), { cls: 'torrent' }) }
        case 'pem': { const b = await binary(); const u8 = new Uint8Array(b); return showView(ctx, 'Сертификат', () => N.certView(b), { text: u8.subarray(0, 2000).includes(0) ? undefined : decodeText(u8), ext: 'pem', cls: 'cert' }) }
        case 'exe': { const b = await binary(); return showView(ctx, 'Сведения', () => G.peView(ctx, b), { cls: 'pe' }) }
        case 'bin': { const b = await binary(); return showView(ctx, 'Байты', () => N.hexView(b), { cls: 'hex' }) }
    }
    // новые языки и конфиги без отдельного просмотрщика — исходник с подсветкой
    const fmt = FORMAT_BY_EXT.get(orig)
    if (fmt && (fmt.group === 'code' || fmt.group === 'data')) { const t = await text(); T.assertText(t); return startDom(ctx, new CodeRenderer(ctx, t, orig)) }
    throw new ReaderError('Формат не поддерживается: .' + ext)
}
