const { chromium } = require('playwright')
;(async () => {
  const lang = process.env.UR_LANG || 'en'
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1100, height: 900 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message))
  await p.addInitScript(l => { localStorage.setItem('universal-reader-lang', l); localStorage.setItem('ur-data', JSON.stringify({ lang: l })) }, lang)
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  await p.evaluate(() => openSettings()); await p.waitForTimeout(300)
  await p.screenshot({ path: `shots/i18n-${lang}-settings.png` })
  for (const f of ['test.ics', 'test.gpx', 'test.h5', 'test.epub', 'test.exe']) {
    try { await p.evaluate(n => openFile(n), f) } catch (e) { console.log(f, e.message.slice(0, 100)) }
    await p.waitForTimeout(1500)
    await p.screenshot({ path: `shots/i18n-${lang}-${f.replace('.', '_')}.png` })
  }
  console.log('commands', await p.evaluate(() => Object.values(window.commands || {}).map(c => c.name).join(' | ')))
  console.log('errors', errs)
  await b.close()
})()
