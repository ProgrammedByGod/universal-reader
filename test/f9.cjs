const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1220, height: 900 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)) })
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  const shot = async n => { await p.waitForTimeout(2500); const m = await p.$('.modal-container:last-of-type .modal'); if (m) await m.screenshot({ path: `test/shots/f9-${n}.png` }); else await p.screenshot({ path: `test/shots/f9-${n}.png` }); console.log(n, errs.splice(0)) }
  // 1. сведения о файле
  for (const f of ['test.docx', 'test.epub', 'test.txt']) {
    await p.evaluate(f => { document.querySelectorAll('.modal-container').forEach(e => e.remove()); app.workspace.getActiveFile = () => ({ name: f, path: 'books/' + f, extension: f.split('.').pop(), stat: { size: 1, ctime: Date.now() - 1e8, mtime: Date.now() }, parent: { path: 'books' } }); commands['file-info'].checkCallback(false) }, f)
    await shot('info-' + f)
    console.log(await p.evaluate(() => document.querySelector('.modal-content').innerText.slice(0, 400)))
  }
  await p.click('.modal-content button'); await p.waitForTimeout(600)
  console.log(await p.evaluate(() => document.querySelector('.modal-content').innerText.slice(-300)))
  // 2. сравнение
  await p.evaluate(() => { document.querySelectorAll('.modal-container').forEach(e => e.remove()); app.vault.getFiles = () => [{ name: 'test-cp1251.txt', path: 'books/test-cp1251.txt' }]; commands['compare-files'].checkCallback(false); lastSuggest.onChooseItem({ name: 'test-cp1251.txt', path: 'test-cp1251.txt', extension: 'txt' }) })
  await shot('compare-txt')
  await p.evaluate(() => { document.querySelectorAll('.modal-container').forEach(e => e.remove()); app.workspace.getActiveFile = () => ({ name: 'test.epub', path: 'test.epub' }); commands['compare-files'].checkCallback(false); lastSuggest.onChooseItem({ name: 'test.docx', path: 'test.docx' }) })
  await shot('compare-bin')
  console.log(await p.evaluate(() => document.querySelector('.modal-content').innerText.slice(0, 300)))
  await p.evaluate(() => document.querySelectorAll('.modal-container').forEach(e => e.remove()))
  // 3. кодировка
  console.log(await p.evaluate(() => openFile('test-cp1251.txt')).then(s => s.slice(0, 100)))
  console.log('select:', await p.evaluate(() => [...document.querySelectorAll('select')].map(s => s.title || s.options[0]?.text).join(' | ')))
  await shot('enc')
  // 4. мягкий запасной вариант
  console.log(await p.evaluate(() => openFile('broken.docx')).then(s => s.slice(0, 200)))
  await shot('soft')
  // 5. открыть из архива
  console.log(await p.evaluate(() => openFile('nested.zip')).then(s => s.slice(0, 100)))
  await shot('zip')
true
  await p.locator('.ur-archive >> text=test.epub').first().click(); await p.waitForTimeout(1500)
  await p.locator('button:has-text("Открыть читалкой")').first().click()
  await shot('zip-modal')
  console.log('modal:', await p.evaluate(() => document.querySelector('.ur-bytes-modal')?.innerText.slice(0, 200)))
  await p.evaluate(() => document.querySelectorAll('.modal-container').forEach(e => { window.lastModal.close() }))
  // 6. письмо
  console.log(await p.evaluate(() => openFile('test.eml')).then(s => s.slice(0, 100)))
  const btns = await p.locator('button:has-text("Открыть")').count(); console.log('mail open buttons', btns)
  if (btns) { await p.locator('button:has-text("Открыть")').first().click(); await shot('mail-modal'); await p.evaluate(() => window.lastModal.close()) }
  // 7. markdown
  for (const f of ['test.csv', 'test.xlsx', 'test.html', 'test.ipynb', 'test.rtf', 'test.docx']) {
  await p.evaluate(f => openFile(f), f); await p.waitForTimeout(1500)
  await p.evaluate(() => { window.copied = null; navigator.clipboard.writeText = async t => { window.copied = t } })
  const mdBtn = p.locator('button:has-text("clipboard-copy")'); const n = await mdBtn.count()
  if (n) { await mdBtn.first().click(); await p.waitForTimeout(500) }
  console.log(f, 'md btn', n, 'MD:', JSON.stringify((await p.evaluate(() => window.copied))?.slice(0, 200)))
  }
  console.log('errors', errs)
  await b.close()
})()
