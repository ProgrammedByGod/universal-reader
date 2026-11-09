// Открывает файлы и печатает текст из книги (внутри iframe) — для проверки книжных форматов
const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1220, height: 820 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message.slice(0, 200)))
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => window.ready)
  for (const f of process.argv.slice(2)) {
    errs.length = 0
    let st; try { st = await p.evaluate(n => openFile(n), f) } catch (e) { st = 'THROW ' + e.message }
    await p.waitForTimeout(2500)
    const txt = await p.evaluate(() => { let s = ''; for (const fr of document.querySelectorAll('iframe')) { try { s += fr.contentDocument?.body?.innerText ?? '' } catch {} } const toc = [...document.querySelectorAll('.ur-toc a, .ur-toc-item, [class*=toc] li')].map(x => x.textContent.trim()).slice(0, 8).join(' | '); return (s.replace(/\s+/g, ' ').slice(0, 220)) + (toc ? '  [TOC: ' + toc + ']' : '') })
    await p.screenshot({ path: __dirname + '/shots/b-' + f.replace(/\//g, '_') + '.png' })
    console.log((st === 'ok' && !errs.length ? 'OK  ' : 'BAD ') + f, '=>', st === 'ok' ? '' : String(st).slice(0, 150), errs.join(';'), '|', txt)
  }
  await b.close()
})()
