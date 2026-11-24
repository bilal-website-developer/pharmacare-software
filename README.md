# Pharma Care

This repository preserves the existing React/Vite pharmacy application and adds an Electron desktop shell with a local Fastify/encrypted-SQLite backend. The desktop app now has a local development activation flow and an automated Electron acceptance test for activation, first-admin setup, v1 navigation, core transaction APIs, exports, backup/restore, and offline reopen. It is still **not ready for pharmacy production use**: some renderer preferences remain browser-local, unsupported online workflows are intentionally hidden, production licensing/deployment is unverified, and the installer is unsigned.

## Development

Run these commands from the repository root:

```powershell
npm install
npm run dev
npm run lint
npm test
npm run build
```

The existing web application runs at `http://localhost:3000`. The desktop renderer can be built with `npm run desktop:renderer`; this build deliberately disables loading `.env` files.
`npm test` includes the local and central backend suites, plus focused renderer tests. `npm run desktop:e2e` launches Electron with a temporary profile and temporary local Ed25519 licensing service and exercises a representative offline workflow.
The Electron shell uses hash routes (for example `index.html#/products`) so file-based navigation, refresh, and browser history work without changing the web app's pathname routes. Desktop print-request lists, approvals, modifications, print tracking, and pending counts use the local SQLite backend.

## Product CSV import and export

Open **Settings → Product CSV import & export** to import products or export the full catalog to CSV/XLSX; this export is independent of Products-page filters. Large files are processed in 500-row batches with no total-row cap. The template includes product name/code, manufacturer/category, sale unit, conversion factor, price in paisa, and optional opening-batch fields.

Opening quantity is entered in sale units. A positive quantity requires a real batch number, future `YYYY-MM-DD` expiry, and cost in paisa per sale unit; the importer converts it to the smallest stock unit and writes the batch and stock movement atomically. Existing aggregate stock is exported only as a reference and is never guessed into a batch. Opening-stock imports require cost-price permission. Web deployments must apply `supabase/migrations/20261122150000_products_csv_opening_stock.sql` before using opening-batch fields.

Products includes a visible **Status** filter for Active, Inactive, and All. Inactive catalog items are excluded from low-stock, out-of-stock, expiring, and stock-value summaries. The first activation of an imported inactive product asks to confirm its opening quantity; zero is allowed, while positive stock requires a real batch number, future expiry, and cost. The opening stock batch, movement, activation, and one-time confirmation are saved together. Later edits and reactivations do not ask again.

## Desktop development and packaging

For local development activation, start `npm run central:dev` in one terminal and then `npm run desktop:local` in another. The first command generates an ignored local Ed25519 keypair and one-time test activation code. The optional local test installer is `npm run desktop:local:package`.
After an activation code is consumed, stop and restart `central:dev` to create a fresh test pharmacy/code; `npm run central:dev:seed` can prepare the next state before the restart.

Production deployment, the shared Supabase project, Edge Functions, key generation, license reissue, and installer configuration are documented in [docs/PRODUCTION_SETUP.md](./docs/PRODUCTION_SETUP.md). The central API can be deployed as the `central-licensing` Supabase Edge Function; no Render service is required. Generate a production Ed25519 keypair on a trusted workstation with `npm run central:keys:generate`; the script stores it in the ignored `central-backend/.production-keys/` directory and never prints key contents.

For production-key builds, provide the HTTPS central API and matching public key in the build environment. Use placeholders in scripts and replace them privately:

```powershell
$env:CENTRAL_API_URL = 'https://<PROJECT_REF>.supabase.co/functions/v1/central-licensing'
$env:CENTRAL_SUPABASE_ANON_KEY = '<public-supabase-anon-key>'
$env:CENTRAL_LICENSE_PUBLIC_KEY = '<contents-of-license-public.pem>'
npm run desktop:package
```

Other useful commands are `npm run desktop:renderer`, `npm run build --workspace=desktop-app`, and `npm start --workspace=desktop-app`.

The Electron main process reads the public `CENTRAL_API_URL`, optional public `CENTRAL_SUPABASE_ANON_KEY`, and license public key at build time. The anon key is public; never put Supabase service-role keys, central signing secrets, or private signing keys in desktop or renderer build variables. The development launcher embeds only the loopback URL and local public key; its private key is ignored under `central-backend/.dev/`.

The encrypted local database and safe-storage-protected database/recovery keys are kept under Electron's per-user `app.getPath('userData')` directory. The Shop Admin receives a recovery key at setup. Settings supports portable export/restore, and the login screen supports restore before sign-in on a replacement PC; scheduled backups remain daily. POS held bills and purchase drafts are now stored per user in encrypted local SQLite on desktop and survive app restarts/backups; the web build continues to use browser storage. A restored database does not rebind the device-bound license, so obtain an authorized new-device reissue before processing transactions.

Central licensing signs entitlements with an Ed25519 private key held only by the central service (`CENTRAL_LICENSE_PRIVATE_KEY`). The desktop build embeds the matching public key from `CENTRAL_LICENSE_PUBLIC_KEY`; never provide the private key to a desktop build. The central API URL is supplied as `CENTRAL_API_URL`. A production activation requires the central service and matching key pair to be configured and deployed.

The Developer Owner dashboard reports each shop's last successful check-in, installed app/OS version, whether initial Shop Admin setup was reported complete, and whether the last check-in was within 24 hours (a stale-status indicator, not live connectivity). It also lets the Developer set a signed offline-grace period and warning window, and create private drafts or publish shop-targeted announcements. Published announcements reach desktop shops at their next successful check-in and appear in the Shop Admin's Alerts panel; an offline shop cannot receive a change until it reconnects. Passwords and password hashes are never sent to or shown in the Developer dashboard. This does not implement hidden per-shop Super Admin accounts, remote access to a shop, or automatic installer updates.

The desktop shell now includes an opt-in **Check for updates…** menu action. It accepts only a credential-free HTTPS manifest authenticated by a separate Ed25519 public key, then checks the downloaded installer against the signed SHA-512 digest before asking whether to open it. This is a manually operated update feed, not silent auto-update; feed hosting, key custody, Authenticode signing, upgrade/rollback qualification, and production release testing remain operator tasks. Generate a separate update keypair with `npm run desktop:update-keys:generate`; its private key is ignored under `desktop-app/.update-keys/` and must never be embedded in the app.

To preview the Developer Owner screen with synthetic, read-only sample data, run `npm run dev --workspace=developer-dashboard -- --host 127.0.0.1 --strictPort` and open `http://localhost:4173/?demo=1`. Demo mode does not sign in or call the central API.

`npm run desktop:package` checks for `CENTRAL_API_URL` and `CENTRAL_LICENSE_PUBLIC_KEY`; Supabase Edge Function builds also require the public `CENTRAL_SUPABASE_ANON_KEY`. It then requires compatible Visual Studio C++ Build Tools to rebuild the native SQLite addon for Electron. To configure signed-manifest update checks for a release build, also provide `PHARMA_UPDATE_MANIFEST_URL` and `PHARMA_UPDATE_MANIFEST_PUBLIC_KEY`; see [docs/PRODUCTION_SETUP.md](./docs/PRODUCTION_SETUP.md). Code signing requires a publisher certificate and is not configured.

## Desktop readiness and limitations

- A loopback-only local development licensing service now provisions a test pharmacy, one-time code, and ignored Ed25519 keypair; local activation/check-in behavior has focused tests.
- Recovery-key portable backup and restore, first-admin recovery-key display, automatic daily backups, and filtered CSV/XLSX exports for several list/report screens have been implemented with focused tests. The local database restore does not perform device license reissue.
- Local adapters now cover master data, product/import/barcode operations, stock batches and alerts, suppliers, purchases/history, users, trash, cashbook expenses, and sidebar preferences in addition to POS/customer/sales and print requests. The Electron E2E now verifies Manager/Seller/Cashier navigation and 403 boundaries, per-shop Settings entitlement check-in and offline persistence, staff lifecycle, catalog/stock/purchase/customer/cashbook mutations, and backup/restore.
- The Products status filter is immediately visible in desktop mode; inactive products do not inflate stock KPIs. First activation confirms opening stock once and records positive stock as a real batch plus stock movement.
- POS direct medicine returns are processed through the local backend. The separate returns request/approval workflow, Shops, Demo, WhatsApp Reminders, and Print Requests are intentionally hidden in desktop mode; public receipt QR lookup remains web/online-only. Some appearance and alert preferences remain browser-local and are not business-record persistence. Held POS bills and purchase drafts use encrypted local SQLite in desktop mode. See [docs/PARITY_GAPS.md](./docs/PARITY_GAPS.md) for screen-level status.
- `npm run desktop:e2e` exercises every supported v1 page before and after reload, checks role-specific sidebar visibility and backend 403 rules, and verifies persisted local records after renderer reload. It covers local activation, purchase/cash/split-sale/return, safe void/restore/delete operations, CSV/XLSX download requests, encrypted and portable backup/restore, entitlement check-in/offline enforcement, developer-announcement display, and a silently installed NSIS app that activates, signs in, posts a sale, uninstalls, and verifies its database remains. Mutations use the Electron local API bridge; dashboards/reports are read-only and audited transaction records do not have literal edit/delete operations, so this is not mouse-level CRUD coverage for every control or production/clean-machine qualification. Printer hardware and production licensing/deployment remain unverified.
- Latest `npm run desktop:e2e` passed, including the announcement alert and installer install/activation/admin/sale/uninstall check. This does not qualify clean-machine install/upgrade or production licensing.
- The Pharma Care logo is packaged at `desktop-app/build/pharma-care.ico` and `desktop-app/build/icon.png`; the icon check verifies the 16/24/32/48/64/128/256px ICO frames, transparency, Electron paths, and installer configuration.
- The central SQL schema must be applied to a configured Supabase project and the central service deployed before real production activation can work. See [docs/PRODUCTION_SETUP.md](./docs/PRODUCTION_SETUP.md).
- The central shop-monitoring, configurable offline warning, and announcement features require the updated [`supabase/production/setup.sql`](./supabase/production/setup.sql) to be applied and the central API/dashboard redeployed. Their production integration has not been run against a live Supabase project.
- Real production central signing/check-in, code signing, printer hardware, and clean-machine qualification have not been completed. The development service is only for local testing.
- JavaScript minification/obfuscation cannot prevent reverse engineering. The installer and application are unsigned.

See [DECISIONS.md](./DECISIONS.md) and [docs/WINDOWS_DESKTOP_AUDIT.md](./docs/WINDOWS_DESKTOP_AUDIT.md) for implementation choices and remaining gates.
