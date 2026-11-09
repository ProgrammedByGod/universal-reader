const { chromium } = require('playwright')
;(async () => {
  const lang = process.env.UR_LANG || 'en'
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1000, height: 600 } })
  await p.addInitScript(l => { localStorage.setItem('universal-reader-lang', l); localStorage.setItem('ur-data', JSON.stringify({ lang: l })) }, lang)
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  await p.evaluate(() => openFile('test.docx')); await p.waitForTimeout(500)
  await p.screenshot({ path: `test/shots/libs-${lang}-panel.png` })
  await p.evaluate(() => openSettings()); await p.waitForTimeout(500)
  await p.screenshot({ path: `test/shots/libs-${lang}-settings.png`, clip: { x: 0, y: 0, width: 1000, height: 260 } })
  await b.close()
})()
