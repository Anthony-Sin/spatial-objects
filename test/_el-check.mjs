import puppeteer from 'puppeteer-core';

const b = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  userDataDir: '/tmp/chrome-clone',
  args: ['--no-sandbox', '--mute-audio', '--disable-gpu'],
});
const pg = await b.newPage();
try {
  await pg.goto('https://elevenlabs.io/app/settings/api-keys', { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 3000));
  const info = await pg.evaluate(() => ({
    url: location.href, title: document.title,
    bodyPeek: document.body.innerText.slice(0, 600),
    hasKeyField: !!document.querySelector('input[value^="sk_"], [data-testid*="key" i], code'),
    skTexts: [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && /^sk_[a-z0-9]{8,}/i.test(e.textContent || '')).map(e => e.textContent.trim()).slice(0, 5),
  }));
  console.log(JSON.stringify(info, null, 1));
  await pg.screenshot({ path: '/tmp/el-keys.png' });
} catch (e) { console.log('ERR', e.message); }
await b.close();
