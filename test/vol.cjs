const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1220, height: 820 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)) })
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  const cases = { 'ar8/vol.7z.001': ['ar8/vol.7z.001', 'ar8/vol.7z.002', 'ar8/vol.7z.003'], 'ar8/spanned.zip': ['ar8/spanned.z01', 'ar8/spanned.z02', 'ar8/spanned.z03', 'ar8/spanned.zip'] }
  for (const [n, sib] of Object.entries(cases)) {
    errs.length = 0
    const st = await p.evaluate(([n, sib]) => { window.SIBLINGS = { [n]: sib }; return openFile(n) }, [n, sib])
    await p.waitForTimeout(1000)
    console.log(n, st, (await p.evaluate(() => document.querySelector('.ur-stage')?.innerText || '')).replace(/\s+/g, ' ').slice(0, 600), errs.join(' ; ').slice(0, 300))
  }
  await b.close()
})()
