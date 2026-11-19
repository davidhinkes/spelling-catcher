// Watches editable fields, snapshots their text, and ships word events to the
// background worker. No dictionary here — judging happens in background.js.
(() => {
  'use strict';
  const { FieldTracker } = globalThis.SpellCore;
  const DEBOUNCE_MS = 350;
  const FLUSH_MS = 2000;
  const MAX_TEXT = 50000;
  const TEXT_INPUT_TYPES = new Set(['text', 'search', '']);

  let enabled = true;
  const host = location.hostname;

  function applySettings(s) {
    enabled = !s.paused && !(s.excludedSites || []).includes(host);
  }
  chrome.storage.local.get(['paused', 'excludedSites'], applySettings);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('paused' in changes || 'excludedSites' in changes)) return;
    chrome.storage.local.get(['paused', 'excludedSites'], applySettings);
  });

  // Find the field an event belongs to: a textarea, a plain text input, or
  // the outermost contenteditable host.
  function fieldFor(node) {
    if (!(node instanceof Element)) node = node && node.parentElement;
    if (!node) return null;
    if (node instanceof HTMLTextAreaElement) return node;
    if (node instanceof HTMLInputElement) {
      return TEXT_INPUT_TYPES.has(node.type) ? node : null;
    }
    if (!node.isContentEditable) return null;
    while (node.parentElement && node.parentElement.isContentEditable) node = node.parentElement;
    return node;
  }

  function readField(el, finishing) {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      return { text: el.value, caret: finishing ? -1 : (el.selectionEnd ?? el.value.length) };
    }
    const all = document.createRange();
    all.selectNodeContents(el);
    const text = all.toString();
    let caret = -1;
    const sel = el.ownerDocument.getSelection();
    if (!finishing && sel && sel.rangeCount && el.contains(sel.focusNode)) {
      const r = document.createRange();
      r.setStart(el, 0);
      r.setEnd(sel.focusNode, sel.focusOffset);
      caret = r.toString().length;
    }
    return { text, caret };
  }

  const trackers = new WeakMap();
  const timers = new WeakMap();
  let queue = [];

  function snap(el, finishing) {
    clearTimeout(timers.get(el));
    timers.delete(el);
    const { text, caret } = readField(el, finishing);
    if (text.length > MAX_TEXT) return;
    let t = trackers.get(el);
    if (!t) { t = new FieldTracker(); trackers.set(el, t); }
    for (const ev of t.snapshot(text, caret)) queue.push(ev);
  }

  function flush() {
    if (!queue.length) return;
    const events = queue;
    queue = [];
    try {
      chrome.runtime.sendMessage({ kind: 'events', host, events }).catch(() => {});
    } catch (_) {
      // Extension was reloaded; this content script is orphaned.
    }
  }
  setInterval(flush, FLUSH_MS);
  addEventListener('pagehide', flush);

  // Seed a tracker when a field gains focus, so pre-existing text is a baseline.
  addEventListener('focusin', (e) => {
    const el = fieldFor(e.composedPath()[0]);
    if (enabled && el && !trackers.has(el)) snap(el, false);
  }, true);

  addEventListener('input', (e) => {
    if (!enabled || e.isComposing) return;
    const el = fieldFor(e.composedPath()[0]);
    if (!el) return;
    if (!trackers.has(el)) snap(el, false);
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(() => snap(el, false), DEBOUNCE_MS));
  }, true);

  // Chat boxes clear on Enter, so capture the final word before that happens.
  addEventListener('keydown', (e) => {
    if (!enabled || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const el = fieldFor(e.composedPath()[0]);
    if (el && trackers.has(el)) { snap(el, true); flush(); }
  }, true);

  addEventListener('focusout', (e) => {
    if (!enabled) return;
    const el = fieldFor(e.composedPath()[0]);
    if (el && trackers.has(el)) snap(el, true);
  }, true);
})();
