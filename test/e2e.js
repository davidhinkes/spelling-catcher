// End-to-end check in real Chrome: load the unpacked extension, type into a
// textarea and a contenteditable, make corrections, and read back storage.
// Run: node test/e2e.js   (needs playwright and a Chrome/Chromium binary)
const path = require('path');
const http = require('http');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const EXT = path.join(__dirname, '../extension');
const PAGE = `<!doctype html><textarea id="ta"></textarea>
<div id="ce" contenteditable="true" style="min-height:40px;border:1px solid"></div>
<input id="pw" type="password">
<input id="toggle" type="password"><button id="show" onclick="document.getElementById('toggle').type='text'">show</button>
<input id="otp" type="text" autocomplete="one-time-code">`;

(async () => {
  const server = http.createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  const ctx = await chromium.launchPersistentContext('', {
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new'],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');

  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForTimeout(500);
  const type = (sel, text) => page.type(sel, text, { delay: 30 });
  const pause = (ms = 600) => page.waitForTimeout(ms);

  // Textarea: misspell, then backspace and retype.
  await page.click('#ta');
  await type('#ta', 'I will recieve ');
  await pause();
  for (let i = 0; i < 8; i++) { await page.keyboard.press('Backspace'); await pause(120); }
  await type('#ta', 'receive it tommorow');
  await pause();
  await page.keyboard.press('Enter'); // tommorow stays uncorrected -> flagged

  // Contenteditable: misspell, then fix by clicking back in (Home + arrows).
  await page.click('#ce');
  await type('#ce', 'that is definately right ');
  await pause();
  await page.keyboard.press('Home');
  for (let i = 0; i < 'that is defin'.length; i++) await page.keyboard.press('ArrowRight');
  await pause();
  for (let i = 0; i < 5; i++) await page.keyboard.press('Delete'); // "ately"
  await type('#ce', 'itely');
  await pause();
  await page.keyboard.press('End');
  await type('#ce', 'ok ');
  await pause();

  // Password field must be ignored.
  await page.click('#pw');
  await type('#pw', 'hunter2 secrett ');
  // "Show password" toggle: field flips to type=text but must stay ignored.
  await page.click('#show');
  await page.click('#toggle');
  await type('#toggle', 'zorkmid ');
  // One-time-code field marked by autocomplete.
  await page.click('#otp');
  await type('#otp', 'qwrtyp ');
  await page.click('#ta');
  await pause(2800); // let the content script flush

  const data = await sw.evaluate(() => chrome.storage.local.get(null));
  console.log(JSON.stringify(data, null, 2));

  const ok =
    data.corrections?.recieve?.fixes?.receive === 1 &&
    data.corrections?.definately?.fixes?.definitely === 1 &&
    data.flagged?.tommorow?.count === 1 &&
    !data.flagged?.secrett && !data.flagged?.recieve &&
    !data.flagged?.zorkmid && !data.flagged?.qwrtyp &&
    // Only corrections are queued for Google Sheets, and rows carry no site.
    JSON.stringify((data.outbox || []).map(r => r.row.slice(2))) ===
      JSON.stringify([['recieve', 'receive'], ['definately', 'definitely']]) &&
    data.outbox.every(r => r.row.length === 4);
  console.log(ok ? 'E2E PASS' : 'E2E FAIL');

  // Render the popup for a visual check.
  const extId = sw.url().split('/')[2];
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 340 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForTimeout(300);
  await popup.screenshot({ path: path.join(__dirname, '../docs/popup-corrected.png') });
  await popup.click('#tab-flagged');
  await popup.screenshot({ path: path.join(require('os').tmpdir(), 'popup-flagged.png') });

  await ctx.close();
  server.close();
  process.exit(ok ? 0 : 1);
})();
