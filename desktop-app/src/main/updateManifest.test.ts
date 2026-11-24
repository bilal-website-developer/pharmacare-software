import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isNewerStableVersion, parseAndVerifyUpdateManifest } from './updateManifest';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function createManifest(overrides: Record<string, string> = {}) {
  const manifest = {
    version: '1.2.0',
    downloadUrl: 'https://updates.example.test/PharmaCare-1.2.0-Setup.exe',
    sha512: createHash('sha512').update('test installer').digest('base64'),
    ...overrides,
  };
  const signature = sign(
    null,
    Buffer.from(JSON.stringify(manifest)),
    keys.privateKey,
  ).toString('base64url');
  return { ...manifest, signature };
}

test('update manifest accepts a signed stable version and HTTPS installer', () => {
  const result = parseAndVerifyUpdateManifest(createManifest(), publicKey);
  assert.equal(result.version, '1.2.0');
  assert.equal(result.downloadUrl, 'https://updates.example.test/PharmaCare-1.2.0-Setup.exe');
});

test('update manifest rejects tampering, HTTP URLs, and malformed versions', () => {
  const valid = createManifest();
  assert.throws(() => parseAndVerifyUpdateManifest({ ...valid, version: '9.9.9' }, publicKey), /signature/i);
  assert.throws(() => parseAndVerifyUpdateManifest(createManifest({
    downloadUrl: 'http://updates.example.test/installer.exe',
  }), publicKey), /HTTPS/i);
  assert.throws(() => parseAndVerifyUpdateManifest(createManifest({ version: 'latest' }), publicKey), /fields are invalid/i);
});

test('stable update versions compare numerically and reject equal or older versions', () => {
  assert.equal(isNewerStableVersion('1.10.0', '1.9.9'), true);
  assert.equal(isNewerStableVersion('1.2.0', '1.2.0'), false);
  assert.equal(isNewerStableVersion('1.1.9', '1.2.0'), false);
  assert.equal(isNewerStableVersion('1.3.0-beta.1', '1.2.0'), false);
});

test('release script writes a manifest whose digest and signature match the installer', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacare-update-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const privateKeyPath = path.join(directory, 'test-private.pem');
  const installerPath = path.join(directory, 'test-installer.exe');
  const manifestPath = path.join(directory, 'latest.json');
  const scriptPath = fileURLToPath(new URL('../../../scripts/create-update-manifest.mjs', import.meta.url));
  const contents = Buffer.from('synthetic update artifact');
  fs.writeFileSync(privateKeyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(installerPath, contents);

  execFileSync(process.execPath, [
    scriptPath,
    '--installer', installerPath,
    '--private-key', privateKeyPath,
    '--version', '1.2.3',
    '--url', 'https://updates.example.test/PharmaCare-1.2.3-Setup.exe',
    '--output', manifestPath,
  ]);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(parseAndVerifyUpdateManifest(manifest, publicKey).sha512, createHash('sha512').update(contents).digest('base64'));
});
