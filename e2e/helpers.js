import { expect } from '@playwright/test';

/** Type a request into the panel and wait for the agent to finish. */
export async function ask(panel, text) {
  await panel.locator('#prompt').fill(text);
  await panel.locator('#send').click();
  await expect(panel.locator('.card.finish')).toBeVisible({ timeout: 20000 });
  return panel.locator('.card.finish');
}

export async function save(panel) {
  await panel.locator('.card.finish button:has-text("Save")').click();
  await expect(panel.locator('.card.finish')).toHaveCount(0);
}
