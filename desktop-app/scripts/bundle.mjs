import { build } from 'esbuild';

const centralApiUrl = process.env.CENTRAL_API_URL || process.env.VITE_CENTRAL_API_URL || '';
const centralLicensePublicKey = process.env.CENTRAL_LICENSE_PUBLIC_KEY || '';
const centralSupabaseAnonKey = process.env.CENTRAL_SUPABASE_ANON_KEY || '';
const updateManifestUrl = process.env.PHARMA_UPDATE_MANIFEST_URL || '';
const updateManifestPublicKey = process.env.PHARMA_UPDATE_MANIFEST_PUBLIC_KEY || '';
if (centralApiUrl) {
  const parsed = new URL(centralApiUrl);
  if (
    !['https:', 'http:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('CENTRAL_API_URL must be an HTTP(S) URL without credentials, query, or fragment.');
  }
  if (
    parsed.hostname.endsWith('.supabase.co')
    && parsed.pathname.includes('/functions/v1/central-licensing')
    && !centralSupabaseAnonKey
  ) {
    throw new Error('CENTRAL_SUPABASE_ANON_KEY is required for Supabase Edge Function licensing.');
  }
}
if (updateManifestUrl) {
  const parsed = new URL(updateManifestUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('PHARMA_UPDATE_MANIFEST_URL must be a credential-free HTTPS URL.');
  }
  if (!updateManifestPublicKey) {
    throw new Error('PHARMA_UPDATE_MANIFEST_PUBLIC_KEY is required when the update feed is configured.');
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
    'process.env.CENTRAL_SUPABASE_ANON_KEY': JSON.stringify(centralSupabaseAnonKey),
    'process.env.PHARMA_UPDATE_MANIFEST_URL': JSON.stringify(updateManifestUrl),
    'process.env.PHARMA_UPDATE_MANIFEST_PUBLIC_KEY': JSON.stringify(updateManifestPublicKey),
    'process.env.PHARMA_LOCAL_LICENSE_DEV': JSON.stringify(process.env.PHARMA_LOCAL_LICENSE_DEV === 'true' ? 'true' : ''),
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
