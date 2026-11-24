const requiredVariables = ['CENTRAL_API_URL', 'CENTRAL_LICENSE_PUBLIC_KEY'];
const centralApiUrl = process.env.CENTRAL_API_URL?.trim();
const usesSupabaseEdgeFunction = (() => {
  if (!centralApiUrl) return false;
  try {
    const url = new URL(centralApiUrl);
    return url.hostname.endsWith('.supabase.co')
      && url.pathname.includes('/functions/v1/central-licensing');
  } catch {
    return false;
  }
})();
if (usesSupabaseEdgeFunction) requiredVariables.push('CENTRAL_SUPABASE_ANON_KEY');
const missingVariables = requiredVariables.filter((name) => !process.env[name]?.trim());

if (missingVariables.length > 0) {
  console.error(
    `Cannot package Pharma Care: set ${missingVariables.join(' and ')} before running npm run desktop:package.`,
  );
  process.exit(1);
}
