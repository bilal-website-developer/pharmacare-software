import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getWindowIconPath } from './windowIcon';

const appPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('window icon path exists in development and packaged resources', () => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pharma-icon-test-'));
  const packagedBuildPath = path.join(resourcesPath, 'build');
  fs.mkdirSync(packagedBuildPath);
  fs.copyFileSync(
    path.join(appPath, 'build', 'pharma-care.ico'),
    path.join(packagedBuildPath, 'pharma-care.ico'),
  );
  try {
    assert.ok(fs.existsSync(getWindowIconPath(false, appPath, resourcesPath)));
    assert.equal(
      getWindowIconPath(true, appPath, resourcesPath),
      path.join(packagedBuildPath, 'pharma-care.ico'),
    );
    assert.ok(fs.existsSync(getWindowIconPath(true, appPath, resourcesPath)));
  } finally {
    fs.rmSync(resourcesPath, { recursive: true, force: true });
  }
  assert.throws(
    () => getWindowIconPath(true, appPath, path.join(resourcesPath, 'missing-resources')),
    /window icon is missing/,
  );
});
