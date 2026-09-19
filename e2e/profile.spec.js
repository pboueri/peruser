import fs from 'node:fs';
import path from 'node:path';
import { test, expect, SITE } from './extension.js';
import { save } from './helpers.js';

test('the preferences profile is edited in options, stored as profile.md, and applied with one click', async ({ context, extensionId, ready, openPanel }) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await expect(options.locator('#presets label')).toHaveCount(10);
  await options.locator('#presets input[value="larger-text"]').check();
  await options.locator('#presets input[value="hide-promos"]').check();
  await options.locator('#notes').fill('Soft colours please');
  await options.locator('#save-profile').click();
  await expect(options.locator('#profile-status')).toHaveText('Saved to profile.md');
  const file = path.join(process.env.PERUSER_E2E_ROOT, 'profile.md');
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('- [x] Larger text');
  expect(fs.readFileSync(file, 'utf8')).toContain('Soft colours please');

  const page = await context.newPage();
  await page.goto(`${SITE()}/form.html`);
  const panel = await openPanel(page);
  await expect(panel.locator('#tailor')).toBeEnabled();
  await panel.locator('#tailor').click();
  const card = panel.locator('.card.finish');
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card).toContainText('Tailored to my profile');
  await expect(card).toContainText('Applied your note: Soft colours please');
  await expect(page.locator('html')).toHaveCSS('font-size', '20px');
  await expect(page.locator('#promo')).toBeHidden();
  await save(panel);
  await expect(panel.locator('.patch .name')).toHaveText('Tailored to my profile');

  // editing profile.md by hand reaches the options page
  fs.writeFileSync(file, '# My preferences\n- [x] Prefer dark\n## Notes\n');
  await expect(options.locator('#presets input[value="dark"]')).toBeChecked({ timeout: 5000 });
  await expect(options.locator('#presets input[value="larger-text"]')).not.toBeChecked();
  await expect(options.locator('#notes')).toHaveValue('');
});

test('tailor is disabled while the profile is empty', async ({ context, ready, openPanel }) => {
  const page = await context.newPage();
  await page.goto(`${SITE()}/form.html`);
  const panel = await openPanel(page);
  await expect(panel.locator('#send')).toBeEnabled();
  await expect(panel.locator('#tailor')).toBeDisabled();
});
