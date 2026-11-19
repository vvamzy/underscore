const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const output = mkdtempSync(join(tmpdir(), 'underscore-ui-'));
try {
  const result = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', ...process.argv.slice(2)], {
    env: { ...process.env, UNDERSCORE_TEST_OUTPUT_DIR: output },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(output, { force: true, recursive: true, maxRetries: 5 });
}
