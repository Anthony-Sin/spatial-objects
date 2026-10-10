import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio'] });
const pg = await b.newPage();
pg.on('pageerror', e => console.log('PAGEERR:', e.message.slice(0,300)));
pg.on('console', m => { const t = m.text(); if (!/^INFO:|XNNPACK|TensorFlow|Created TensorFlow|GroupMarker|swiftshader|Vulkan|deprecat/i.test(t)) console.log(m.type().toUpperCase() + ':', t.slice(0,300)); });
await pg.goto('http://127.0.0.1:8890/boxing.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 25000));
console.log('TAG:', await pg.evaluate(() => document.querySelector('[data-peep]')?.textContent));
await b.close();
