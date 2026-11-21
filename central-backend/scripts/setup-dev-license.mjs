import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const configDir = path.resolve(scriptDir, '../.dev');
const privateKeyPath = path.join(configDir, 'license-private.pem');
const publicKeyPath = path.join(configDir, 'license-public.pem');
const statePath = path.join(configDir, 'state.json');
const activationCodePath = path.join(configDir, 'activation-code.txt');

fs.mkdirSync(configDir, { recursive: true });

if (!fs.existsSync(privateKeyPath) || !fs.existsSync(publicKeyPath)) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'w' });
  fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'w' });
}

let state;
if (fs.existsSync(statePath)) {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

let activationCode;
if (state && !state.activationUsed && fs.existsSync(activationCodePath)) {
  activationCode = fs.readFileSync(activationCodePath, 'utf8').trim();
} else {
  activationCode = randomBytes(24).toString('hex').toUpperCase();
  const activationCodeHash = createHash('sha256').update(activationCode).digest('hex');
  state = {
    shopId: randomUUID(),
    shopName: 'Pharma Care Local Development',
    shopStatus: 'ACTIVE',
    licenseStatus: 'ACTIVE',
    expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
    graceDays: 30,
    activationCodeHash,
    activationUsed: false,
    hardwareId: null,
  };
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(activationCodePath, `${activationCode}\n`, { mode: 0o600 });
}

console.log(`Development pharmacy: ${state.shopName}`);
console.log(`One-time activation code: ${activationCode}`);
console.log('Development signing keys are stored in the ignored central-backend/.dev directory.');
