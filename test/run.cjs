const { chromium } = require('playwright')
const fs = require('fs')
const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(__dirname + '/samples').filter(f => f.startsWith('test'))
;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1220, height: 820 } })
  const logs = []
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text().slice(0, 300)) })
  page.on('pageerror', e => logs.push('pageerror: ' + e.message.slice(0, 300)))
  await page.goto('http://localhost:8765/index.html')
  await page.evaluate(() => window.ready)
  fs.mkdirSync(__dirname + '/shots', { recursive: true })
  for (const f of files) {
    logs.length = 0
    let status
    try {
      status = await Promise.race([
        page.evaluate(n => window.openFile(n, { asBook: n.endsWith('.md') }), f),
        new Promise(r => setTimeout(() => r('TIMEOUT'), 20000)),
      ])
    } catch (e) { status = 'THROW ' + e.message.slice(0, 200) }
    await page.waitForTimeout(f.match(/djvu|pptx|tif/) ? 3500 : 1500)
    const info = await page.evaluate(() => ({ page: document.querySelector('.ur-page-input')?.value, total: document.querySelector('.ur-page-total')?.textContent, label: document.querySelector('.ur-status')?.textContent, toc: document.querySelectorAll('.ur-toc-item').length }))
    await page.screenshot({ path: `${__dirname}/shots/${f}.png` })
    console.log(`${f.padEnd(20)} ${status.slice(0,120)} | page ${info.page ?? '-'} ${info.total ?? ''} | toc ${info.toc} | ${info.label}`)
    for (const l of logs.slice(0, 6)) console.log('     ', l)
  }
  await browser.close()
})()
