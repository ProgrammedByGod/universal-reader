const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1220, height: 820 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message))
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  const st = () => p.evaluate(() => ({ page: Number(document.querySelector('.ur-page-input').value), total: document.querySelector('.ur-page-total').textContent, label: document.querySelector('.ur-status-label').textContent }))
  for (const f of ['user2.fb2', 'test.fb2', 'test.mobi', 'test.epub']) {
    await p.evaluate(() => localStorage.clear())
    await p.evaluate(f => openFile(f), f); await p.waitForTimeout(500)
    for (let i = 0; i < 200; i++) { const d = await p.evaluate(() => view.renderer.debugPages); if (!d.measuring && d.key) break; await p.waitForTimeout(300) }
    const d = await p.evaluate(() => view.renderer.debugPages)
    const total = parseInt((await st()).total.replace(/\D/g, ''))
    // клик по первой сноске в тексте
    let footnote = null
    if (f === 'user2.fb2' || f === 'test.fb2') {
      const href = await p.evaluate(async () => {
        for (let i = 0; i < 40; i++) {
          const doc = view.renderer.view.renderer.getContents()[0]?.doc
          const a = doc?.querySelector('a[href^="#"]')
          if (a) { a.click(); return a.getAttribute('href') }
          await view.renderer.next(); await new Promise(r => setTimeout(r, 150))
        }
        return null
      })
      await p.waitForTimeout(600)
      footnote = { href, ...(await st()) }
    }
    // долистать с предпоследних страниц до конца
    await p.evaluate(n => view.renderer.goToPage(n), Math.max(1, total - 25)); await p.waitForTimeout(400)
    let pv = (await st()).page, jumps = [], last
    for (let i = 0; i < 60; i++) { await p.evaluate(() => view.renderer.next()); await p.waitForTimeout(160); const s = await st(); last = s; if (s.page === pv) break; if (s.page !== pv + 1) jumps.push([pv, s.page]); pv = s.page }
    console.log(f.padEnd(10), 'sections', d.sections, 'linear all', d.linear.every(Boolean), '| total', total, '| end', last.page, last.label.slice(0, 40), '| jumps', jumps, footnote ? '| footnote ' + JSON.stringify(footnote) : '')
  }
  console.log('errors', errs.slice(0, 5))
  await b.close()
})()
