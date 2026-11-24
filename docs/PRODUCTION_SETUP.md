# Production setup: central licensing

This guide uses one Supabase project for the web app and central licensing. The licensing tables are prefixed `central_` so they do not collide with the app's tables. Desktop pharmacy transactions remain in each desktop installation's encrypted local database.

Do not paste real credentials into source files, commits, chat, or this guide. Replace angle-bracket placeholders privately in the provider's secret settings. This project has not been connected to or deployed against a production Supabase project.

## Deployment security stop (2026-11-23)

A prior local commit (`3b96d3f`) captured credential material in the Render blueprint. The owner reports rotating the affected Supabase service-role key; never reuse the old value. The separate signing key was also treated as compromised. On 2026-11-25, the old local keypair was replaced with a fresh pair after assuming no real production shops had been licensed. If any real shop was licensed with the old key, stop and plan a client-key rollover before activating production.

The owner's new Supabase project is the only project available and is intended for the whole application. The Edge Function keeps the signing key in Supabase Function Secrets; the browser and desktop receive only the public anon key and the public signing key.

The replacement keypair is stored locally in the ignored `central-backend/.production-keys/` directory; the private key contents were not displayed or committed. Add that private key to the Supabase Edge Function secret named `CENTRAL_LICENSE_PRIVATE_KEY`. The public key is safe to distribute and must be provided to desktop packaging through `CENTRAL_LICENSE_PUBLIC_KEY`. GitHub publication will use a clean snapshot based on the existing remote branch, excluding the unpublished history that contains the old values.

## What you need

- The new Supabase project for the whole application.
- A Supabase Auth account for each Developer Owner.
- Supabase CLI (`npx supabase`) for deploying the Edge Function.
- A static host for the Developer Owner dashboard. The dashboard can be built and hosted separately; it does not need a Node API host.
- A trusted workstation for signing-key generation.
- A secure way to enter the private signing key in Supabase Function Secrets and distribute the public key with desktop releases.

## 1. Create the Supabase project

1. Keep the new project. It can hold the web app and licensing metadata; the licensing objects in [`supabase/production/setup.sql`](../supabase/production/setup.sql) use `central_` names and do not alter the app's `shops` or `licenses` tables.
2. Run [`supabase/production/setup.sql`](../supabase/production/setup.sql) in the new project's **SQL Editor**. It creates the central licensing tables, RLS/grants, atomic activation/reissue functions, and announcement storage.
3. In **Authentication → Users**, create the first Developer Owner account. Confirm that the account can sign in.
4. Copy that account's user UUID from the Supabase dashboard. In SQL Editor, replace the placeholder below with that UUID, then run:

   ```sql
   insert into public.central_developer_owners (user_id, is_active)
   values ('<AUTH_USER_UUID>', true)
   on conflict (user_id) do update set is_active = true;
   ```

5. Keep the Supabase URL, project ref, anon key, and service-role key private to your workstation/provider settings. The anon key is public; never copy the service-role key into the dashboard or desktop build.

The SQL enables RLS and grants central table/function access to `service_role`; it does not grant browser users direct access to licensing records. The Edge Function uses the project's service key server-side and checks every Developer endpoint against the `central_developer_owners` allowlist. Because this is a shared project, keep the service key only in Supabase's protected function environment; the key is project-wide privileged.

The public activation and check-in routes currently have no distributed rate limiter (request bodies are bounded to 64 KiB). Configure and verify provider/API abuse protections and monitoring before real shop traffic; CORS is not an access-control mechanism for non-browser clients.

**Whole web-app setup:** The new project also needs PharmaCare's app database schema and migrations. The checked-in `supabase/baseline/00_baseline_schema.sql` is explicitly marked reconstructed/incomplete, so do not treat the licensing SQL as a replacement for the app bootstrap. Confirm the full app schema/migration sequence before relying on web mode.

## 2. Generate production signing keys

On a trusted workstation in the repository root, run:

```powershell
npm run central:keys:generate
```

The script creates an Ed25519 pair under the ignored `central-backend/.production-keys/` directory. It refuses to overwrite an existing pair, restricts the directory to the current Windows user (and uses private directory/file modes on POSIX), and prints only file paths, never key contents. Back up the private key in an approved secrets vault. Do not commit it, upload it to the desktop, or put it in a renderer/dashboard build setting. The public key is safe to distribute with desktop builds.

The current local pair is compromised as described above and must not be used. The generator refuses to overwrite an existing pair. Only after confirming that no real shop used it, remove the two named files and run the generator again. Never copy the private key into Git, the desktop, or the dashboard.

## 3. Deploy the central API as a Supabase Edge Function

The `central-licensing` Edge Function implements activation, check-in, Developer Owner shop/licence management, reissue, and announcements. It uses the same Supabase project as the dashboard and the app. No Render service is required.

1. In the Supabase dashboard, add these Edge Function secrets:

   | Secret name | Value |
   |---|---|
   | `CENTRAL_LICENSE_PRIVATE_KEY` | Contents of the replacement Ed25519 private PEM |
   | `CORS_ORIGIN` | Exact HTTPS origin of the Developer dashboard |

   Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to Edge Functions. Do not put either service-role key or signing private key in source control or client build variables.
2. From the repository root, link the CLI to the new project and deploy only this function:

   ```powershell
   npx supabase link --project-ref <PROJECT_REF>
   npx supabase functions deploy central-licensing --project-ref <PROJECT_REF>
   ```

3. The central API base URL is:

   ```text
   https://<PROJECT_REF>.supabase.co/functions/v1/central-licensing
   ```

   Add `/api/health` to that URL to verify the function's health route. The function gateway has JWT verification disabled only so desktop activation can reach public activation/check-in routes; the function itself verifies Supabase Auth and Developer Owner authorization for every management route.

## 4. Deploy the Developer Owner dashboard with Vercel

The root `vercel.json` uses Vercel Services (currently Beta) for two frontends:

- `pharmacare-web` serves the existing pharmacy app at `/`.
- `developer-dashboard` serves the owner dashboard at `/developer/`; the build sets Vite's asset base so dashboard assets also load under that path.

The central API remains the Supabase `central-licensing` Edge Function, not a Vercel service. The Electron `local-backend` is a loopback-only encrypted SQLite server and must stay on the pharmacy PC. No Vercel service bindings are needed: both browser frontends call Supabase directly, and the dashboard calls the public Edge Function. Bindings are only for server-side service-to-service requests.

In Vercel, import the existing repository and keep the repository root (`.`) as the project root. The per-service build commands and output directories are configured in `vercel.json`. The rewrites route `/developer` and `/developer/*` to the dashboard and all other paths to the pharmacy web app. Do not configure `central-backend` or `local-backend` as public services for this deployment.

Set these **build-time** variables in Vercel's project settings under **Settings → Environment Variables**. Add them for Production and Preview as needed:

| Name | Value to provide |
|---|---|
| `VITE_CENTRAL_API_URL` | `https://<PROJECT_REF>.supabase.co/functions/v1/central-licensing` |
| `VITE_SUPABASE_URL` | `<SUPABASE_PROJECT_URL>` |
| `VITE_SUPABASE_ANON_KEY` | `<SUPABASE_PUBLIC_ANON_KEY>` |

Only the public anon key belongs in the dashboard. Never use the service-role key there. Rebuild and deploy the dashboard after changing these values. After the first production deployment, copy its stable `https://<project>.vercel.app` origin into the Supabase Function Secret `CORS_ORIGIN` and deploy the Edge Function. Avoid using a temporary Preview URL as the production CORS origin. Add these values in Vercel's settings, not in a committed `.env` file.

Vercel deployment does not require another Supabase project. If the repository is not already available to Vercel, do not add a Git remote or push unless you choose to; a local Vercel CLI deployment is another option.

## 5. Build the production desktop installer

In PowerShell, provide the HTTPS central URL and matching public PEM as placeholders in your private build environment, then build:

```powershell
$env:CENTRAL_API_URL = 'https://<PROJECT_REF>.supabase.co/functions/v1/central-licensing'
$env:CENTRAL_SUPABASE_ANON_KEY = '<SUPABASE_PUBLIC_ANON_KEY>'
$env:CENTRAL_LICENSE_PUBLIC_KEY = '<CONTENTS_OF_LICENSE_PUBLIC_PEM>'
npm run desktop:package
```

The package preflight requires the API URL, matching public signing key, and (for Supabase Edge Function URLs) the public anon key. It does not read `.env` files or print configured values. Never set the signing private key or service-role key for a desktop build.

The installer is written to `desktop-app/release/PharmaCare-<VERSION>-Setup.exe`. The Windows installer is unsigned unless a publisher certificate is configured. Sign and verify releases before distribution.

## 6. Issue, activate, and reissue licenses

1. Sign in to the dashboard with a user listed as active in `public.central_developer_owners`.
2. Create a pharmacy and deliver its single-use activation key privately. The key is shown once and expires after its configured period.
3. Activate the desktop app. The central API binds the signed license to that PC; the desktop checks signature, expiry, status, device binding, and offline grace locally.
4. To move a license, select **Reissue licence for a new PC** on that pharmacy. Confirm the warning, then copy the new one-time key privately. The database function atomically removes prior device registrations and unused activation keys before creating the replacement key. Only an active license can be reissued.
5. Activate the replacement PC with the new key. A disconnected old PC may continue under its already-signed offline entitlement until its grace period expires; reissue is not an instant remote wipe.

## 7. Monitor shops and publish messages

The dashboard's shop cards show the latest successful check-in, reported app/OS version, whether first Shop Admin setup has completed, and whether the last check-in was within 24 hours. This is a last-seen report, not a live connection indicator. The dashboard does not display local usernames, passwords, password hashes, or pharmacy business data.

Set **Offline grace (days)** and **Warning before lockout (days)** on a shop's license. The warning window must be between 1 day and the grace period. A check-in refreshes the signed policy; while offline, the desktop keeps enforcing its last verified policy and blocks new transactions when its cached grace expires. A central suspension or policy change cannot reach a disconnected PC before reconnection or expiry of its signed grace period.

Use **Admin announcements** to save a private draft or publish a message to selected shops (or all current and future shops). Published messages appear in the Shop Admin's desktop Alerts panel after the shop's next successful check-in; other local staff do not receive the message content. Unpublishing or deleting a message also takes effect on an offline PC only after its next check-in. Drafts are visible only to authorized Developer Owners.

Announcements can tell admins about a release, but they do not deliver or automatically install software updates. The central service does not collect or reveal local credentials, and it does not create hidden per-shop Super Admin accounts or provide remote access to pharmacy PCs.

## 8. Configure signed update delivery

The desktop's **Check for updates…** action is manual; it does not install in the background. Use a separate Ed25519 keypair from the license key:

1. On a trusted Windows release workstation, run `npm run desktop:update-keys:generate`. Keep `desktop-app/.update-keys/manifest-private.pem` private and backed up in an approved secrets vault. Never commit or distribute it. The public key can be embedded in the desktop build.
2. Host both `latest-update.json` and each installer at stable, direct HTTPS URLs that do not redirect. Use an access-controlled release process; never host a private key alongside the public files.
3. Before packaging a release, increment `desktop-app/package.json`'s version. Set the normal central licensing variables and these optional update variables in the private build environment:

   ```powershell
   $env:PHARMA_UPDATE_MANIFEST_URL = 'https://<UPDATE_HOST>/latest-update.json'
   $env:PHARMA_UPDATE_MANIFEST_PUBLIC_KEY = (Get-Content 'desktop-app\.update-keys\manifest-public.pem' -Raw)
   ```

   Then run `npm run desktop:package`. The public key and URL are embedded at build time; private signing keys are not.
4. Upload the resulting installer to its direct HTTPS URL. Create the signed manifest from the release workstation:

   ```powershell
   npm run desktop:update-manifest -- --installer 'desktop-app\release\PharmaCare-<VERSION>-Setup.exe' --private-key 'desktop-app\.update-keys\manifest-private.pem' --version '<VERSION>' --url 'https://<UPDATE_HOST>/PharmaCare-<VERSION>-Setup.exe' --output 'latest-update.json'
   ```

   Upload the generated manifest only after the installer is available. The command refuses to overwrite an existing output file; remove or choose a new output path before regenerating. It prints only the output path.
5. Test the signed manifest with the release build, download the installer, verify the SHA-512 rejection path with a deliberately altered test artifact, and accept the Windows installer only after saving work. The app does not silently install, roll back, or establish a valid publisher identity for an unsigned executable.

Keep the update signing key and license signing key separate. Rotate the update key by preparing a desktop build with the new public key before publishing manifests signed by its private key. Use a code-signing certificate and verify Authenticode signatures before distributing any installer; this repository does not contain a publisher certificate or configure Windows signing.

## 9. Pre-release checklist

- Verify `/api/health` over HTTPS.
- Confirm the Developer Owner can sign in and a non-owner cannot manage licenses.
- Test new activation, one-time key replay rejection, check-in, entitlement changes, suspension, expiry, and offline grace with a non-production pharmacy.
- On the new project, verify last-check-in/version reporting, test signed warning/grace changes, and confirm targeted announcements remain private until published. Use a test shop before activating a real one.
- Test license reissue and confirm the old PC cannot check in while the new PC can activate.
- Test backup recovery separately. A restored database retains its device-bound license and may require another authorized reissue.
- Review CORS, Supabase RLS, Function Secrets, backups, logs, and incident/key-rotation procedures.
- Qualify the complete desktop workflow, installer signature, upgrade/uninstall behavior, and printer hardware before serving a real pharmacy.

## 10. Local development (not production)

For isolated local tests without a deployment, use `npm run central:dev` and `npm run desktop:local`. Local keys/state are stored under the ignored `central-backend/.dev/` directory. Do not expose that loopback-only service to the internet or use its development keypair for production.
