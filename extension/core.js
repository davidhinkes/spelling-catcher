// Pure logic shared by the content script and the Node tests.
// No DOM, no chrome.* — just text snapshots in, edit events out.
(function (root) {
  'use strict';

  const WORD_RE = /[\p{L}]+(?:['’][\p{L}]+)*/gu;
  const CODEISH = /[\p{N}_@\/\\#$%^&*=<>|~`]/u;

  // Split text into word tokens with offsets. Tokens glued to code-ish
  // characters (paths, emails, identifiers, URLs, numbers) are marked skip.
  function tokenize(text) {
    const out = [];
    for (const m of text.matchAll(WORD_RE)) {
      const s = m.index, e = s + m[0].length;
      const before = text[s - 1] || ' ', before2 = text[s - 2] || ' ';
      const after = text[e] || ' ', after2 = text[e + 1] || ' ';
      const skip =
        CODEISH.test(before) || CODEISH.test(after) ||
        (before === '.' && /\p{L}/u.test(before2)) ||
        (after === '.' && /\p{L}/u.test(after2)) ||
        (after === ':' && after2 === '/');
      out.push({ w: m[0].replace(/’/g, "'"), s, e, skip });
    }
    return out;
  }

  // A word is "complete" once the caret is no longer touching it.
  function complete(tok, caret) {
    return caret < tok.s || caret > tok.e;
  }

  const ERASE_WINDOW_MS = 15000;

  // Tracks one editable field. Feed it (text, caret) snapshots; it returns
  // events: {type:'typed', word} for newly finished words and
  // {type:'replace', from, to} when a finished word was edited into another.
  class FieldTracker {
    constructor(now = () => Date.now()) {
      this.tokens = null;
      this.caret = 0;
      this.erased = null; // {orig, at, t} — a word backspaced away, maybe being retyped
      this.now = now;
    }

    // caret: offset of the cursor, or -1 when the field lost focus / is being submitted.
    snapshot(text, caret) {
      const toks = tokenize(text);
      const old = this.tokens;
      this.tokens = toks;
      this.caret = caret;
      if (!old) {
        // First sight of this field: pre-existing text isn't ours to judge.
        return [];
      }

      let i = 0;
      while (i < old.length && i < toks.length && old[i].w === toks[i].w) {
        toks[i].orig = old[i].orig; toks[i].seen = old[i].seen;
        i++;
      }
      let oj = old.length - 1, nj = toks.length - 1;
      while (oj >= i && nj >= i && old[oj].w === toks[nj].w) {
        toks[nj].orig = old[oj].orig; toks[nj].seen = old[oj].seen;
        oj--; nj--;
      }
      const oldM = old.slice(i, oj + 1);
      const newM = toks.slice(i, nj + 1);
      const events = [];

      // Tokens that were already in the field and unchanged but have only now
      // become complete (caret moved away, or field submitted).
      for (const t of toks) {
        if (!t.seen && !t.skip && complete(t, caret) && !newM.includes(t)) {
          if (t.orig) {
            if (t.orig !== t.w) events.push({ type: 'replace', from: t.orig, to: t.w });
            t.orig = undefined;
          } else {
            events.push({ type: 'typed', word: t.w });
          }
          t.seen = true;
        }
      }

      if (oldM.length === 0 && newM.length === 0) return events;

      // A word's origin is what it was when first finished; words never
      // finished (still being typed) have no origin.
      const originOf = (o) => o.orig || (o.seen ? o.w : null);

      // A word was erased entirely — remember it in case it's being retyped.
      if (newM.length === 0) {
        if (oldM.length === 1 && originOf(oldM[0]) && !oldM[0].skip) {
          this.erased = { orig: originOf(oldM[0]), at: i, t: this.now() };
        }
        return events;
      }

      // A word appeared where one was recently erased: it inherits the origin.
      if (oldM.length === 0 && newM.length === 1 && this.erased &&
          this.erased.at === i && this.now() - this.erased.t < ERASE_WINDOW_MS) {
        oldM.push({ w: '', orig: this.erased.orig, s: -1, e: -1 });
      }
      this.erased = null;

      const finish = (n, origin) => {
        if (n.skip) { n.seen = true; return; }
        if (complete(n, caret)) {
          n.seen = true;
          if (origin) {
            if (origin !== n.w) events.push({ type: 'replace', from: origin, to: n.w });
          } else {
            events.push({ type: 'typed', word: n.w });
          }
        } else if (origin) {
          n.orig = origin; // still being edited — carry the original forward
        }
      };

      if (oldM.length === newM.length && oldM.length <= 3) {
        oldM.forEach((o, k) => finish(newM[k], originOf(o)));
      } else if (oldM.length === 1 && newM.length === 2 && originOf(oldM[0]) &&
                 newM.every(n => complete(n, caret))) {
        // Split: "alot" -> "a lot"
        newM.forEach(n => { n.seen = true; });
        events.push({ type: 'replace', from: originOf(oldM[0]), to: newM.map(n => n.w).join(' ') });
      } else if (newM.length - oldM.length <= 3) {
        // Ordinary typing of a few new words (a big jump is a paste — ignore it).
        const firstOld = oldM[0];
        newM.forEach((n, k) => finish(n, k === 0 && firstOld ? originOf(firstOld) : null));
      } else {
        newM.forEach(n => { n.seen = true; });
      }
      return events;
    }
  }

  // Damerau-Levenshtein (optimal string alignment) distance.
  function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[a.length][b.length];
  }

  // Dictionary judgement, used by the background worker.
  function makeChecker(words, ignore = new Set()) {
    function isWord(w) {
      if (ignore.has(w.toLowerCase())) return true;
      if (words.has(w) || words.has(w.toLowerCase())) return true;
      const cap = w[0] + w.slice(1).toLowerCase();
      return words.has(cap);
    }
    // Words we shouldn't judge at all: short, acronyms, camelCase.
    function judgeable(w) {
      if (w.length < 3) return false;
      if (w === w.toUpperCase() && w.length <= 6) return false;
      if (/\p{Ll}\p{Lu}/u.test(w)) return false;
      return true;
    }
    function isTypo(word) {
      return judgeable(word) && !isWord(word);
    }
    function isCorrection(from, to) {
      const fromWords = from.split(' '), toWords = to.split(' ');
      if (!fromWords.some(isTypo)) return false;
      if (!toWords.every(w => isWord(w) || !judgeable(w))) return false;
      const a = from.toLowerCase().replace(/ /g, ''), b = to.toLowerCase().replace(/ /g, '');
      if (a === b && from.toLowerCase() === to.toLowerCase()) return false;
      return editDistance(a, b) <= Math.max(2, Math.ceil(a.length / 3));
    }
    return { isWord, isTypo, isCorrection, judgeable };
  }

  const api = { tokenize, FieldTracker, editDistance, makeChecker };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpellCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
