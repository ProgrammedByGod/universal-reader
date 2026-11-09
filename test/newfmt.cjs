const { chromium } = require('playwright')
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['test.srt','test-cp1251.srt','test.vtt','test.sbv','test.ass','test.ssa','test.sub','test.lrc','test.vcf','test.ics','test.opml','test.rss','test.atom','test.po','test.pot','test.eml','test.bib','test.ris','test.diff','test.patch','test.nfo','test.fountain','test.py','test.js','test.sql','test.sh','test.css','test.env','test.conf','test.ts']
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1220, height: 820 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)) })
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  for (const f of files) {
    errs.length = 0
    const status = await p.evaluate(f => openFile(f), f); await p.waitForTimeout(700)
    let search = '-'
    if (!status.startsWith('Не удалось')) {
      const q = f === 'test.nfo' ? 'uniqueword' : (f === 'test-cp1251.srt' ? 'кодировки' : (f === 'test.po' || f === 'test.pot' ? 'уникальноеслово' : 'уникальноеслово'))
      search = await p.evaluate(async q => { if (!view.renderer?.caps.search) return 'нет поиска'; view.openSearch(); await view.runSearch(q); return view.searchInfo.textContent }, q)
    }
    const modes = await p.evaluate(() => [...document.querySelectorAll('.ur-select')].map(s => [...s.options].map(o => o.text).join('/')).join(' | '))
    await p.screenshot({ path: `shots/n-${f}.png` })
    console.log(f.padEnd(18), status.replace(/\n+/g, ' ').slice(0, 100), '| поиск:', search, '| режимы:', modes, errs.length ? '| ERR ' + errs.slice(0, 2).join(' ; ') : '')
  }
  // переключение режимов у субтитров
  await p.evaluate(() => openFile('test.vtt')); await p.waitForTimeout(400)
  await p.evaluate(() => view.renderer.setMode('text')); await p.waitForTimeout(300); await p.screenshot({ path: 'shots/n-vtt-text.png' })
  await p.evaluate(() => view.renderer.setMode('source')); await p.waitForTimeout(300); await p.screenshot({ path: 'shots/n-vtt-source.png' })
  await p.evaluate(() => openFile('test.lrc')); await p.evaluate(() => view.renderer.setMode('time')); await p.waitForTimeout(300); await p.screenshot({ path: 'shots/n-lrc-time.png' })
  await b.close()
})()
