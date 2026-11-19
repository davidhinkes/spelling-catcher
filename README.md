# Spelling Catcher

A Chrome extension that keeps a running tally of the words you misspell — specifically the ones you **misspell and then fix**, which is a much stronger signal than whatever the red squiggle flags.

![popup](docs/popup-corrected.png)

Everything stays in `chrome.storage.local`. Nothing is sent anywhere.

## How it works

Chrome's built-in spellchecker doesn't expose results to extensions, so this runs its own check alongside it:

1. **`content.js`** watches textareas, plain text inputs and contenteditable fields (Gmail, claude.ai, Slack web, …) in every frame. Password, email and other non-text inputs are ignored. It takes a debounced snapshot of the field's text and caret position.
2. **`core.js`** diffs consecutive snapshots at the word level. A word counts as *finished* once the caret leaves it. If a finished word is later edited into something else — via the right-click suggestion, backspacing and retyping, or clicking back into it — that's a `replace` event (`recieve → receive`). Newly finished words are `typed` events. Partial words, large pastes and code-ish tokens (`foo.bar`, emails, URLs, `snake_case`, numbers) are ignored.
3. **`background.js`** judges events against a Hunspell en_US word list:
   - **Corrected** — the original wasn't a word, the result is, and they're within a small edit distance. High confidence.
   - **Flagged, not fixed** — you finished a non-dictionary word and left it. Lower confidence (names, jargon). Mark false positives "not a typo" in the popup to add them to your ignore list.

Enter (without Shift) and blur finish the last word, so chat boxes that clear on send are covered.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → pick the `extension/` folder

The popup has pause, per-site ignore, **Copy as Markdown** (a `| Misspelling | Correct | Count | Last seen |` table) and a full JSON export.

## Development

```sh
npm test            # core diff/judgement logic (node:test, no deps)
npm run e2e         # loads the extension in headless Chrome via Playwright and types into real fields
npm run build:dict  # regenerate extension/words.txt from the system Hunspell dictionary
```

`words.txt` is committed (≈167k words, 1.6 MB) so the extension loads with no build step.

## Not yet

- Real-word errors (`form`→`from`, `their`→`there`) are deliberately dropped: both sides are valid words, and they can't be told apart from ordinary rewording yet.
- Native macOS apps — that would need an Accessibility-API companion app.
- Syncing totals to the spelling-tracker doc automatically (for now, Copy as Markdown).
