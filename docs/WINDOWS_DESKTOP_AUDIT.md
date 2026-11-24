# Pharma Care Windows Desktop Audit and Roadmap

**Audit date:** 2026-11-21 (updated 2026-11-23)
**Basis:** Checked-in source and configuration, plus a Playwright Electron test using temporary local development keys and profile. No live Supabase project or production credentials/deployment were accessed.

## Executive summary

The existing React application is substantial and should be preserved. This copy now has a desktop renderer build, a secure Electron/preload foundation, a local encrypted SQLite backend, a loopback development licensing service, portable recovery-key backups, and filtered CSV/XLSX exports on several screens. It is **not a complete offline desktop product**: feature parity and export coverage remain partial, production activation is not configured, and the complete packaged pharmacy workflow has not been accepted.

**Recommendation:** Continue in place in this standalone copy. Its previous Git history and remote were intentionally removed, and it now has a fresh local-only repository. Preserve the React UI. Do not distribute the desktop application or expose the central API as production-ready until the remaining parity, licensing, restore/recovery, installer, and deployment gates below are satisfied.

### 2026-11-22 verification update

The signed desktop license carries the existing per-shop page and feature grants; the local backend verifies and stores them and denies routes whose page is not enabled. Older signed licenses with no entitlement arrays default to all supported access. Shops, Demo, WhatsApp Reminders, My Print Requests, Print Requests, and the separate returns request/approval workflow are hidden in the desktop edition; direct medicine returns inside POS use the local backend.

`npm run desktop:e2e` passed against generated temporary Ed25519 keys, temporary licensing-service state, and temporary Electron profiles. It activates and sets up the Shop Admin, visits every supported v1 sidebar page, checks Manager/Seller/Cashier sidebar visibility and API 403 boundaries, performs representative local catalog/supplier/customer/staff lifecycle operations, posts and voids purchases, posts cash/split sales and a POS return, records an expense, checks CSV/XLSX download requests, performs encrypted and portable backup/restore, and verifies a disabled Settings entitlement after check-in and offline reopen. After renderer reload it confirms persistence for master data, units, products, stock, suppliers, purchases, customers/ledger, sales, expenses, users, Settings, and Trash. It also builds and silently installs the NSIS package, activates it, creates the admin, posts a sale, uninstalls it, and verifies the app files are removed while the isolated database remains. Mutations use the Electron local API bridge rather than page controls; read-only screens and immutable/audited records do not have literal CRUD operations. This does not qualify production activation, printer hardware, cross-PC restore/license reissue, or clean-machine install/upgrade. The test found and fixed purchase-item and return-item foreign-key ordering defects, a Settings authorization gap, and incorrect discount-denial status.

The 2026-11-22 E2E extension completed the inactive-filter/first-activation checks but had a transient final silent-uninstall file-cleanup failure. The 2026-11-23 complete E2E run passed, including the Developer announcement in Alerts and the final silent install/activation/admin/sale/uninstall/database-retention checks. Production deployment, clean-machine qualification, and printer hardware remain unverified.

The app remains unsuitable for production deployment until remaining browser-local preferences and partial data workflows are resolved, authorization is accepted across every local route, the unsigned installer is qualified on a clean Windows machine, production central deployment is configured, and the replacement-device license process is tested. Desktop POS held bills and purchase drafts now use encrypted local SQLite. Current screen-level statuses are recorded in [PARITY_GAPS.md](./PARITY_GAPS.md).

## 1. Existing project audit

### Frontend structure and workflows

- React + TypeScript + Vite application; existing UI is in `src/`, with shared data, types, and utilities under `src/data/`, `src/types/`, and `src/utils/`.
- `src/App.tsx` is the application shell and route/page coordinator. Feature screens include POS and receipt printing, product/catalog and stock inventory, purchasing and purchase history, suppliers, customers and ledger, sales history, reports, cash book, settings, staff management, and print-request workflows.
- Existing import/export includes product CSV import, product CSV/XLSX export, purchase-history XLSX export, and browser printing for thermal/A4 receipts.
- The web app includes browser-local preferences, purchase drafts, WhatsApp templates, held bills, and some in-memory or demo-only data. Desktop held bills and purchase drafts now persist in SQLite; other localStorage rows are listed in [PARITY_GAPS.md](./PARITY_GAPS.md).
- Do not infer that a screen is offline-ready merely because it renders in the desktop shell.

### Current data, auth, and business logic

- `src/utils/supabase.ts` constructs a browser Supabase client from `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- A source search finds direct `supabase.rpc`, `supabase.auth`, or `supabase.from` usage in **20 frontend files**, including `App.tsx`, auth, POS/catalog, inventory, purchasing, suppliers, settings, sales, reports/alerts, trash, and print workflows. Those call sites require feature-by-feature migration or an explicit supported local adapter.
- Authentication currently begins with Supabase email/password. `loadAuthSession()` then reads `profiles`, calls `current_shop_access()` / `current_shop_profile()`, and may invoke `manage-users`. The roles and module grants in `src/permissions.tsx` are primarily client-side UI gates; local backend authorization must enforce access on every protected operation.
- The database currently supplies important business logic through Postgres RPCs and RLS. Reproducing the UI alone will not preserve behavior: FEFO, checkout/discount/payment rules, returns, audit trails, tenant/role guards, and reporting semantics must be ported and reconciled.
- Receipt/public QR workflows and Supabase Edge Functions are web-specific dependencies and need an explicit desktop policy (disable, adapt locally, or retain an online-only feature).

### Existing desktop and local backend work

- `local-backend/src/db/schema.ts` creates the local SQLite tables for users, products/units, batches/movements, suppliers/purchases, customers/ledger, sales/allocations/payments/returns, cash transactions, print requests, audit/trash, settings, licensing, preferences, and recovery-key verification.
- `local-backend` uses `better-sqlite3-multiple-ciphers`, a 256-bit database key, WAL/foreign-key pragmas, Argon2id via `@node-rs/argon2`, JWT, and Fastify routes for auth, POS, inventory, purchases, customers, cashbook, reports, and settings. Versioned migration handling, FEFO allocation, role checks, cost redaction, and backend tests exist. The selected cipher is not SQLCipher compatibility mode.
- Electron `safeStorage` protects the database and recovery keys under per-user `app.getPath('userData')`. Portable backup files carry the encrypted SQLite database and an AES-256-GCM-wrapped database key derived with scrypt; restore verifies the key and database integrity, preserves rollback copies, updates the active database key, and is available before sign-in. Encrypted and portable backup/restore pass the development-shell E2E; restore on the installed package and cross-PC license reissue remain unverified.
- `desktop-app` sets `contextIsolation`, `sandbox`, and `nodeIntegration: false`; its preload exposes a limited IPC bridge. The renderer builds into `desktop-app/renderer/`, and Electron starts Fastify on loopback. The unsigned NSIS x64 installer has passed a temporary-directory silent install, activation/admin setup, sale, uninstall, and retained-database check; clean-machine and upgrade qualification remain incomplete.
- `developer-dashboard` supports Supabase sign-in, shop creation/listing, license status/expiry management, and unused activation-key revocation. No deployed dashboard/central service has been verified.
- `central-backend` checks a signed-in Supabase identity against the `developer_owners` allowlist, and activation-key redemption uses a SQL RPC for atomic single-use consumption. A separate local-only dev service creates an ignored Ed25519 keypair and one-time test pharmacy/code; its activation/check-in protocol is tested without Supabase. Production deployment and real activation remain unverified.
- The Developer Owner dashboard also shows last check-in, a 24-hour stale indicator, reported app/OS version, and whether initial Shop Admin setup completed; signed licenses include configurable offline grace/warning days. Targeted draft/publish announcements are synced to the Shop Admin's desktop Alerts panel and stored in local encrypted SQLite, with non-admin users denied announcement reads. These controls require the updated production SQL and deployment; no live Supabase check has been run. No local credentials are sent to the dashboard, and this does not add hidden Super Admin access or automatic update installation.
- Production deployment scaffolding includes the optional Render blueprint/Docker image and a `central-licensing` Supabase Edge Function for the owner's one-project/no-Render path. Central SQL now uses `central_*` names, revokes direct browser table access, and provides atomic shop creation, activation consumption, and device reissue RPCs. Edge tests verify owner gating, API routing, table namespacing, and Ed25519 activation tokens. Dashboard and packaged desktop APIs preserve the function URL path. No production SQL was applied and no live Supabase function was deployed or tested. The existing local production signing key matches historical committed key material and must not be used. The deleted old project's Supabase credential is not to be reused. The new project's web-app bootstrap sequence remains a separate prerequisite; the reconstructed baseline file is explicitly incomplete.

## 2. Requirement-to-current-state audit

| Requirement | Current state | Work needed |
|---|---|---|
| Preserve existing React app | Existing app is present; desktop local login/session restoration is separate from the web Supabase path | Keep the app and migrate services incrementally behind tested interfaces |
| Offline sign-in and all daily operations | Local Argon2id login exists; frontend auth/session restore and most data calls remain Supabase-based | Local session lifecycle, profile/permissions, protected API routes, and complete module parity |
| Isolated SQLite per shop | Local schema and configurable DB path exist | Verify production path, enforce Windows ACLs, migration/backup/restore, and multi-install isolation |
| Encrypted local database | `better-sqlite3-multiple-ciphers` with protected key and encrypted-file tests; not SQLCipher compatibility mode | Qualify Electron/Windows native build, define portable recovery, access controls, and migration policy |
| Local API security | Runtime JWT secret is required, loopback token is configured by Electron, and local API roles are tested | Continue route/schema review, test packaged IPC/API boundaries, and verify least-privilege permissions for every operation |
| Cashier cost redaction | Helper and some POS mapping exist | Audit every API response and endpoint, then test raw response data by role |
| Activation | One-time activation UI and local Ed25519 verification exist; local dev service tests one-time redemption, signing and device-bound check-in | Configure production keys and deployment; test real activation, renewal, suspension and expiry end to end |
| Developer Owner authorization | Central API checks Supabase identity and the `developer_owners` allowlist | Deploy and test policies/configuration; audit identity failure handling and administrator lifecycle |
| Licenses, suspension, renewals, resets | Dashboard can list/change shop status and expiry; local signature/expiry/device checks and periodic check-in exist | Verify production suspension/renewal end to end and define authorized replacement-device reissue and password-reset flows |
| Offline grace and clock rollback | Signed grace/warning periods, local warning/transaction restriction, and clock high-water logic exist | Validate production policy synchronization, clock jumps, backup/restore, and safe restricted-mode behavior |
| Shop monitoring and announcements | Last successful check-in, app/OS version, Shop Admin setup boolean, targeted private drafts/published messages, and local announcement persistence exist | Apply SQL and verify staging deployment; offline shops update only at next check-in |
| Updates and release verification | Manual update menu verifies an Ed25519-signed HTTPS manifest and the streamed installer SHA-512 digest before opening; signing and manifest-generation helpers have focused tests | Configure and host the feed, test packaged downloads/upgrades, Authenticode-sign installers, and qualify rollback/data preservation; no silent or staged auto-update |
| Packaging and installation | Local-development NSIS x64 installer and isolated install/activation/sale/uninstall/data-retention smoke passed | Test clean install/upgrade, full installed workflows, data protection/ACLs; sign before release |
| SQLCipher, code signing, Inno Setup | Not implemented | Add only after architecture/build decisions; current NSIS config is not an Inno Setup installer |

## 3. Current blockers

1. **Feature parity is incomplete.** Local login/session restore, activation/setup UI, POS catalog/checkout, customer lookup, sales history, shop settings, and parts of the backend are wired. Many existing screens and services still use Supabase or browser/in-memory state; do not assume desktop mode is fully offline.
2. **Installer packaging succeeds; release qualification remains incomplete.** `npm run desktop:local:package` rebuilt `better-sqlite3-multiple-ciphers` for Electron 39.8.10 and produced `desktop-app/release/PharmaCare-1.0.0-Setup.exe`. The Playwright E2E silently installed this NSIS package in a temporary directory, activated it, created an admin, posted a sale, uninstalled it, and confirmed the app files were removed while the isolated database remained. The installer is unsigned and has not been qualified on a clean Windows machine or through upgrade.
3. **Local API authorization still needs production acceptance.** The global route hook checks the current database user, active state, module entitlement, and current role/permissions; the JWT trust callback rejects non-admin tokens with stale or missing permission claims and inactive/role-changed users. Unauthenticated local licensing/setup paths require Electron's per-launch local token. Regression tests cover stale role/permission, missing permission, and deactivation. A route-by-route live acceptance matrix, complete sensitive-response review, and deployment/device testing remain outstanding.
4. **Licensing is not verified end to end.** Local Ed25519 signature, expiry, status, device-binding, clock-rollback, and grace-period checks are implemented. Central signing/check-in now uses the matching-key protocol, but no private/public key pair, deployed central API, or live activation was configured or tested here.
5. **Shop creation is multi-step.** Central shop, license, and activation creation use sequential requests rather than one transaction; failed intermediate calls may leave partial records.
6. **Encrypted data recovery is implemented but not release-qualified.** The database uses `better-sqlite3-multiple-ciphers`, not SQLCipher compatibility mode. Recovery-key backup/restore is tested in the Electron development-shell E2E, and the restore path supports pre-login use with database/key rollback on errors; installed-package restore, cross-PC restore, and license reissue have not been accepted. The restored signed entitlement is still device-bound, so a replacement PC needs an authorized reissue. Backup retention and Windows ACLs are not qualified.
7. **Exports and remaining desktop flows are incomplete.** CSV/XLSX exports now use filtered rows on the product/stock, purchase history, supplier, customer, staff, cashbook, sales report, and pending-return screens. Other tables and desktop-local data paths still need migration and tests.
8. **Deployment prerequisites are absent.** No central signing key/API deployment, code-signing certificate, update host, or clean Windows VM acceptance run is available. The installer remains unsigned; update verification code is implemented, but no production feed has been configured or tested end to end. `npm audit fix` resolved compatible findings; 8 advisories remain in the Electron/Electron Builder dependency chain because their available fixes require major upgrades and Electron ABI requalification.

## 4. Security and technology evaluation

### SQLCipher and key handling

SQLCipher is appropriate if the threat model includes someone copying a powered-off PC's database file. It does not protect data from a local administrator or a compromised running application. A compatible SQLite binding/build must be selected and tested with Electron's supported Node ABI and Windows x64. Keep keys out of source, renderer bundles, and installer files. Use Windows-protected key storage/DPAPI with a documented multi-Windows-user model; test recovery and machine replacement. Backups must be encrypted with the same or a separately recoverable key policy.

### Local API and Electron

- Bind only to `127.0.0.1`; use an unpredictable per-launch token and avoid making that token directly readable to all renderer JavaScript. Prefer narrow preload IPC methods for specific operations over exposing a general token.
- Require authenticated local sessions and enforce permissions in every route. Validate request schemas and bound input sizes. Do not rely on CORS, hidden UI controls, or renderer checks as authorization.
- Keep `contextIsolation: true`, `nodeIntegration: false`, and sandboxing. Restrict navigation and external links; use a narrowly scoped CSP that names the actual central API rather than `https://*`.
- Use OS ACLs rather than granting the entire Windows Users group broad write access to the data folder. Protect database, WAL/SHM, backups, logs, and key material consistently.

### Obfuscation and native compilation

JavaScript obfuscation/minification can slow casual inspection but **cannot prevent reverse engineering or protect secrets**. Do not put central keys or trust decisions in the desktop binary. Keep production source maps disabled and include no private build artifacts.

**Recommendation: do not compile business logic into native code for the first release.** Native code may raise the cost of casual code inspection and can isolate a small, well-defined algorithm. It does not hide data or prevent a determined analyst from observing inputs/outputs. It adds native toolchains, architecture/ABI variants, Electron rebuild requirements, debugging difficulty, and release compatibility risk. Existing SQLite/Argon2 dependencies are already native modules and need packaging qualification. Reconsider native compilation only for a narrowly scoped algorithm after correctness and compatibility are stable and a concrete threat model justifies its costs.

### Installer signing and update integrity

Code signing is recommended for publisher identity and Windows reputation; it does not prove that the application is vulnerability-free. A signing certificate and protected CI signing process are deployment prerequisites. Verify downloaded updates with signed metadata and hashes, but do not treat a hash delivered over the same unauthenticated channel as a trust anchor. Installer and update tests must confirm the database directory survives upgrade, rollback, and uninstall.

## 5. Recommended phased implementation and gates

### Phase 0 — Baseline and decisions

- Keep the current React application and existing web deployment path unchanged.
- Record current frontend build/test results and freeze representative workflows as regression tests.
- Decide Windows support (initially x64), SQLCipher binding, key protection/recovery, local Admin bootstrap, offline grace behavior, update channel, and signing approach.
- **Gate:** existing web build/tests remain green; no production DB or credentials are changed by desktop development.

### Phase 1 — Local backend correctness and security

- Add versioned migrations and verify every schema constraint/foreign key.
- Finish and test auth/session lifecycle, role/permission checks, POS atomic transaction and FEFO behavior, purchases, returns, customer ledger, cashbook, reports, settings, audit, import/export, and restore.
- Remove hard-coded JWT fallback; require startup secrets and local-token authentication. Restrict CORS and validate all inputs.
- Add transactionally safe license and timestamp handling.
- **Gate:** API integration tests cover business invariants, rollback behavior, authorization, cost redaction, and reopen/restart durability.

### Phase 2 — React data adapter

- Introduce an explicit service/data interface; retain current Supabase implementation for web.
- Implement a local implementation for desktop and migrate one workflow at a time, starting with login/session, catalog, and POS.
- Continue through inventory, purchases, suppliers, returns, customers, reports, settings, users, cashbook, print, and imports/exports.
- **Gate:** feature-by-feature parity tests; offline tests prove no app data request leaves the machine.

### Phase 3 — Data protection and recovery

- Qualify SQLCipher-compatible Windows x64 build and Electron ABI rebuild.
- Implement key storage, database migration/encryption transition, encrypted backups, retention, restore, and documented recovery.
- Set restrictive `%PROGRAMDATA%\PharmaCare` ACLs and validate access from supported Windows accounts.
- **Gate:** copy-the-database, wrong-key, restore, power-loss, and multi-user tests pass.

### Phase 4 — Central licensing and Developer Owner portal

- Add Owner authentication/authorization before exposing privileged routes.
- Implement shops, activation generation/expiry, atomic one-use redemption, hardware/device policy, license issue/renew/suspend, check-ins, reset tokens, and audit log.
- Do not store pharmacy transaction/customer/inventory data centrally.
- **Gate:** abuse/race tests prove one-time redemption, expiry, authorization, rate limiting, and correct suspension behavior.

### Phase 5 — Electron integration

- Build/copy the existing Vite renderer, package the compiled local backend with the correct Electron-compatible runtime, and implement robust startup/readiness/shutdown/port handling.
- Complete secure IPC, activation UI, first Admin creation, local login, updater, and failure recovery.
- **Gate:** no Node.js prerequisite; clean installation and offline daily workflows pass on fresh Windows VMs.

### Phase 6 — Release hardening

- Implement signed installer and update pipeline, software manifest verification, rollback, encrypted backups, and support runbooks.
- Test install/upgrade/uninstall data preservation, clock tampering, network outage, license expiry, import/export, printer behavior, and role-based API responses.
- **Gate:** documented acceptance suite passes on clean Windows 10/11 x64 machines.

## 6. Build and deployment snapshot

- Root application commands are in `package.json`: `npm run dev`, `npm run build`, `npm run lint`, and `npm test`. The desktop renderer command is `npm run desktop:renderer`.
- Workspace builds pass for the local backend, desktop shell, central backend, and developer dashboard. The root TypeScript check, root frontend tests, and local-backend tests pass after current changes.
- The root Vite build produces the existing web app and receipt entry. The separate desktop renderer build disables `.env` loading and writes to `desktop-app/renderer/`.
- `npm run desktop:local:package` produced an unsigned NSIS x64 installer in the latest run. The Electron E2E silently installed that package, activated it against a temporary local issuer, created the first Admin, posted a sale, uninstalled it, and verified database retention. Production central activation and installed-package restore remain unverified.
- `.env` values were not read, printed, or changed. Environment variable names may be documented in `.env.example` files.

## 7. Immediate next actions

1. Migrate remaining browser-local preferences where they represent operational settings, and complete page-control acceptance; keep the returns request/approval workflow hidden until its policy and authorization are ported.
2. Qualify production licensing/deployment, replacement-device reissue, and route-level authorization beyond the tested role matrix.
3. Decide portable backup/key recovery and Windows ACL policy before storing production data.
4. Test installed-package backup/restore, clean install/upgrade, Windows ACLs, physical printing, and filtered exports on clean Windows VMs.
5. Add a deployed-central activation test, then sign the installer/update metadata before distribution.

## Current update (2026-11-21)

- Electron now uses hash-based routes while web routing remains pathname-based. Desktop print-request creation, lists, decisions, modifications, printed tracking, and pending counts use the local API; remote QR links and automatic approval remain unavailable in that flow.
- The focused route tests, local-backend tests, lint, and `npm run desktop:local:package` passed; the x64 NSIS installer was rebuilt.
- Packaged UI acceptance did not complete: the Computer Use launch returned no targetable window. The already-running local-development window still showed Page not found and the old Supabase print-count toast. This stale window is not evidence that the rebuilt package passes or fails; verify the packaged executable and all sidebar pages when a targetable window is available.

## Continuation update (2026-11-21)

- Added local data routes/adapters for master data, product/import preview/import, stock batches/overview/adjustment reads, purchase history, sidebar preferences, stock-alert notifications, and cashbook expense persistence. Existing local suppliers, purchases, users, trash, settings, POS/customers/sales, and print-request adapters remain. These changes do not constitute complete parity; see [PARITY_GAPS.md](./PARITY_GAPS.md).
- The source inventory still includes reachable Supabase and browser/in-memory code. Sale-return request/review, public QR receipt resolution, profile/logo Storage upload, transient purchase/held-bill state, and several preferences remain gaps or intentionally unsupported. Do not rely on these features for offline pharmacy operations.
- Root TypeScript lint, root web build, local-backend TypeScript build and tests (21/21), and `npm run desktop:local:package` passed. The full root `npm test` first exposed a stale product-import-preview test fixture (it checked the old product code after an edit); after correcting the fixture, the full suite passed, including a test that ensures desktop RPC calls fail before touching a null Supabase client.
- The icon checker verified the transparent 512px PNG, all seven requested ICO frames, both icon paths, AppUserModelID, and NSIS/Windows settings. Windows icon extraction confirmed the unpacked executable and NSIS installer use the same 32px icon as the source ICO.
- Computer Use launched the unpacked executable but did not expose a targetable window. No login, business-record CRUD, role matrix, restore, export, offline reopen, or sidebar acceptance is claimed. Installer remains unsigned; production central activation/deployment, device reissue, full local returns, complete filtered exports, and clean-machine install/upgrade acceptance remain release blockers.
