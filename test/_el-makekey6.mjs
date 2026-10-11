import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
const jar = JSON.parse(readFileSync('/tmp/dec-cookies.json', 'utf8'));
const b = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  userDataDir: '/tmp/el-fresh-profile',
  args: ['--no-sandbox', '--mute-audio', '--disable-gpu'],
});
const pg = await b.newPage();
const cookies = Object.entries(jar).map(([k, v]) => { const [dom, name] = k.split('\t');
  return { name, value: v, domain: dom, path: '/', secure: true }; }).filter(c => c.domain.includes('elevenlabs'));
await pg.setCookie(...cookies);
const realClick = async (sel) => {
  const h = await pg.$(sel);
  if (!h) return false;
  const box = await h.boundingBox();
  if (!box) return false;
  await pg.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
};
try {
  await pg.goto('https://elevenlabs.io/app/developers/api-keys', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 3000));
  await pg.evaluate(() => [...document.querySelectorAll('button')].find(b => /create key/i.test(b.textContent))?.click());
  await new Promise(r => setTimeout(r, 2500));
  await pg.type('input[placeholder="API Key Name"]', 'knighthacks-corner');
  // find the Access button inside the TTS list-item, click with real mouse
  const pos = await pg.evaluate(() => {
    const row = [...document.querySelectorAll('li.eleven-list-item')].find(li => /text to speech/i.test(li.textContent));
    const btn = row && [...row.querySelectorAll('button')].find(b => /^access$/i.test((b.textContent || '').trim()));
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  console.log('access btn at', JSON.stringify(pos));
  if (pos) { await pg.mouse.click(pos.x, pos.y); await new Promise(r => setTimeout(r, 900)); }
  await pg.screenshot({ path: '/tmp/el-modal6.png' });
  // real click on the dialog's Create Key submit (the LAST matching button)
  const sub = await pg.evaluate(() => {
    const btns = [...document.querySelectorAll('button')].filter(b => /^create key$/i.test((b.textContent || '').trim()));
    const btn = btns[btns.length - 1];
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  console.log('submit at', JSON.stringify(sub));
  if (sub) await pg.mouse.click(sub.x, sub.y);
  await new Promise(r => setTimeout(r, 6000));
  const res = await pg.evaluate(() => ({
    keys: (document.body.innerText.match(/sk_[a-zA-Z0-9]{20,}/g) || []),
    inputs: [...document.querySelectorAll('input')].map(i => i.value).filter(v => /^sk/.test(v)),
    tableHit: (document.body.innerText.match(/knighthacks-corner[\s\S]{0,80}/) || [])[0],
  }));
  console.log('RESULT:', JSON.stringify(res, null, 1));
  await pg.screenshot({ path: '/tmp/el-key-shown.png' });
} catch (e) { console.log('ERR', e.message); }
await b.close();
