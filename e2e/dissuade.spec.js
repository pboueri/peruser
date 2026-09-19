import { test, expect, SITE } from './extension.js';
import { ask } from './helpers.js';

test('a patch that breaks controls fails verification and is not offered for saving', async ({ context, ready, openPanel }) => {
  const page = await context.newPage();
  await page.goto(`${SITE()}/form.html`);
  const panel = await openPanel(page);
  const card = await ask(panel, 'break');
  await expect(card).toContainText('verification failed');
  await expect(card.locator('.badge')).toHaveText('high risk');
  await expect(card.locator('button:has-text("Save")')).toHaveCount(0);
  await expect(card).toContainText('Instead: Ask for a smaller change');
  const report = panel.locator('.report');
  await expect(report).toContainText('Links, buttons and fields still work');
  await expect(report.locator('.check.bad')).toHaveCount(1);
  await expect(report).toContainText('Create account');
  // the preview was cleared: buttons are back
  await expect(page.locator('#submit')).toBeVisible();
});

test('touching a server-side attribute is rejected before it reaches the page', async ({ context, ready, openPanel }) => {
  const page = await context.newPage();
  await page.goto(`${SITE()}/form.html`);
  const panel = await openPanel(page);
  const card = await ask(panel, 'attr #email name=zzz');
  await expect(card).toContainText('rejected');
  await expect(card).toContainText('protected');
  await expect(card.locator('button:has-text("Save")')).toHaveCount(0);
  await expect(page.locator('#email')).toHaveAttribute('name', 'email');
});

test('a high-risk patch needs an explicit acknowledgement', async ({ context, ready, openPanel }) => {
  const page = await context.newPage();
  await page.goto(`${SITE()}/form.html`);
  const panel = await openPanel(page);
  const card = await ask(panel, 'risky\nvalue #name => Jane');
  await expect(card.locator('.badge')).toHaveText('high risk');
  await expect(card).toContainText('changes how you interact');
  panel.once('dialog', (d) => d.accept());
  await card.locator('button:has-text("Save")').click();
  await expect(card).toBeVisible(); // refused without the tick
  await card.locator('input[type=checkbox]').check();
  await card.locator('button:has-text("Save")').click();
  await expect(panel.locator('.card.finish')).toHaveCount(0);
  await expect(page.locator('#name')).toHaveValue('Jane');
  // and the declined part shows up when the agent refuses something
  const card2 = await ask(panel, 'refuse rename the email field\nnopatch');
  await expect(card2).toContainText('Not done:');
  await expect(card2).toContainText('Hide or restyle the field instead');
});
