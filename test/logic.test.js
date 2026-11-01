// Run: node --test   (Node's built-in test runner, no packages)
// Uses made-up data only: this repository is public, never put real log data here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../logic.js';

const LOG = `date,order,exercise,sets,note
2026-01-02,1,Leg press,80x20/60 100x20/60 100x20,Depth 6
2026-01-02,2,Lat pulldown,40x10/60 50x10/60 50x10,
2026-01-02,3,"Curl, machine",20x15/30 25x15,"Pad 4, back 2"
2026-01-05,1,Leg press,80x20/60 100x20/60 100x20,Depth 6
2026-01-05,2,Lat pulldown,40x10/60 50x10/60 50x11,
2026-01-05,3,"Curl, machine",20x15/30 25x15,"Pad 4, back 2"
2026-01-09,1,Leg press,80x20/60 105x18/60 105x20,Depth 6
2026-01-09,2,Pull-up,bwx6/120 bwx5,
`;
const rows = L.parseLog(LOG);

test('CSV round trip keeps quoting compatible with Python csv', () => {
  const lines = LOG.trim().split('\n').slice(1);
  assert.deepEqual(rows.map(L.rowToLine), lines);
  assert.equal(L.csvLine(['a"b', 'c,d', 'e']), '"a""b","c,d",e');
});

test('parseSets and formatSets', () => {
  assert.deepEqual(L.parseSets('bwx6/120 52.5x10 junk'), [
    { load: 'bw', reps: 6, rest: 120 }, { load: '52.5', reps: 10, rest: null }]);
  assert.equal(L.formatSets(L.parseSets('77x20/60 101x20')), '77x20/60 101x20');
});

test('normLoad accepts decimal comma and rejects junk', () => {
  assert.equal(L.normLoad('52,5'), '52.5');
  assert.equal(L.normLoad('BW'), 'bw');
  assert.equal(L.normLoad('60.0'), '60');
  for (const bad of ['', '-5', '1e3', '5kg', '2000', 'x']) assert.equal(L.normLoad(bad), null, bad);
});

test('validateRow rejects unsafe or malformed rows', () => {
  const ok = { date: '2026-02-01', order: 1, exercise: 'Leg press', sets: [{ load: '80', reps: 20, rest: null }], note: '' };
  assert.deepEqual(L.validateRow(ok), []);
  assert.ok(L.validateRow({ ...ok, date: '2026-02-30' }).includes('date'));
  assert.ok(L.validateRow({ ...ok, exercise: 'a\nb' }).includes('exercise'));
  assert.ok(L.validateRow({ ...ok, note: 'x\ny' }).includes('note'));
  assert.ok(L.validateRow({ ...ok, sets: [{ load: '80kg', reps: 1, rest: null }] }).includes('load'));
  assert.ok(L.validateRow({ ...ok, order: 0 }).includes('order'));
});

test('cleanText strips control characters and newlines', () => {
  assert.equal(L.cleanText('  Depth\n6\t ok\u0007 ', 300), 'Depth 6 ok');
  assert.equal(L.cleanText('abcdef', 3), 'abc');
});

test('appendLines adds header to new files and skips duplicates', () => {
  const fresh = L.appendLines('', ['x']);
  assert.equal(fresh.text, 'date,order,exercise,sets,note\nx\n');
  const again = L.appendLines(fresh.text, ['x', 'y', 'y']);
  assert.equal(again.added, 1);
  assert.equal(again.text, 'date,order,exercise,sets,note\nx\ny\n');
  assert.equal(L.appendLines('h\r\na', ['b']).text, 'h\na\nb\n');
});

test('next exercise follows the usual order', () => {
  assert.equal(L.rankNextExercises(rows, '2026-01-12', [])[0], 'Leg press');
  assert.equal(L.rankNextExercises(rows, '2026-01-12', ['Leg press'])[0], 'Lat pulldown'); // 2 of 3 workouts
  const r = L.rankNextExercises(rows, '2026-01-12', ['Leg press', 'Lat pulldown']);
  assert.ok(!r.includes('Leg press') && !r.includes('Lat pulldown'));
  assert.equal(r[0], 'Curl, machine');
});

test('weight, reps and rest suggestions come from the same set last time', () => {
  const last = L.lastTime(rows, 'Leg press', '2026-01-12');
  assert.equal(last.date, '2026-01-09');
  assert.equal(L.suggestLoad(last, []), '80');
  assert.equal(L.suggestLoad(last, [{}, {}, {}, {}]), '105'); // more sets than last time
  assert.equal(L.suggestReps(last, [{}]), 18);
  assert.equal(L.suggestRest(last, [{}]), 60);
  assert.equal(L.suggestRest(last, [{}, {}, {}]), 'finish');
  assert.equal(L.suggestLoad(null, []), null);
  assert.equal(L.suggestRest(null, [{ rest: 90 }, {}]), 90);
});

test('load options use loads seen before and include bodyweight when relevant', () => {
  const opts = L.loadOptions(rows, 'Leg press', '100');
  assert.ok(opts.includes('80') && opts.includes('105') && !opts.includes('100'));
  assert.deepEqual(L.loadOptions(rows, 'Pull-up', 'bw'), []);
  assert.ok(L.loadOptions([], 'New', '40').includes('45'));
});

test('rest options never repeat the recommended choice', () => {
  assert.ok(!L.restOptions(60).includes(60));
  assert.ok(L.restOptions('finish').includes(60) && !L.restOptions('finish').includes('finish'));
  assert.ok(L.restOptions(75).includes(60));
});

test('base64 UTF-8 round trip (Finnish characters)', () => {
  const s = 'Jalkaprässi, syvyys 6 – ok';
  assert.equal(L.b64decodeUtf8(L.b64encodeUtf8(s)), s);
});

test('exercisesByRecency orders by last done, then alphabetically', () => {
  assert.deepEqual(L.exercisesByRecency(rows, ['Zottman curl', 'Abs']).slice(0, 2), ['Leg press', 'Pull-up']);
  assert.deepEqual(L.exercisesByRecency(rows, ['Zottman curl', 'Abs']).slice(-2), ['Abs', 'Zottman curl']);
});
