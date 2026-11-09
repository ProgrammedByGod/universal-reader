const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1220, height: 820 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message))
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  await p.evaluate(() => openFile('test.h5')); await p.waitForTimeout(1500)
  for (const n of ['температура', 'таблица', 'куб', 'картинка', 'test.h5']) {
    await p.locator('.ur-h5-item', { hasText: n }).first().click(); await p.waitForTimeout(300)
    if (n === 'картинка') { await p.locator('text=Показать картинкой').click(); await p.waitForTimeout(300); await p.screenshot({ path: 'test/shots/h5-img.png' }) }
    console.log(n, (await p.evaluate(() => document.querySelector('.ur-h5-pane').innerText)).replace(/\s+/g, ' ').slice(0, 250))
  }
  console.log(errs); await b.close()
})()
