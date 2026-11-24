import { createHash, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? '' : process.argv[index + 1] || '';
}

const installerArgument = option('installer');
const privateKeyArgument = option('private-key');
const installerPath = installerArgument ? path.resolve(installerArgument) : '';
const privateKeyPath = privateKeyArgument ? path.resolve(privateKeyArgument) : '';
const version = option('version');
const downloadUrl = option('url');
const outputArgument = option('output');
const outputPath = path.resolve(outputArgument || 'latest-update.json');
if (!installerPath || !privateKeyPath || !version || !downloadUrl) {
  console.error('Usage: node scripts/create-update-manifest.mjs --installer <exe> --private-key <pem> --version <x.y.z> --url <https-url> [--output <json>]');
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Version must use stable x.y.z format.');
const parsedUrl = new URL(downloadUrl);
if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
  throw new Error('Download URL must be a credential-free HTTPS URL.');
}
if (!fs.statSync(installerPath).isFile()) throw new Error('Installer path must be a file.');

const hasher = createHash('sha512');
for await (const chunk of fs.createReadStream(installerPath)) hasher.update(chunk);
const manifest = {
  version,
  downloadUrl: parsedUrl.toString(),
  sha512: hasher.digest('base64'),
};
const signature = sign(
  null,
  Buffer.from(JSON.stringify(manifest)),
  fs.readFileSync(privateKeyPath, 'utf8'),
).toString('base64url');
fs.writeFileSync(outputPath, `${JSON.stringify({ ...manifest, signature }, null, 2)}\n`, { flag: 'wx' });
console.log(`Signed update manifest created: ${outputPath}`);
