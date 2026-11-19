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
  // Fields that are, or ever were, password fields — catches "show password"
  // toggles that flip type=password to type=text.
  const everSecret = new WeakSet();
  const SECRET_HINT = /pass|pwd|pin\b|otp|one-time|2fa|mfa|totp|verif|security|secret|token|api.?key|cvv|cvc|card.?num|cc-(num|csc)|ssn|account.?num|routing/i;

  function looksSecret(el) {
    if (everSecret.has(el)) return true;
    if (el instanceof HTMLInputElement && el.type === 'password') { everSecret.add(el); return true; }
    const hints = [
      el.getAttribute('autocomplete'), el.name, el.id, el.getAttribute('aria-label'),
      el.getAttribute('placeholder'), el.getAttribute('data-testid'),
    ].filter(Boolean).join(' ');
    if (hints && SECRET_HINT.test(hints)) { everSecret.add(el); return true; }
    return false;
  }

  // Remember password inputs as soon as they exist, before any toggle.
  function scanForPasswords(root) {
    for (const el of root.querySelectorAll('input[type=password]')) everSecret.add(el);
  }
  scanForPasswords(document);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes' && m.target instanceof HTMLInputElement && m.oldValue === 'password') {
        everSecret.add(m.target);
      }
      for (const n of m.addedNodes || []) if (n instanceof Element) {
        if (n instanceof HTMLInputElement && n.type === 'password') everSecret.add(n);
        else scanForPasswords(n);
      }
    }
  }).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['type'], attributeOldValue: true,
  });

  function fieldFor(node) {
    if (!(node instanceof Element)) node = node && node.parentElement;
    if (!node) return null;
    if (node instanceof HTMLTextAreaElement) return looksSecret(node) ? null : node;
    if (node instanceof HTMLInputElement) {
      if (looksSecret(node)) return null;
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
    // Only edits to finished words leave this page; typed words are dropped here.
    for (const ev of t.snapshot(text, caret)) if (ev.type === 'replace') queue.push(ev);
  }

  function flush() {
    if (!queue.length) return;
    const events = queue;
    queue = [];
    try {
      chrome.runtime.sendMessage({ kind: 'events', events }).catch(() => {});
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
