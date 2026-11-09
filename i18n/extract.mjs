// Собирает все русские строки из src: обычные литералы и шаблоны (`...${x}...` → ключ с {0})
import fs from 'node:fs'; import path from 'node:path'
import * as acorn from 'acorn'; import * as walk from 'acorn-walk'
export const CYR = /[А-Яа-яЁё]/
export function keyOfTemplate(q) { return q.quasis.map(x => x.value.cooked).reduce((a, s, i) => i ? a + `{${i - 1}}` + s : s, '') }
export function scan(src, file, cb) {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
  const tagged = new Set()
  walk.full(ast, n => { if (n.type === 'TaggedTemplateExpression') tagged.add(n.quasi) })
  walk.fullAncestor(ast, (n, _s, anc) => {
    const parent = anc[anc.length - 2]
    if (n.type === 'Literal' && typeof n.value === 'string' && CYR.test(n.value)) {
      // ключи объектов, импорты и т.п. не трогаем
      if (parent && ((parent.type === 'Property' && parent.key === n && !parent.computed) || parent.type === 'ImportDeclaration' || parent.type === 'ExportNamedDeclaration' || parent.type === 'MethodDefinition')) return
      cb({ kind: 'lit', node: n, key: n.value, file, line: n.loc.start.line, parent })
    } else if (n.type === 'TemplateLiteral' && !tagged.has(n) && n.quasis.some(q => CYR.test(q.value.cooked ?? ''))) {
      cb({ kind: 'tpl', node: n, key: keyOfTemplate(n), file, line: n.loc.start.line, parent })
    }
  })
}
if (process.argv[1].endsWith('extract.mjs')) {
  const files = fs.readdirSync('src', { recursive: true }).filter(f => f.endsWith('.js')).map(f => path.join('src', f))
  const all = new Map()
  for (const f of files) scan(fs.readFileSync(f, 'utf8'), f, h => { if (!all.has(h.key)) all.set(h.key, []); all.get(h.key).push(`${h.file}:${h.line}`) })
  const arr = [...all].map(([k, w]) => ({ k, w }))
  fs.writeFileSync('i18n/keys.json', JSON.stringify(arr, null, 1))
  console.log('unique', arr.length, 'chars', arr.reduce((a, x) => a + x.k.length, 0))
}
