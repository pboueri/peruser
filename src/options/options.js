import * as store from '../lib/storage.js';
import { MSG } from '../lib/protocol.js';
import { PRESETS, parseProfile } from '../lib/profile.js';

const $ = (id) => document.getElementById(id);

async function worker(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error || 'no response');
  return res.result;
}

function flash(text) {
  $('saved').textContent = text;
  setTimeout(() => ($('saved').textContent = ''), 2000);
}

async function renderStatus() {
  try {
    const s = await worker({ type: MSG.BRIDGE_STATUS });
    $('status').textContent = s.connected ? `Connected. Patches live in ${s.hello.root}. Harnesses: ${s.hello.harnesses.map((h) => `${h.label} ${h.available ? '✓' : '✗'}`).join(', ')}` : 'Not connected.';
  } catch (e) {
    $('status').textContent = e.message;
  }
}

function renderPresets(profile) {
  const box = $('presets');
  box.replaceChildren();
  for (const p of PRESETS) {
    const lab = document.createElement('label');
    lab.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = p.id;
    input.checked = profile.presets.includes(p.id);
    lab.append(input, ` ${p.label}`, Object.assign(document.createElement('span'), { className: 'hint', textContent: ` — ${p.hint}` }));
    box.append(lab);
  }
  $('notes').value = profile.notes;
}

async function renderJsStatus() {
  try {
    const s = await worker({ type: 'js.status' });
    $('js-status').textContent = `Engine: ${s.engine}. ${s.hint}`;
  } catch (e) {
    $('js-status').textContent = e.message;
  }
}

async function load() {
  const s = await store.getSettings();
  $('port').value = s.bridgePort;
  $('harness').value = s.harness;
  $('model').value = s.model;
  $('global').checked = s.globalEnabled;
  $('allow-js').checked = !!s.allowJs;
  const catalog = await store.getCatalog();
  renderPresets(parseProfile(catalog.profile));
  await renderStatus();
  await renderJsStatus();
}

$('port').addEventListener('change', async () => {
  const port = Number($('port').value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return flash('Port must be between 1 and 65535');
  await store.saveSettings({ bridgePort: port });
  flash('Saved. Reconnecting…');
  setTimeout(renderStatus, 1500);
});
$('harness').addEventListener('change', () => store.saveSettings({ harness: $('harness').value }).then(() => flash('Saved')));
$('model').addEventListener('change', () => store.saveSettings({ model: $('model').value.trim() }).then(() => flash('Saved')));
$('global').addEventListener('change', () => store.saveSettings({ globalEnabled: $('global').checked }).then(() => flash('Saved')));
$('allow-js').addEventListener('change', async () => {
  const on = $('allow-js').checked;
  if (on && !confirm('Allow the agent to write JavaScript that runs on pages? You will see the code before saving.')) {
    $('allow-js').checked = false;
    return;
  }
  await store.saveSettings({ allowJs: on });
  flash('Saved');
  renderJsStatus();
});
$('save-profile').addEventListener('click', async () => {
  const profile = { presets: [...$('presets').querySelectorAll('input:checked')].map((i) => i.value), notes: $('notes').value.trim() };
  try {
    await worker({ type: MSG.BRIDGE_REQUEST, frame: { type: MSG.SAVE_PROFILE, profile } });
    $('profile-status').textContent = 'Saved to profile.md';
  } catch (e) {
    $('profile-status').textContent = e.message;
  }
  setTimeout(() => ($('profile-status').textContent = ''), 3000);
});
$('reconnect').addEventListener('click', () => worker({ type: 'bridge.reconnect' }).then(() => setTimeout(renderStatus, 800)));
$('export').addEventListener('click', async () => {
  const data = await store.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `peruser-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});
$('import').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => {
  const f = $('file').files[0];
  if (!f) return;
  try {
    const count = await store.importAll(JSON.parse(await f.text()));
    flash(`Imported ${count} patch(es) into the local cache. Save them through the bridge to get files.`);
  } catch (e) {
    flash(e.message);
  }
});
$('clear-acks').addEventListener('click', () => store.set({ [store.KEYS.ACKS]: {} }).then(() => flash('Forgotten')));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === MSG.BRIDGE_STATUS_EVENT) renderStatus();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[store.KEYS.PROFILE]) renderPresets(parseProfile(changes[store.KEYS.PROFILE].newValue || ''));
});

load();
