import { test, expect, SITE } from './extension.js';

test('extension loads, connects to the bridge and the panel shows the site', async ({ context, ready, openPanel }) => {
  const page = await context.newPage();
  await page.goto(`${SITE()}/form.html`);
  const panel = await openPanel(page);
  await expect(panel.locator('#host')).toHaveText('127.0.0.1:48910');
  await expect(panel.locator('#bridge-dot')).toHaveClass(/on/);
  await expect(panel.locator('#send')).toBeEnabled();
  await expect(panel.locator('#harness')).toContainText('Fake');
});
