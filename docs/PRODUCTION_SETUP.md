# Production setup: central licensing

This guide deploys the licensing service and Developer Owner dashboard. Pharmacy sales, customers, inventory, and purchases stay in each desktop installation's encrypted local database; Supabase stores only central shop and license administration records.

Do not paste real credentials into source files, commits, chat, or this guide. Replace angle-bracket placeholders privately in the provider's secret settings. This project has not been connected to or deployed against a production Supabase project.

## What you need

- A Supabase project dedicated to licensing metadata.
- A Supabase Auth account for each Developer Owner.
- A Render account for the central API. Use a paid, non-sleeping plan for production use.
- A trusted workstation for signing-key generation.
- A secure way to transfer the private signing key to Render and the public key to the desktop release build.

## 1. Create the Supabase project

1. Create a new Supabase project for central licensing. Do not use a pharmacy's business-data project.
2. In **SQL Editor**, open and run [`supabase/production/setup.sql`](../supabase/production/setup.sql). It creates the licensing tables, row-level security, service-role grants, activation/reissue functions, and entitlement constraints. Re-running the setup is supported. If an existing project reports duplicate licenses for a shop, resolve those records before adding the one-license-per-shop index.
3. In **Authentication → Users**, create the first Developer Owner account. Confirm that the account can sign in.
4. Copy that account's user UUID from the Supabase dashboard. In SQL Editor, replace the placeholder below with that UUID, then run:

   ```sql
   insert into public.developer_owners (user_id, is_active)
   values ('<AUTH_USER_UUID>', true)
   on conflict (user_id) do update set is_active = true;
   ```

5. In **Project Settings → API**, note the project URL and the service-role key. Keep the service-role key private; it is only for the central service.

The SQL enables RLS and grants table/function access to `service_role`; it does not grant browser users direct access to license tables. The Developer Owner dashboard authenticates with Supabase Auth, while privileged changes go through the central API's owner allowlist check.

## 2. Generate production signing keys

On a trusted workstation in the repository root, run:

```powershell
npm run central:keys:generate
```

The script creates an Ed25519 pair under the ignored `central-backend/.production-keys/` directory. It refuses to overwrite an existing pair, restricts the directory to the current Windows user (and uses private directory/file modes on POSIX), and prints only file paths, never key contents. Back up the private key in an approved secrets vault. Do not commit it, upload it to the desktop, or put it in a renderer/dashboard build setting. The public key is safe to distribute with desktop builds.

The generator is intentionally not run as part of this setup work; no production signing keys are created here.

## 3. Deploy the central API on Render

1. In Render, choose **New → Blueprint** and connect this repository. Render reads the root [`render.yaml`](../render.yaml), which builds [`central-backend/Dockerfile`](../central-backend/Dockerfile).
2. When prompted, add these environment variables in Render's protected service settings:

   | Name | Value to provide privately |
   |---|---|
   | `CENTRAL_SUPABASE_URL` | `<SUPABASE_PROJECT_URL>` |
   | `CENTRAL_SUPABASE_SERVICE_KEY` | `<SUPABASE_SERVICE_ROLE_KEY>` |
   | `CENTRAL_LICENSE_PRIVATE_KEY` | `<CONTENTS_OF_LICENSE_PRIVATE_PEM>` |
   | `CORS_ORIGIN` | `<DEVELOPER_DASHBOARD_HTTPS_ORIGIN>` |

   Do not add the signing private key or service-role key to Git, Render's public build arguments, or desktop build settings. `PORT` is supplied by Render. Keep CORS limited to the exact dashboard origin.
3. Create the service and wait for its health check to pass. Its health endpoint is `GET /api/health`.
4. Copy the HTTPS service URL from Render. It is the desktop build's `CENTRAL_API_URL`.

The Render blueprint uses a paid starter plan and automatic deploy is disabled so production releases can be reviewed. For a no-cost evaluation, change `plan: starter` to `plan: free` in `render.yaml` before creating the Blueprint, if Render's free Docker web service is available for your account/region. Free instances can sleep and cold-start, so use them only for testing; restore the paid non-sleeping plan before production. Review current plan/pricing and health-check behavior before rollout.

## 4. Deploy the Developer Owner dashboard

Deploy `developer-dashboard` as a static Vite site using your approved static host. Set these **build-time** variables in that host's protected project settings:

| Name | Value to provide |
|---|---|
| `VITE_CENTRAL_API_URL` | `<CENTRAL_HTTPS_SERVICE_URL>` |
| `VITE_SUPABASE_URL` | `<SUPABASE_PROJECT_URL>` |
| `VITE_SUPABASE_ANON_KEY` | `<SUPABASE_PUBLIC_ANON_KEY>` |

Only the public anon key belongs in the dashboard. Never use the service-role key there. Rebuild and deploy the dashboard after changing these values.

## 5. Build the production desktop installer

In PowerShell, provide the HTTPS central URL and matching public PEM as placeholders in your private build environment, then build:

```powershell
$env:CENTRAL_API_URL = 'https://<CENTRAL_SERVICE_HOST>'
$env:CENTRAL_LICENSE_PUBLIC_KEY = '<CONTENTS_OF_LICENSE_PUBLIC_PEM>'
npm run desktop:package
```

The package preflight stops immediately with a clear error if either variable is missing. It does not read `.env` files or print the configured values. `CENTRAL_LICENSE_PRIVATE_KEY` and `CENTRAL_SUPABASE_SERVICE_KEY` must never be set for a desktop build.

The installer is written to `desktop-app/release/PharmaCare-<VERSION>-Setup.exe`. The Windows installer is unsigned unless a publisher certificate is configured. Sign and verify releases before distribution.

## 6. Issue, activate, and reissue licenses

1. Sign in to the dashboard with a user listed as active in `public.developer_owners`.
2. Create a pharmacy and deliver its single-use activation key privately. The key is shown once and expires after its configured period.
3. Activate the desktop app. The central API binds the signed license to that PC; the desktop checks signature, expiry, status, device binding, and offline grace locally.
4. To move a license, select **Reissue licence for a new PC** on that pharmacy. Confirm the warning, then copy the new one-time key privately. The database function atomically removes prior device registrations and unused activation keys before creating the replacement key. Only an active license can be reissued.
5. Activate the replacement PC with the new key. A disconnected old PC may continue under its already-signed offline entitlement until its grace period expires; reissue is not an instant remote wipe.

## 7. Pre-release checklist

- Verify `/api/health` over HTTPS.
- Confirm the Developer Owner can sign in and a non-owner cannot manage licenses.
- Test new activation, one-time key replay rejection, check-in, entitlement changes, suspension, expiry, and offline grace with a non-production pharmacy.
- Test license reissue and confirm the old PC cannot check in while the new PC can activate.
- Test backup recovery separately. A restored database retains its device-bound license and may require another authorized reissue.
- Review CORS, Supabase RLS, Render secret settings, backups, logs, and incident/key-rotation procedures.
- Qualify the complete desktop workflow, installer signature, upgrade/uninstall behavior, and printer hardware before serving a real pharmacy.

## Local development (not production)

For isolated local tests without a deployment, use `npm run central:dev` and `npm run desktop:local`. Local keys/state are stored under the ignored `central-backend/.dev/` directory. Do not expose that loopback-only service to the internet or use its development keypair for production.
