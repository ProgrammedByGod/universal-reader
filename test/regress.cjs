const { chromium } = require('playwright')
const fs = require('fs')
const files = fs.readdirSync(__dirname + '/samples').filter(f => fs.statSync(__dirname + '/samples/' + f).isFile()).sort()
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1220, height: 820 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message.slice(0, 160)))
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  const bad = []
  for (const f of files) {
    errs.length = 0
    let st
    try { st = await Promise.race([p.evaluate(n => openFile(n), f), new Promise(r => setTimeout(() => r('TIMEOUT'), 25000))]) } catch (e) { st = 'THROW ' + e.message }
    await p.waitForTimeout(/djvu|djv|pptx|ppsx|potx|tif|heic|heif|psd|sqlite|db|7z|rar|cbr|cb7/.test(f) ? 2500 : 900)
    if (st !== 'ok' || errs.length) bad.push(`${f}: ${st.replace(/\n+/g, ' ').slice(0, 120)} ${errs.length ? '| ERR ' + errs.join(' ; ') : ''}`)
  }
  console.log('всего файлов:', files.length, '| с проблемами:', bad.length)
  for (const x of bad) console.log(' -', x)
  await b.close()
})()
