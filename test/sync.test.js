// Sheets sync against a fake Google API.
const test = require('node:test');
const assert = require('node:assert');
const { makeSync, toRow } = require('../extension/sync.js');

function harness({ token = 'tok', failFirst = null } = {}) {
  const store = { outbox: [] };
  const calls = [];
  const sheet = { rows: [] };
  let failed = false;
  const deps = {
    configured: true,
    get: async (keys) => Object.fromEntries(keys.map(k => [k, store[k]])),
    set: async (obj) => Object.assign(store, obj),
    mutate: async (fn) => fn(store),
    getToken: async () => { if (!token) throw new Error('not signed in'); return token; },
    dropToken: async () => { calls.push('drop'); },
    fetch: async (url, opts) => {
      calls.push(`${opts.method} ${url.replace('https://sheets.googleapis.com/v4/spreadsheets', '')}`);
      if (failFirst && !failed && url.includes(':append')) {
        failed = true;
        return { ok: false, status: failFirst, text: async () => 'nope' };
      }
      let body = {};
      if (url.endsWith('/spreadsheets')) body = { spreadsheetId: 'S1', spreadsheetUrl: 'https://docs.google.com/S1' };
      if (url.includes(':append')) sheet.rows.push(...JSON.parse(opts.body).values);
      return { ok: true, status: 200, json: async () => body, text: async () => '' };
    },
  };
  return { store, calls, sheet, sync: makeSync(deps) };
}

test('connect creates the sheet once, with no data queued', async () => {
  const h = harness();
  await h.sync.sync({ interactive: true, force: true });
  assert.strictEqual(h.store.sheetId, 'S1');
  assert.strictEqual(h.store.syncStatus.state, 'ok');
  assert.deepStrictEqual(h.calls, ['POST ', 'POST /S1/values:batchUpdate']);
});

test('queued corrections are appended and cleared from the outbox', async () => {
  const h = harness();
  h.store.outbox = [toRow('recieve', 'receive'), toRow('teh', 'the')];
  await h.sync.sync();
  assert.deepStrictEqual(h.sheet.rows.map(r => r.slice(2)), [['recieve', 'receive'], ['teh', 'the']]);
  assert.strictEqual(h.store.outbox.length, 0);
});

test('rows contain only timestamp, date, typed, fixed — nothing else', () => {
  const r = toRow('recieve', 'receive', new Date('2026-11-19T20:00:00Z'));
  assert.deepStrictEqual(r.row, ['2026-11-19T20:00:00.000Z', '2026-11-19', 'recieve', 'receive']);
});

test('signed out: nothing sent, outbox kept, status says so', async () => {
  const h = harness({ token: null });
  h.store.outbox = [toRow('teh', 'the')];
  await h.sync.sync();
  assert.strictEqual(h.store.syncStatus.state, 'signed-out');
  assert.strictEqual(h.store.outbox.length, 1);
  assert.deepStrictEqual(h.calls, []);
});

test('expired token is dropped and retried', async () => {
  const h = harness({ failFirst: 401 });
  h.store.sheetId = 'S1';
  h.store.outbox = [toRow('teh', 'the')];
  await h.sync.sync();
  assert.ok(h.calls.includes('drop'));
  assert.strictEqual(h.sheet.rows.length, 1);
  assert.strictEqual(h.store.syncStatus.state, 'ok');
});

test('deleted sheet is recreated', async () => {
  const h = harness({ failFirst: 404 });
  h.store.sheetId = 'GONE';
  h.store.outbox = [toRow('teh', 'the')];
  await h.sync.sync();
  assert.strictEqual(h.store.sheetId, 'S1');
  assert.strictEqual(h.sheet.rows.length, 1);
});

test('rows added during a sync are not lost', async () => {
  const h = harness();
  h.store.sheetId = 'S1';
  h.store.outbox = [toRow('teh', 'the')];
  const p = h.sync.sync();
  h.store.outbox.push(toRow('alot', 'a lot')); // arrives mid-flight
  await p;
  await h.sync.sync();
  assert.strictEqual(h.sheet.rows.length, 2);
  assert.strictEqual(h.store.outbox.length, 0);
});
