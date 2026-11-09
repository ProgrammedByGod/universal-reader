const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage()
  await p.goto('http://localhost:8765/index.html')
  // имитируем: плагин Excalidraw уже занял свои файлы до того, как читалка забирает спорные форматы
  await p.evaluate(() => { app.viewRegistry.typeByExtension.excalidraw = 'excalidraw' })
  await p.evaluate(() => window.ready); await p.waitForTimeout(1500)
  console.log(await p.evaluate(() => ({ excalidraw: app.viewRegistry.typeByExtension.excalidraw, tldr: app.viewRegistry.typeByExtension.tldr, fb2: app.viewRegistry.typeByExtension.fb2, busy: JSON.stringify([...plugin.busy]), skipped: plugin.exts.has("excalidraw") })))
  await b.close()
})()
