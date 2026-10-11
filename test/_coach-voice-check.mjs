/* does the corner voice actually reach Audio.play()? (tip → mp3 → speaker) */
import puppeteer from 'puppeteer-core';
import { setTimeout as delay } from 'node:timers/promises';
const base = process.env.BASE || 'http://127.0.0.1:8791';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required'] });
const pg = await browser.newPage();
const plays = [];
await pg.evaluateOnNewDocument(() => {
  window.__plays = [];
  const op = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__plays.push(this.src?.slice(0, 40) || 'media'); return op.call(this).catch(() => {}); };
  window.__voiceFetch = 0;
  const of = window.fetch.bind(window);
  window.fetch = (u, o) => { if (String(u).includes('/api/coach-voice')) window.__voiceFetch++; return of(u, o); };
});
await pg.goto(`${base}/boxing.html?notrack=1&coach=1`, { waitUntil: 'domcontentloaded' });
await pg.waitForFunction('window.__boxing && window.__boxing.fight', { timeout: 30000 });
await pg.evaluate(() => {
  const B = window.__boxing, EMPTY = { hands: [] };
  for (let i = 0; i < 40 && B.state.phase !== 'fighting'; i++) B.game.step(1/60, EMPTY, null, {});
  B.state.player.hp = 20;
});
let card = false;
try { await pg.waitForFunction(`document.querySelector('[data-coach]').classList.contains('on')`, { timeout: 10000 }); card = true; } catch {}
// let the tip resolve + voice fetch + play (up to ~9s)
for (let i = 0; i < 45; i++) {
  const n = await pg.evaluate(() => ({ p: window.__plays.length, f: window.__voiceFetch,
    tip: document.querySelector('[data-coachtip]').textContent.slice(0, 40) }));
  if (n.p > 0) { console.log('PLAY after', (i*200)+'ms wait —', JSON.stringify(n)); plays.push(n); break; }
  if (i === 44) console.log('no play; last:', JSON.stringify(n));
  await delay(200);
}
console.log('card on:', card, '| coach-voice fetches:', await pg.evaluate(() => window.__voiceFetch),
  '| media plays:', await pg.evaluate(() => window.__plays.length));
await browser.close();
