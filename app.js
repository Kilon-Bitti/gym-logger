// Gym Logger UI. Plain browser JavaScript, no third-party code.
// Security notes:
// - The GitHub token is kept only in this device's localStorage and is sent only
//   to https://api.github.com (also enforced by the Content-Security-Policy).
// - All text is inserted with textContent / text nodes, never as HTML.
import * as L from './logic.js';

const VERSION = 5; // shown on the home screen; keep equal to the number in sw.js CACHE
const API = 'https://api.github.com';
const KEYS = { settings: 'gl.settings', cache: 'gl.cache', pending: 'gl.pending', workout: 'gl.workout' };
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

const read = (k, fallback) => {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
};
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

let settings = read(KEYS.settings, { owner: '', repo: '', branch: 'main', token: '' });
let cache = read(KEYS.cache, { files: {}, exercises: [] }); // files: { path: { text, sha } }
let pending = read(KEYS.pending, []); // [{ id, row }] saved locally, not yet on GitHub
let workout = read(KEYS.workout, null);
if (workout && workout.current && workout.current.step === 'timer') workout.current.step = 'load';
const ui = { settingsOpen: false, showAll: false, status: 'idle', statusMsg: '' };
let rowsMemo = null;

const configured = () => Boolean(settings.owner && settings.repo && settings.branch && settings.token);
const saveWorkout = () => write(KEYS.workout, workout);
const invalidate = () => { rowsMemo = null; };

function allRows() {
  if (rowsMemo) return rowsMemo;
  const rows = [];
  for (const f of Object.values(cache.files)) {
    try { rows.push(...L.parseLog(f.text)); } catch { /* skip unreadable file */ }
  }
  pending.forEach((p) => rows.push(p.row));
  rowsMemo = L.dedupeRows(rows);
  return rowsMemo;
}

// ---------- GitHub ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function contentsUrl(path) {
  const segs = path.split('/').map(encodeURIComponent).join('/');
  return `${API}/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/contents/${segs}`;
}

async function gh(method, url, body) {
  const res = await fetch(url, {
    method,
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: {
      Authorization: `Bearer ${settings.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new HttpError(res.status, `GitHub ${res.status}`);
  return res.json();
}

async function getFile(path) {
  try {
    const j = await gh('GET', `${contentsUrl(path)}?ref=${encodeURIComponent(settings.branch)}`);
    return { text: L.b64decodeUtf8(j.content), sha: j.sha };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function putFile(path, text, sha, message) {
  const body = { message, content: L.b64encodeUtf8(text), branch: settings.branch, ...(sha ? { sha } : {}) };
  const j = await gh('PUT', contentsUrl(path), body);
  return j.content.sha;
}

function errorText(e) {
  switch (e.status) {
    case 401: return 'Token rejected (expired or wrong). Check Settings.';
    case 403: return 'GitHub refused: token lacks Contents read/write on this repo, or rate limit.';
    case 404: return 'Repository or branch not found, or the token has no access to it.';
    case 409: case 422: return 'GitHub reported a conflict. Will retry.';
    default: return e.status ? `GitHub error ${e.status}.` : 'No connection. Entries are kept on this phone.';
  }
}

function setStatus(status, msg = '') { ui.status = status; ui.statusMsg = msg; renderStatus(); }

async function refreshData() {
  if (!configured()) return;
  setStatus('loading');
  try {
    // Fails with 404 if the repo or branch does not exist or the token cannot see it.
    await gh('GET', `${API}/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/branches/${encodeURIComponent(settings.branch)}`);
    const y = new Date().getFullYear();
    const files = {};
    for (const path of [`log/${y - 1}.csv`, `log/${y}.csv`]) {
      const f = await getFile(path);
      if (f) files[path] = f;
    }
    const ex = await getFile('exercises.csv');
    cache = { files, exercises: ex ? L.parseExerciseNames(ex.text) : [], fetchedAt: Date.now() };
    write(KEYS.cache, cache);
    invalidate();
    setStatus('ok');
    softRender();
    syncPending();
  } catch (e) {
    setStatus('error', errorText(e));
  }
}

let syncing = false;
async function syncPending() {
  if (syncing || !pending.length || !configured()) { renderStatus(); return; }
  syncing = true;
  setStatus('saving');
  try {
    const byPath = new Map();
    for (const p of pending) {
      const path = `log/${p.row.date.slice(0, 4)}.csv`;
      if (!byPath.has(path)) byPath.set(path, []);
      byPath.get(path).push(p);
    }
    for (const [path, items] of byPath) {
      for (let attempt = 0; ; attempt++) {
        const f = await getFile(path);
        const { text, added } = L.appendLines(f ? f.text : '', items.map((p) => L.rowToLine(p.row)));
        let stored = f;
        if (added) {
          const msg = items.length === 1
            ? `Log ${items[0].row.date}: ${items[0].row.exercise}`
            : `Log ${items.length} exercises`;
          try {
            stored = { text, sha: await putFile(path, text, f && f.sha, msg) };
          } catch (e) {
            if ((e.status === 409 || e.status === 422) && attempt < 3) continue; // file changed meanwhile
            throw e;
          }
        }
        if (stored) cache.files[path] = stored;
        const ids = new Set(items.map((p) => p.id));
        pending = pending.filter((p) => !ids.has(p.id));
        write(KEYS.pending, pending);
        write(KEYS.cache, cache);
        invalidate();
        break;
      }
    }
    setStatus('ok');
  } catch (e) {
    setStatus('error', errorText(e));
  } finally {
    syncing = false;
    renderStatus();
  }
}

// ---------- Small DOM helper (text only, never innerHTML) ----------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const btn = (label, onclick, cls = '', sub = null) =>
  h('button', { type: 'button', class: `btn ${cls}`, onclick }, h('span', { class: 'label' }, label), sub && h('span', { class: 'sub' }, sub));

const loadLabel = (v) => (v === 'bw' ? 'Bodyweight' : `${v} kg`);
const restLabel = (v) => (v === 'finish' ? 'Finish exercise' : v === 'none' ? 'Next set, no timer'
  : v >= 120 && v % 60 === 0 ? `${v / 60} min` : `${v} s`);

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return y === new Date().getFullYear() ? `${d}.${m}.` : `${d}.${m}.${y}`;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const setsShort = (sets) => sets.map((s) => `${s.load === 'bw' ? 'bw' : s.load}×${s.reps}`).join('  ');

function lastSummary(name) {
  const last = L.lastTime(allRows(), name, workout ? workout.date : todayIso());
  return last ? `${fmtDate(last.date)}  ${setsShort(last.sets)}` : 'Not done before';
}

// A question with one big recommended answer, smaller alternatives and an "Other" input.
function question(title, { recommended, alternatives, label, onpick, other, hint }) {
  const box = h('section', { class: 'question' }, h('h3', null, title), hint && h('p', { class: 'muted' }, hint));
  if (recommended != null) box.append(btn(label(recommended), () => onpick(recommended), 'primary big'));
  if (alternatives.length) box.append(h('div', { class: 'grid' }, alternatives.map((a) => btn(label(a), () => onpick(a)))));
  if (other) {
    const input = h('input', { type: 'text', inputmode: other.inputmode, placeholder: other.placeholder, autocomplete: 'off', enterkeyhint: 'done' });
    const err = h('p', { class: 'error', hidden: true });
    const submit = () => {
      const v = other.parse(input.value);
      if (v == null) { err.textContent = other.error; err.hidden = false; return; }
      onpick(v);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    box.append(h('div', { class: 'other' }, input, btn('OK', submit, 'small')), err);
  }
  return box;
}

// ---------- Screens ----------

function settingsScreen() {
  const f = {
    owner: h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'GitHub user name', value: settings.owner }),
    repo: h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'private log repository name', value: settings.repo }),
    branch: h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', value: settings.branch || 'main' }),
    token: h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: settings.token ? 'Saved. Leave empty to keep it.' : 'github_pat_…' }),
  };
  const err = h('p', { class: 'error', hidden: true });
  const save = async () => {
    const next = {
      owner: f.owner.value.trim(), repo: f.repo.value.trim(), branch: f.branch.value.trim(),
      token: f.token.value.trim() || settings.token,
    };
    const problem = !OWNER_RE.test(next.owner) ? 'Check the user name.'
      : !REPO_RE.test(next.repo) ? 'Check the repository name.'
      : !BRANCH_RE.test(next.branch) ? 'Check the branch name.'
      : !/^[A-Za-z0-9_]{20,255}$/.test(next.token) ? 'The token does not look right.' : null;
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    const changedRepo = next.owner !== settings.owner || next.repo !== settings.repo || next.branch !== settings.branch;
    settings = next;
    write(KEYS.settings, settings);
    if (changedRepo) { cache = { files: {}, exercises: [] }; write(KEYS.cache, cache); invalidate(); }
    ui.settingsOpen = false;
    render();
    refreshData();
  };
  const forget = () => {
    if (!confirm('Remove the token and all workout data stored on this phone? Entries not yet saved to GitHub will be lost.')) return;
    Object.values(KEYS).forEach((k) => localStorage.removeItem(k)); // only this app's keys
    settings = { owner: '', repo: '', branch: 'main', token: '' };
    cache = { files: {}, exercises: [] };
    pending = [];
    workout = null;
    invalidate();
    render();
  };
  const field = (label, input) => h('label', { class: 'field' }, h('span', null, label), input);
  return h('main', null,
    h('h2', null, 'Settings'),
    field('GitHub user', f.owner), field('Repository', f.repo), field('Branch', f.branch), field('Access token', f.token),
    err,
    btn('Save', save, 'primary'),
    h('details', { class: 'help' },
      h('summary', null, 'How to create the token'),
      h('ol', null,
        h('li', null, 'github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.'),
        h('li', null, 'Expiration: e.g. one year. Repository access: Only select repositories → your private log repository.'),
        h('li', null, 'Permissions → Repository permissions → Contents: Read and write. Nothing else.'),
        h('li', null, 'Copy the token and paste it here. It is stored only on this phone and sent only to api.github.com.'))),
    configured() && btn('Back', () => { ui.settingsOpen = false; render(); }),
    btn('Forget token and data on this phone', forget, 'danger'));
}

function homeScreen() {
  const date = h('input', { type: 'date', value: todayIso(), max: '2100-12-31' });
  const start = () => {
    const d = date.value;
    if (!L.isValidDate(d)) return;
    const already = allRows().filter((r) => r.date === d).sort((a, b) => a.order - b.order);
    workout = {
      date: d,
      done: already.map((r) => r.exercise),
      nextOrder: already.reduce((m, r) => Math.max(m, r.order), 0) + 1,
      current: null,
      undo: [],
    };
    saveWorkout();
    render();
  };
  const sessions = L.groupSessions(allRows(), '9999-12-31');
  const last = sessions[0];
  return h('main', null,
    h('h2', null, 'Workout'),
    h('label', { class: 'field' }, h('span', null, 'Date'), date),
    btn('Start workout', start, 'primary big'),
    last && h('section', { class: 'info' },
      h('h3', null, `Last workout ${fmtDate(last.date)}`),
      h('ul', null, last.rows.map((r) => h('li', null, `${r.exercise}: ${setsShort(r.sets)}`)))),
    h('div', { class: 'grid' },
      btn('Refresh data', () => refreshData()),
      btn('Settings', () => { ui.settingsOpen = true; render(); })),
    h('p', { class: 'muted version' }, `App version ${VERSION}`));
}

function chooseExerciseScreen() {
  const rows = allRows();
  const ranked = L.rankNextExercises(rows, workout.date, workout.done);
  const done = new Set(workout.done);
  const start = (name) => {
    workout.current = { exercise: name, order: workout.nextOrder, sets: [], step: 'load', load: null, timerEnd: null };
    workout.undo = [];
    ui.showAll = false;
    saveWorkout();
    render();
  };
  const main = h('main', null,
    h('h2', null, `Exercise ${workout.done.length + 1}`),
    h('p', { class: 'muted' }, fmtDate(workout.date) + (workout.done.length ? `  ·  Done: ${workout.done.join(', ')}` : '')));
  if (ranked.length) main.append(btn(ranked[0], () => start(ranked[0]), 'primary big', lastSummary(ranked[0])));
  ranked.slice(1, 4).forEach((n) => main.append(btn(n, () => start(n), '', lastSummary(n))));

  if (!ui.showAll) main.append(btn('Other exercise…', () => { ui.showAll = true; render(); }));
  else {
    const top = new Set(ranked.slice(0, 4));
    const all = L.exercisesByRecency(rows, cache.exercises).filter((n) => !done.has(n) && !top.has(n));
    main.append(h('section', { class: 'list' }, all.map((n) => btn(n, () => start(n), 'small'))));
    // Exercises already done today stay available for another round, listed last.
    if (done.size) {
      main.append(h('section', { class: 'list' }, h('h3', null, 'Done today, another round:'),
        [...done].map((n) => btn(n, () => start(n), 'small'))));
    }
    const input = h('input', { type: 'text', placeholder: 'New exercise name (English)', autocomplete: 'off', maxlength: 80 });
    const err = h('p', { class: 'error', hidden: true });
    const add = () => {
      const name = L.cleanText(input.value, 80);
      if (!name) { err.textContent = 'Type a name.'; err.hidden = false; return; }
      start(name);
    };
    main.append(h('div', { class: 'other' }, input, btn('Add', add, 'small')), err);
  }
  main.append(workout.done.length
    ? btn('Finish workout', finishWorkout, 'secondary')
    : btn('Cancel workout', () => { workout = null; saveWorkout(); render(); }, 'secondary'));
  return main;
}

function finishWorkout() {
  workout = null;
  saveWorkout();
  render();
  syncPending();
}

function pushUndo() {
  workout.undo.push(JSON.stringify(workout.current));
  if (workout.undo.length > 60) workout.undo.shift();
}

function undo() {
  if (workout.undo.length) workout.current = JSON.parse(workout.undo.pop());
  else workout.current = null; // nothing done yet: back to exercise choice
  saveWorkout();
  render();
}

function exerciseScreen() {
  const cur = workout.current;
  const rows = allRows();
  const last = L.lastTime(rows, cur.exercise, workout.date);
  const n = cur.sets.length + (cur.step === 'load' || cur.step === 'reps' ? 1 : 0);
  const update = (fn) => { pushUndo(); fn(); saveWorkout(); render(); };

  const main = h('main', null,
    h('h2', null, cur.exercise),
    cur.step !== 'note' && h('p', { class: 'setno' }, `Set ${n}`),
    h('section', { class: 'info' },
      h('p', null, last ? `Last time ${fmtDate(last.date)}: ${L.formatSets(last.sets)}` : 'No earlier entries.'),
      last && last.note && h('p', { class: 'note' }, last.note),
      cur.sets.length > 0 && h('p', null, `Today: ${L.formatSets(cur.sets)}`)));

  // During the rest the next set's weight can already be chosen; the countdown stays on top.
  if (resting()) {
    main.append(h('section', { class: 'timer', id: 'timer' },
      h('p', { id: 'countdown', class: 'countdown' }, ''),
      btn('+30 s', () => {
        cur.timerEnd = Math.max(cur.timerEnd, Date.now()) + 30000;
        cur.sets[cur.sets.length - 1].rest += 30;
        saveWorkout();
        tick();
      }, 'small')));
  }

  if (cur.step === 'load') {
    const rec = L.suggestLoad(last, cur.sets);
    const reps = L.suggestReps(last, cur.sets);
    main.append(question(`Weight for set ${n}?`, {
      recommended: rec,
      hint: reps != null ? `Suggested reps: ${reps}` : null,
      alternatives: L.loadOptions(rows, cur.exercise, rec, cur.sets),
      label: loadLabel,
      onpick: (v) => update(() => { cur.load = v; cur.step = 'reps'; }),
      other: { inputmode: 'decimal', placeholder: 'kg, or bw', parse: L.normLoad, error: 'Enter kg (e.g. 52,5) or bw.' },
    }));
    if (cur.sets.length) main.append(btn('Finish exercise', () => update(finishSets), 'secondary'));
  } else if (cur.step === 'reps') {
    const rec = L.suggestReps(last, cur.sets);
    main.append(question(`${loadLabel(cur.load)}: reps done?`, {
      recommended: rec,
      hint: resting() ? 'Tap after the set.' : null,
      alternatives: L.repOptions(rec),
      label: String,
      onpick: (v) => update(() => {
        cur.sets.push({ load: cur.load, reps: v, rest: null });
        cur.load = null;
        cur.timerEnd = null;
        cur.step = 'rest';
      }),
      other: { inputmode: 'numeric', placeholder: 'reps', parse: (s) => L.normInt(s, 999), error: 'Enter a whole number.' },
    }));
  } else if (cur.step === 'rest') {
    const rec = L.suggestRest(last, cur.sets);
    main.append(question('Rest before the next set?', {
      recommended: rec,
      alternatives: L.restOptions(rec),
      label: restLabel,
      onpick: (v) => update(() => pickRest(v)),
      other: { inputmode: 'numeric', placeholder: 'seconds', parse: (s) => L.normInt(s, 3600), error: 'Enter seconds.' },
    }));
  } else if (cur.step === 'note') {
    main.append(noteQuestion(last));
  }
  main.append(btn('Undo', undo, 'secondary'));
  return main;
}

function pickRest(v) {
  const cur = workout.current;
  if (v === 'finish') return finishSets();
  const lastSet = cur.sets[cur.sets.length - 1];
  if (v === 'none') { lastSet.rest = null; cur.step = 'load'; return; }
  lastSet.rest = v;
  cur.timerEnd = Date.now() + v * 1000;
  cur.step = 'load';
}

// The rest after the final set is not recorded (same as in the original log).
function finishSets() {
  const cur = workout.current;
  if (cur.sets.length) cur.sets[cur.sets.length - 1].rest = null;
  cur.timerEnd = null;
  cur.step = 'note';
}

function noteQuestion(last) {
  const lastNote = last && last.note;
  const box = h('section', { class: 'question' }, h('h3', null, 'Note for this exercise?'));
  if (lastNote) box.append(btn(`Same as last time: ${lastNote}`, () => saveExercise(lastNote), 'primary big'), btn('No note', () => saveExercise('')));
  else box.append(btn('No note', () => saveExercise(''), 'primary big'));
  const ta = h('textarea', { rows: 2, maxlength: 300, placeholder: 'e.g. Depth 6. Felt heavy at the end.' });
  if (lastNote) ta.value = lastNote;
  box.append(h('div', { class: 'other' }, ta, btn('Save', () => saveExercise(ta.value), 'small')));
  return box;
}

function saveExercise(noteInput) {
  const cur = workout.current;
  const row = {
    date: workout.date, order: cur.order, exercise: cur.exercise,
    sets: cur.sets.map((s) => ({ load: s.load, reps: s.reps, rest: s.rest })),
    note: L.cleanText(noteInput, 300),
  };
  const problems = L.validateRow(row);
  if (problems.length) { alert(`Cannot save, invalid: ${problems.join(', ')}`); return; }
  const id = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`;
  pending.push({ id, row });
  write(KEYS.pending, pending);
  invalidate();
  workout.done.push(cur.exercise);
  workout.nextOrder = cur.order + 1;
  workout.current = null;
  workout.undo = [];
  saveWorkout();
  render();
  syncPending();
}

// ---------- Rest timer: countdown and keep the screen on (no sound, by owner's choice) ----------

let timerInterval = null;
let wakeLock = null;

// True while a rest countdown is shown (from choosing the rest until the next set's reps are entered).
function resting() {
  const cur = workout && workout.current;
  return Boolean(cur && cur.timerEnd != null && (cur.step === 'load' || cur.step === 'reps'));
}

async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not supported or refused */ }
}

function tick() {
  const cur = workout && workout.current;
  const el = document.getElementById('countdown');
  if (!resting() || !el) return;
  const left = Math.max(0, Math.ceil((cur.timerEnd - Date.now()) / 1000));
  el.textContent = left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Rest over';
  if (left === 0) document.getElementById('timer').classList.add('done');
}

function manageTimer() {
  const timing = resting();
  if (timing && !timerInterval) timerInterval = setInterval(tick, 250);
  if (!timing && timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  keepAwake(timing);
  if (timing) tick();
}

// ---------- Rendering ----------

function renderStatus() {
  const el = document.getElementById('status');
  if (!el) return;
  const unsaved = pending.length;
  let text;
  let cls = ui.status;
  if (ui.status === 'error') text = `⚠ ${ui.statusMsg}${unsaved ? ` ${unsaved} unsaved, tap to retry.` : ' Tap to retry.'}`;
  else if (ui.status === 'saving') text = 'Saving to GitHub…';
  else if (ui.status === 'loading') text = 'Loading…';
  else if (unsaved) { text = `${unsaved} unsaved, tap to retry.`; cls = 'error'; }
  else text = configured() ? '✓ All saved' : 'Not set up';
  el.className = `status ${cls}`;
  el.textContent = text;
}

function render() {
  const screen = !configured() || ui.settingsOpen ? settingsScreen()
    : !workout ? homeScreen()
    : workout.current ? exerciseScreen() : chooseExerciseScreen();
  document.getElementById('app').replaceChildren(screen);
  renderStatus();
  manageTimer();
  window.scrollTo(0, 0);
}

// Re-render after background data changes, unless the user is typing.
function softRender() {
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) renderStatus();
  else render();
}

document.getElementById('status').addEventListener('click', () => {
  if (pending.length) syncPending(); else refreshData();
});
window.addEventListener('online', () => syncPending());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  manageTimer();
  syncPending();
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

render();
refreshData();
