import { build } from 'esbuild';

const centralApiUrl = process.env.CENTRAL_API_URL || process.env.VITE_CENTRAL_API_URL || '';
const centralLicensePublicKey = process.env.CENTRAL_LICENSE_PUBLIC_KEY || '';
if (centralApiUrl) {
  const parsed = new URL(centralApiUrl);
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('CENTRAL_API_URL must use HTTP or HTTPS.');
  }
}

await build({
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', 'better-sqlite3-multiple-ciphers', '@node-rs/argon2'],
  define: {
    'process.env.CENTRAL_API_URL': JSON.stringify(centralApiUrl),
    'process.env.CENTRAL_LICENSE_PUBLIC_KEY': JSON.stringify(centralLicensePublicKey),
    'process.env.PHARMA_DESKTOP_HOST': JSON.stringify('true'),
  },
});

await build({
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
