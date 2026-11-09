const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1220, height: 820 } })
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  for (const f of process.argv.slice(2)) {
    await p.evaluate(n => openFile(n), f); await p.waitForTimeout(800)
    const rows = await p.evaluate(() => [...document.querySelectorAll('.ur-grid tbody tr')].slice(0, 4).map(tr => [...tr.querySelectorAll('td')].slice(0, 8).map(td => td.textContent).join(' | ')))
    console.log('==', f); rows.forEach(r => console.log(r))
  }
  await b.close()
})()
