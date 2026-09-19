// Side panel: talk to the agent, watch it work, save or discard, manage
// views and patches for this site.

import { MSG } from '../lib/protocol.js';
import * as store from '../lib/storage.js';
import { makeScope, describeScope } from '../lib/scope.js';
import { toRecord, validatePatch } from '../lib/patch.js';
import { makeView, viewName } from '../lib/views.js';

const $ = (id) => document.getElementById(id);
const el = {
  dot: $('bridge-dot'), host: $('host'), enabled: $('enabled'), view: $('view'), cycle: $('cycle'), newView: $('new-view'),
  notice: $('notice'), gate: $('gate'), gateReasons: $('gate-reasons'), ack: $('ack'),
  transcript: $('transcript'), patches: $('patches'),
  prompt: $('prompt'), harness: $('harness'), scope: $('scope'), send: $('send'), cancel: $('cancel'), hint: $('compose-hint'),
  editor: $('editor'), editorJson: $('editor-json'), editorCss: $('editor-css'), editorError: $('editor-error'), editorPath: $('editor-path'), editorSave: $('editor-save'),
};

const state = {
  tab: null, // { id, url }
  origin: null,
  catalog: { patches: {}, views: {}, activeViews: {} },
  settings: store.DEFAULT_SETTINGS,
  acks: {},
  bridge: { connected: false, hello: null },
  outline: null,
  pageEnabled: true,
  draft: null, // { runId, events, finish, history, existing, promptText, running }
  editing: null, // patch id in the source editor
  paths: {}, // patchId -> path on disk
};

// ---- plumbing --------------------------------------------------------------------

async function worker(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res) throw new Error('no response from the extension');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}
const tabSend = (message) => worker({ type: 'tab.send', tabId: state.tab.id, message });
const bridgeRequest = (frame) => worker({ type: MSG.BRIDGE_REQUEST, frame });

function isWebUrl(url) {
  return /^(https?|file):/.test(url || '');
}

async function resolveTab() {
  const forced = new URLSearchParams(location.search).get('tabId');
  if (forced) {
    const t = await chrome.tabs.get(Number(forced));
    return { id: t.id, url: t.url };
  }
  const t = await worker({ type: 'tab.active' });
  return t ? { id: t.id, url: t.url } : null;
}

async function loadAll() {
  [state.catalog, state.settings, state.acks, state.bridge] = await Promise.all([store.getCatalog(), store.getSettings(), store.getAcks(), worker({ type: MSG.BRIDGE_STATUS })]);
}

// ---- rendering -----------------------------------------------------------------------

function render() {
  renderHeader();
  renderNotice();
  renderGate();
  renderTranscript();
  renderPatches();
  renderCompose();
}

function renderHeader() {
  el.dot.classList.toggle('on', state.bridge.connected);
  el.dot.title = state.bridge.connected ? `Bridge connected (patches in ${state.bridge.hello?.root || '~/.peruser'})` : 'Bridge not running';
  el.host.textContent = state.origin ? state.origin.replace(/^https?:\/\//, '') : 'Not a web page';
  el.enabled.checked = state.pageEnabled;
  const summary = store.siteSummary(state.catalog, state.tab?.url || '');
  el.view.replaceChildren(new Option('Original (no patches)', ''));
  for (const v of summary.views) el.view.add(new Option(v.name, v.id));
  el.view.value = summary.activeViewId || '';
  el.cycle.disabled = summary.views.length === 0;
}

function renderNotice() {
  const problems = state.bridge.hello?.problems || [];
  let text = '';
  let bad = false;
  if (!state.tab || !isWebUrl(state.tab.url)) {
    text = 'Open a web page to customise it.';
  } else if (!state.bridge.connected) {
    text = `The bridge is not running, so saved patches still apply but you cannot create or edit them. Start it in a terminal:  npx peruser-bridge  (port ${state.settings.bridgePort})`;
    bad = true;
  } else if (problems.length) {
    text = `Some patch files could not be read: ${problems.join('; ')}`;
    bad = true;
  }
  el.notice.hidden = !text;
  el.notice.textContent = text;
  el.notice.classList.toggle('bad', bad);
}

function volatilityBlocked() {
  const v = state.outline?.volatility;
  return !!(v?.volatile && !state.acks[state.origin]?.volatility);
}

function renderGate() {
  const show = volatilityBlocked();
  el.gate.hidden = !show;
  if (show) el.gateReasons.textContent = state.outline.volatility.reasons.join('. ') + '.';
}

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function renderTranscript() {
  const t = el.transcript;
  t.replaceChildren();
  const d = state.draft;
  if (!d) {
    t.append(node('div', 'empty', state.bridge.connected ? 'Describe a change below. The agent will preview it live and verify the page still works before you save.' : ''));
    return;
  }
  for (const turn of d.history) t.append(node('div', `msg ${turn.role}`, turn.content));
  t.append(node('div', 'msg user', d.promptText));
  for (const ev of d.events) {
    switch (ev.kind) {
      case 'status':
      case 'log':
        t.append(node('div', 'msg status', ev.text));
        break;
      case 'assistant':
        t.append(node('div', 'msg assistant', ev.text));
        break;
      case 'thinking_tool':
        break; // the real call shows up as tool_call
      case 'tool_call': {
        const det = node('details', 'tool');
        det.append(node('summary', null, `▸ ${labelTool(ev.tool)}`));
        if (ev.input && Object.keys(ev.input).length) det.append(pre(ev.input));
        t.append(det);
        break;
      }
      case 'tool_result':
        if (ev.tool === 'verify') t.append(renderReport(ev.result));
        else if (ev.tool === 'preview_patch' && ev.result?.ok === false) t.append(node('div', 'msg error', 'Patch rejected: ' + ev.result.errors.join('; ')));
        else if (ev.tool !== 'finish') {
          const det = node('details', 'tool');
          det.append(node('summary', null, `✓ ${labelTool(ev.tool)} result`));
          det.append(pre(ev.result));
          t.append(det);
        }
        break;
      case 'tool_error':
        t.append(node('div', 'msg error', `${labelTool(ev.tool)} failed: ${ev.error}`));
        break;
      case 'error':
        t.append(node('div', 'msg error', ev.error));
        break;
      case 'finish':
        t.append(renderFinish(ev.result));
        break;
      case 'done':
        if (!ev.ok && !d.events.some((e) => e.kind === 'finish')) t.append(node('div', 'msg status', 'The run ended without a result.'));
        break;
      default:
        break;
    }
  }
  if (d.running) t.append(node('div', 'msg status', 'Working…'));
  t.lastElementChild?.scrollIntoView({ block: 'end' });
}

function labelTool(name) {
  return { page_outline: 'Reading the page', inspect: 'Inspecting elements', preview_patch: 'Previewing the patch', verify: 'Verifying the page still works', clear_preview: 'Clearing the preview', finish: 'Finishing' }[name] || name;
}

function pre(obj) {
  const p = node('pre');
  p.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return p;
}

function renderReport(report) {
  const box = node('div', 'report');
  box.append(node('div', null, report.ok ? 'Verification passed' : `Verification: ${report.summary}`));
  for (const c of report.checks || []) {
    const row = node('div', `check ${c.skipped ? 'skipped' : c.ok ? 'ok' : 'bad'}`);
    row.append(node('span', 'mark', c.skipped ? '–' : c.ok ? '✓' : '✗'), node('span', null, c.title));
    box.append(row);
    if (c.details?.length) {
      const ul = node('ul');
      for (const d of c.details.slice(0, 6)) ul.append(node('li', null, d));
      if (c.details.length > 6) ul.append(node('li', null, `… and ${c.details.length - 6} more`));
      box.append(ul);
    }
  }
  return box;
}

function renderFinish(result) {
  const card = node('div', 'card finish');
  card.append(node('div', null, result.message));
  const badges = node('div', 'row');
  badges.append(node('span', `badge ${result.risk}`, `${result.risk} risk`));
  card.append(badges);
  if (result.warnings?.length) {
    const ul = node('ul');
    for (const w of result.warnings) ul.append(node('li', null, w));
    card.append(node('div', null, 'Warnings:'), ul);
  }
  if (result.declined?.length) {
    const ul = node('ul');
    for (const d of result.declined) ul.append(node('li', null, `${d.request}: ${d.reason} Instead: ${d.alternative}`));
    card.append(node('div', null, 'Not done:'), ul);
  }
  if (result.patch) {
    card.append(node('div', 'hint', `${result.patch.name} · ${result.patch.rules.length} rule(s)${result.patch.css.trim() ? ' + CSS' : ''}`));
    const row = node('div', 'row');
    let ackBox = null;
    if (result.risk === 'high') {
      const lab = node('label');
      ackBox = node('input');
      ackBox.type = 'checkbox';
      lab.append(ackBox, ' I understand this may break how I use this page');
      card.append(lab);
    }
    const save = node('button', 'primary', 'Save');
    save.addEventListener('click', () => {
      if (ackBox && !ackBox.checked) return alert('Tick the box first: this patch is rated high risk.');
      savePatch(result).catch((e) => showError(e));
    });
    const discard = node('button', 'secondary', 'Discard');
    discard.addEventListener('click', () => discardDraft().catch(showError));
    row.append(save, discard);
    card.append(row, node('div', 'hint', 'Not right yet? Describe what to change and send again.'));
  }
  return card;
}

function renderPatches() {
  const box = el.patches;
  box.replaceChildren();
  if (!state.origin) return;
  const s = store.siteSummary(state.catalog, state.tab.url);
  if (!s.patches.length) {
    box.append(node('div', 'empty', 'No patches for this site yet.'));
    return;
  }
  const byView = new Map();
  for (const p of s.patches) byView.set(p.viewId, [...(byView.get(p.viewId) || []), p]);
  for (const [viewId, list] of byView) {
    box.append(node('h4', null, `${viewName(state.catalog.views, viewId)}${viewId === s.activeViewId ? ' · active' : ''}`));
    for (const p of list) box.append(renderPatch(p));
  }
}

function renderPatch(p) {
  const row = node('div', 'patch');
  const title = node('div', 'title');
  const on = node('input');
  on.type = 'checkbox';
  on.checked = p.enabled !== false;
  on.title = 'Enabled';
  on.addEventListener('change', () => updatePatch(p, { enabled: on.checked }).catch(showError));
  title.append(on, node('span', 'name', p.name), node('span', `badge ${p.risk || 'low'}`, p.risk || 'low'));
  row.append(title);
  row.append(node('div', 'meta', `${describeScope(p.scope)} · ${p.summary || ''}`));
  if (p.risk === 'high' && !p.acknowledgedRisk) {
    const warn = node('div', 'meta', 'High risk: not applied until you confirm. ');
    const b = node('button', 'small', 'Apply anyway');
    b.addEventListener('click', () => updatePatch(p, { acknowledgedRisk: true }).catch(showError));
    warn.append(b);
    row.append(warn);
  }
  const actions = node('div', 'row');
  const refine = node('button', 'small', 'Refine');
  refine.addEventListener('click', () => startRefine(p));
  const source = node('button', 'small', 'Source');
  source.addEventListener('click', () => openEditor(p));
  const del = node('button', 'small', 'Delete');
  del.addEventListener('click', () => {
    if (confirm(`Delete "${p.name}"?`)) deletePatch(p).catch(showError);
  });
  actions.append(refine, source, del);
  row.append(actions);
  return row;
}

function renderCompose() {
  const web = state.tab && isWebUrl(state.tab.url);
  const ready = web && state.bridge.connected && !volatilityBlocked() && !state.draft?.running;
  el.prompt.disabled = !ready;
  el.send.disabled = !ready;
  el.cancel.hidden = !state.draft?.running;
  const harnesses = state.bridge.hello?.harnesses || [];
  const current = el.harness.value || state.settings.harness;
  el.harness.replaceChildren();
  for (const h of harnesses) el.harness.add(new Option(`${h.label}${h.available ? '' : ' (not found)'}`, h.name, false, h.name === current));
  if (harnesses.length && !harnesses.some((h) => h.name === el.harness.value)) el.harness.value = harnesses.find((h) => h.available)?.name || harnesses[0].name;
  const chosen = harnesses.find((h) => h.name === el.harness.value);
  el.hint.textContent = !web ? '' : state.draft?.existing ? `Refining "${state.draft.existing.name}".` : chosen && !chosen.available ? `${chosen.label} is not installed on this machine (${chosen.command} was not found on PATH).` : state.draft?.finish?.patch ? 'Send another message to refine the preview, or save it above.' : '';
}

function showError(e) {
  console.error(e);
  el.notice.hidden = false;
  el.notice.classList.add('bad');
  el.notice.textContent = e.message || String(e);
}

// ---- actions ---------------------------------------------------------------------------

async function send() {
  const text = el.prompt.value.trim();
  if (!text) return;
  const prev = state.draft;
  const history = prev ? [...prev.history, { role: 'user', content: prev.promptText }, ...(prev.finish ? [{ role: 'assistant', content: prev.finish.message }] : [])] : [];
  const existing = prev?.finish?.patch ? { ...(prev.existing || {}), ...prev.finish.patch } : prev?.existing || null;
  state.draft = { runId: null, events: [], finish: null, history, existing, existingRecord: prev?.existingRecord || null, promptText: text, running: true };
  el.prompt.value = '';
  render();
  try {
    const { runId } = await bridgeRequest({
      type: MSG.AGENT_START,
      harness: el.harness.value,
      model: state.settings.model || '',
      tabId: state.tab.id,
      url: state.tab.url,
      prompt: text,
      history,
      existingPatch: existing,
      volatility: state.outline?.volatility || null,
      acknowledged: !!state.acks[state.origin]?.volatility,
    });
    state.draft.runId = runId;
    const missed = await worker({ type: 'run.events', runId });
    for (const ev of missed) if (!state.draft.events.includes(ev)) onEvent(runId, ev);
  } catch (e) {
    state.draft.running = false;
    state.draft.events.push({ kind: 'error', error: e.message });
    render();
  }
}

function onEvent(runId, ev) {
  const d = state.draft;
  if (!d || d.runId !== runId) return;
  if (d.events.some((x) => x.at === ev.at && x.kind === ev.kind)) return;
  d.events.push(ev);
  if (ev.kind === 'finish') d.finish = ev.result;
  if (ev.kind === 'done') d.running = false;
  render();
}

async function cancel() {
  if (state.draft?.runId) await bridgeRequest({ type: MSG.AGENT_CANCEL, runId: state.draft.runId }).catch(() => {});
}

async function ensureView() {
  const s = store.siteSummary(state.catalog, state.tab.url);
  if (s.activeViewId) return s.activeViewId;
  let view = s.views[0];
  if (!view) {
    view = makeView(state.origin, 'My view');
    await bridgeRequest({ type: MSG.SAVE_VIEW, view });
  }
  await worker({ type: MSG.SET_ACTIVE_VIEW, origin: state.origin, viewId: view.id });
  return view.id;
}

async function savePatch(result) {
  const d = state.draft;
  const viewId = await ensureView();
  const existing = d.existingRecord;
  const record = toRecord(result.patch, {
    id: existing?.id,
    scope: existing?.scope || makeScope(el.scope.value, state.tab.url),
    viewId: existing?.viewId || viewId,
    risk: result.risk,
    warnings: result.warnings,
    history: [...d.history, { role: 'user', content: d.promptText }, { role: 'assistant', content: result.message }].slice(-12),
    existing,
  });
  if (record.risk === 'high') record.acknowledgedRisk = true; // the user ticked the box
  const res = await bridgeRequest({ type: MSG.SAVE_PATCH, patch: record });
  if (res.path) state.paths[record.id] = res.path;
  await tabSend({ type: MSG.CLEAR_PREVIEW }).catch(() => {});
  state.draft = null;
  await refreshCatalog();
  render();
}

async function discardDraft() {
  await tabSend({ type: MSG.CLEAR_PREVIEW }).catch(() => {});
  state.draft = null;
  render();
}

function startRefine(p) {
  state.draft = { runId: null, events: [], finish: null, history: (p.history || []).slice(-6), existing: p, existingRecord: p, promptText: '', running: false };
  // show the existing conversation, but no new user message yet
  state.draft.history = state.draft.history.filter((h) => h.content);
  render();
  el.prompt.focus();
}

async function updatePatch(p, changes) {
  const next = { ...p, ...changes };
  if (state.bridge.connected) await bridgeRequest({ type: MSG.SAVE_PATCH, patch: next });
  else await store.updatePatch(p.id, changes);
  await refreshCatalog();
  render();
}

async function deletePatch(p) {
  await bridgeRequest({ type: MSG.DELETE_PATCH, patchId: p.id });
  await refreshCatalog();
  render();
}

function openEditor(p) {
  state.editing = p.id;
  const { css, ...rest } = p;
  el.editorJson.value = JSON.stringify(rest, null, 2);
  el.editorCss.value = css || '';
  el.editorError.textContent = '';
  el.editorPath.textContent = state.paths[p.id] ? `On disk: ${state.paths[p.id]}` : `On disk under ${state.bridge.hello?.root || '~/.peruser'}/sites/`;
  el.editor.showModal();
}

async function saveEditor(ev) {
  ev.preventDefault();
  let json;
  try {
    json = JSON.parse(el.editorJson.value);
  } catch (e) {
    el.editorError.textContent = `patch.json: ${e.message}`;
    return;
  }
  const v = validatePatch({ ...json, css: el.editorCss.value });
  if (!v.ok) {
    el.editorError.textContent = v.errors.join('; ');
    return;
  }
  const original = state.catalog.patches[state.editing];
  const record = { ...original, ...json, ...v.patch, id: original.id, viewId: json.viewId || original.viewId, scope: json.scope || original.scope };
  try {
    await bridgeRequest({ type: MSG.SAVE_PATCH, patch: record });
    el.editor.close();
    await refreshCatalog();
    render();
  } catch (e) {
    el.editorError.textContent = e.message;
  }
}

async function refreshCatalog() {
  state.catalog = await store.getCatalog();
}

async function loadOutline() {
  state.outline = null;
  if (!state.tab || !isWebUrl(state.tab.url)) return;
  try {
    state.outline = await tabSend({ type: MSG.OUTLINE });
    const status = await tabSend({ type: MSG.STATUS });
    state.pageEnabled = status.enabled;
  } catch {
    /* page not ready yet */
  }
}

// ---- events -------------------------------------------------------------------------------

el.send.addEventListener('click', () => send().catch(showError));
el.prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send().catch(showError);
});
el.cancel.addEventListener('click', () => cancel().catch(showError));
el.enabled.addEventListener('change', () => tabSend({ type: MSG.TOGGLE, enabled: el.enabled.checked }).then((s) => (state.pageEnabled = s.enabled)).catch(showError));
el.view.addEventListener('change', () => worker({ type: MSG.SET_ACTIVE_VIEW, origin: state.origin, viewId: el.view.value || null }).then(refreshCatalog).then(render).catch(showError));
el.cycle.addEventListener('click', () => worker({ type: MSG.CYCLE_VIEW, url: state.tab.url, tabId: state.tab.id }).then(refreshCatalog).then(render).catch(showError));
el.newView.addEventListener('click', async () => {
  const name = prompt('Name for the new view:', 'Focus');
  if (!name) return;
  try {
    const view = makeView(state.origin, name);
    await bridgeRequest({ type: MSG.SAVE_VIEW, view });
    await worker({ type: MSG.SET_ACTIVE_VIEW, origin: state.origin, viewId: view.id });
    await refreshCatalog();
    render();
  } catch (e) {
    showError(e);
  }
});
el.ack.addEventListener('click', async () => {
  await store.acknowledge(state.origin, 'volatility');
  state.acks = await store.getAcks();
  render();
});
el.harness.addEventListener('change', () => store.saveSettings({ harness: el.harness.value }).then(() => renderCompose()));
el.editorSave.addEventListener('click', (e) => saveEditor(e));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === MSG.AGENT_EVENT) onEvent(msg.runId, msg.event);
  else if (msg?.type === MSG.BRIDGE_STATUS) {
    state.bridge = msg.status;
    render();
  } else if (msg?.type === MSG.CATALOG_UPDATED) {
    refreshCatalog().then(() => {
      state.bridge = { ...state.bridge, hello: { ...state.bridge.hello, problems: msg.problems } };
      render();
    });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[store.KEYS.PATCHES] || changes[store.KEYS.VIEWS] || changes[store.KEYS.ACTIVE_VIEWS] || changes[store.KEYS.ACKS]) refreshCatalog().then(render);
});

async function switchTab() {
  state.tab = await resolveTab();
  state.origin = state.tab && isWebUrl(state.tab.url) ? new URL(state.tab.url).origin : null;
  state.draft = null;
  await loadOutline();
  render();
}

chrome.tabs.onActivated.addListener(() => switchTab().catch(showError));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (state.tab && tabId === state.tab.id && (info.status === 'complete' || info.url)) switchTab().catch(showError);
});

(async () => {
  await loadAll();
  await switchTab();
})().catch(showError);
