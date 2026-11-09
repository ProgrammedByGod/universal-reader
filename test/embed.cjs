const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 800, height: 400 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message))
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  await p.evaluate(() => {
    const f = Object.assign(new TFileShim(), { name: 'test.epub', path: 'test.epub', extension: 'epub', stat: { size: 10196 }, parent: { path: '/' } })
    app.metadataCache = { getFirstLinkpathDest: () => f }
    document.body.innerHTML = '<div id="note"><p>Текст заметки</p><span class="internal-embed" src="test.epub"></span></div>'
    mdpp(document.getElementById('note'), { sourcePath: 'a.md' })
  })
  await p.waitForTimeout(300)
  await p.screenshot({ path: 'test/shots/embed.png' }); console.log(await p.evaluate(() => document.body.innerText), errs)
  await b.close()
})()
