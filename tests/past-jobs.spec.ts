import { expect, test } from '@playwright/test';

test('lists a saved separation and plays its karaoke WAV', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#serverPill')).toHaveClass(/\bonline\b/);
  await page.getByRole('button', { name: 'Past jobs' }).click();
  await expect(page.locator('#jobsCard')).toBeVisible();
  await expect(page.locator('.job-row')).toContainText('fixture.wav');
  await expect(page.locator('#jobsCount')).toHaveText('1 job');
  await page.getByRole('button', { name: '▶ Karaoke', exact: true }).click();
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#dropzone')).toBeHidden();
  await expect.poll(() => page.locator('#player').evaluate((element) => {
    const audio = element as HTMLAudioElement;
    return !audio.paused && audio.currentTime > 0 && audio.currentSrc.endsWith('/karaoke.wav');
  })).toBe(true);
});

test('downloads both saved WAVs with distinct filenames', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Past jobs' }).click();
  for (const [label, stem] of [['Karaoke', 'karaoke'], ['Vocals', 'vocals']]) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: `↓ ${label} WAV` }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`fixture_${stem}.wav`);
    expect(download.url()).toMatch(new RegExp(`/${stem}\\.wav$`));
    expect(await download.failure()).toBeNull();
  }
});

test('refresh requests a fresh list of saved jobs', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Past jobs' }).click();
  await expect(page.locator('.job-row')).toHaveCount(1);
  await page.route('**/api/past-jobs', (route) => route.fulfill({ json: { jobs: [] } }));
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('No past jobs yet.', { exact: false })).toBeVisible();
  await expect(page.locator('#jobsCount')).toHaveText('0 jobs');
});

test('shows older jobs on demand', async ({ page }) => {
  const jobs = Array.from({ length: 51 }, (_, i) => ({ id: String(i), filename: `track ${i}` }));
  await page.route('**/api/past-jobs', (route) => route.fulfill({ json: { jobs } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Past jobs' }).click();
  await expect(page.locator('.job-row')).toHaveCount(50);
  const more = page.getByRole('button', { name: 'Show more jobs' });
  await more.click();
  await expect(page.locator('.job-row')).toHaveCount(51);
  await expect(more).toBeHidden();
});

test('health reports torch status and saved audio has no permissive CORS header', async ({ request }) => {
  const origin = 'http://localhost:8000';
  const health = await request.get('/api/health', { headers: { Origin: origin } });
  expect(health.ok()).toBe(true);
  expect(await health.json()).toHaveProperty('torch');
  expect(health.headers()['access-control-allow-origin']).toBe(origin);
  const headers = { Origin: 'https://example.invalid' };
  for (const path of ['/api/past-jobs', '/outputs/000000000001/karaoke.wav']) {
    const response = await request.get(path, { headers });
    expect(response.ok()).toBe(true);
    expect(response.headers()['access-control-allow-origin']).toBeUndefined();
  }
});
