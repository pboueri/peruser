import fs from 'node:fs';
import path from 'node:path';
import { test, expect, SITE } from './extension.js';
import { ask, save } from './helpers.js';

test('editing files on disk updates the page live; the source editor writes files', async ({ context, ready, openPanel }) => {
  const page = await context.newPage();
  await page.goto(`${SITE()}/form.html`);
  const panel = await openPanel(page);
  await ask(panel, 'css h1{color:rgb(255,0,0)}');
  await save(panel);
  await expect(page.locator('h1')).toHaveCSS('color', 'rgb(255, 0, 0)');
  const dir = path.join(process.env.PERUSER_E2E_ROOT, 'sites', '127.0.0.1_48910', 'my-view', 'fake-patch');

  fs.writeFileSync(path.join(dir, 'style.css'), 'h1{color:rgb(0,128,0)}');
  await expect(page.locator('h1')).toHaveCSS('color', 'rgb(0, 128, 0)', { timeout: 5000 });

  const json = JSON.parse(fs.readFileSync(path.join(dir, 'patch.json'), 'utf8'));
  json.name = 'Green heading';
  json.rules = [{ action: 'setText', selector: 'h1', text: 'Hello from disk' }];
  fs.writeFileSync(path.join(dir, 'patch.json'), JSON.stringify(json, null, 2));
  await expect(page.locator('h1')).toHaveText('Hello from disk', { timeout: 5000 });
  await expect(panel.locator('.patch .name')).toHaveText('Green heading');

  // source editor in the panel
  await panel.locator('.patch button:has-text("Source")').click();
  const dialog = panel.locator('#editor');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#editor-json')).toHaveValue(/Green heading/);
  await dialog.locator('#editor-css').fill('h1{color:rgb(0,0,255)}');
  await dialog.locator('#editor-json').fill('{ broken');
  await dialog.locator('#editor-save').click();
  await expect(dialog.locator('#editor-error')).toContainText('patch.json');
  await dialog.locator('#editor-json').fill(JSON.stringify({ ...json, name: 'Blue heading' }));
  await dialog.locator('#editor-save').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('h1')).toHaveCSS('color', 'rgb(0, 0, 255)');
  await expect.poll(() => fs.readFileSync(path.join(dir, 'style.css'), 'utf8')).toContain('rgb(0,0,255)');
  await expect(panel.locator('.patch .name')).toHaveText('Blue heading');

  // deleting the folder deletes the patch
  fs.rmSync(dir, { recursive: true });
  await expect(page.locator('h1')).toHaveText('Create your account', { timeout: 5000 });
  await expect(panel.locator('.patch')).toHaveCount(0);
});
