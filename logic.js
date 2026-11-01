// Pure functions: CSV handling, the log format, validation and suggestions.
// No DOM and no network here, so everything can be unit-tested with `node --test`.

export const HEADER = ['date', 'order', 'exercise', 'sets', 'note'];
export const REST_CHOICES = [30, 45, 60, 90, 120, 180];

// ---------- CSV (RFC 4180 subset, same quoting as Python's csv module) ----------

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function csvField(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export const csvLine = (fields) => fields.map(csvField).join(',');

// ---------- Sets: "77x20/60 101x20/60 101x20" ----------

const SET_RE = /^(bw|\d+(?:\.\d+)?)x(\d+)(?:\/(\d+))?$/;

export function parseSets(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).map((token) => {
    const m = SET_RE.exec(token);
    return m ? { load: m[1], reps: Number(m[2]), rest: m[3] === undefined ? null : Number(m[3]) } : null;
  }).filter(Boolean);
}

export const formatSets = (sets) =>
  sets.map((s) => `${s.load}x${s.reps}` + (s.rest != null ? `/${s.rest}` : '')).join(' ');

// "bw", or a number with at most two decimals. Accepts a comma as decimal separator.
export function normLoad(input) {
  const s = String(input).trim().toLowerCase().replace(',', '.');
  if (s === 'bw') return 'bw';
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(Number(s) * 100) / 100;
  return n <= 1000 ? String(n) : null;
}

export function normInt(input, max) {
  const s = String(input).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n <= max ? n : null;
}

// ---------- Log rows ----------

export function parseLog(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  if (HEADER.some((k, i) => rows[0][i] !== k)) throw new Error('Unexpected log file header');
  return rows.slice(1).filter((r) => r.length >= 3 && r[0]).map((r) => ({
    date: r[0],
    order: Number.parseInt(r[1], 10) || 0,
    exercise: r[2],
    sets: parseSets(r[3] || ''),
    note: r[4] || '',
  }));
}

export const rowToLine = (r) => csvLine([r.date, r.order, r.exercise, formatSets(r.sets), r.note]);

export function parseExerciseNames(text) {
  return parseCsv(text).slice(1).map((r) => (r[0] || '').trim()).filter(Boolean);
}

// Single-line free text: no control characters, trimmed, length-limited.
export function cleanText(input, max) {
  return String(input).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// Returns a list of problems; empty means the row is safe to write.
export function validateRow(r) {
  const errors = [];
  if (!isValidDate(r.date)) errors.push('date');
  if (!Number.isInteger(r.order) || r.order < 1 || r.order > 99) errors.push('order');
  if (typeof r.exercise !== 'string' || r.exercise !== cleanText(r.exercise, 80) || !r.exercise) errors.push('exercise');
  if (!Array.isArray(r.sets) || r.sets.length > 30) errors.push('sets');
  else {
    for (const s of r.sets) {
      if (normLoad(s.load) !== s.load) errors.push('load');
      if (!Number.isInteger(s.reps) || s.reps < 0 || s.reps > 999) errors.push('reps');
      if (s.rest !== null && (!Number.isInteger(s.rest) || s.rest < 0 || s.rest > 3600)) errors.push('rest');
    }
  }
  if (typeof r.note !== 'string' || r.note !== cleanText(r.note, 300)) errors.push('note');
  return errors;
}

export function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    const key = rowToLine(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Append lines to a log file's text, skipping lines that are already present.
// Skipping makes a retried save harmless if an earlier attempt actually succeeded.
export function appendLines(text, lines) {
  let base = text && text.trim() ? text.replace(/\r\n/g, '\n') : HEADER.join(',') + '\n';
  if (!base.endsWith('\n')) base += '\n';
  const existing = new Set(base.split('\n'));
  const added = [...new Set(lines)].filter((l) => !existing.has(l));
  return { text: base + added.map((l) => l + '\n').join(''), added: added.length };
}

// ---------- History lookups and suggestions ----------

// Workouts before `beforeDate`, newest first, each with its rows in workout order.
export function groupSessions(rows, beforeDate) {
  const byDate = new Map();
  for (const r of rows) {
    if (r.date >= beforeDate) continue;
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, rs]) => ({ date, rows: rs.sort((a, b) => a.order - b.order) }));
}

// Exercises ranked by how likely they come next, given what was already done today.
// Recent workouts weigh more. Each past workout gives points to an exercise for
// (a) appearing in it, (b) being the first one in it not yet done today, and
// (c) directly following, in that workout, the exercise just finished today.
export function rankNextExercises(rows, date, doneToday, lookback = 12) {
  const done = new Set(doneToday);
  const prev = doneToday[doneToday.length - 1];
  const score = new Map();
  const add = (name, pts) => score.set(name, (score.get(name) || 0) + pts);
  groupSessions(rows, date).slice(0, lookback).forEach((s, i) => {
    const w = 0.8 ** i;
    const names = [...new Set(s.rows.map((r) => r.exercise))];
    const remaining = names.filter((n) => !done.has(n));
    remaining.forEach((n) => add(n, w));
    if (remaining.length) add(remaining[0], w);
    const pi = names.indexOf(prev);
    if (pi >= 0) {
      const next = names.slice(pi + 1).find((n) => !done.has(n));
      if (next) add(next, 2 * w);
    }
  });
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

export function lastTime(rows, exercise, beforeDate) {
  let best = null;
  for (const r of rows) {
    if (r.exercise !== exercise || r.date >= beforeDate) continue;
    if (!best || r.date > best.date || (r.date === best.date && r.order > best.order)) best = r;
  }
  return best;
}

// All exercise names: most recently done first, then never-done names alphabetically.
export function exercisesByRecency(rows, extraNames = []) {
  const last = new Map();
  for (const r of rows) if (!last.has(r.exercise) || r.date > last.get(r.exercise)) last.set(r.exercise, r.date);
  const done = [...last.keys()].sort((a, b) => (last.get(a) < last.get(b) ? 1 : last.get(a) > last.get(b) ? -1 : a.localeCompare(b)));
  const rest = [...new Set(extraNames)].filter((n) => !last.has(n)).sort((a, b) => a.localeCompare(b));
  return [...done, ...rest];
}

const setAt = (sets, i) => sets[Math.min(i, sets.length - 1)];

export function suggestLoad(last, todaySets) {
  if (last && last.sets.length) return setAt(last.sets, todaySets.length).load;
  return todaySets.length ? todaySets[todaySets.length - 1].load : null;
}

export function suggestReps(last, todaySets) {
  if (last && last.sets.length) return setAt(last.sets, todaySets.length).reps;
  return todaySets.length ? todaySets[todaySets.length - 1].reps : null;
}

// After a completed set: a rest in seconds, 'none' (next set without timer) or 'finish'.
export function suggestRest(last, todaySets) {
  const i = todaySets.length - 1;
  if (last && last.sets.length) {
    if (i >= last.sets.length - 1) return 'finish';
    return last.sets[i].rest ?? 'none';
  }
  const prev = todaySets[i - 1];
  return prev && prev.rest != null ? prev.rest : 60;
}

// Alternatives around the suggested load: loads used before for this exercise
// (machine stacks have uneven steps), padded with plain steps where history is thin.
export function loadOptions(rows, exercise, suggestion, todaySets = []) {
  const used = new Set();
  let bw = false;
  const note = (load) => (load === 'bw' ? (bw = true) : used.add(Number(load)));
  for (const r of rows) if (r.exercise === exercise) r.sets.forEach((s) => note(s.load));
  todaySets.forEach((s) => note(s.load));
  const nums = [...used].sort((a, b) => a - b);
  let alts;
  if (suggestion == null || suggestion === 'bw') alts = nums.slice(-4);
  else {
    const v = Number(suggestion);
    const step = v >= 20 ? 5 : 2.5;
    const below = nums.filter((x) => x < v).slice(-2);
    const above = nums.filter((x) => x > v).slice(0, 2);
    for (let k = 1; below.length < 2 && v - k * step >= 0; k++) if (!below.includes(v - k * step)) below.unshift(v - k * step);
    for (let k = 1; above.length < 2; k++) if (!above.includes(v + k * step)) above.push(v + k * step);
    alts = [...below.sort((a, b) => a - b).slice(-2), ...above.sort((a, b) => a - b).slice(0, 2)];
  }
  const out = alts.map((n) => normLoad(n)).filter((x) => x !== null && x !== suggestion);
  if (bw && suggestion !== 'bw') out.unshift('bw');
  return [...new Set(out)];
}

export function repOptions(suggestion) {
  if (suggestion == null) return [8, 10, 12, 15, 20];
  const step = suggestion >= 30 ? 5 : 1;
  return [-2, -1, 1, 2].map((k) => suggestion + k * step).filter((n) => n > 0);
}

export function restOptions(recommended) {
  const nums = [...new Set([...REST_CHOICES, ...(typeof recommended === 'number' ? [recommended] : [])])]
    .sort((a, b) => a - b);
  return [...nums, 'none', 'finish'].filter((o) => o !== recommended);
}

// ---------- Text encoding for the GitHub contents API ----------

export function b64encodeUtf8(str) {
  let bin = '';
  for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decodeUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
