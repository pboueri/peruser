import { test, expect, SITE } from './extension.js';
import { ask, save } from './helpers.js';

test('a self-rerendering page is gated until acknowledged, and patches hold across re-renders', async ({ context, ready, openPanel }) => {
  const page = await context.newPage();
  await page.goto(`${SITE()}/spa.html`);
  await page.waitForTimeout(1500); // let the mutation rate build up
  const panel = await openPanel(page);
  await expect(panel.locator('#gate')).toBeVisible();
  await expect(panel.locator('#gate-reasons')).toContainText('re-renders');
  await expect(panel.locator('#send')).toBeDisabled();
  await panel.locator('#ack').click();
  await expect(panel.locator('#gate')).toBeHidden();
  await expect(panel.locator('#send')).toBeEnabled();

  const card = await ask(panel, 'hide #promo');
  await expect(card).toContainText('re-renders itself');
  await expect(card.locator('.badge')).toHaveText('medium risk');
  await save(panel);
  // the page replaces #promo every 100ms; the rule keeps catching the new one
  await page.waitForTimeout(600);
  await expect(page.locator('#promo')).toBeHidden();
  await expect(page.locator('#refresh')).toBeVisible();

  // the acknowledgement is remembered for the site
  const panel2 = await openPanel(page);
  await expect(panel2.locator('#send')).toBeEnabled();
  await expect(panel2.locator('#gate')).toBeHidden();
});
