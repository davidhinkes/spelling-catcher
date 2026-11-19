// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { FieldTracker, tokenize, makeChecker, editDistance } = require('../extension/core.js');

const words = new Set(fs.readFileSync(path.join(__dirname, '../extension/words.txt'), 'utf8').split('\n'));
const checker = makeChecker(words);

// Simulate typing: feed a sequence of field states. A '|' marks the caret;
// with no '|', the field is being submitted / blurred (caret = -1).
function run(states, clock) {
  const t = new FieldTracker(clock ? () => clock.now : undefined);
  t.snapshot('', 0);
  const events = [];
  for (const s of states) {
    const caret = s.indexOf('|');
    const text = s.replace('|', '');
    events.push(...t.snapshot(text, caret));
    if (clock) clock.now += 500;
  }
  return events;
}
const replaces = ev => ev.filter(e => e.type === 'replace').map(e => `${e.from}->${e.to}`);
const typed = ev => ev.filter(e => e.type === 'typed').map(e => e.word);

test('typing words emits typed events once each word is finished', () => {
  const ev = run(['hel|', 'hello wor|', 'hello world |']);
  assert.deepStrictEqual(typed(ev), ['hello', 'world']);
  assert.deepStrictEqual(replaces(ev), []);
});

test('partial words are not treated as corrections', () => {
  const ev = run(['rec|', 'recie|', 'receive |']);
  assert.deepStrictEqual(replaces(ev), []);
});

test('suggestion-menu style whole-word replacement', () => {
  const ev = run(['I recieve |', 'I receive |']);
  assert.deepStrictEqual(replaces(ev), ['recieve->receive']);
});

test('backspace and retype in slow steps', () => {
  const ev = run(['teh |', 'teh|', 'te|', 'th|', 'the|', 'the |']);
  assert.deepStrictEqual(replaces(ev), ['teh->the']);
});

test('backspace the whole word away then retype it', () => {
  const clock = { now: 0 };
  const ev = run(['ok teh |', 'ok te|', 'ok |', 'ok t|', 'ok the|', 'ok the |'], clock);
  assert.deepStrictEqual(replaces(ev), ['teh->the']);
});

test('click back into an earlier word and fix it', () => {
  const ev = run(['I definately agree |', 'I defin|ately agree ', 'I definit|ely agree ', 'I definitely agree |']);
  assert.deepStrictEqual(replaces(ev), ['definately->definitely']);
});

test('last word is finished on submit (Enter / blur)', () => {
  const ev = run(['see you tommorow|', 'see you tommorow']);
  assert.ok(typed(ev).includes('tommorow'));
});

test('split correction', () => {
  const ev = run(['alot |', 'a lot |']);
  assert.deepStrictEqual(replaces(ev), ['alot->a lot']);
});

test('paste of a large block is ignored', () => {
  const ev = run(['|', 'one two three four five six seven |']);
  assert.deepStrictEqual(typed(ev), []);
});

test('code-ish tokens are skipped', () => {
  const toks = tokenize('see foo.bar and me@example.com or https://x.io/abc and file_name ok.');
  const skipped = toks.filter(t => t.skip).map(t => t.w);
  assert.deepStrictEqual(toks.filter(t => !t.skip).map(t => t.w), ['see', 'and', 'or', 'and', 'ok']);
  assert.ok(skipped.includes('foo') && skipped.includes('https'));
});

test('dictionary checks', () => {
  for (const w of ['receive', 'David', "don't", 'Running', 'unhappiness']) assert.ok(checker.isWord(w), w);
  for (const w of ['recieve', 'teh', 'definately', 'tommorow']) assert.ok(checker.isTypo(w), w);
  for (const w of ['API', 'NASA', 'useState', 'ok']) assert.ok(!checker.isTypo(w), w);
});

test('correction judgement', () => {
  assert.ok(checker.isCorrection('recieve', 'receive'));
  assert.ok(checker.isCorrection('alot', 'a lot'));
  assert.ok(checker.isCorrection('teh', 'the'));
  assert.ok(!checker.isCorrection('big', 'large'), 'rewording a correct word');
  assert.ok(!checker.isCorrection('recieve', 'obtain'), 'too far apart to be a fix');
  assert.ok(!checker.isCorrection('recieve', 'recieved'), 'still wrong after edit');
});

test('edit distance counts transpositions as one', () => {
  assert.strictEqual(editDistance('teh', 'the'), 1);
  assert.strictEqual(editDistance('recieve', 'receive'), 1);
});
