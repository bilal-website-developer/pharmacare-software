# Pharma Care

This repository preserves the existing React/Vite pharmacy application and adds an Electron desktop shell with a local Fastify/encrypted-SQLite backend. Desktop conversion remains **in progress and not ready for pharmacy production use**: several feature screens still use Supabase/browser/in-memory paths, and packaged end-to-end pharmacy workflows have not been accepted.

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
`npm test` includes the local and central backend suites, plus focused renderer tests.
The Electron shell uses hash routes (for example `index.html#/products`) so file-based navigation, refresh, and browser history work without changing the web app's pathname routes. Desktop print-request lists, approvals, modifications, print tracking, and pending counts use the local SQLite backend.

## Desktop development and packaging

For local development activation, start `npm run central:dev` in one terminal and then `npm run desktop:local` in another. The first command generates an ignored local Ed25519 keypair and one-time test activation code. The optional local test installer is `npm run desktop:local:package`.
After an activation code is consumed, stop and restart `central:dev` to create a fresh test pharmacy/code; `npm run central:dev:seed` can prepare the next state before the restart.

For production-key builds, use the HTTPS central API and matching public key as build-time environment variables:

```powershell
$env:CENTRAL_API_URL = 'https://your-central-api.example'
$env:CENTRAL_LICENSE_PUBLIC_KEY = Get-Content -Raw 'central-license-public.pem'
npm run desktop:package
```

Other useful commands are `npm run desktop:renderer`, `npm run build --workspace=desktop-app`, and `npm start --workspace=desktop-app`.

The Electron main process reads the public `CENTRAL_API_URL` at build time. Never put Supabase service-role keys, central signing secrets, or private signing keys in desktop or renderer build variables. The development launcher embeds only the loopback URL and local public key; its private key is ignored under `central-backend/.dev/`.

The encrypted local database and safe-storage-protected database/recovery keys are kept under Electron's per-user `app.getPath('userData')` directory. The Shop Admin receives a recovery key at setup. Settings supports portable export/restore, and the login screen supports restore before sign-in on a replacement PC; scheduled backups remain daily. A restored database does not rebind the device-bound license, so obtain an authorized new-device reissue before processing transactions.

Central licensing signs entitlements with an Ed25519 private key held only by the central service (`CENTRAL_LICENSE_PRIVATE_KEY`). The desktop build embeds the matching public key from `CENTRAL_LICENSE_PUBLIC_KEY`; never provide the private key to a desktop build. The central API URL is supplied as `CENTRAL_API_URL`. A production activation requires the central service and matching key pair to be configured and deployed.

`npm run desktop:package` requires compatible Visual Studio C++ Build Tools to rebuild the native SQLite addon for Electron. Packaging previously succeeded in this environment and produced an unsigned NSIS x64 installer. Code signing requires a publisher certificate and is not configured.

## Desktop readiness and limitations

- A loopback-only local development licensing service now provisions a test pharmacy, one-time code, and ignored Ed25519 keypair; local activation/check-in behavior has focused tests.
- Recovery-key portable backup and restore, first-admin recovery-key display, automatic daily backups, and filtered CSV/XLSX exports for several list/report screens have been implemented with focused tests. The local database restore does not perform device license reissue.
- Local adapters now cover master data, product/import/barcode operations, stock batches and alerts, suppliers, purchases/history, users, trash, cashbook expenses, and sidebar preferences in addition to POS/customer/sales and print requests. Test coverage is API-focused; desktop role-by-role screen acceptance is still incomplete.
- Offline parity is still incomplete. The sale-return request/review workflow has no compatible local route, public receipt QR lookup is online-only, several preferences and purchase drafts remain browser-local, and some receipt/profile and demo paths are disabled or incomplete. See [docs/PARITY_GAPS.md](./docs/PARITY_GAPS.md) for the source inventory and exact statuses.
- The Pharma Care logo is packaged at `desktop-app/build/pharma-care.ico` and `desktop-app/build/icon.png`; the icon check verifies the 16/24/32/48/64/128/256px ICO frames, transparency, Electron paths, and installer configuration.
- The central SQL schema must be applied to a configured Supabase project and the central service deployed before real production activation can work. See [docs/PRODUCTION_SETUP.md](./docs/PRODUCTION_SETUP.md).
- Real production central signing/check-in and packaged role/workflow acceptance have not been completed. The development service is only for local testing.
- JavaScript minification/obfuscation cannot prevent reverse engineering. The installer and application are unsigned.

See [DECISIONS.md](./DECISIONS.md) and [docs/WINDOWS_DESKTOP_AUDIT.md](./docs/WINDOWS_DESKTOP_AUDIT.md) for implementation choices and remaining gates.
