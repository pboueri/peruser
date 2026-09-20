import { test, expect, SITE } from './extension.js';
import { ask, save } from './helpers.js';

test('an exact-page patch does not leak to other pages; a site patch does', async ({ context, ready, openPanel }) => {
  const page = await context.newPage();
  await page.goto(`${SITE()}/form.html`);
  const panel = await openPanel(page);
  await panel.locator('#scope').selectOption('exact');
  await ask(panel, 'hide #promo');
  await save(panel);
  await expect(panel.locator('.patch .meta')).toContainText('127.0.0.1:48910/form.html');
  await expect(page.locator('#promo')).toBeHidden();
  await page.goto(`${SITE()}/about.html`);
  await expect(page.locator('#promo')).toBeVisible();
  await page.goto(`${SITE()}/form.html`);
  await expect(page.locator('#promo')).toBeHidden();

  const panel2 = await openPanel(page);
  await panel2.locator('#scope').selectOption('origin');
  await ask(panel2, 'css h1{color:rgb(255,0,0)}');
  await save(panel2);
  await page.goto(`${SITE()}/about.html`);
  await expect(page.locator('h1')).toHaveCSS('color', 'rgb(255, 0, 0)');
  await expect(page.locator('#promo')).toBeVisible();
});

test('without the bridge, saved patches still apply and the panel says what to do', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await page.evaluate(() => chrome.storage.local.set({ settings: { bridgePort: 1, harness: 'fake', model: '', globalEnabled: true } }));
  await page.evaluate((origin) =>
    chrome.storage.local.set({
      views: { v1: { id: 'v1', origin, name: 'Cached', createdAt: 1 } },
      activeViews: { [origin]: 'v1' },
      patches: { p1: { id: 'p1', viewId: 'v1', name: 'Cached patch', scope: { type: 'origin', origin }, css: 'h1{color:rgb(0,0,255)}', rules: [], enabled: true, updatedAt: 1 } },
    }), new URL(process.env.PERUSER_E2E_SITE).origin);
  const site = await context.newPage();
  await site.goto(`${process.env.PERUSER_E2E_SITE}/form.html`);
  await expect(site.locator('h1')).toHaveCSS('color', 'rgb(0, 0, 255)');
  const helper = await context.newPage();
  await helper.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  const id = await helper.evaluate(async (url) => (await chrome.tabs.query({ url })).at(-1)?.id, site.url());
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?tabId=${id}`);
  await expect(panel.locator('#notice')).toContainText('npx peruser-bridge');
  await expect(panel.locator('#send')).toBeDisabled();
  await expect(panel.locator('.patch .name')).toHaveText('Cached patch');
});
