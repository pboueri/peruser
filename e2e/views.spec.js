import { test, expect, SITE } from './extension.js';
import { ask, save } from './helpers.js';

test('views hold separate patches and cycle Original → A → B → Original', async ({ context, ready, openPanel }) => {
  const page = await context.newPage();
  await page.goto(`${SITE()}/form.html`);
  const panel = await openPanel(page);
  await ask(panel, 'hide #promo');
  await save(panel);
  await expect(panel.locator('#view')).toHaveValue(/^v_/);
  const viewA = await panel.locator('#view').inputValue();

  panel.once('dialog', (d) => d.accept('Big text'));
  await panel.locator('#new-view').click();
  await expect(panel.locator('#view option')).toHaveCount(3);
  await expect(panel.locator('#view')).not.toHaveValue(viewA);
  await expect(page.locator('#promo')).toBeVisible(); // new view is empty
  await ask(panel, 'css body{font-size:22px}');
  await save(panel);
  await expect(page.locator('body')).toHaveCSS('font-size', '22px');
  await expect(page.locator('#promo')).toBeVisible();

  // cycle: Big text -> Original
  await panel.locator('#cycle').click();
  await expect(panel.locator('#view')).toHaveValue('');
  await expect(page.locator('body')).not.toHaveCSS('font-size', '22px');
  await expect(page.locator('#promo')).toBeVisible();
  // Original -> My view
  await panel.locator('#cycle').click();
  await expect(panel.locator('#view')).toHaveValue(viewA);
  await expect(page.locator('#promo')).toBeHidden();
  await expect(page.locator('body')).not.toHaveCSS('font-size', '22px');
  // My view -> Big text
  await panel.locator('#cycle').click();
  await expect(page.locator('body')).toHaveCSS('font-size', '22px');
  await expect(page.locator('#promo')).toBeVisible();
  // the picker works too
  await panel.locator('#view').selectOption(viewA);
  await expect(page.locator('#promo')).toBeHidden();
});
