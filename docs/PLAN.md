# Peruser — Plan

Peruser is a Chrome (Manifest V3) extension plus a small local companion
process (the **bridge**). You open a side panel on any page and describe how
you want the page to look or behave. A coding agent (Claude Code first, Codex
as a second adapter) works against the live page through a set of browser
tools, produces a **patch** (CSS plus a fixed vocabulary of reversible DOM
rules), verifies that the page still works, and explains the risks. Saved
patches live as plain files on disk, grouped into **views** that you can cycle
with a hotkey, and are re-applied on every visit.

## Decisions (confirmed with the user)

| Topic | Decision |
|-------|----------|
| Model access | Through a coding harness, not raw API calls. Claude Code via the Claude Agent SDK, using the user's existing Claude Code login. Codex via `codex exec` with the same tools exposed as an MCP server (best-effort until verified on a machine with Codex). |
| Companion process | Required. `npx peruser-bridge` runs a WebSocket server on localhost. The extension applies cached patches without it, but creating and editing patches needs it. |
| Patch power | CSS + declarative DOM rules only (hide, setAttribute, removeAttribute, setText, setValue, addClass, removeClass, style, autofocus, move). No arbitrary JavaScript in v1. |
| Server/client safety | Attributes the server or page scripts depend on are **protected**: rules that touch them are rejected by validation, and verification checks that every form still submits the same payload. |
| Verification | The agent must call a `verify` tool before finishing. The report (pass/fail per check) is shown to the user and included in the agent's transcript. |
| Guidance | The agent's final answer is structured: patch or no patch, risk level, warnings, declined requests with alternatives. High risk requires an explicit confirmation before saving. |
| Unpatch | `Alt+Shift+P` toggles every patch on the current tab; the panel has the same switch. |
| Views | Named sets of patches per site. One active view per site. `Alt+Shift+V` cycles Original → view 1 → view 2 … with an on-page toast. |
| Dynamic pages | A volatility score (framework markers, mutation rate, shadow DOM, generated class names) gates patch creation behind an explicit per-site acknowledgement. |
| Files | Patches are files under `~/.peruser/sites/<site>/<view>/<patch>/` (`patch.json` + `style.css`). The bridge watches the folder; edits with any editor, including Claude Code itself, reach the browser live. Extension storage is a cache. |
| Tests | Unit tests (node:test + jsdom) with 100% coverage enforced by c8 on `src/lib` and `bridge/src`; Playwright end-to-end tests that load the unpacked extension against fixture pages with a fake harness; GitHub Actions runs both. |

## Architecture

```
extension (this repo root, load unpacked)
  manifest.json
  src/background/service-worker.js   side panel wiring, hotkeys, bridge client,
                                     message routing, storage cache
  src/content/loader.js              document_start: imports runtime.js
  src/content/runtime.js             applies patches, answers tool requests
                                     (outline, inspect, preview, verify),
                                     SPA + MutationObserver resilience, toasts
  src/sidepanel/                     chat with the agent, live tool log,
                                     verification report, views, patch list,
                                     source editor
  src/options/                       bridge port, harness choice, model,
                                     export / import, per-site acknowledgements
  src/lib/                           pure, unit-tested logic:
    scope.js      URL scopes (origin / prefix / exact)
    patch.js      schema, validation, protected attributes, CSS sanitising
    snapshot.js   page outline + volatility + server-bound annotations
    patcher.js    apply / undo CSS and DOM rules
    verify.js     interactive-element health, form payload invariance,
                  selector coverage, CSS parse, occlusion
    views.js      view model helpers (cycle, active view, grouping)
    storage.js    cache CRUD over chrome.storage.local
    protocol.js   message types shared by extension and bridge
    slug.js       stable file/folder names

bridge (bridge/, Node 22, ESM)
  src/server.js        WebSocket server; one extension connection, many tabs
  src/store.js         patch files on disk + watcher + catalog
  src/tools.js         browser tool definitions (proxied to the tab)
  src/harness/
    claude-code.js     Claude Agent SDK adapter (in-process MCP tools)
    codex.js           Codex CLI adapter (`codex exec` + stdio MCP server)
    fake.js            canned responses for tests and demos
  src/mcp-stdio.js     stdio MCP server that forwards tool calls to the bridge
  bin/peruser-bridge.js
```

### Message flow (creating a patch)

1. Panel → worker: `agent.start { tabId, prompt, viewId, patchId? }`.
2. Worker → bridge (WebSocket): same message plus the tab's URL.
3. Bridge starts a harness run. The harness has these tools, each proxied
   worker → content script and back:
   - `page_outline()` – title, URL, landmarks, forms with fields (never
     values), buttons, headings, tag tree, theme, volatility, protected
     attributes.
   - `inspect(selector)` – match count, outer HTML excerpt (values stripped),
     computed style highlights, nearest form, event-ish attributes.
   - `preview_patch(patch)` – validates, applies as a preview, returns
     selector match counts and validation errors.
   - `verify()` – runs the verification suite against the current preview.
   - `clear_preview()`.
   - `finish({ patch | null, risk, warnings, declined, message })`.
4. Every tool call and result streams to the panel as a transcript line.
5. On `finish`, the panel shows the summary, the verification report, and
   the risk. Save writes the files through the bridge; the bridge updates the
   catalog; the worker caches it; the runtime applies it for real.

### Data model

```js
Patch = {
  id, name, summary, notes,
  viewId,                              // which view it belongs to
  scope: { type: 'origin'|'prefix'|'exact', origin, path },
  css, rules, intentionallyHidden,
  risk: 'low'|'medium'|'high', warnings: [string],
  enabled, acknowledgedRisk: boolean,
  history: [{ role, content }],
  createdAt, updatedAt
}
View = { id, origin, name, createdAt }
ActiveViews = { [origin]: viewId | null }   // null = Original
Acknowledgements = { [origin]: { volatility: true } }
```

On disk: `~/.peruser/sites/<site-slug>/<view-slug>/<patch-slug>/patch.json`
(everything but `css`) and `style.css`. `views.json` in each site folder
holds view metadata and the active view.

### Protected attributes (server / client contract)

Rules may never `setAttribute` / `removeAttribute` on: `name`, `id`, `type`,
`for`, `form`, `action`, `method`, `enctype`, `value` of hidden inputs,
`data-*`, `aria-controls`, `aria-owns`, `aria-labelledby`, `aria-describedby`,
`href` (except to `#`-fragment-free same value), `src`, `on*`. `move` may not
take an element out of, or into, a `<form>`. `setValue` is allowed only on
visible text-like controls and is reported in verification as an intended
payload change.

### Verification suite (runs in the page)

| Check | Fails when |
|-------|------------|
| interactive | a link, button, field or ARIA widget that was visible and focusable before the patch is now missing, invisible, zero-size, `pointer-events: none`, disabled, or covered — unless matched by `intentionallyHidden` |
| forms | any form's `FormData` differs from before, except fields changed by an explicit `setValue` |
| css | the CSS does not parse (`CSSStyleSheet.replaceSync`) |
| selectors | a rule selector matches nothing |
| protected | a rule touches a protected attribute (belt and braces; validation already rejects it) |
| layout | the document became horizontally scrollable when it was not |

### Volatility score

Signals: framework markers (`#__next`, `[data-reactroot]`, `ng-version`,
`data-v-*`, `svelte-*`), mutation count over a 2 s window, shadow roots,
proportion of hashed class names, canvas/iframe-dominant content. Score ≥ 0.6
means "volatile": the panel shows why and requires acknowledgement per site;
the agent is told to prefer ids, `name`, ARIA and text-anchored selectors.

## Milestones

1. Library modules with unit tests at 100% coverage.
2. Bridge: store, watcher, WebSocket protocol, fake harness, Claude Code
   adapter, Codex adapter.
3. Extension: runtime, worker, side panel, options, hotkeys, toasts, views.
4. Fixture site + Playwright end-to-end tests + GitHub Actions workflow.
5. README with install, run, and file-editing instructions.

## Out of scope for v1

Sync across devices, arbitrary JavaScript patches, screenshots to the model,
Firefox/Safari ports, session-based login to claude.ai / chatgpt.com.

## Status (end of first implementation session)

Built and verified in this repository:

- `src/lib`: scope, patch validation with protected attributes, snapshot
  (outline, inspect, volatility), patcher (apply/undo/reapply), verification
  suite, views, storage cache, protocol, runtime core. 100% coverage.
- `bridge/`: file store with watcher, WebSocket server, browser tools, prompts,
  Claude Code and Codex adapters (spawn the local CLI with an MCP stdio tool
  server), fake harness, CLI. 100% coverage.
- Extension: content runtime (toasts, SPA and re-render resilience), service
  worker (bridge client, hotkeys, routing), side panel (transcript, verification
  report, risk gating, views, patch list, source editor), options page, icons.
- `e2e/`: Playwright suite with fixture pages and the fake harness; GitHub
  Actions workflow running unit + e2e.

Corrections to earlier assumptions:

- The Claude Agent SDK requires an API key and does not reuse the Claude Code
  subscription login. To keep "use the harness you already have", both
  adapters spawn the locally installed CLI (`claude -p`, `codex exec`) and
  attach Peruser's tools as an MCP server; auth is whatever each CLI is
  configured with. Users should check the terms of the CLI they use.

Not verified here (no CLI or model access in this environment):

- Real runs through `claude` and `codex`. The argv for both is built from
  their documented flags and unit-tested, but has not been executed against
  the real binaries. Codex is marked experimental; its flags are overridable
  with `PERUSER_CODEX_ARGS`.
- The Chrome side panel as a docked panel (tests open it as a tab with
  `?tabId=`); the hotkeys (Chrome commands cannot be triggered from
  Playwright; the same code paths run from the panel buttons).
