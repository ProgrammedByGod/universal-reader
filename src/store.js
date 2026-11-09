// library.json в папке хранилища: место чтения по каждому файлу (позже — полка, закладки, прогресс)
import { normalizePath } from 'obsidian'
import { debounce } from './util.js'

export class LibraryStore {
    data = { version: 1, books: {} }
    constructor(app, getFolder) {
        this.app = app
        this.getFolder = getFolder
        this.saveSoon = debounce(() => this.save(), 2000)
    }
    get path() { return normalizePath(`${this.getFolder()}/library.json`) }
    async load() {
        try {
            const a = this.app.vault.adapter
            if (await a.exists(this.path)) {
                const parsed = JSON.parse(await a.read(this.path))
                if (parsed && typeof parsed === 'object') this.data = { version: 1, books: {}, ...parsed }
            }
        } catch (e) { console.warn('[Читалка] не удалось прочитать library.json', e) }
    }
    async save() {
        try {
            const a = this.app.vault.adapter
            const folder = normalizePath(this.getFolder())
            if (!(await a.exists(folder))) await this.app.vault.createFolder(folder).catch(() => a.mkdir(folder))
            await a.write(this.path, JSON.stringify(this.data, null, 1))
        } catch (e) { console.warn('[Читалка] не удалось сохранить library.json', e) }
    }
    getPosition(path) { return this.data.books[path]?.position ?? null }
    setPosition(path, position) {
        const b = this.data.books[path] ?? (this.data.books[path] = {})
        b.position = position
        b.progress = Math.round((position?.fraction ?? 0) * 1000) / 10
        b.lastRead = new Date().toISOString()
        this.saveSoon()
    }
    rename(oldPath, newPath) {
        for (const prefix of ['', 'book:']) {
            if (this.data.books[prefix + oldPath]) {
                this.data.books[prefix + newPath] = this.data.books[prefix + oldPath]
                delete this.data.books[prefix + oldPath]
                this.saveSoon()
            }
        }
    }
}
