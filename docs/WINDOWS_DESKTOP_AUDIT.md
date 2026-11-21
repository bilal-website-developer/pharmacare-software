# Pharma Care Windows Desktop Audit and Roadmap

**Audit date:** 2026-11-21
**Basis:** Checked-in source and configuration. No live Supabase project or production credentials/deployment were accessed. The local development licensing service and portable backup implementation were unit/API tested; latest packaged workflow acceptance remains pending.

## Executive summary

The existing React application is substantial and should be preserved. This copy now has a desktop renderer build, a secure Electron/preload foundation, a local encrypted SQLite backend, a loopback development licensing service, portable recovery-key backups, and filtered CSV/XLSX exports on several screens. It is **not a complete offline desktop product**: feature parity and export coverage remain partial, production activation is not configured, and the complete packaged pharmacy workflow has not been accepted.

**Recommendation:** Continue in place in this standalone copy. Its previous Git history and remote were intentionally removed, and it now has a fresh local-only repository. Preserve the React UI. Do not distribute the desktop application or expose the central API as production-ready until the remaining parity, licensing, restore/recovery, installer, and deployment gates below are satisfied.

## 1. Existing project audit

### Frontend structure and workflows

- React + TypeScript + Vite application; existing UI is in `src/`, with shared data, types, and utilities under `src/data/`, `src/types/`, and `src/utils/`.
- `src/App.tsx` is the application shell and route/page coordinator. Feature screens include POS and receipt printing, product/catalog and stock inventory, purchasing and purchase history, suppliers, customers and ledger, sales history, reports, cash book, settings, staff management, and print-request workflows.
- Existing import/export includes product CSV import, product CSV/XLSX export, purchase-history XLSX export, and browser printing for thermal/A4 receipts.
- Existing behavior also includes browser-local preferences, purchase drafts, WhatsApp templates, held bills, and some in-memory or demo-only data. These are not automatically persisted in SQLite.
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
- Electron `safeStorage` protects the database and recovery keys under per-user `app.getPath('userData')`. Portable backup files carry the encrypted SQLite database and an AES-256-GCM-wrapped database key derived with scrypt; restore verifies the key and database integrity, preserves rollback copies, updates the active database key, and is available before sign-in. Automated and packaged restore behavior still need acceptance testing.
- `desktop-app` sets `contextIsolation`, `sandbox`, and `nodeIntegration: false`; its preload exposes a limited IPC bridge. The renderer builds into `desktop-app/renderer/`, and Electron starts Fastify on loopback. Packaging previously produced an unsigned NSIS x64 installer; installer and clean-install acceptance remain incomplete.
- `developer-dashboard` supports Supabase sign-in, shop creation/listing, license status/expiry management, and unused activation-key revocation. No deployed dashboard/central service has been verified.
- `central-backend` checks a signed-in Supabase identity against the `developer_owners` allowlist, and activation-key redemption uses a SQL RPC for atomic single-use consumption. A separate local-only dev service creates an ignored Ed25519 keypair and one-time test pharmacy/code; its activation/check-in protocol is tested without Supabase. Production deployment and real activation remain unverified.

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
| Licenses, suspension, renewals, resets | Dashboard can list/change shop status and expiry; local signature/expiry/device checks and periodic check-in exist | Verify suspension/renewal end to end and define authorized replacement-device reissue and password-reset flows |
| Offline grace and clock rollback | Basic local timestamp/high-water logic exists | Validate signed entitlements, persist transaction high-water marks transactionally, handle clock jumps and backups/restores; define safe restricted-mode behavior |
| Updates and release verification | `electron-updater` dependency is present; no updater workflow is wired | Signed release manifest, hash/signature verification, staged rollout/rollback, and data-preservation tests |
| Packaging and installation | Local-development NSIS x64 installer has been produced; earlier packaged startup passed | Test full workflows, clean install/upgrade/uninstall, data preservation, and ACLs; sign before release |
| SQLCipher, code signing, Inno Setup | Not implemented | Add only after architecture/build decisions; current NSIS config is not an Inno Setup installer |

## 3. Current blockers

1. **Feature parity is incomplete.** Local login/session restore, activation/setup UI, POS catalog/checkout, customer lookup, sales history, shop settings, and parts of the backend are wired. Many existing screens and services still use Supabase or browser/in-memory state; do not assume desktop mode is fully offline.
2. **Installer packaging succeeds; release qualification remains incomplete.** `npm run desktop:local:package` rebuilt `better-sqlite3-multiple-ciphers` for Electron 39.8.10 and produced `desktop-app/release/PharmaCare-1.0.0-Setup.exe`. The unpacked packaged app starts and creates its encrypted local profile after fixing two packaging/runtime issues. The installer is unsigned and has not been installed on a clean Windows machine.
3. **Local API authorization still needs complete review.** Startup requires a JWT secret and loopback auth token; route permission checks and backend tests cover selected operations, not the full feature surface.
4. **Licensing is not verified end to end.** Local Ed25519 signature, expiry, status, device-binding, clock-rollback, and grace-period checks are implemented. Central signing/check-in now uses the matching-key protocol, but no private/public key pair, deployed central API, or live activation was configured or tested here.
5. **Shop creation is multi-step.** Central shop, license, and activation creation use sequential requests rather than one transaction; failed intermediate calls may leave partial records.
6. **Encrypted data recovery is implemented but not release-qualified.** The database uses `better-sqlite3-multiple-ciphers`, not SQLCipher compatibility mode. Recovery-key backup/restore is tested at the backend level and the desktop restore path now supports pre-login use with database/key rollback on errors; the packaged UI has not been acceptance-tested. The restored signed entitlement is still device-bound, so a replacement PC needs an authorized reissue. Backup retention and Windows ACLs are not qualified.
7. **Exports and remaining desktop flows are incomplete.** CSV/XLSX exports now use filtered rows on the product/stock, purchase history, supplier, customer, staff, cashbook, sales report, and pending-return screens. Other tables and desktop-local data paths still need migration and tests.
8. **Deployment prerequisites are absent.** No central signing key/API deployment, code-signing certificate, or clean Windows VM acceptance run is available. The installer is unsigned and no signed update pipeline is configured. `npm audit fix` resolved compatible findings; 8 advisories remain in the Electron/Electron Builder dependency chain because their available fixes require major upgrades and Electron ABI requalification.

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
- `npm run desktop:package` previously completed and produced an unsigned NSIS x64 installer. Packaged startup was smoke-tested; the new local-dev activation flow has API tests, but a packaged full activation and transaction workflow has not been run.
- `.env` values were not read, printed, or changed. Environment variable names may be documented in `.env.example` files.

## 7. Immediate next actions

1. Migrate each Supabase-backed workflow to the local API and add parity tests, including purchases, returns, suppliers, inventory, reports, settings/profile, staff, printing, and filtered exports.
2. Finish license entitlement verification, device/expiry/grace rules, periodic check-in, and clock-rollback handling; apply and test the central schema in a controlled Supabase project.
3. Decide portable backup/key recovery and Windows ACL policy before storing production data.
4. Provide a compatible Windows C++ build toolchain, build the NSIS installer, and test fresh install, upgrade, backup/restore, and data preservation on clean Windows VMs.
5. Add end-to-end activation and smoke tests with a deployed central API, then sign the installer/update metadata before distribution.

## Current update (2026-11-21)

- Electron now uses hash-based routes while web routing remains pathname-based. Desktop print-request creation, lists, decisions, modifications, printed tracking, and pending counts use the local API; remote QR links and automatic approval remain unavailable in that flow.
- The focused route tests, local-backend tests, lint, and `npm run desktop:local:package` passed; the x64 NSIS installer was rebuilt.
- Packaged UI acceptance did not complete: the Computer Use launch returned no targetable window. The already-running local-development window still showed Page not found and the old Supabase print-count toast. This stale window is not evidence that the rebuilt package passes or fails; verify the packaged executable and all sidebar pages when a targetable window is available.
