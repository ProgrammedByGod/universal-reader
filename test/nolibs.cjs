// Каждый образец: открылся / показал «нужен пакет библиотек» / другая ошибка
const { chromium } = require('playwright'); const fs = require('fs')
const files = fs.readdirSync(__dirname + '/samples').filter(f => fs.statSync(__dirname + '/samples/' + f).isFile()).sort()
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage()
  await p.addInitScript(() => { localStorage.setItem('universal-reader-lang', 'en'); localStorage.setItem('ur-data', JSON.stringify({ lang: 'en' })) })
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  const res = { ok: [], libs: [], err: [], inner: [] }
  for (const f of files) {
    let st; try { st = await Promise.race([p.evaluate(n => openFile(n), f), new Promise(r => setTimeout(() => r('TIMEOUT'), 20000))]) } catch (e) { st = 'THROW ' + e.message }
    await p.waitForTimeout(400)
    const s = await p.evaluate(() => ({ panel: !!document.querySelector('.ur-libs-missing'), txt: document.body.innerText.match(/library pack[^\n]*/)?.[0] || '' }))
    if (s.panel) res.libs.push(f); else if (s.txt) res.inner.push(f); else if (st === 'ok') res.ok.push(f); else res.err.push(f + ': ' + String(st).slice(0, 100).replace(/\n/g, ' '))
  }
  console.log('ok', res.ok.length, '| panel', res.libs.length, '| message inside', res.inner.length, '| errors', res.err.length)
  console.log('PANEL:', res.libs.join(' ')); console.log('INNER:', res.inner.join(' ')); console.log('ERR:\n' + res.err.join('\n'))
  await b.close()
})()
