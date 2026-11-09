// i18n/en.json — словарь «русская строка → английская». Новые переводы добавляются в i18n/add.tsv
// (русский<TAB>английский, ⏎ = перевод строки), этот скрипт вливает их в en.json, проверяет
// заполнители и теги и пишет в i18n/missing.txt строки из кода, у которых ещё нет перевода.
import fs from 'node:fs'
const keys = JSON.parse(fs.readFileSync('i18n/keys.json', 'utf8')).map(x => x.k)
const en = JSON.parse(fs.readFileSync('i18n/en.json', 'utf8')); let bad = 0
const ph = s => (s.match(/\{\d+\}|\$\d/g) || []).sort().join()
const tags = s => (s.match(/<\/?[a-z][a-z0-9]*/gi) || []).map(t => t.toLowerCase()).sort().join()
if (fs.existsSync('i18n/add.tsv')) for (const line of fs.readFileSync('i18n/add.tsv', 'utf8').split('\n')) {
  const i = line.indexOf('\t'); if (i < 1) continue
  const k = line.slice(0, i).replace(/⏎/g, '\n'), v = line.slice(i + 1).replace(/⏎/g, '\n')
  if (!k.includes('|') && ph(k) !== ph(v)) { console.log('заполнители:', k.slice(0, 80)); bad++ }
  if (!k.includes('|') && tags(k) !== tags(v)) { console.log('теги:', k.slice(0, 80)); bad++ }
  en[k] = v
}
fs.writeFileSync('i18n/en.json', JSON.stringify(en))
const missing = keys.filter(k => !(k in en))
fs.writeFileSync('i18n/missing.txt', missing.join('\n'))
console.log('переводов', Object.keys(en).length, 'без перевода', missing.length, 'ошибок', bad)
