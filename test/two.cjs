const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1220, height: 820 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 600)) })
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  for (const f of ['test.woff2', 'test-archive.zip']) {
    const st = await p.evaluate(f => openFile(f), f); await p.waitForTimeout(700)
    console.log(f, st, await p.evaluate(() => [!!view.searchResults, !!view.renderer, view.sidebar.children.length]))
    const r = await p.evaluate(async () => { try { view.openSearch(); await view.runSearch('x'); return view.searchInfo.textContent } catch (e) { return 'ERR ' + e.stack } })
    console.log(r.slice(0, 300))
  }
  console.log(errs)
  await b.close()
})()
