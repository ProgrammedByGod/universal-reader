// В английском режиме ищет русский текст в элементах интерфейса (кнопки, заголовки таблиц, подписи)
const { chromium } = require('playwright')
const fs = require('fs')
const files = (process.argv[2] ? process.argv.slice(2) : fs.readdirSync(__dirname + '/samples').filter(f => fs.statSync(__dirname + '/samples/' + f).isFile()).sort())
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1220, height: 820 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message.slice(0, 160)))
  await p.addInitScript(l => { localStorage.setItem('universal-reader-lang', l); localStorage.setItem('ur-data', JSON.stringify({ ...JSON.parse(localStorage.getItem('ur-data') || '{}'), lang: l })) }, process.env.UR_LANG || 'en')
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  const found = new Map(), bad = []
  for (const f of files) {
    errs.length = 0
    let st
    try { st = await Promise.race([p.evaluate(n => openFile(n), f), new Promise(r => setTimeout(() => r('TIMEOUT'), 25000))]) } catch (e) { st = 'THROW ' + e.message }
    await p.waitForTimeout(700)
    if (st !== 'ok' || errs.length) bad.push(`${f}: ${String(st).replace(/\n+/g, ' ').slice(0, 140)} ${errs.length ? '| ERR ' + errs.join(' ; ') : ''}`)
    const hits = await p.evaluate(() => {
      const out = new Set(); const cyr = /[А-Яа-яЁё]/
      const sel = 'button, th, .ur-meta, .ur-muted, summary, h2, h3, h4, label, .ur-error, option, .ur-badge, .ur-set-gname, .ur-kv td:first-child, .ur-font-facts td:first-child, .ur-font-facts th, .ur-toolbar *'
      for (const el of document.querySelectorAll(sel)) { const t = (el.childNodes.length && [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('') || '').trim(); if (t && cyr.test(t) && t.length < 120) out.add(t) }
      for (const el of document.querySelectorAll('[title],[placeholder],[aria-label]')) for (const a of ['title', 'placeholder', 'aria-label']) { const v = el.getAttribute(a); if (v && cyr.test(v)) out.add('@' + v) }
      return [...out]
    })
    for (const h of hits) { if (!found.has(h)) found.set(h, f) }
  }
  console.log('файлов:', files.length, '| ошибок:', bad.length)
  for (const x of bad) console.log(' -', x)
  console.log('--- русский текст в интерфейсе:')
  for (const [h, f] of found) console.log(f.padEnd(28), h)
  await b.close()
})()
