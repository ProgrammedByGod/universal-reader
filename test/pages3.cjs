const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1220, height: 820 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message))
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  const st = () => p.evaluate(() => ({ page: Number(document.querySelector('.ur-page-input').value), total: document.querySelector('.ur-page-total').textContent }))
  for (const f of ['user.fb2', 'test.epub', 'test.docx', 'test.txt', 'test.mobi']) {
    await p.evaluate(() => localStorage.clear())
    await p.evaluate(f => openFile(f), f); await p.waitForTimeout(500)
    for (let i = 0; i < 100; i++) { const d = await p.evaluate(() => view.renderer.debugPages); if (!d.measuring && d.key) break; await p.waitForTimeout(300) }
    const total = parseInt((await st()).total.replace(/\D/g, ''))
    const res = []
    for (const n of [1, 2, Math.floor(total / 3), Math.floor(total / 2), total - 1, total]) {
      await p.evaluate(n => view.renderer.goToPage(n), n); await p.waitForTimeout(300)
      res.push(`${n}->${(await st()).page}`)
    }
    // пролистать всё
    await p.evaluate(() => view.renderer.goToPage(1)); await p.waitForTimeout(300)
    let pv = 1, jumps = 0
    for (let i = 0; i < total + 5; i++) { await p.evaluate(() => view.renderer.next()); await p.waitForTimeout(140); const s = await st(); if (s.page !== pv + 1 && s.page !== pv) jumps++; if (s.page === pv) break; pv = s.page }
    console.log(f.padEnd(10), 'total', total, '| goTo', res.join(' '), '| flip end', pv, 'jumps', jumps)
  }
  console.log('errors', errs.slice(0, 5))
  await b.close()
})()
