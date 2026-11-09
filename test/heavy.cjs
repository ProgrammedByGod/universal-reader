const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] }); const p = await b.newPage({ viewport: { width: 1220, height: 820 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text().slice(0, 300)) })
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  for (const f of process.argv.slice(2)) {
    errs.length = 0
    const t0 = Date.now()
    const st = await Promise.race([p.evaluate(f => openFile(f), f), new Promise(r => setTimeout(() => r('TIMEOUT'), 90000))]); await p.waitForTimeout(4000)
    await p.screenshot({ path: `test/shots/h-${f}.png` })
    const meta = await p.evaluate(() => document.querySelector('.ur-meta')?.innerText || '')
    console.log(f, '=>', String(st).replace(/\n+/g, ' ').slice(0, 200), (Date.now() - t0) + 'ms', meta.slice(0, 200), errs.slice(0, 4))
  }
  await b.close()
})()
