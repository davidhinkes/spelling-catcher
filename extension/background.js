// Judges word events against the dictionary, keeps running totals in
// chrome.storage.local, and queues confirmed corrections for Google Sheets.
// Only correction pairs (typed -> fixed) ever leave the machine.
importScripts('core.js', 'sync.js');
const { makeChecker } = self.SpellCore;
const { makeSync, toRow } = self.SpellSync;

let checkerPromise = null;
function getChecker() {
  if (!checkerPromise) {
    checkerPromise = (async () => {
      const res = await fetch(chrome.runtime.getURL('words.txt'));
      const words = new Set((await res.text()).split('\n'));
      const { ignore = [] } = await chrome.storage.local.get('ignore');
      return makeChecker(words, new Set(ignore.map(w => w.toLowerCase())));
    })();
  }
  return checkerPromise;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ignore) checkerPromise = null;
});

// Serialize read-modify-write cycles on storage.
let chain = Promise.resolve();
function update(fn) {
  chain = chain.then(async () => {
    const data = await chrome.storage.local.get(['corrections', 'flagged', 'outbox']);
    data.corrections = data.corrections || {};
    data.flagged = data.flagged || {};
    data.outbox = data.outbox || [];
    if (fn(data) !== false) await chrome.storage.local.set(data);
  }).catch(err => console.error('spelling-catcher', err));
  return chain;
}

async function handle(host, events) {
  const checker = await getChecker();
  const today = new Date().toISOString().slice(0, 10);
  const hits = [];
  for (const ev of events) {
    if (ev.type === 'replace' && checker.isCorrection(ev.from, ev.to)) {
      hits.push({ kind: 'correction', wrong: ev.from.toLowerCase(), right: ev.to.toLowerCase() });
    } else if (ev.type === 'typed' && checker.isTypo(ev.word)) {
      hits.push({ kind: 'flag', word: ev.word.toLowerCase() });
    }
  }
  if (!hits.length) return false;
  let queued = false;
  await update((data) => {
    for (const h of hits) {
      if (h.kind === 'correction') {
        const c = data.corrections[h.wrong] ||= { count: 0, fixes: {}, sites: {}, first: today };
        c.count++;
        c.fixes[h.right] = (c.fixes[h.right] || 0) + 1;
        c.sites[host] = (c.sites[host] || 0) + 1; // local only, for the popup
        c.last = today;
        data.outbox.push(toRow(h.wrong, h.right));
        queued = true;
        const f = data.flagged[h.wrong];
        if (f && --f.count <= 0) delete data.flagged[h.wrong];
      } else {
        // Flagged-but-unfixed words stay on this machine: they could be names,
        // jargon, or a letters-only secret typed into a plain field.
        const f = data.flagged[h.word] ||= { count: 0, first: today };
        f.count++;
        f.last = today;
      }
    }
  });
  return queued;
}

// ---- Google Sheets sync ----
const clientId = (chrome.runtime.getManifest().oauth2 || {}).client_id || '';
const sheets = makeSync({
  configured: !!clientId && !clientId.startsWith('PASTE_'),
  get: (keys) => chrome.storage.local.get(keys),
  set: (obj) => chrome.storage.local.set(obj),
  mutate: (fn) => update(fn),
  fetch: (...a) => fetch(...a),
  getToken: async (interactive) => (await chrome.identity.getAuthToken({ interactive })).token,
  dropToken: (token) => chrome.identity.removeCachedAuthToken({ token }),
});

let soon = null;
function syncSoon() {
  clearTimeout(soon);
  soon = setTimeout(() => sheets.sync(), 15000);
}
chrome.alarms.create('sync', { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'sync') sheets.sync(); });
chrome.runtime.onStartup.addListener(() => sheets.sync());

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return;
  if (msg.kind === 'events' && Array.isArray(msg.events)) {
    handle(msg.host || 'unknown', msg.events).then((queued) => { if (queued) syncSoon(); });
  } else if (msg.kind === 'connect') {
    sheets.sync({ interactive: true, force: true }).then(() => reply(true));
    return true;
  } else if (msg.kind === 'disconnect') {
    sheets.signOut().then(() => reply(true));
    return true;
  }
});
