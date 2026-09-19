# Peruser

A Chrome extension that lets you re-skin any web page for yourself while
keeping it working. You describe the change in a side panel; a coding agent
(Claude Code, or Codex) works against the live page through a set of browser
tools, previews the change, **verifies that every link, button, field and form
still works**, tells you what it would not do and why, and then you save.
Saved patches are plain files on disk, grouped into **views** you can cycle
with a hotkey, and they re-apply on every visit.

```
┌──────────────┐   WebSocket    ┌──────────────────┐   spawns    ┌──────────────────┐
│  extension   │ ◄────────────► │  peruser-bridge  │ ──────────► │ claude -p / codex │
│ side panel + │                │  (localhost)     │ ◄────────── │  + MCP tools      │
│ content script│               │  ~/.peruser/**   │  tool calls │                   │
└──────────────┘                └──────────────────┘             └──────────────────┘
```

## Install

Requirements: Chrome 116+, Node 22+, and at least one harness installed and
logged in: [Claude Code](https://code.claude.com) (`claude`) or
[Codex](https://github.com/openai/codex) (`codex`).

1. Clone this repository.
2. `npm install`
3. Start the bridge in a terminal and leave it running:
   ```
   node bridge/bin/peruser-bridge.js
   ```
   It stores patches in `~/.peruser` and listens on `ws://127.0.0.1:48923`.
   Use `--port` and `--root` to change that; `--fake` adds a scripted
   demo harness that needs no model.
4. Open `chrome://extensions`, enable *Developer mode*, *Load unpacked*, and
   pick the repository folder.
5. Click the Peruser toolbar icon on any page to open the side panel.

## Using it

- **Describe** what you want ("make the search box bigger and hide the promo
  banner"). The transcript shows every tool the agent calls: reading the
  page, inspecting elements, previewing, verifying.
- **Preview** appears on the page immediately. The **verification report**
  lists each check with pass/fail: interactive elements still usable, forms
  submit the same data, CSS parses, every selector matched, no server-side
  attribute touched, no horizontal overflow.
- The agent's answer has a **risk level**, **warnings**, and a **"Not done"**
  list for things it declined because they would break the page, each with an
  alternative. High-risk patches need an explicit tick before saving.
- **Save** writes files; **Discard** removes the preview; sending another
  message refines the same preview.
- **Unpatch**: `Alt+Shift+P` toggles every patch on the current tab (also the
  switch at the top of the panel).
- **Views**: named sets of patches per site. `Alt+Shift+V` cycles
  Original → view 1 → view 2 → …; the panel has a picker and a ＋ button.
- **Dynamic pages**: if a page re-renders itself constantly or uses generated
  class names, the panel explains why patches may not hold and asks you to
  acknowledge that once per site before continuing.
- **Scope**: whole site, this section (path prefix) or this exact page.

Hotkeys can be changed at `chrome://extensions/shortcuts`.

## Your patches are files

```
~/.peruser/sites/<site>/views.json                 views + active view
~/.peruser/sites/<site>/<view>/<patch>/patch.json  name, scope, rules, risk, …
~/.peruser/sites/<site>/<view>/<patch>/style.css   the CSS
```

Edit them with any editor, or point Claude Code at the folder. The bridge
watches it and the browser updates live. Deleting a folder deletes the patch
or view. The panel's **Source** button edits the same files. The **Options**
page can export and import everything as JSON.

Without the bridge running, saved patches still apply from the extension's
cache; creating and editing needs the bridge.

## What a patch can and cannot do

A patch is CSS plus declarative rules: `hide`, `setAttribute`,
`removeAttribute`, `setText`, `setValue`, `addClass`, `removeClass`, `style`,
`autofocus`, `move`. There is no JavaScript. Rules may never touch
**protected attributes** (`name`, `id`, `type`, `for`, `form`, `action`,
`method`, `enctype`, `target`, `href`, `src`, `data-*`, ARIA wiring, `on*`) and
may never move an element into or out of a form: those are the server-side
and script-side contracts that make a page keep looking fine while silently
breaking. Validation rejects such rules before they reach the page, and
verification checks the outcome anyway.

## Harnesses

| Harness | How it runs | Auth |
|---------|-------------|------|
| Claude Code | `claude -p … --output-format stream-json --mcp-config …` with Peruser's tools as an MCP server; built-in file and shell tools are disallowed | whatever `claude` is logged in with |
| Codex | `codex exec --json … -c mcp_servers.peruser.…` | whatever `codex` is logged in with; **experimental**, flags configurable via `PERUSER_CODEX_ARGS` |
| Fake | in-process, scripted; for tests and demos (`--fake`) | none |

Environment variables: `PERUSER_CLAUDE_COMMAND`, `PERUSER_CLAUDE_ARGS`,
`PERUSER_CODEX_COMMAND`, `PERUSER_CODEX_ARGS`, `PERUSER_FAKE_HARNESS`.

Note: this drives the CLIs you already have installed and logged in. Check the
terms of the tool you use; Anthropic's policy on third-party products using
claude.ai logins is described in the Claude Agent SDK documentation.

## Development

```
npm test          # unit tests, 100% line/branch/function coverage enforced (c8)
npm run test:e2e  # Playwright: loads the unpacked extension into Chromium,
                  # runs the fake harness through the bridge against fixture pages
```

The end-to-end suite covers: describe → preview → verify → save → reload,
toggling, refining, verification failure and dissuasion, protected-attribute
rejection, high-risk acknowledgement, views and cycling, the volatile-page
gate, live edits on disk, the source editor, scopes, and bridge-offline mode.
GitHub Actions runs both suites on every push (`.github/workflows/ci.yml`).

Layout: `src/lib` (pure, tested logic shared by extension and bridge),
`src/content`, `src/background`, `src/sidepanel`, `src/options`,
`bridge/src`, `e2e/`. The plan and the decisions behind it are in
`docs/PLAN.md`.
