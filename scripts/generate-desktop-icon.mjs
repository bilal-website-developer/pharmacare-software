import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'public', 'pharma-care-512.png');
const buildPath = path.join(root, 'desktop-app', 'build');
const sizes = [16, 24, 32, 48, 64, 128, 256];

function resize(source, size) {
  const output = new PNG({ width: size, height: size, colorType: 6 });
  const scaleX = source.width / size;
  const scaleY = source.height / size;

  for (let y = 0; y < size; y += 1) {
    const sourceY = (y + 0.5) * scaleY - 0.5;
    const y0 = Math.max(0, Math.floor(sourceY));
    const y1 = Math.min(source.height - 1, y0 + 1);
    const fy = Math.max(0, sourceY - y0);
    for (let x = 0; x < size; x += 1) {
      const sourceX = (x + 0.5) * scaleX - 0.5;
      const x0 = Math.max(0, Math.floor(sourceX));
      const x1 = Math.min(source.width - 1, x0 + 1);
      const fx = Math.max(0, sourceX - x0);
      const samples = [
        [x0, y0, (1 - fx) * (1 - fy)],
        [x1, y0, fx * (1 - fy)],
        [x0, y1, (1 - fx) * fy],
        [x1, y1, fx * fy],
      ];
      let alpha = 0;
      const channels = [0, 0, 0];
      for (const [sampleX, sampleY, weight] of samples) {
        const index = (sampleY * source.width + sampleX) * 4;
        const sampleAlpha = source.data[index + 3] / 255;
        const contribution = weight * sampleAlpha;
        alpha += contribution;
        for (let channel = 0; channel < 3; channel += 1) {
          channels[channel] += source.data[index + channel] * contribution;
        }
      }
      const target = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        output.data[target + channel] = alpha === 0 ? 0 : Math.round(channels[channel] / alpha);
      }
      output.data[target + 3] = Math.round(alpha * 255);
    }
  }
  return PNG.sync.write(output);
}

function createIcon(frames) {
  const headerSize = 6 + frames.length * 16;
  const directory = Buffer.alloc(headerSize);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = headerSize;
  frames.forEach(({ size, image }, index) => {
    const entry = 6 + index * 16;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = size === 256 ? 0 : size;
    directory[entry + 2] = 0;
    directory[entry + 3] = 0;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  return Buffer.concat([directory, ...frames.map(({ image }) => image)]);
}

const sourceBuffer = fs.readFileSync(sourcePath);
const source = PNG.sync.read(sourceBuffer);
if (source.width !== 512 || source.height !== 512) {
  throw new Error('The desktop icon source must be a 512x512 PNG.');
}
if (!source.data.some((value, index) => index % 4 === 3 && value < 255)) {
  throw new Error('The desktop icon source must include transparent pixels.');
}

fs.mkdirSync(buildPath, { recursive: true });
fs.copyFileSync(sourcePath, path.join(buildPath, 'icon.png'));
const frames = sizes.map((size) => ({ size, image: resize(source, size) }));
fs.writeFileSync(path.join(buildPath, 'pharma-care.ico'), createIcon(frames));
