// Playwright fixtures: a persistent Chromium context with the unpacked
// extension loaded, the extension id, and helpers for the side panel.
import { test as base, chromium } from '@playwright/test';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const test = base.extend({
  context: async ({}, use) => {
    const userDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'peruser-profile-'));
    // Prefer a Chromium the environment provides (PERUSER_CHROMIUM or the
    // pre-installed /opt/pw-browsers/chromium); otherwise Playwright's own.
    const executablePath = [process.env.PERUSER_CHROMIUM, '/opt/pw-browsers/chromium'].find((p) => p && fs.existsSync(p));
    const context = await chromium.launchPersistentContext(userDir, {
      ...(executablePath ? { executablePath } : { channel: 'chromium' }),
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    await use(context);
    await context.close();
    await fsp.rm(userDir, { recursive: true, force: true });
  },
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw.url().split('/')[2]);
  },
  /** Points the extension at the test bridge and waits until it is connected. */
  ready: async ({ context, extensionId }, use) => {
    // start every test from an empty patch store
    const sites = path.join(process.env.PERUSER_E2E_ROOT, 'sites');
    for (const d of await fsp.readdir(sites)) await fsp.rm(path.join(sites, d), { recursive: true, force: true });
    await fsp.writeFile(path.join(process.env.PERUSER_E2E_ROOT, 'profile.md'), '# My preferences\n\n## Notes\n\n');
    await new Promise((r) => setTimeout(r, 500));
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
    await page.evaluate((port) => chrome.storage.local.set({ settings: { bridgePort: port, harness: 'fake', model: '', globalEnabled: true } }), Number(process.env.PERUSER_E2E_PORT));
    await page.waitForFunction(async () => {
      const r = await chrome.runtime.sendMessage({ type: 'bridge.status' });
      return r?.ok && r.result.connected;
    }, null, { timeout: 15000 });
    await page.close();
    await use(true);
  },
  /** Opens the side panel page for a given tab page. */
  openPanel: async ({ context, extensionId }, use) => {
    await use(async (page) => {
      const tabId = await page.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: 'peruser.tabid' }, r))).catch(() => null);
      // content scripts cannot ask for their own tab id; look it up from an extension page instead
      const helper = await context.newPage();
      await helper.goto(`chrome-extension://${extensionId}/src/options/options.html`);
      const id = await helper.evaluate(async (url) => (await chrome.tabs.query({ url })).at(-1)?.id, page.url());
      await helper.close();
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?tabId=${id ?? tabId}`);
      return panel;
    });
  },
});

export const expect = base.expect;
export const SITE = () => process.env.PERUSER_E2E_SITE;
