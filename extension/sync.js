// Google Sheets sync. Corrections queue in an outbox in chrome.storage.local and
// are appended to a "Log" tab of a spreadsheet the extension creates in the
// user's Drive (drive.file scope: it can only see files it created).
// Only correction pairs are ever synced — no surrounding text, no sites.
// Dependencies are injected so this runs under Node tests with fakes.
(function (root) {
  'use strict';

  const API = 'https://sheets.googleapis.com/v4/spreadsheets';
  const LOG_HEADER = ['Timestamp', 'Date', 'Typed', 'Fixed to'];
  const REVIEW_HEADER = ['Date', 'Word', 'Result', 'Notes'];
  const BATCH = 500;

  // deps: {
  //   configured: bool, get(keys), set(obj), mutate(fn) /* serialized RMW */,
  //   getToken(interactive) -> token, dropToken(token), fetch
  // }
  function makeSync(deps) {
    async function setStatus(state, message) {
      await deps.set({ syncStatus: { state, message: message || '', at: new Date().toISOString() } });
    }

    async function call(token, url, method, body) {
      const res = await deps.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const err = new Error(`Google Sheets ${res.status}: ${(await res.text()).slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }

    async function createSheet(token) {
      const sheet = await call(token, API, 'POST', {
        properties: { title: 'Spelling Catcher' },
        sheets: [
          { properties: { title: 'Log', gridProperties: { frozenRowCount: 1 } } },
          { properties: { title: 'Summary' } },
          { properties: { title: 'Reviews', gridProperties: { frozenRowCount: 1 } } },
        ],
      });
      const id = sheet.spreadsheetId;
      await call(token, `${API}/${id}/values:batchUpdate`, 'POST', {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: 'Log!A1:D1', values: [LOG_HEADER] },
          { range: 'Reviews!A1:D1', values: [REVIEW_HEADER] },
          {
            range: 'Summary!A1',
            values: [[
              `=QUERY(Log!A:D, "select C, D, count(C), max(B) where C is not null group by C, D ` +
              `order by count(C) desc label C 'Typed', D 'Fixed to', count(C) 'Times', max(B) 'Last seen'", 1)`,
            ]],
          },
        ],
      });
      await deps.set({ sheetId: id, sheetUrl: sheet.spreadsheetUrl });
      return id;
    }

    let running = null;
    // interactive: may show Google's sign-in/consent UI (only from a user click).
    // force: talk to Google even with nothing queued (creates the sheet on connect).
    function sync({ interactive = false, force = false } = {}) {
      if (!running) running = doSync(interactive, force).finally(() => { running = null; });
      return running;
    }

    async function getToken(interactive) {
      try { return await deps.getToken(interactive); } catch (_) { return null; }
    }

    async function doSync(interactive, force) {
      if (!deps.configured) { await setStatus('not-configured'); return; }
      const { outbox = [], sheetId } = await deps.get(['outbox', 'sheetId']);
      if (!outbox.length && !force && sheetId) return;

      let token = await getToken(interactive);
      if (!token) { await setStatus('signed-out'); return; }

      let retried401 = false, recreated = false;
      for (let rounds = 0; rounds < 50; rounds++) {
        try {
          let { sheetId, outbox = [] } = await deps.get(['sheetId', 'outbox']);
          if (!sheetId) sheetId = await createSheet(token);
          if (!outbox.length) break;
          const batch = outbox.slice(0, BATCH);
          await call(token,
            `${API}/${sheetId}/values/${encodeURIComponent('Log!A:D')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
            'POST', { values: batch.map(r => r.row) });
          const sent = new Set(batch.map(r => r.id));
          await deps.mutate((data) => { data.outbox = (data.outbox || []).filter(r => !sent.has(r.id)); });
        } catch (e) {
          if (e.status === 401 && !retried401) {
            retried401 = true;
            await deps.dropToken(token);
            token = await getToken(false);
            if (!token) { await setStatus('signed-out'); return; }
            continue;
          }
          if ((e.status === 404 || e.status === 403) && !recreated) {
            // Sheet deleted, or no longer reachable — start a fresh one.
            recreated = true;
            await deps.set({ sheetId: null, sheetUrl: null });
            continue;
          }
          await setStatus('error', e.message);
          return;
        }
      }
      await setStatus('ok');
    }

    async function signOut() {
      const token = await getToken(false);
      if (token) {
        await deps.dropToken(token);
        try { await deps.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }); } catch (_) {}
      }
      await setStatus('signed-out');
    }

    return { sync, signOut };
  }

  let seq = 0;
  function toRow(typed, fixed, when = new Date()) {
    const iso = when.toISOString();
    return {
      id: `${when.getTime()}-${seq++}-${Math.random().toString(36).slice(2, 7)}`,
      row: [iso, iso.slice(0, 10), typed, fixed],
    };
  }

  const api = { makeSync, toRow, LOG_HEADER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpellSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
