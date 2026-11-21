import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(scriptDir, '../.production-keys');
const privateKeyPath = path.join(outputDir, 'license-private.pem');
const publicKeyPath = path.join(outputDir, 'license-public.pem');

fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
if (fs.existsSync(privateKeyPath) || fs.existsSync(publicKeyPath)) {
  console.error('Production signing key files already exist; refusing to overwrite them.');
  process.exit(1);
}
if (process.platform === 'win32') {
  const domain = process.env.USERDOMAIN;
  const account = domain ? `${domain}\\${os.userInfo().username}` : os.userInfo().username;
  execFileSync('icacls', [
    outputDir,
    '/inheritance:r',
    '/grant:r',
    `${account}:(OI)(CI)F`,
  ], { stdio: 'ignore' });
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

let privateKeyWritten = false;
let publicKeyWritten = false;
try {
  fs.writeFileSync(privateKeyPath, privateKey, { flag: 'wx', mode: 0o600 });
  privateKeyWritten = true;
  fs.writeFileSync(publicKeyPath, publicKey, { flag: 'wx', mode: 0o644 });
  publicKeyWritten = true;
} catch (error) {
  if (privateKeyWritten) fs.rmSync(privateKeyPath, { force: true });
  if (publicKeyWritten) fs.rmSync(publicKeyPath, { force: true });
  throw error;
}

console.log('Production Ed25519 keypair created. Key contents were not displayed.');
console.log(`Private key file: ${privateKeyPath}`);
console.log(`Public key file: ${publicKeyPath}`);
