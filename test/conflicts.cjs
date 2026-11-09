const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1000, height: 1100 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message))
  await p.addInitScript(() => localStorage.removeItem('ur-data'))
  await p.goto('http://localhost:8765/index.html')
  // имитируем: другие плагины заняли свои форматы до того, как читалка их регистрирует
  await p.evaluate(() => {
    Object.assign(app.viewRegistry.typeByExtension, { epub: 'epub-reader-view', numbers: 'numbers-viewer', excalidraw: 'excalidraw' })
    app.plugins = { manifests: { 'numbers-viewer': { id: 'numbers-viewer', name: 'Numbers Viewer' }, 'obsidian-excalidraw-plugin': { id: 'obsidian-excalidraw-plugin', name: 'Excalidraw' } } }
    window.notices = []; const N = window.Notice
  })
  await p.evaluate(() => window.ready)
  const reg = () => p.evaluate(() => ({ epub: app.viewRegistry.typeByExtension.epub, numbers: app.viewRegistry.typeByExtension.numbers, excalidraw: app.viewRegistry.typeByExtension.excalidraw, fb2: app.viewRegistry.typeByExtension.fb2, svg: app.viewRegistry.typeByExtension.svg }))
  console.log('после запуска', await reg())
  console.log('известные конфликты', await p.evaluate(() => plugin.settings.knownConflicts))
  await p.evaluate(() => openSettings())
  const rows = () => p.evaluate(() => [...document.querySelectorAll('.ur-set-conflicts .setting-item')].map(r => r.querySelector('.setting-item-name').textContent + ' | ' + r.querySelector('.setting-item-description').textContent + ' | ' + r.querySelector('input').checked))
  console.log('блок конфликтов', await rows())
  await p.screenshot({ path: 'shots/conflicts1.png' })
  // забираем .numbers себе
  await p.evaluate(() => [...document.querySelectorAll('.ur-set-conflicts .setting-item')].find(r => r.textContent.startsWith('.numbers')).querySelector('input').click())
  await p.waitForTimeout(300)
  console.log('забрали .numbers', await reg(), await rows(), 'forced', await p.evaluate(() => plugin.settings.forcedExts))
  // возвращаем
  await p.evaluate(() => [...document.querySelectorAll('.ur-set-conflicts .setting-item')].find(r => r.textContent.startsWith('.numbers')).querySelector('input').click())
  await p.waitForTimeout(300)
  console.log('вернули .numbers', await reg(), await rows())
  // перезапуск с сохранённым выбором: забрали .epub — после перезапуска читалка снова его забирает
  await p.evaluate(() => [...document.querySelectorAll('.ur-set-conflicts .setting-item')].find(r => r.textContent.startsWith('.epub')).querySelector('input').click())
  await p.waitForTimeout(300)
  await p.evaluate(() => plugin.onunload())
  console.log('после выгрузки', await reg())
  console.log('перезапуск, сохранено:', await p.evaluate(() => JSON.parse(localStorage.getItem('ur-data')).forcedExts), 'epub после перезапуска:', await p.evaluate(async () => { await plugin.onload(); await new Promise(r => setTimeout(r, 900)); return app.viewRegistry.typeByExtension.epub }))
  console.log('errors', errs)
  await b.close()
})()
