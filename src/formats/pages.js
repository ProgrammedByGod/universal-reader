// Источники «готовых страниц»: комиксы (zip/rar/7z/tar), многостраничный TIFF, DjVu.
// Источник: { count, getPage(i) -> {url,width,height}, releasePage?(i), getText?(i), toc?, destroy() }
import JSZip from 'jszip'
import { isImageName, naturalCompare, extOf, MIME, parseTar, sniffArchive, imageDataToUrl, canvasToUrl, ReaderError } from '../util.js'

const blobSource = (names, loadBytes) => {
    const cache = new Map()
    return {
        count: names.length,
        names,
        async getPage(i) {
            if (cache.has(i)) return cache.get(i)
            const bytes = await loadBytes(names[i])
            const url = URL.createObjectURL(new Blob([bytes], { type: MIME[extOf(names[i])] || 'image/jpeg' }))
            const page = { url }
            cache.set(i, page)
            return page
        },
        releasePage(i) {
            const p = cache.get(i)
            if (p) { URL.revokeObjectURL(p.url); cache.delete(i) }
        },
        destroy() { for (const p of cache.values()) URL.revokeObjectURL(p.url); cache.clear() },
    }
}

const sortImages = names => names.filter(isImageName).sort(naturalCompare)

export const openComic = async (ctx, buf) => {
    const kind = sniffArchive(buf)
    if (kind === 'zip') {
        const zip = await JSZip.loadAsync(buf)
        const names = sortImages(Object.keys(zip.files).filter(n => !zip.files[n].dir))
        if (!names.length) throw new ReaderError('В архиве нет картинок.')
        return blobSource(names, n => zip.file(n).async('uint8array'))
    }
    if (kind === 'tar') {
        const { entries, data } = parseTar(buf)
        const map = new Map(entries.map(e => [e.name, e]))
        const names = sortImages([...map.keys()])
        if (!names.length) throw new ReaderError('В архиве нет картинок.')
        return blobSource(names, n => { const e = map.get(n); return data.slice(e.offset, e.offset + e.size) })
    }
    if (kind === 'rar') {
        const { createExtractorFromData, wasmBinary } = await ctx.loadLib('unrar')
        const extractor = await createExtractorFromData({ data: buf, wasmBinary })
        const list = [...extractor.getFileList().fileHeaders]
        const names = sortImages(list.filter(h => !h.flags.directory).map(h => h.name))
        if (!names.length) throw new ReaderError('В архиве нет картинок.')
        return blobSource(names, async n => {
            const ex = await createExtractorFromData({ data: buf, wasmBinary })
            const { files } = ex.extract({ files: [n] })
            for (const f of files) return f.extraction
            throw new ReaderError('Не удалось распаковать ' + n)
        })
    }
    if (kind === '7z') {
        const { SevenZip, wasmBinary } = await ctx.loadLib('sevenzip')
        const sz = await SevenZip({ wasmBinary, print: () => {}, printErr: () => {} })
        sz.FS.writeFile('/a.7z', new Uint8Array(buf))
        sz.FS.mkdir('/out')
        sz.callMain(['x', '/a.7z', '-o/out', '-y'])
        const files = []
        const walk = dir => {
            for (const name of sz.FS.readdir(dir)) {
                if (name === '.' || name === '..') continue
                const p = dir + '/' + name
                if (sz.FS.isDir(sz.FS.stat(p).mode)) walk(p); else files.push(p.slice(5))
            }
        }
        walk('/out')
        const names = sortImages(files)
        if (!names.length) throw new ReaderError('В архиве нет картинок.')
        return blobSource(names, n => sz.FS.readFile('/out/' + n))
    }
    throw new ReaderError('Неизвестный тип архива комикса.')
}

export const openTiff = async (ctx, buf) => {
    const UTIF = await ctx.loadLib('utif')
    const ifds = UTIF.decode(buf).filter(ifd => ifd.t256 && ifd.t257)
    if (!ifds.length) throw new ReaderError('В файле TIFF не найдено страниц.')
    const cache = new Map()
    return {
        count: ifds.length,
        async getPage(i) {
            if (cache.has(i)) return cache.get(i)
            const ifd = ifds[i]
            UTIF.decodeImage(buf, ifd)
            const rgba = UTIF.toRGBA8(ifd)
            const w = ifd.width, h = ifd.height
            const page = await imageDataToUrl(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h))
            ifd.data = null
            cache.set(i, page)
            return page
        },
        releasePage(i) { const p = cache.get(i); if (p) { URL.revokeObjectURL(p.url); cache.delete(i) } },
        destroy() { for (const p of cache.values()) URL.revokeObjectURL(p.url); cache.clear() },
    }
}

export const openDjvu = async (ctx, buf) => {
    const { Document } = await ctx.loadLib('djvu')
    const doc = new Document(buf)
    const count = doc.getPagesQuantity()
    const cache = new Map()
    const texts = new Map()
    let queue = Promise.resolve()
    const serial = fn => (queue = queue.then(fn, fn))
    const mapToc = items => (items || []).map(it => {
        let page = null
        try { page = doc.getPageNumberByUrl(it.url) } catch { /* ignore */ }
        if (page == null) { const m = /#?(\d+)/.exec(it.url || ''); if (m) page = Number(m[1]) }
        return { label: it.description || it.url, target: page ? page - 1 : 0, subitems: mapToc(it.children) }
    })
    let toc = null
    try { toc = mapToc(doc.getContents()) } catch { toc = null }
    return {
        count,
        toc: toc?.length ? toc : null,
        getPage(i) {
            if (cache.has(i)) return cache.get(i)
            const p = serial(async () => {
                const page = await doc.getPage(i + 1)
                const data = page.getImageData()
                try { if (!texts.has(i)) texts.set(i, page.getText() || '') } catch { texts.set(i, '') }
                page.reset?.()
                return imageDataToUrl(data)
            })
            cache.set(i, p)
            return p
        },
        async releasePage(i) {
            const p = cache.get(i)
            if (p) { cache.delete(i); URL.revokeObjectURL((await p).url) }
        },
        getText(i) {
            if (texts.has(i)) return texts.get(i)
            return serial(async () => {
                const page = await doc.getPage(i + 1)
                let t = ''
                try { t = page.getText() || '' } catch { t = '' }
                texts.set(i, t)
                return t
            })
        },
        destroy() { for (const p of cache.values()) p.then(x => URL.revokeObjectURL(x.url)); cache.clear() },
    }
}

export { canvasToUrl }
