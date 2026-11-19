// Judges word events against the dictionary and keeps running totals in
// chrome.storage.local. Nothing leaves the machine.
importScripts('core.js');
const { makeChecker } = self.SpellCore;

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
    const data = await chrome.storage.local.get(['corrections', 'flagged']);
    data.corrections = data.corrections || {};
    data.flagged = data.flagged || {};
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
  if (!hits.length) return;
  await update((data) => {
    for (const h of hits) {
      if (h.kind === 'correction') {
        const c = data.corrections[h.wrong] ||= { count: 0, fixes: {}, sites: {}, first: today };
        c.count++;
        c.fixes[h.right] = (c.fixes[h.right] || 0) + 1;
        c.sites[host] = (c.sites[host] || 0) + 1;
        c.last = today;
        // It was flagged when first typed; now it's a confirmed correction.
        const f = data.flagged[h.wrong];
        if (f && --f.count <= 0) delete data.flagged[h.wrong];
      } else {
        const f = data.flagged[h.word] ||= { count: 0, first: today };
        f.count++;
        f.last = today;
      }
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.kind === 'events' && Array.isArray(msg.events)) {
    handle(msg.host || 'unknown', msg.events);
  }
});
