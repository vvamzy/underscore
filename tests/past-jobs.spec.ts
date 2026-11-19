import { test, expect } from '@playwright/test';

test.use({ baseURL: 'http://localhost:8000' });

test.beforeEach(async ({ page }) => {
  // Navigate to the app
  await page.goto('/');

  // Wait for the server pill to show online (server is up and JS has run)
  await expect(page.locator('#serverPill')).toContainText('AI server', { timeout: 15000 });
});

test('Past Jobs page lists previous separations and plays a track', async ({ page }) => {
  // Click the Past jobs button
  await page.locator('#pastJobsBtn').click();

  // The jobs card should appear
  await expect(page.locator('#jobsCard')).toBeVisible();

  // Wait for jobs to load from the API
  await page.waitForSelector('.job-row', { state: 'visible', timeout: 10000 });

  // Check that at least one job row exists
  const jobRows = page.locator('.job-row');
  await expect(jobRows.first()).toBeVisible();

  // Click the first job's Karaoke play button
  const firstKaraokeBtn = page.locator('button').filter({ hasText: '▶ Karaoke' }).first();
  await expect(firstKaraokeBtn).toBeVisible();
  await firstKaraokeBtn.click();

  // The workspace should appear
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#dropzone')).toBeHidden();

  // Check that the player is playing (pause icon visible, not play icon)
  await page.waitForTimeout(1000);
  const pauseIcon = page.locator('#playBtn #iconPause');
  await expect(pauseIcon).not.toHaveClass('hidden');
});

test('Past jobs download buttons are present and distinct', async ({ page }) => {
  await page.locator('#pastJobsBtn').click();

  // Wait for jobs to load from the API
  await page.waitForSelector('.job-row', { state: 'visible', timeout: 10000 });

  // Check download buttons exist with distinct labels
  const karaokeDlBtn = page.locator('button').filter({ hasText: '↓ Karaoke WAV' }).first();
  const vocalsDlBtn = page.locator('button').filter({ hasText: '↓ Vocals WAV' }).first();

  await expect(karaokeDlBtn).toBeVisible();
  await expect(vocalsDlBtn).toBeVisible();
  await expect(karaokeDlBtn).toHaveText(/Karaoke/);
  await expect(vocalsDlBtn).toHaveText(/Vocals/);
});

test('Refresh button reloads jobs', async ({ page }) => {
  await page.locator('#pastJobsBtn').click();

  // Wait for jobs to load from the API
  await page.waitForSelector('.job-row', { state: 'visible', timeout: 10000 });

  const jobsBefore = await page.locator('.job-row').count();
  expect(jobsBefore).toBeGreaterThan(0);

  await page.locator('#refreshJobsBtn').click();
  await page.waitForTimeout(2000);

  const jobsAfter = await page.locator('.job-row').count();
  expect(jobsAfter).toBe(jobsBefore);
});
