# Central Licensing Production Setup

This configures only the central licensing service. Pharmacy transactions remain in the local encrypted database; Supabase stores shop/license administration metadata only.

## 1. Create Supabase project and schema

1. Create a Supabase project for the central service and configure its Auth provider for Developer Owner accounts.
2. In the Supabase SQL editor, run the checked-in [`licensing-schema.sql`](../central-backend/supabase/licensing-schema.sql).
3. Create and verify a Developer Owner through Supabase Auth. Add that user's UUID to `public.developer_owners` as an active Owner. The central API denies privileged shop-management routes to all other users.
4. Keep pharmacy transaction, customer, inventory, and purchase data out of this project.

The central API uses the Supabase REST/Auth endpoints with its service-role credential. Restrict that credential to the central service's secret store; never put it in a desktop build.

## 2. Generate an Ed25519 signing keypair

Generate the pair on a trusted administration workstation. Store the private PEM in the central host's secret manager and the public PEM in the desktop release build configuration. Do not commit either key.

```js
// Run as a one-off Node.js script on a trusted workstation.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
writeFileSync('central-license-private.pem', privateKey, { flag: 'wx', mode: 0o600 });
writeFileSync('central-license-public.pem', publicKey, { flag: 'wx' });
```

After transferring the private key into the central host's secret manager, securely remove the temporary private-key file according to the workstation's data-handling policy. Never provide the private key to Electron, Vite, or a customer PC.

## 3. Deploy the central API

Deploy `central-backend` as a Node.js web service with outbound HTTPS access to the Supabase project. Build and run the compiled server:

```powershell
npm ci
npm run build --workspace=central-backend
node central-backend/dist/server.js
```

Configure these names in the hosting provider's secret/environment settings (do not place secret values in source or renderer configuration):

- `CENTRAL_SUPABASE_URL`
- `CENTRAL_SUPABASE_SERVICE_KEY`
- `CENTRAL_LICENSE_PRIVATE_KEY`
- `CORS_ORIGIN` (only the trusted Developer Owner dashboard origin)
- `PORT` (when required by the provider)

The health endpoint is `GET /api/health`. Put the service behind HTTPS and use its HTTPS URL as the desktop build's `CENTRAL_API_URL`.

For testing and demonstrations, a Supabase free plan plus a free Node web-service tier can reduce cost. Free tiers may sleep, impose request/compute limits, or change terms; they are not an availability or data-retention guarantee and are not recommended for a production pharmacy licensing dependency. Verify the provider's current limitations before deployment and use a supported paid plan for production operations.

## 4. Build the desktop release

Use the matching public PEM and HTTPS API URL only as build-time public configuration:

```powershell
$env:CENTRAL_API_URL = 'https://licensing.example.invalid'
$env:CENTRAL_LICENSE_PUBLIC_KEY = Get-Content -Raw 'central-license-public.pem'
npm run desktop:package
```

The Electron bundle embeds only `CENTRAL_API_URL` and `CENTRAL_LICENSE_PUBLIC_KEY`. Do not define `CENTRAL_LICENSE_PRIVATE_KEY` or `CENTRAL_SUPABASE_SERVICE_KEY` in the desktop build environment. Protect release signing credentials separately; the current installer configuration is unsigned unless a publisher certificate is configured.

## 5. Create and activate a pharmacy

1. Sign in to the Developer Owner dashboard with a user present in `developer_owners`.
2. Create the pharmacy and issue a one-time activation code. Deliver the code through a private channel; it expires according to the activation-expiry setting.
3. Activate the pharmacy in the desktop application. The central API binds that redemption to the device fingerprint and returns an Ed25519-signed entitlement.
4. The desktop stores and verifies the signed entitlement locally. Check-ins require the same registered device; expiry, suspension/revocation, device binding, clock rollback, and offline grace are enforced locally.
5. Test activation, check-in, suspension, expiry, restore, and loss-of-network behavior with a non-production shop before issuing production licenses.

## Local development activation

No Supabase project or deployment is needed for local development:

```powershell
# Terminal 1: creates ignored dev signing keys and a test shop/code, then serves loopback only.
npm run central:dev

# Terminal 2: builds/starts the desktop renderer with the dev public key and local service URL.
npm run desktop:local

# Optional test installer; it is a local-development build, not a production release.
npm run desktop:local:package
```

`npm run central:dev` prints a one-time test activation code and stores its hash/state and Ed25519 keypair under the ignored `central-backend/.dev/` directory. The private key is never embedded in the desktop build. After a code is consumed, stop and restart the service to load a fresh pharmacy/code; `npm run central:dev:seed` can prepare that state before restarting. The service binds to `127.0.0.1`; do not expose it to a network.

## Recovery-key backups

The Shop Admin receives a recovery key during first-admin setup. Portable backup exports are authenticated-encrypted and wrap the local database key with that recovery key. Restore is available from Settings and from the login screen before sign-in; it verifies the backup and recovery-key verifier before replacing the local database. A restored database contains the original device-bound license; transferring to a replacement PC also requires an authorized new-device activation/reissue from the central licensing operator.
