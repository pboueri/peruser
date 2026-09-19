# Peruser — Initial Plan

Peruser is a Chrome (Manifest V3) extension that lets you re-skin any web page
for yourself. You describe a change in plain language in a side panel, an LLM
turns it into a **patch** (CSS plus a small set of declarative DOM rules), the
extension previews the patch on the live page, checks that the page still
works, and remembers the patch for that site so it is re-applied on every visit.

## Clarifying questions (and the defaults chosen for v1)

The user asked to be consulted before building. This session runs unattended,
so each question below is answered with a default that is easy to change later.

| # | Question | Default chosen for v1 |
|---|----------|-----------------------|
| 1 | **How does the extension authenticate with Claude / ChatGPT?** "Log into Claude or ChatGPT" could mean (a) reuse the claude.ai / chatgpt.com web session, or (b) use an API key. Option (a) relies on undocumented private endpoints and breaks whenever the site changes; it also runs against those services' terms of use. | **(b) API keys**, entered once in the Options page and stored in `chrome.storage.local`. Both Anthropic (Claude) and OpenAI (ChatGPT models) are supported through a small provider adapter, and a third "OpenAI-compatible" endpoint option covers local models. |
| 2 | **What is the scope of a remembered patch?** Whole site, a path prefix, or one exact URL? | The user picks per patch in the side panel: **whole site (origin)** is the default, with "pages under this path" and "this exact page" as alternatives. Multiple patches can stack on one page. |
| 3 | **How much power should a patch have?** Pure CSS is safest but cannot prefill form fields or change text. Arbitrary JavaScript is the most powerful but the hardest to keep safe. | **CSS + a fixed vocabulary of declarative DOM rules** (hide, set attribute, set text, set form value, add class, inline style, autofocus, move element). No arbitrary JS. This is enough for form-field customisation and UX changes, and it means every operation can be undone and health-checked. |
| 4 | **What does "intelligently ensure the page still works" mean concretely?** | Three layers (see *Functional safety* below): prompt rules for the model, an automatic before/after **health check** of interactive elements on the page, and an **auto-repair** round that feeds any breakage back to the model. Plus a per-page kill switch. |
| 5 | **Where do patches live?** Local only, or synced across Chrome profiles? | **Local** (`chrome.storage.local`, no size pressure) with **JSON export / import** from the Options page. Sync can be added later; `storage.sync` has a 100 KB cap that a few CSS patches would exhaust. |
| 6 | **Build tooling?** TypeScript + bundler, or plain files? | **Plain ES-module JavaScript, no build step.** The repo can be loaded as an unpacked extension directly. Pure logic lives in `src/lib` and is unit-tested with `node --test` + jsdom. |
| 7 | **Which model by default?** | Anthropic `claude-opus-5` (Claude), OpenAI `gpt-5` (ChatGPT). Both can be changed in Options. |
| 8 | **Should the model see the whole page?** Sending full HTML is expensive and may leak personal data. | The model receives a **compact page outline**: title, URL, landmarks, forms and fields (name/type/label/placeholder, never values), buttons, headings, a depth-limited tag tree with ids/classes, and the current computed theme (fonts, key colours). Input values and text longer than a short excerpt are never sent. |

## Architecture

```
manifest.json                MV3: side panel, content script, service worker
src/background/service-worker.js
    - opens the side panel on toolbar click
    - routes messages between side panel and content script
    - calls the LLM provider (fetch from the worker avoids page CSP/CORS)
src/content/loader.js        classic script at document_start: applies stored
                             CSS immediately (minimises flash), then imports
                             the ES-module runtime
src/content/runtime.js       ES module: snapshot, preview, apply, undo,
                             health check, SPA navigation + MutationObserver
src/lib/scope.js             URL scope matching (origin / prefix / exact)
src/lib/patch.js             patch schema, validation, CSS sanitising
src/lib/snapshot.js          page outline builder (pure DOM → JSON)
src/lib/patcher.js           applies / removes CSS + DOM rules (pure DOM)
src/lib/health.js            interactive-element health check
src/lib/prompt.js            system prompt, schema, response parsing
src/lib/providers.js         Anthropic / OpenAI / OpenAI-compatible adapters
src/lib/storage.js           patch + settings CRUD over chrome.storage.local
src/sidepanel/*              the side panel UI ("describe → preview → save")
src/options/*                provider, API key, model, export / import
test/*.test.js               node --test + jsdom unit tests for src/lib
```

### Data model

```js
Patch = {
  id, name, summary,
  scope: { type: 'origin' | 'prefix' | 'exact', origin, path },
  css: string,
  rules: [ { action, selector, ...args } ],
  intentionallyHidden: [selector],   // what the user asked to hide
  enabled: boolean,
  history: [ { role, content } ],    // the conversation that produced it
  createdAt, updatedAt
}
```

Rule actions: `hide`, `setAttribute`, `removeAttribute`, `setText`,
`setValue` (uses the native value setter and dispatches `input`/`change` so
React/Vue notice), `addClass`, `removeClass`, `style`, `autofocus`, `move`
(`before`/`after`/`prepend`/`append` a target).

### Request flow

1. Side panel sends `GENERATE {prompt, scope, patchId?}` to the worker.
2. Worker asks the tab's content script for a `SNAPSHOT`.
3. Worker builds the conversation (system prompt + snapshot + prior turns for
   this patch + user prompt) and calls the provider, requesting JSON.
4. Worker validates the patch, sends `PREVIEW {patch}` to the content script.
5. Content script snapshots interactive elements, applies the patch, re-runs
   the health check, and returns a report.
6. Panel shows summary + report. **Save** persists it; **Discard** reverts;
   **Fix it** sends the report back to the model for a repair round;
   further messages refine the same patch.

### Functional safety

* **Prompt rules**: prefer CSS; never remove or `pointer-events:none` an
  interactive element unless asked; keep selectors specific; no `@import`,
  no remote `url()`; list everything intentionally hidden.
* **Sanitising**: CSS is parsed with `CSSStyleSheet.replaceSync`; `@import`
  and remote `url()` are rejected. Rules only come from the fixed vocabulary.
* **Health check**: before applying, record every interactive element
  (links, buttons, inputs, selects, textareas, ARIA widgets) that is visible
  and focusable. After applying, re-check. Any element that became invisible,
  zero-size, non-interactive or covered, and that is not matched by an
  `intentionallyHidden` selector, is reported as a regression.
* **Auto-repair**: the report is sent back to the model, which returns a
  revised patch. Two rounds max.
* **Kill switch**: `Alt+Shift+P` toggles all patches on the current tab;
  a per-site enable toggle lives in the panel.
* **SPA resilience**: `MutationObserver` re-applies DOM rules (debounced),
  and `pushState`/`popstate` changes re-evaluate the active patch set.

## Milestones

1. Scaffold: manifest, worker, side panel opens, options page stores a key.
2. Storage + scope matching + patch application on load (no LLM yet).
3. Snapshot + prompt + provider call → preview → save.
4. Health check + auto-repair + kill switch.
5. Tests for `src/lib`, README, load-unpacked instructions.

## Out of scope for v1 (follow-ups)

* Sync across devices; sharing patches with others.
* Session-based login to claude.ai / chatgpt.com.
* Arbitrary JavaScript patches.
* Screenshots sent to the model (would help "make this look like…").
* Firefox / Safari ports.
