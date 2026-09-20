import fs from 'node:fs';
import path from 'node:path';
import { test, expect, SITE } from './extension.js';
import { ask, save } from './helpers.js';

test('describe → preview → verify → save → persists across reloads → toggle off/on', async ({ context, ready, openPanel }) => {
  const page = await context.newPage();
  await page.goto(`${SITE()}/form.html`);
  const panel = await openPanel(page);
  await expect(panel.locator('#send')).toBeEnabled();

  const card = await ask(panel, 'hide #promo\ncss h1{color:rgb(255,0,0)}');
  await expect(card).toContainText('Verification passed');
  await expect(card.locator('.badge')).toHaveText('low risk');
  await expect(panel.locator('.report .check.ok')).toHaveCount(6);
  // the preview is live on the page
  await expect(page.locator('#promo')).toBeHidden();
  await expect(page.locator('h1')).toHaveCSS('color', 'rgb(255, 0, 0)');
  // the transcript shows the tool calls the agent made
  await expect(panel.locator('details.tool summary').first()).toContainText('Reading the page');

  await save(panel);
  await expect(panel.locator('.patch .name')).toHaveText('Fake patch');
  await expect(panel.locator('.patches h4')).toContainText('My view · active');
  await expect(page.locator('#promo')).toBeHidden();

  // patch.json + style.css exist on disk
  const dir = path.join(process.env.PERUSER_E2E_ROOT, 'sites', '127.0.0.1_48910', 'my-view', 'fake-patch');
  await expect.poll(() => fs.existsSync(path.join(dir, 'patch.json'))).toBe(true);
  expect(fs.readFileSync(path.join(dir, 'style.css'), 'utf8')).toContain('color:rgb(255,0,0)');
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'patch.json'), 'utf8'));
  expect(json.rules[0]).toEqual({ action: 'hide', selector: '#promo' });
  expect(json.css).toBeUndefined();

  // survives a reload (applied from the cache at document start)
  await page.reload();
  await expect(page.locator('#promo')).toBeHidden();
  await expect(page.locator('h1')).toHaveCSS('color', 'rgb(255, 0, 0)');
  // the form still submits the same data
  const payload = await page.evaluate(() => Object.fromEntries(new FormData(document.querySelector('form'))));
  expect(payload).toEqual({ csrf: 'token-123', email: '', name: '', plan: 'free' });

  // "unpatch" switch
  await panel.locator('#enabled').uncheck();
  await expect(page.locator('#promo')).toBeVisible();
  await expect(page.locator('h1')).not.toHaveCSS('color', 'rgb(255, 0, 0)');
  await panel.locator('#enabled').check();
  await expect(page.locator('#promo')).toBeHidden();

  // disabling one patch from the list
  await panel.locator('.patch input[type=checkbox]').uncheck();
  await expect(page.locator('#promo')).toBeVisible();
  await panel.locator('.patch input[type=checkbox]').check();
  await expect(page.locator('#promo')).toBeHidden();

  // delete
  panel.once('dialog', (d) => d.accept());
  await panel.locator('.patch button:has-text("Delete")').click();
  await expect(panel.locator('.patch')).toHaveCount(0);
  await expect(page.locator('#promo')).toBeVisible();
  await expect.poll(() => fs.existsSync(dir)).toBe(false);
});

test('refining a saved patch keeps its identity', async ({ context, ready, openPanel }) => {
  const page = await context.newPage();
  await page.goto(`${SITE()}/form.html`);
  const panel = await openPanel(page);
  await ask(panel, 'hide #promo');
  await save(panel);
  await panel.locator('.patch button:has-text("Refine")').click();
  await expect(panel.locator('#compose-hint')).toContainText('Refining');
  await ask(panel, 'hide #promo\nhide footer');
  await save(panel);
  await expect(panel.locator('.patch')).toHaveCount(1);
  await expect(page.locator('footer')).toBeHidden();
  await expect(page.locator('#promo')).toBeHidden();
});
