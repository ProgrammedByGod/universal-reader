import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { i18nPlugin } from './i18n/transform.mjs'

const out = process.argv[2] || 'dist'
const test = process.argv.includes('--test')
fs.mkdirSync(path.join(out, 'libs'), { recursive: true })

// pdf.js из foliate не нужен (PDF открывает Обсидиан) — подменяем заглушкой;
// customElements.define делаем безопасным при перезагрузке плагина
const foliatePlugin = {
    name: 'foliate',
    setup(b) {
        b.onResolve({ filter: /\/pdf\.js$/ }, args => args.importer.includes('foliate-js') ? { path: 'pdf-stub', namespace: 'stub' } : undefined)
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const makePDF = () => { throw new Error("PDF не поддерживается здесь") }' }))
        b.onLoad({ filter: /foliate-js\/.*\.js$/ }, async args => {
            let src = await fs.promises.readFile(args.path, 'utf8')
            src = src.replace('const setStylesImportant = (el, styles) => {', 'const setStylesImportant = (el, styles) => { if (!el) return;')
            // книга могла закрыться, пока движок раскладывал страницы — тихо выходим
            if (args.path.endsWith('paginator.js')) {
                src = src.replace(/(\n        const doc = this\.document\n)/g, '$1        if (!doc?.documentElement) return\n')
                src = src.replace('const getVisibleRange = (doc, start, end, mapRect) => {', 'const getVisibleRange = (doc, start, end, mapRect) => {\n    if (!doc?.body) return null')
                src = src.replace('    #getVisibleRange() {', '    #getVisibleRange() {\n        if (!this.#view?.document?.body) return null')
                src = src.replace('const getBackground = doc => {', 'const getBackground = doc => {\n    if (!doc?.defaultView || !doc.body) return \'\'')
                src = src.replace('const getDirection = doc => {', 'const getDirection = doc => {\n    if (!doc?.defaultView || !doc.body) return { vertical: false, rtl: false }')
                src = src.replace('const { documentElement } = this.document', 'const { documentElement } = this.document ?? {}\n        if (!documentElement) return')
            }
            src = src.replace(/customElements\.define\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g,
                (_, n, c) => `if (!customElements.get('${n}')) customElements.define('${n}', ${c})`)
            return { contents: src, loader: 'js' }
        })
    },
}

const libs = ['djvu', 'unrar', 'sevenzip', 'utif', 'xlsx', 'pptx', 'mammoth', 'rtf', 'asciidoctor', 'org', 'bz2', 'opentype', 'heic', 'psd', 'sqlite', 'abc',
    'zstd', 'xz', 'lz4', 'parquet', 'markup', 'msg', 'viz', 'osmd', 'jxl', 'bpmn', 'mdb', 'arrow', 'three', 'dxf', 'hwp', 'emf', 'rough', 'pst', 'openjpeg', 'jpegll', 'mpegts', 'brotli', 'h5', 'verovio', 'occt', 'rhino', 'ifc']
// популярные и не слишком большие библиотеки встраиваются прямо в main.js (строками, исполняются только при открытии формата),
// чтобы версия из каталога Обсидиана без пакета libs открывала Word, Excel, PowerPoint, TIFF, DjVu, RAR, SQLite, 3D и т. п.
export const EMBEDDED = ['mammoth', 'xlsx', 'pptx', 'utif', 'djvu', 'unrar', 'sqlite', 'three', 'opentype', 'psd', 'org', 'markup', 'dxf', 'rough',
    'bz2', 'zstd', 'xz', 'lz4', 'brotli', 'jpegll', 'heic']
const only = process.argv.find(a => a.startsWith('--libs='))?.slice(7).split(',')
const buildLib = (name, write) => esbuild.build({
    entryPoints: [`libs-src/${name}.js`],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    outfile: path.join(out, 'libs', `${name}.js`),
    write,
    charset: 'utf8',
    loader: { '.wasm': 'binary', '.css': 'text', '.txt': 'text' },
    define: { 'import.meta.url': '"https://localhost/lib.js"', 'process.env.NODE_ENV': '"production"' },
    inject: name === 'mdb' || name === 'pst' ? ['libs-src/node-shim.js'] : [],
    alias: name === 'pst' ? { zlib: './libs-src/pst-zlib.js', fs: './libs-src/pst-fs.js' } : {},
    external: name === 'pst' ? [] : ['stream', 'events', 'fs', 'path', 'crypto', 'module', 'url', 'worker_threads', 'child_process', 'node:*'],
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
})
// Старые полифилы setImmediate (asap, lie, core-js) проверяют "onreadystatechange" у <script> — это ветка для IE,
// в Обсидиане она никогда не выполняется. Подменяем такой <script> на <div>: поведение то же, а плагин заведомо
// не создаёт элементов <script> (этого требует проверка каталога Обсидиана).
const scrub = (code, where) => code.replace(/createElement\((\\?["'])script\1\)/g, (m, q, i) => {
    if (!code.slice(Math.max(0, i - 120), i + 120).includes('onreadystatechange')) throw new Error(`createElement(script) вне полифила: ${where} @${i}`)
    return `createElement(${q}div${q})`
})
const embedded = {}
for (const name of EMBEDDED) {
    let code = scrub((await buildLib(name, false)).outputFiles[0].text, name)
    // в three.js (chevrotain) есть шаблон HTML-страницы со ссылкой на чужой main.js — не наш файл, только текст
    if (name === 'three') code = code.replace("src/main.js'", "src/main\\x2ejs'")
    embedded[name] = code
}
const embedPlugin = {
    name: 'embedded-libs',
    setup(b) {
        b.onResolve({ filter: /^embedded-libs$/ }, () => ({ path: 'embedded-libs', namespace: 'emb' }))
        b.onLoad({ filter: /.*/, namespace: 'emb' }, () => ({ contents: 'export default {' + Object.entries(embedded).map(([k, v]) => JSON.stringify(k) + ':' + JSON.stringify(v)).join(',\n') + '}', loader: 'js' }))
    },
}

const obsidianAlias = test ? { obsidian: path.resolve('test/obsidian-shim.js') } : {}

await esbuild.build({
    entryPoints: ['src/main.js'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: test ? [] : ['obsidian', 'electron', '@codemirror/*'],
    alias: obsidianAlias,
    outfile: path.join(out, 'main.js'),
    plugins: [i18nPlugin, foliatePlugin, embedPlugin],
    charset: 'utf8',
    minify: !test,
    legalComments: 'none',
    banner: { js: '/* Универсальная читалка — альфа. Собрано esbuild. Исходники: foliate-js (MIT) и др. */' },
    logLevel: 'warning',
})

{ const mp = path.join(out, 'main.js'); fs.writeFileSync(mp, scrub(fs.readFileSync(mp, 'utf8'), 'main.js')) }
for (const name of libs) {
    if (EMBEDDED.includes(name) || (only && !only.includes(name))) continue
    try { await buildLib(name, true) } catch (e) { console.error('LIB FAIL', name, e.errors?.map(x => x.text + ' @ ' + x.location?.file).join('; ')); if (!only) process.exitCode = 1 }
}
// большие .wasm кладём рядом отдельными файлами (читаются как двоичные, без base64)
const ASSETS = { 'occt.wasm': 'node_modules/occt-import-js/dist/occt-import-js.wasm', 'rhino3dm.wasm': 'node_modules/rhino3dm/rhino3dm.wasm', 'web-ifc.wasm': 'node_modules/web-ifc/web-ifc.wasm' }
if (!only || only.includes('assets')) {
    for (const [to, from] of Object.entries(ASSETS)) fs.copyFileSync(from, path.join(out, 'libs', to))
    // Ruffle (Flash): грузится по адресу ресурса, файлы как есть. Берём только сборку с расширениями WebAssembly
    const rd = path.join(out, 'libs', 'ruffle'); fs.mkdirSync(rd, { recursive: true })
    for (const f of fs.readdirSync('node_modules/@ruffle-rs/ruffle')) if (/\.js$/.test(f) || f === '172de42e6619eac8f371.wasm') fs.copyFileSync(path.join('node_modules/@ruffle-rs/ruffle', f), path.join(rd, f))
}
// паспорт пакета библиотек: по нему плагин понимает, установлен ли пакет и подходит ли он
if (!only) {
    const pack = Number((fs.readFileSync('src/libspack.js', 'utf8').match(/LIBS_PACK = (\d+)/) || [])[1])
    fs.writeFileSync(path.join(out, 'libs', 'pack.json'), JSON.stringify({ pack, version: JSON.parse(fs.readFileSync('manifest.json', 'utf8')).version }))
}
fs.copyFileSync('manifest.json', path.join(out, 'manifest.json'))
fs.copyFileSync('styles.css', path.join(out, 'styles.css'))
for (const f of fs.readdirSync(out, { recursive: true })) {
    const p = path.join(out, f)
    if (fs.statSync(p).isFile()) console.log(String(Math.round(fs.statSync(p).size / 1024)).padStart(6), 'KB ', f)
}
