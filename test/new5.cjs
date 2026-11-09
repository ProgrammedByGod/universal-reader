const { chromium } = require('playwright')
const fs = require('fs')
const list = process.argv.slice(2).length ? process.argv.slice(2) : fs.readFileSync(__dirname + '/new5.list', 'utf8').split('\n').filter(Boolean)
;(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }); const p = await b.newPage({ viewport: { width: 1220, height: 820 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message.slice(0, 200))); p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)) })
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  for (const f of list) {
    errs.length = 0
    let st
    const [name, opt] = f.split('|')
    try { st = await Promise.race([p.evaluate(([n, o]) => openFile(n, o ? { [o]: true } : {}), [name, opt]), new Promise(r => setTimeout(() => r('TIMEOUT'), 30000))]) } catch (e) { st = 'THROW ' + e.message }
    await p.waitForTimeout(1500)
    const txt = await p.evaluate(() => (document.querySelector('.ur-stage')?.innerText || '').replace(/\s+/g, ' ').slice(0, 160))
    await p.screenshot({ path: __dirname + `/shots/n-${name.replace(/\//g, '_')}${opt ? '-' + opt : ''}.png` })
    console.log((st === 'ok' && !errs.length ? 'OK  ' : 'BAD ') + name + (opt ? ' (' + opt + ')' : ''), '=>', st === 'ok' ? '' : st.replace(/\n+/g, ' ').slice(0, 160), errs.length ? '| ' + errs.slice(0, 3).join(' ; ') : '', '| ' + txt)
  }
  await b.close()
})()
