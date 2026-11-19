// Judges edit events against the dictionary. The only thing ever retained is a
// correction the user made themselves: a misspelled word they changed into a
// real one (typed -> fixed). Totals live in chrome.storage.local and the same
// pairs are queued for Google Sheets. Nothing else is stored or sent.
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
    const data = await chrome.storage.local.get(['corrections', 'outbox']);
    data.corrections = data.corrections || {};
    data.outbox = data.outbox || [];
    if (fn(data) !== false) await chrome.storage.local.set(data);
  }).catch(err => console.error('spelling-catcher', err));
  return chain;
}

async function handle(events) {
  const checker = await getChecker();
  const today = new Date().toISOString().slice(0, 10);
  const hits = events
    .filter(ev => ev.type === 'replace' && checker.isCorrection(ev.from, ev.to))
    .map(ev => ({ wrong: ev.from.toLowerCase(), right: ev.to.toLowerCase() }));
  if (!hits.length) return false;
  await update((data) => {
    for (const h of hits) {
      const c = data.corrections[h.wrong] ||= { count: 0, fixes: {}, first: today };
      c.count++;
      c.fixes[h.right] = (c.fixes[h.right] || 0) + 1;
      c.last = today;
      data.outbox.push(toRow(h.wrong, h.right));
    }
  });
  return true;
}

// Drop data kept by earlier versions (unfixed-word list, per-site counts).
chrome.runtime.onInstalled.addListener(() => update((data) => {
  chrome.storage.local.remove(['flagged', 'ignore']);
  for (const c of Object.values(data.corrections)) delete c.sites;
}));

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
    handle(msg.events).then((queued) => { if (queued) syncSoon(); });
  } else if (msg.kind === 'connect') {
    sheets.sync({ interactive: true, force: true }).then(() => reply(true));
    return true;
  } else if (msg.kind === 'disconnect') {
    sheets.signOut().then(() => reply(true));
    return true;
  }
});
