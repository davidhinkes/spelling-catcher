// Expand a Hunspell .dic/.aff pair into a flat, sorted word list.
// Usage: node expand-dict.js en_US.aff en_US.dic > words.txt
const fs = require('fs');
const [affPath, dicPath] = process.argv.slice(2);

const aff = fs.readFileSync(affPath, 'utf8').split('\n');
const rules = {}; // flag -> {type, cross, entries:[{strip, add, re}]}
let onlyInCompound = null;

for (let i = 0; i < aff.length; i++) {
  const parts = aff[i].trim().split(/\s+/);
  if (parts[0] === 'ONLYINCOMPOUND') onlyInCompound = parts[1];
  if ((parts[0] === 'PFX' || parts[0] === 'SFX') && (parts[2] === 'Y' || parts[2] === 'N') && parts.length === 4) {
    const [type, flag, cross, countStr] = parts;
    const count = parseInt(countStr, 10);
    const entries = [];
    for (let j = 1; j <= count; j++) {
      const p = aff[i + j].trim().split(/\s+/);
      const strip = p[2] === '0' ? '' : p[2];
      const add = (p[3] === '0' ? '' : p[3]).split('/')[0];
      const cond = p[4] || '.';
      const re = type === 'SFX' ? new RegExp(cond + '$') : new RegExp('^' + cond);
      entries.push({ strip, add, re });
    }
    rules[flag] = { type, cross: cross === 'Y', entries };
    i += count;
  }
}

function applyRule(word, rule) {
  const out = [];
  for (const e of rule.entries) {
    if (!e.re.test(word)) continue;
    if (rule.type === 'SFX') {
      if (e.strip && !word.endsWith(e.strip)) continue;
      out.push(word.slice(0, word.length - e.strip.length) + e.add);
    } else {
      if (e.strip && !word.startsWith(e.strip)) continue;
      out.push(e.add + word.slice(e.strip.length));
    }
  }
  return out;
}

const words = new Set();
const dic = fs.readFileSync(dicPath, 'utf8').split('\n').slice(1);
for (const line of dic) {
  if (!line.trim()) continue;
  const [stem, flagStr = ''] = line.trim().split('/');
  const flags = flagStr.split('');
  if (onlyInCompound && flags.includes(onlyInCompound)) continue;
  if (/\d/.test(stem)) continue; // numbers handled by the tokenizer, not the dictionary
  words.add(stem);
  const pfx = flags.map(f => rules[f]).filter(r => r && r.type === 'PFX');
  const sfx = flags.map(f => rules[f]).filter(r => r && r.type === 'SFX');
  const suffixed = [];
  for (const r of sfx) for (const w of applyRule(stem, r)) { words.add(w); if (r.cross) suffixed.push(w); }
  for (const p of pfx) {
    for (const w of applyRule(stem, p)) words.add(w);
    if (p.cross) for (const s of suffixed) for (const w of applyRule(s, p)) words.add(w);
  }
}

process.stdout.write([...words].sort().join('\n') + '\n');
