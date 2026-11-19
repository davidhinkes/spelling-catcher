'use strict';
const $ = (id) => document.getElementById(id);
let tab = 'corrections';
let state = {};
let currentHost = null;

const topFix = (c) => Object.entries(c.fixes).sort((a, b) => b[1] - a[1])[0][0];
const sorted = (obj) => Object.entries(obj).sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
const esc = (s) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function render() {
  const corrections = state.corrections || {};
  const flagged = state.flagged || {};
  $('n-corrections').textContent = Object.keys(corrections).length || '';
  $('n-flagged').textContent = Object.keys(flagged).length || '';
  $('tab-corrections').classList.toggle('on', tab === 'corrections');
  $('tab-flagged').classList.toggle('on', tab === 'flagged');
  $('paused').checked = !!state.paused;
  const excluded = (state.excludedSites || []).includes(currentHost);
  $('site').textContent = excluded ? 'Track this site again' : 'Ignore this site';
  $('site').disabled = !currentHost;

  let html;
  if (tab === 'corrections') {
    const rows = sorted(corrections);
    html = rows.length ? `<table><tr><th>Typed</th><th>Fixed to</th><th class="n">Times</th><th>Last</th></tr>` +
      rows.map(([w, c]) => `<tr><td class="wrong">${esc(w)}</td><td>${esc(topFix(c))}</td><td class="n">${c.count}</td><td class="muted">${c.last}</td></tr>`).join('') +
      `</table>` : `<div class="empty">No corrections caught yet.<br>Misspell something, then fix it.</div>`;
  } else {
    const rows = sorted(flagged);
    html = rows.length ? `<table><tr><th>Word</th><th class="n">Times</th><th></th></tr>` +
      rows.map(([w, f]) => `<tr><td class="wrong">${esc(w)}</td><td class="n">${f.count}</td><td><button class="x" data-ignore="${esc(w)}">not a typo</button></td></tr>`).join('') +
      `</table>` : `<div class="empty">Nothing flagged.</div>`;
  }
  $('list').innerHTML = html;
}

async function load() {
  state = await chrome.storage.local.get(['corrections', 'flagged', 'paused', 'excludedSites']);
  render();
}

function markdown() {
  const rows = sorted(state.corrections || {});
  const lines = ['| Misspelling | Correct | Count | Last seen |', '|---|---|---|---|'];
  for (const [w, c] of rows) lines.push(`| ${w} | ${topFix(c)} | ${c.count} | ${c.last} |`);
  const flagged = sorted(state.flagged || {});
  if (flagged.length) {
    lines.push('', '**Flagged, never corrected:** ' + flagged.map(([w, f]) => `${w} (${f.count})`).join(', '));
  }
  return lines.join('\n');
}

$('tab-corrections').onclick = () => { tab = 'corrections'; render(); };
$('tab-flagged').onclick = () => { tab = 'flagged'; render(); };
$('paused').onchange = (e) => chrome.storage.local.set({ paused: e.target.checked });

$('site').onclick = async () => {
  const list = new Set(state.excludedSites || []);
  list.has(currentHost) ? list.delete(currentHost) : list.add(currentHost);
  await chrome.storage.local.set({ excludedSites: [...list] });
};

$('md').onclick = async () => {
  await navigator.clipboard.writeText(markdown());
  $('md').textContent = 'Copied ✓';
  setTimeout(() => { $('md').textContent = 'Copy as Markdown'; }, 1500);
};

$('json').onclick = async () => {
  const data = await chrome.storage.local.get(null);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `spelling-catcher-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
};

$('clear').onclick = async () => {
  if (!confirm('Clear all tracked misspellings? Settings and ignored words are kept.')) return;
  await chrome.storage.local.remove(['corrections', 'flagged']);
};

$('list').onclick = async (e) => {
  const w = e.target.dataset && e.target.dataset.ignore;
  if (!w) return;
  const { ignore = [], flagged = {} } = await chrome.storage.local.get(['ignore', 'flagged']);
  delete flagged[w];
  await chrome.storage.local.set({ ignore: [...new Set([...ignore, w])], flagged });
};

chrome.storage.onChanged.addListener(load);
chrome.tabs.query({ active: true, currentWindow: true }, ([t]) => {
  try { currentHost = t && t.url ? new URL(t.url).hostname || null : null; } catch (_) {}
  render();
});
load();
