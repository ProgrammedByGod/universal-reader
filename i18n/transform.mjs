// esbuild-плагин: русские строки → T('…'), шаблоны с русским → TT(ctx)`…`, 'ru-RU' → LOC()
import fs from 'node:fs'; import path from 'node:path'
import * as acorn from 'acorn'; import * as walk from 'acorn-walk'; import MagicString from 'magic-string'
const CYR = /[А-Яа-яЁё]/
const I18N = path.resolve('src/i18n.js')
export function transform(src, file) {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' })
  const ms = new MagicString(src); const ctx = JSON.stringify(path.basename(file, '.js'))
  const tagged = new Set(); let used = false
  walk.full(ast, n => { if (n.type === 'TaggedTemplateExpression') tagged.add(n.quasi) })
  walk.fullAncestor(ast, (n, _s, anc) => {
    const p = anc[anc.length - 2]
    if (n.type === 'Literal' && typeof n.value === 'string') {
      if (!p) return
      if (p.type === 'Property' && p.key === n && !p.computed) return
      if (/^(Import|Export)/.test(p.type) || p.type === 'MethodDefinition' || p.type === 'PropertyDefinition' && p.key === n) return
      if (p.type === 'MemberExpression' && p.property === n) return
      if (p.type === 'BinaryExpression' && p.operator === 'in' && p.left === n) return
      if (p.type === 'CallExpression' && p.callee.type === 'Identifier' && p.callee.name === 'NT') return
      if (n.value === 'ru-RU') { ms.overwrite(n.start, n.end, '__LOC()'); used = true; return }
      if (!CYR.test(n.value)) return
      ms.appendLeft(n.start, '__T('); ms.appendRight(n.end, `, ${ctx})`); used = true
    } else if (n.type === 'TemplateLiteral' && !tagged.has(n) && n.quasis.some(q => CYR.test(q.value.cooked ?? ''))) {
      if (p && p.type === 'CallExpression' && p.callee.type === 'Identifier' && p.callee.name === 'NT') return
      ms.appendLeft(n.start, `__TT(${ctx})`); used = true
    }
  })
  if (used) ms.prepend(`import { T as __T, TT as __TT, LOC as __LOC } from ${JSON.stringify(I18N)};\n`)
  return ms.toString()
}
export const i18nPlugin = {
  name: 'i18n',
  setup(b) {
    b.onLoad({ filter: new RegExp('^' + path.resolve('src').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\\\/].*\\.js$') }, async a => {
      if (a.path === I18N) return
      return { contents: transform(await fs.promises.readFile(a.path, 'utf8'), a.path), loader: 'js', resolveDir: path.dirname(a.path) }
    })
  },
}
