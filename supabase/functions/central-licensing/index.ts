import { createCentralLicensingHandler } from './handler.ts';

const handler = createCentralLicensingHandler({
  supabaseUrl: Deno.env.get('SUPABASE_URL') || '',
  serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
  licensePrivateKey: Deno.env.get('CENTRAL_LICENSE_PRIVATE_KEY') || '',
  corsOrigins: (Deno.env.get('CORS_ORIGIN') || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
});

Deno.serve(handler);
