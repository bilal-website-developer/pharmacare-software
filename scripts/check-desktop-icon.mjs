import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildPath = path.join(root, 'desktop-app', 'build');
const iconPath = path.join(buildPath, 'pharma-care.ico');
const pngPath = path.join(buildPath, 'icon.png');
const logoPath = path.join(root, 'public', 'pharma-care-512.png');
const builderPath = path.join(root, 'desktop-app', 'electron-builder.yml');
const mainPath = path.join(root, 'desktop-app', 'src', 'main', 'index.ts');
const windowIconPath = path.join(root, 'desktop-app', 'src', 'main', 'windowIcon.ts');

const pngIcon = fs.readFileSync(pngPath);
const originalLogo = fs.readFileSync(logoPath);
assert.deepEqual(pngIcon, originalLogo, 'desktop-app/build/icon.png must be an exact copy of the source logo.');
const pngImage = PNG.sync.read(pngIcon);
assert.equal(pngImage.width, 512);
assert.equal(pngImage.height, 512);
assert.ok(pngImage.data.some((value, index) => index % 4 === 3 && value < 255), 'The PNG icon must retain transparency.');

const icon = fs.readFileSync(iconPath);
assert.equal(icon.readUInt16LE(0), 0);
assert.equal(icon.readUInt16LE(2), 1);
const frameCount = icon.readUInt16LE(4);
assert.ok(frameCount >= 4, 'The ICO must contain at least four sizes.');

const frames = new Map();
for (let index = 0; index < frameCount; index += 1) {
  const entryOffset = 6 + index * 16;
  const width = icon[entryOffset] || 256;
  const height = icon[entryOffset + 1] || 256;
  const byteLength = icon.readUInt32LE(entryOffset + 8);
  const imageOffset = icon.readUInt32LE(entryOffset + 12);
  assert.ok(imageOffset + byteLength <= icon.length, 'ICO frame data must be within the file.');
  const frame = PNG.sync.read(icon.subarray(imageOffset, imageOffset + byteLength));
  assert.equal(frame.width, width);
  assert.equal(frame.height, height);
  assert.ok(frame.data.some((value, pixel) => pixel % 4 === 3 && value < 255), `${width}px frame must retain transparency.`);
  frames.set(width, height);
}
for (const size of [16, 24, 32, 48, 64, 128, 256]) {
  assert.equal(frames.get(size), size, `ICO must contain a ${size}px frame.`);
}

const builder = fs.readFileSync(builderPath, 'utf8');
const appId = builder.match(/^appId:\s*(\S+)\s*$/m)?.[1];
assert.ok(appId, 'electron-builder.yml must declare appId.');
for (const setting of ['icon', 'installerIcon', 'uninstallerIcon', 'installerHeaderIcon']) {
  assert.match(builder, new RegExp(`^\\s*${setting}:\\s*build/pharma-care\\.ico\\s*$`, 'm'));
}
assert.match(builder, /from:\s*build\/pharma-care\.ico/);
assert.match(builder, /from:\s*build\/icon\.png/);

const main = fs.readFileSync(mainPath, 'utf8');
assert.ok(main.includes(`const APP_USER_MODEL_ID = '${appId}'`));
assert.match(main, /app\.setAppUserModelId\(APP_USER_MODEL_ID\)/);
assert.match(main, /icon:\s*getWindowIconPath\(app\.isPackaged,\s*app\.getAppPath\(\),\s*process\.resourcesPath\)/);

const windowIcon = fs.readFileSync(windowIconPath, 'utf8');
assert.match(windowIcon, /resourcesPath,\s*'build',\s*'pharma-care\.ico'/);
assert.match(windowIcon, /appPath,\s*'build',\s*'pharma-care\.ico'/);
assert.ok(fs.existsSync(iconPath), 'Development window icon path must exist.');

console.log(`Desktop icon check passed (${frameCount} ICO frames).`);
