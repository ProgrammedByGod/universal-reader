const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1220, height: 820 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message))
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  const st = () => p.evaluate(() => ({ page: document.querySelector('.ur-page-input')?.value, total: document.querySelector('.ur-page-total')?.textContent, pct: document.querySelector('.ur-status-progress')?.textContent, label: document.querySelector('.ur-status-label')?.textContent }))
  const search = async q => { await p.evaluate(q => { view.openSearch(); view.searchInput.value = q; return view.runSearch(q) }, q); await p.waitForTimeout(800); return p.evaluate(() => ({ info: view.searchInfo.textContent, n: view.searchResults.querySelectorAll('.ur-search-hit').length })) }
  const clickHit = async () => { await p.evaluate(() => view.searchResults.querySelector('.ur-search-hit')?.click()); await p.waitForTimeout(800) }
  // EPUB
  console.log('epub open', await p.evaluate(() => openFile('test.epub'))); await p.waitForTimeout(1000)
  console.log(' start', await st())
  await p.evaluate(() => view.renderer.next()); await p.waitForTimeout(500); await p.evaluate(() => view.renderer.next()); await p.waitForTimeout(500)
  console.log(' after next x2', await st())
  await p.evaluate(() => document.querySelectorAll('.ur-toc-item')[3].click()); await p.waitForTimeout(800)
  console.log(' toc[3]', await st())
  console.log(' search', await search('уникальноеслово')); await clickHit(); console.log(' after hit', await st())
  await p.screenshot({ path: 'shots/f-epub-search.png' })
  await p.evaluate(() => view.update({ flow: 'scrolled' })); await p.waitForTimeout(800); console.log(' scrolled', await st())
  await p.evaluate(() => view.update({ flow: 'paginated', fontSize: 150, width: 'spread' })); await p.waitForTimeout(800); console.log(' font150 spread', await st())
  await p.screenshot({ path: 'shots/f-epub-font.png' })
  await p.evaluate(() => view.update({ fontSize: 100, width: 'medium' }))
  await p.evaluate(() => view.renderer.goToPage(20)); await p.waitForTimeout(800); const before = await st(); console.log(' goToPage20', before)
  await p.waitForTimeout(1800)
  // reopen -> restore position
  await p.evaluate(() => openFile('test.txt')); await p.waitForTimeout(500)
  await p.evaluate(() => openFile('test.epub')); await p.waitForTimeout(1500)
  console.log(' reopened', await st())
  // dark theme
  await p.evaluate(() => { document.body.classList.add('theme-dark'); view.onCssChange() }); await p.waitForTimeout(800)
  await p.screenshot({ path: 'shots/f-epub-dark.png' })
  await p.evaluate(() => document.body.classList.remove('theme-dark'))
  // FB2 footnote link + back
  console.log('fb2', await p.evaluate(() => openFile('test.fb2'))); await p.waitForTimeout(1000)
  console.log(' search fb2', await search('уникальноеслово'))
  // TXT cp1251
  console.log('txt1251', await p.evaluate(() => openFile('test-cp1251.txt'))); await p.waitForTimeout(800)
  console.log(' search', await search('уникальноеслово'))
  // DJVU search
  console.log('djvu', await p.evaluate(() => openFile('test.djvu'))); await p.waitForTimeout(2500)
  console.log(' search', await search('chunk')); await clickHit(); console.log(' after hit', await st())
  await p.evaluate(() => view.update({ flow: 'scrolled' })); await p.waitForTimeout(2500); await p.screenshot({ path: 'shots/f-djvu-scroll.png' })
  await p.evaluate(() => { document.body.classList.add('theme-dark'); view.renderer.setInverted(true) }); await p.waitForTimeout(500); await p.screenshot({ path: 'shots/f-djvu-invert.png' })
  await p.evaluate(() => document.body.classList.remove('theme-dark'))
  // comics spread
  console.log('cbz', await p.evaluate(() => openFile('test.cbz')))
  await p.evaluate(() => view.update({ flow: 'paginated', spread: true })); await p.evaluate(() => view.renderer.next()); await p.waitForTimeout(800)
  console.log(' spread next', await st()); await p.screenshot({ path: 'shots/f-cbz-spread.png' })
  await p.evaluate(() => view.update({ spread: false }))
  // code/table search
  for (const f of ['test.json', 'test.csv', 'test.xlsx', 'test.ipynb', 'test.adoc', 'test.html', 'test.mhtml', 'test.pptx', 'test.odp', 'test.log']) {
    await p.evaluate(f => openFile(f), f); await p.waitForTimeout(f === 'test.pptx' ? 2500 : 900)
    const r = await search(f === 'test.mhtml' ? 'uniqueword' : (f === 'test.odp' ? 'слайда' : 'уникальноеслово'))
    console.log(f, r)
  }
  await p.evaluate(() => openFile('test.html')); await p.evaluate(() => view.renderer.setMode('source')); await p.waitForTimeout(600); await p.screenshot({ path: 'shots/f-html-source.png' })
  console.log('pageerrors:', errs.slice(0, 8))
  await b.close()
})()
