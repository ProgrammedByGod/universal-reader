const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1220, height: 820 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)) })
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  for (const f of process.argv.slice(2)) {
    errs.length = 0
    const st = await p.evaluate(f => openFile(f), f); await p.waitForTimeout(1200)
    await p.screenshot({ path: `shots/o-${f}.png` })
    console.log(f, '=>', st.replace(/\n+/g, ' ').slice(0, 200), errs.slice(0, 3))
  }
  await b.close()
})()
