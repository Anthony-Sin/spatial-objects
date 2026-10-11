import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';

const jar = JSON.parse(readFileSync('/tmp/dec-cookies.json', 'utf8'));
const b = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  userDataDir: '/tmp/el-fresh-profile',
  args: ['--no-sandbox', '--mute-audio', '--disable-gpu'],
});
const pg = await b.newPage();
// feed every elevenlabs cookie into the fresh profile
const cookies = Object.entries(jar)
  .map(([k, v]) => { const [dom, name] = k.split('\t'); return { dom, name, v }; })
  .filter(c => c.dom.includes('elevenlabs'))
  .map(c => ({
    name: c.name, value: c.v,
    domain: c.dom.startsWith('.') ? c.dom : c.dom,
    path: '/', secure: true,
    ...(c.name.startsWith('__Secure') || c.name.startsWith('__Host') ? { sameSite: 'None' } : {}),
  }));
console.log('injecting', cookies.length, 'cookies');
await pg.setCookie(...cookies);
try {
  await pg.goto('https://elevenlabs.io/app/developers/api-keys', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 4000));
  const info = await pg.evaluate(() => ({
    url: location.href, title: document.title,
    peek: document.body.innerText.slice(0, 900),
    emails: (document.body.innerText.match(/[\w.+-]+@[\w-]+\.\w+/g) || []).slice(0, 3),
  }));
  console.log(JSON.stringify(info, null, 1));
  await pg.screenshot({ path: '/tmp/el-app.png' });
} catch (e) { console.log('ERR', e.message); await pg.screenshot({ path: '/tmp/el-app-err.png' }).catch(() => {}); }
await b.close();
