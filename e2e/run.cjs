// Browser test: drives the app in headless Chromium against a fake GitHub API.
// Run: node e2e/run.cjs   (needs Playwright + Chromium installed; not an app dependency)
// Uses made-up data only: this repository is public.
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const pathMod = require('path');
const ROOT = pathMod.resolve(__dirname, '..');
const PORT = 8123;
const BASE = `http://localhost:${PORT}/`;
const shots = pathMod.join(require('os').tmpdir(), 'gym-log-shots/'); fs.mkdirSync(shots, { recursive: true });
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

// ---- static file server for the app ----
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, BASE).pathname);
  const file = pathMod.join(ROOT, p === '/' ? 'index.html' : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[pathMod.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1');

// ---- made-up history: two workouts, 9 and 2 days ago ----
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const fmt = (d) => `${d.getDate()}.${d.getMonth() + 1}.` + (d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear());
const WORKOUT = (date) => [
  `${date},1,Leg press,77x20/60 101x20/60 101x20,Depth 6`,
  `${date},2,Lat pulldown,45x10/60 53x10/60 53x10,`,
  `${date},3,Leg curl machine,45x20/30 55x20/30 55x20,"Ankle pad 4, backrest 2"`,
  `${date},4,Seated row machine,30x10/60 35x10/60 35x10,`,
];
const repo = { 'exercises.csv': 'exercise,finnish_sheet_name\nLeg press,x\nLat pulldown,x\nLeg curl machine,x\nSeated row machine,x\nHack squat machine,x\n' };
for (const d of [daysAgo(9), daysAgo(2)]) {
  const p = `log/${d.getFullYear()}.csv`;
  repo[p] = (repo[p] || 'date,order,exercise,sets,note\n') + WORKOUT(iso(d)).join('\n') + '\n';
}
for (const y of [new Date().getFullYear()]) if (!repo[`log/${y}.csv`]) repo[`log/${y}.csv`] = 'date,order,exercise,sets,note\n';
const LAST = fmt(daysAgo(2));

// ---- fake GitHub ----
let shaN = 1; const sha = {}; for (const k in repo) sha[k] = 'sha' + shaN++;
const puts = []; const foreign = []; let mode = 'ok'; let conflictOnce = false;
const problems = [];

async function fakeGitHub(route) {
  const req = route.request(); const url = new URL(req.url());
  if (req.headers()['authorization'] !== 'Bearer github_pat_TESTTOKEN_1234567890abcdef') problems.push('bad auth header ' + url.pathname);
  if (mode === 'offline') return route.abort('internetdisconnected');
  const m = url.pathname.match(/^\/repos\/o-wner\/my-log\/(contents|branches)\/(.+)$/);
  if (!m) return route.fulfill({ status: 404, body: '{}' });
  if (m[1] === 'branches') return route.fulfill({ status: m[2] === 'main' ? 200 : 404, contentType: 'application/json', body: '{}' });
  const path = decodeURIComponent(m[2]);
  if (req.method() === 'GET') {
    if (!(path in repo)) return route.fulfill({ status: 404, body: '{}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: b64(repo[path]).replace(/(.{60})/g, '$1\n'), sha: sha[path] }) });
  }
  if (req.method() === 'PUT') {
    const body = JSON.parse(req.postData());
    if (conflictOnce) { conflictOnce = false; repo[path] += iso(daysAgo(1)) + ',1,Extra row added elsewhere,10x10,\n'; sha[path] = 'sha' + shaN++; }
    if ((sha[path] || null) !== (body.sha || null)) return route.fulfill({ status: 409, body: '{}' });
    repo[path] = unb64(body.content); sha[path] = 'sha' + shaN++;
    puts.push({ path, message: body.message, branch: body.branch, text: repo[path] });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: { sha: sha[path] } }) });
  }
  route.fulfill({ status: 405, body: '{}' });
}

const lastLine = (p) => repo[p].trim().split('\n').pop();
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
function check(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) problems.push(msg); }

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await ctx.route('https://api.github.com/**', fakeGitHub);
  await ctx.route(/^(?!http:\/\/localhost:8123\/|https:\/\/api\.github\.com\/)/, (r) => { foreign.push(r.request().url()); r.abort(); });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  const notFound = [];
  page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });
  const primary = () => page.locator('.btn.primary').first();
  const primaryText = async () => (await primary().locator('.label').textContent()).trim();
  const tapPrimary = async () => { const t = await primaryText(); await primary().click(); return t; };
  const tap = (label) => page.locator('.btn', { has: page.locator('.label', { hasText: new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) }).first().click();

  await page.goto(BASE);
  await page.screenshot({ path: shots + '01-settings.png' });
  check(await page.locator('h2').textContent() === 'Settings', 'first launch opens Settings');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill('o-wner'); await inputs.nth(1).fill('my-log');
  await inputs.nth(3).fill('short');
  await tap('Save');
  check(await page.locator('.error').isVisible(), 'rejects malformed token');
  await inputs.nth(3).fill('github_pat_TESTTOKEN_1234567890abcdef');
  await tap('Save');
  await page.waitForSelector('text=Start workout');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('All saved'));
  await page.screenshot({ path: shots + '02-home.png' });
  check((await page.locator('.info h3').textContent()).includes(LAST), 'home shows last workout ' + LAST);
  const stored = await page.evaluate(() => localStorage.getItem('gl.settings'));
  check(stored.includes('github_pat_TESTTOKEN'), 'token stored in localStorage only');

  await tap('Start workout');
  await page.screenshot({ path: shots + '03-choose.png' });
  check(await primaryText() === 'Leg press', 'recommends Leg press first');
  await tapPrimary();
  await page.screenshot({ path: shots + '04-load.png' });
  check(await primaryText() === '77 kg', 'set 1 weight suggestion 77 kg');
  await tapPrimary();
  await page.screenshot({ path: shots + '05-reps.png' });
  check(await primaryText() === '20', 'set 1 reps suggestion 20');
  await tapPrimary();
  await page.screenshot({ path: shots + '06-rest.png' });
  check(await primaryText() === '60 s', 'rest suggestion 60 s');
  await tapPrimary();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: shots + '07-timer.png' });
  const cd = await page.locator('#countdown').textContent();
  check(/^0:5\d$/.test(cd), 'timer counting down (' + cd + ')');
  // during the countdown the next set's weight is asked, with suggested reps shown
  check(await primaryText() === '101 kg', 'set 2 weight asked during countdown (101 kg)');
  check(await page.locator('.question .muted').textContent() === 'Suggested reps: 20', 'suggested reps shown during countdown');
  // reload mid-rest: state and countdown must survive
  await page.reload(); await page.waitForSelector('.setno');
  check((await page.locator('.setno').textContent()) === 'Set 2', 'state survives reload (Set 2)');
  check(/^0:5\d$/.test(await page.locator('#countdown').textContent()), 'countdown survives reload');
  // use "Other" with decimal comma, then undo it
  await page.locator('.other input').fill('102,5'); await tap('OK');
  check((await page.locator('.question h3').textContent()).startsWith('102.5 kg'), 'decimal comma accepted (102,5 → 102.5)');
  check(await page.locator('#countdown').count() === 1, 'countdown still shown while waiting for reps');
  await page.screenshot({ path: shots + '08-reps-during-rest.png' });
  await tap('Undo');
  await tapPrimary(); await tapPrimary();             // 101 kg, 20 reps
  check(await page.locator('#countdown').count() === 0, 'countdown gone after reps entered');
  await page.locator('.other input').fill('3'); await tap('OK'); // 3 s rest
  await page.waitForTimeout(3800);
  check((await page.locator('#countdown').textContent()) === 'Rest over' && await page.locator('#timer.done').count() === 1, 'timer reaches Rest over');
  await page.screenshot({ path: shots + '08b-rest-over.png' });
  await tapPrimary(); await tapPrimary();             // 101, 20
  check(await primaryText() === 'Finish exercise', 'after set 3 recommends Finish exercise');
  await tapPrimary();
  await page.screenshot({ path: shots + '09-note.png' });
  check((await primaryText()) === 'Same as last time: Depth 6', 'note suggestion is last note');
  await tapPrimary();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('All saved'));
  check(puts.length === 1 && puts[0].branch === 'main', 'one PUT to main');
  check(lastLine('log/2026.csv') === `${today},1,Leg press,77x20/60 101x20/3 101x20,Depth 6`, 'row written: ' + lastLine('log/2026.csv'));
  check(puts[0].message === `Log ${today}: Leg press`, 'commit message');

  // exercise 2 with a write conflict (file changed on GitHub meanwhile)
  check(await primaryText() === 'Lat pulldown', 'then recommends Lat pulldown');
  await page.screenshot({ path: shots + '10-choose2.png' });
  await tapPrimary();
  for (let i = 0; i < 3; i++) { await tapPrimary(); await tapPrimary(); await tapPrimary(); } // weight, reps, rest (finish after set 3)
  conflictOnce = true;
  await tapPrimary(); // No note
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('All saved'));
  const t = repo['log/2026.csv'];
  check(t.includes('Extra row added elsewhere') && t.trim().endsWith(`${today},2,Lat pulldown,45x10/60 53x10/60 53x10,`), 'conflict retried, both changes kept');

  // offline: entry queued, then synced
  mode = 'offline';
  await tap('Other exercise…');
  check(await page.locator('.list h3', { hasText: 'Done today' }).count() === 1
    && await page.locator('.list').last().locator('.label', { hasText: /^Leg press$/ }).count() === 1,
    'exercises done today offered for another round');
  await page.locator('.other input').fill('Cable crunch'); await tap('Add');
  await page.locator('.other input').fill('20'); await tap('OK');
  await page.locator('.other input').fill('15'); await tap('OK');
  await tap('Finish exercise');
  await tapPrimary(); // No note
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('unsaved'));
  await page.screenshot({ path: shots + '11-offline.png' });
  check((await page.locator('#status').textContent()).includes('1 unsaved'), 'offline entry kept as unsaved');
  mode = 'ok';
  await page.locator('#status').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('All saved'));
  check(lastLine('log/2026.csv') === `${today},3,Cable crunch,20x15,`, 'queued entry saved after reconnect');

  await tap('Finish workout');
  await page.screenshot({ path: shots + '12-home-after.png' });
  const endWorkout = () => page.locator('.btn.secondary', { hasText: /^(Cancel|Finish) workout$/ }).last().click();
  // stale date: home screen drawn yesterday (app left in memory), Start pressed today
  const yesterday = iso(daysAgo(1));
  await page.evaluate((y) => { document.querySelector('main input[type=date]').value = y; }, yesterday);
  await tap('Start workout');
  check(JSON.parse(await page.evaluate(() => localStorage.getItem('gl.workout'))).date === today, 'stale default date on home screen replaced by today');
  check(await page.locator('main .note', { hasText: 'not today' }).count() === 0, 'no date warning for today');
  await endWorkout();
  // a date picked by hand is kept, and warned about
  await page.locator('main input[type=date]').fill(yesterday);
  await tap('Start workout');
  check(JSON.parse(await page.evaluate(() => localStorage.getItem('gl.workout'))).date === yesterday, 'hand-picked date kept');
  check(await page.locator('main .note', { hasText: 'not today' }).count() === 1, 'warning shown when not logging to today');
  await endWorkout();
  // empty workout started yesterday with the default date moves to today on reopen
  await page.evaluate((y) => localStorage.setItem('gl.workout', JSON.stringify({ date: y, autoDate: true, done: [], nextOrder: 1, current: null, undo: [] })), yesterday);
  await page.reload(); await page.waitForSelector('h2');
  const rolled = JSON.parse(await page.evaluate(() => localStorage.getItem('gl.workout')));
  check(rolled.date === today && rolled.nextOrder === 4, 'empty workout from yesterday moved to today (after today\'s 3 exercises)');
  await endWorkout();

  // XSS attempt via exercise name / note stays text
  await tap('Start workout'); await tap('Other exercise…');
  await page.locator('.other input').fill('<img src=x onerror=alert(1)>'); await tap('Add');
  check((await page.locator('h2').textContent()) === '<img src=x onerror=alert(1)>' && await page.locator('main img').count() === 0, 'HTML in names shown as text, not executed');

  check(foreign.length === 0, 'no requests to other servers ' + JSON.stringify(foreign));
  const unexpected = consoleErrors.filter((m) => !/blocked by Playwright|409 \(Conflict\)|ERR_INTERNET_DISCONNECTED|404 \(Not Found\)/.test(m));
  const bad404 = notFound.filter((u) => !/api\.github\.com\/repos\/o-wner\/my-log\/contents\/log\/\d{4}\.csv/.test(u));
  check(bad404.length === 0, 'only missing log files return 404 ' + JSON.stringify(bad404));
  check(unexpected.length === 0, 'no unexpected console errors ' + JSON.stringify(unexpected));
  await browser.close();

  // ---- offline start with service worker ----
  const b2 = await chromium.launch();
  const c2 = await b2.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  await c2.route('https://api.github.com/**', (r) => r.abort());
  const p2 = await c2.newPage();
  const errs2 = []; p2.on('pageerror', (e) => errs2.push(e.message));
  await p2.goto(BASE);
  await p2.evaluate(() => navigator.serviceWorker.ready);
  await p2.reload(); await p2.waitForTimeout(500);
  await c2.setOffline(true);
  await p2.reload({ waitUntil: 'domcontentloaded' }); await p2.waitForSelector('h2', { timeout: 8000 }).catch(() => {});
  check((await p2.locator('h2').textContent().catch(() => '')) === 'Settings', 'app opens offline from service worker cache');
  check(errs2.length === 0, 'no page errors offline ' + JSON.stringify(errs2));
  await b2.close();
  console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : '\nALL CHECKS PASSED');
  server.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
