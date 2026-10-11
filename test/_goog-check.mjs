import puppeteer from 'puppeteer-core';

const b = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  userDataDir: '/tmp/chrome-clone',
  args: ['--no-sandbox', '--mute-audio', '--disable-gpu'],
});
const pg = await b.newPage();
try {
  await pg.goto('https://myaccount.google.com/', { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 2500));
  const info = await pg.evaluate(() => ({
    url: location.href, title: document.title,
    peek: document.body.innerText.slice(0, 400),
    emails: (document.body.innerText.match(/[\w.+-]+@gmail\.com/gi) || []).slice(0, 5),
  }));
  console.log('ACCT', JSON.stringify(info, null, 1));
  await pg.screenshot({ path: '/tmp/goog.png' });
  // also probe mlh.com — maybe there's already an MLH session in the clone
  await pg.goto('https://www.mlh.com/events/knight-hacks-ix/challenges/01999bc7-ad70-0ba6-f3ff-d7eb57ff56d1',
    { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 2000));
  const mlh = await pg.evaluate(() => ({
    url: location.href,
    hasClaim: [...document.querySelectorAll('a,button')].some(e => /claim/i.test(e.textContent || '')),
    claimText: [...document.querySelectorAll('a,button')].map(e => (e.textContent || '').trim()).filter(t => /claim|sign|log/i.test(t)).slice(0, 6),
  }));
  console.log('MLH', JSON.stringify(mlh, null, 1));
  await pg.screenshot({ path: '/tmp/mlh.png' });
} catch (e) { console.log('ERR', e.message); }
await b.close();
