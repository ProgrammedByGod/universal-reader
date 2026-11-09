const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1220, height: 820 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message))
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  await p.evaluate(() => localStorage.clear())
  console.log(await p.evaluate(() => openFile('user.fb2')))
  const st = () => p.evaluate(() => ({ page: Number(document.querySelector('.ur-page-input').value), total: document.querySelector('.ur-page-total').textContent }))
  const t0 = Date.now()
  await p.waitForTimeout(300)
  for (let i = 0; i < 120; i++) { const d = await p.evaluate(() => view.renderer.debugPages); if (!d.measuring && d.key) break; await p.waitForTimeout(300) }
  console.log('measured in', (Date.now() - t0) / 1000, 's', await st())
  let prev = (await st()).page, jumps = [], steps = 0
  for (let i = 0; i < 2000; i++) {
    await p.evaluate(() => view.renderer.next()); await p.waitForTimeout(30)
    const s = await st()
    if (s.page === prev) { // возможно конец книги
      await p.evaluate(() => view.renderer.next()); await p.waitForTimeout(150)
      const s2 = await st(); if (s2.page === prev) { console.log('end at', s2); break }
      if (s2.page !== prev + 1) jumps.push([prev, s2.page]); prev = s2.page; steps++; continue
    }
    if (s.page !== prev + 1) jumps.push([prev, s.page])
    prev = s.page; steps++
  }
  console.log('steps', steps, 'jumps', jumps.length, jumps.slice(0, 15))
  // назад
  let back = []; prev = (await st()).page
  for (let i = 0; i < 40; i++) { await p.evaluate(() => view.renderer.prev()); await p.waitForTimeout(40); const s = await st(); if (s.page !== prev - 1) back.push([prev, s.page]); prev = s.page }
  console.log('back jumps', back)
  await p.evaluate(() => view.renderer.goToPage(131)); await p.waitForTimeout(500); console.log('goTo 131 ->', await st())
  await p.evaluate(() => view.renderer.next()); await p.waitForTimeout(300); console.log('next ->', await st())
  await p.evaluate(() => view.update({ fontSize: 130 })); await p.waitForTimeout(50); console.log('font130 immediately', await st())
  await p.waitForTimeout(500)
  for (let i = 0; i < 120; i++) { const d = await p.evaluate(() => view.renderer.debugPages); if (!d.measuring && d.key) break; await p.waitForTimeout(300) }
  console.log('font130 measured', await st())
  await p.evaluate(() => view.update({ fontSize: 100 }))
  // маленькое окно, как у ноутбука с панелями: страниц больше
  await p.setViewportSize({ width: 900, height: 600 }); await p.evaluate(() => { document.getElementById('host').style.width = '880px'; document.getElementById('host').style.height = '580px' })
  await p.waitForTimeout(800)
  for (let i = 0; i < 120; i++) { const d = await p.evaluate(() => view.renderer.debugPages); if (!d.measuring && d.key) break; await p.waitForTimeout(300) }
  await p.evaluate(() => view.renderer.goToPage(1)); await p.waitForTimeout(400)
  let pv = (await st()).page, j2 = [], n2 = 0
  for (let i = 0; i < 3000; i++) { await p.evaluate(() => view.renderer.next()); await p.waitForTimeout(30); let s = await st(); if (s.page === pv) { await p.waitForTimeout(200); await p.evaluate(() => view.renderer.next()); await p.waitForTimeout(200); s = await st(); if (s.page === pv) { console.log('small window end at', s); break } } if (s.page !== pv + 1) j2.push([pv, s.page]); pv = s.page; n2++ }
  console.log('small window steps', n2, 'jumps', j2.slice(0, 10))
  console.log('errors', errs.slice(0, 5))
  await b.close()
})()
