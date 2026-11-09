const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1220, height: 820 } })
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  await p.evaluate(() => openFile('test-archive.zip')); await p.waitForTimeout(600); await p.screenshot({ path: 'shots/o-arc-list.png' })
  await p.evaluate(() => document.querySelector('.ur-arc-table tbody tr:nth-child(2)').click()); await p.waitForTimeout(600); await p.screenshot({ path: 'shots/o-arc-file.png' })
  await p.evaluate(() => openFile('test.sqlite')); await p.waitForTimeout(1500); await p.screenshot({ path: 'shots/o-sqlite.png' })
  await b.close()
})()
