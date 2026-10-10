import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
const pg = await b.newPage();
const errs = [];
pg.on('pageerror', e => errs.push('PAGEERR: ' + e.message.slice(0,180)));
pg.on('console', m => { const t = m.text(); if (m.type() === 'error' || /worker|detect fail/i.test(t)) errs.push(m.type()+': '+t.slice(0,180)); });
await pg.goto('http://127.0.0.1:8890/boxing.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const s = await pg.evaluate(() => ({
    tag: document.querySelector('[data-peep]')?.textContent,
    face: window.__boxing?.face?.delegate, hands: window.__boxing?.hands?.delegate,
    faceFound: window.__boxing?.face?.state?.found,
    faceSize: window.__boxing?.face?.state?.size?.toFixed?.(3),
    handsN: window.__boxing?.hands?.state?.hands?.length,
    inflight: window.__boxing?.hands?._inFlight,
  }));
  console.log(i+1+'s', JSON.stringify(s));
  if (s.face && s.hands) break;
}
console.log('errs:', JSON.stringify(errs.slice(0,10), null, 1));
await b.close();
