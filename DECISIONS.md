# Implementation decisions

## Preserve the existing application

The existing React/Vite application remains the web experience. Desktop support is added alongside it rather than replacing the UI or removing the existing Supabase paths. Desktop feature parity is incomplete and is not represented as a finished offline product.

## Desktop renderer configuration

The desktop renderer is built into `desktop-app/renderer/` using the existing Vite configuration. Its build sets `envDir: false` so local `.env` files are not loaded into the renderer bundle. The central licensing service URL is a public endpoint configured at Electron main-process build time; private Supabase and signing credentials must remain server-side.

## Local database and key storage

The local database uses `better-sqlite3-multiple-ciphers` with its configured database key and encrypted file backups. This is not SQLCipher compatibility mode. Electron `safeStorage` protects the database and recovery keys under the current Windows user's protected storage. Portable backups can restore the encrypted database on another PC with the recovery key, but the device-bound license still requires authorized reissue.

## License entitlement signatures

License entitlements use Ed25519 signatures. `CENTRAL_LICENSE_PRIVATE_KEY` stays in the central service; the desktop build receives only the matching `CENTRAL_LICENSE_PUBLIC_KEY`. Local verification fails closed for invalid signatures, expiry, device mismatch, suspended/revoked status, or offline-grace exhaustion. The central service must be redeployed with the private key and the desktop installer rebuilt with the matching public key; the HMAC token format is not accepted.

## Desktop-only data access

The desktop Vite build aliases the Supabase client module to a `null` shim, so the Supabase SDK and client are not used in the desktop renderer. This prevents desktop builds from connecting to Supabase through that client, but it does not migrate browser-local/mock screens or provide missing local backend endpoints; offline parity remains incomplete.

## Desktop navigation and print requests

The web app keeps pathname routing; the Electron renderer uses URL hash routes so `file:` URLs retain the packaged HTML path while sidebar navigation, refresh, deep links, and back/forward remain functional. Desktop print-request creation, lists, decisions, edit, print tracking, and pending counts use the local encrypted SQLite backend. The web build retains its Supabase implementation. Local print requests do not provide remote receipt-QR links or automatic approval.

## Authentication and permissions

Local passwords are Argon2id-hashed, and the local Fastify API checks user roles/permissions. Seller discount enforcement uses the cashier percentage setting because the existing shop-settings UI has no separate Seller cap. Backend enforcement, not hidden UI controls, is authoritative for the local checkout route.

The JWT trust callback reloads the account from SQLite whenever tokens are verified. It rejects missing/inactive accounts, changed roles, and non-admin tokens with absent or stale permission arrays. Admin permission claims are not authoritative because Admin access is determined by the current role and signed license entitlements; the global hook replaces request identity with current database values before route checks. Local JWT secrets are generated per app launch, so non-admin tokens do not need a missing-claim compatibility path.

## Licensing and production gates

Activation uses the central API and a one-time activation redemption procedure. Local Ed25519 signature, expiry, device binding, status, clock high-water mark, and grace-period checks are implemented. The central API still requires a deployed matching key pair, applied schema, Owner allowlist, and end-to-end check-in verification before activation is trusted.

## Native code and packaging

No business logic is moved into custom native code: the expected reverse-engineering protection is limited, while ABI and platform maintenance costs are high. Native SQLite and Argon2 modules still require Electron-compatible Windows builds. Packaging is not considered successful until a clean installer is built and exercised on a Windows machine with the required C++ toolchain.

## Known release limitations

The desktop feature set is a vertical-slice foundation, not complete offline parity. A code-signing certificate, migration of remaining browser/in-memory workflows, complete table/export coverage, production acceptance of the implemented device-license reissue flow, and clean-machine install/upgrade acceptance remain outstanding. See the project audit for the full acceptance gates.

## Local licensing development and recovery

Local activation development uses a separate loopback-only Fastify service and generated Ed25519 keypair under ignored `central-backend/.dev/`; it does not reuse production Supabase state or keys. `desktop:local` opts into plain HTTP only for the explicitly marked loopback development build. Production packaged builds still require HTTPS. The development private key is not embedded in the desktop binary.

Portable backups use an authenticated AES-256-GCM envelope to wrap the random local database key with a Shop Admin recovery key derived using scrypt. The backup contains the already-encrypted SQLite file; restore validates its cipher integrity and stored recovery-key verifier before installation. This supports data recovery on another machine, but the signed license remains bound to the original device and must be reissued by the licensing operator after transfer.

Daily backups remain scheduled automatically and are portable when a recovery key is configured; Settings exposes manual portable export/restore, and the login screen allows recovery before sign-in on a replacement PC. Restore keeps rollback copies of the database and protected keys and updates the in-process database key before restarting the local API; error rollback is implemented but packaged restore acceptance remains outstanding. The license remains device-bound and requires operator reissue after transfer. CSV/XLSX exports reuse the records filtered by the respective screens. Export coverage and local data-path parity remain incomplete and are not release acceptance.

## Product CSV import

Product CSV import has no fixed total-row cap. Settings provides full-catalog CSV/XLSX export and CSV import, independent of Products-page filters. Preview and import requests are sent in 500-row batches; the Settings preview summarizes counts and only shows a few errors so large files do not create tens of thousands of DOM nodes. Each import batch is transactional; if a later batch fails, the UI reports the confirmed imported count and requires re-previewing the same file so already-imported products are identified as duplicates. Duplicate preview checks use indexed sets instead of comparing every row with all prior rows.

Optional opening-stock columns are `opening_stock_qty` (sale units), `opening_batch_number`, `opening_expiry_date` (strict future `YYYY-MM-DD`), and `opening_cost_paisa` (per sale unit). The server multiplies quantity by the unit conversion factor and records the batch plus an initial/receipt stock movement atomically. Only users with cost-price visibility can write opening stock. Aggregate legacy/current stock fields are reference-only and do not create sellable batches; never infer a batch from aggregate quantity or expiry.

The supplied source catalog was converted to 36,636 import-valid but inactive review rows. Source `unit` is the sale-unit conversion factor; `percrtn` is a carton count and is not the app's sale-unit factor. `CompanyCode` resolves the complete manufacturer lookup, while `CmpCd` alone misses entries. `rp` was converted from the source's apparent currency units to paisa; verify prices and clinical classifications before activating. A separate five-row DEMO-only file uses synthetic names, quantities, prices, batches, and future expiries; do not merge its fake stock into the real catalog.

Web opening-stock imports use the additive `supabase/migrations/20261122150000_products_csv_opening_stock.sql` wrapper around the existing bulk-import RPC. Apply the migration before using opening-stock fields on web; SQL was not run against a live Supabase project.

## Inactive catalog activation

Imported inactive medicines remain searchable through the Products page's visible Active/Inactive/All status filter. Inactive products are excluded from the desktop stock KPIs. On first activation, the user confirms the current quantity in the product's default sale unit. Zero records that the opening-stock question was answered without creating a batch. Positive quantities require a real batch number, future expiry, and cost-per-sale-unit permission; activation, the batch, stock movement, and persistent one-time marker are committed atomically. Later edits and reactivations do not prompt again. Direct bulk activation is blocked until this first confirmation is recorded.

## Master data CSV exchange

Categories, Manufacturers, and Units each export only the active tab's records; category/manufacturer exports use distinct headers and respect the current search filter. Category/manufacturer imports add new names and skip existing names rather than renaming referenced records. Unit CSVs link to an existing medicine by product code and may include a unit ID to update an existing unit; unit writes reuse the existing product-save permission checks. Unit import preserves exactly one default sale unit per medicine and reports partial failures.

## Production central licensing deployment

The canonical production Supabase setup is [`supabase/production/setup.sql`](./supabase/production/setup.sql). Licensing objects use the `central_` prefix so the new single Supabase project can also host the web app. The `central-licensing` Edge Function serves the API and keeps its service-role/signing credentials server-side; Render is optional. Production Ed25519 keys are generated locally into an ignored directory, and desktop packaging embeds only the public signing key and public Supabase anon key.

The Developer Owner dashboard's **Reissue licence for a new PC** action atomically deletes old device registrations and unused activation keys before storing a new hashed one-time code. This deliberately supports one active device at a time; a disconnected old PC can still use its cached signed entitlement until offline grace expires. The replacement key is displayed once and must be delivered privately.

On 2026-11-23, a local commit captured credential material in the Render blueprint. The owner reports that the old Supabase project was deleted, so its project credentials must not be reused. The Ed25519 signing key is independent of the project and remains compromised; replace it before activation, unless a prior real activation requires a coordinated client rollover. Scrub that history before any future remote publication.

## One-project central licensing and hosting

The owner has only one Supabase project slot and selected the new project for the whole application. Central licensing tables and RPCs are namespaced `central_*`; no central SQL may alter or revoke grants on the app's existing public tables. The API is implemented as a Supabase Edge Function so Render is not required. The function uses the project service-role key only in its server environment; this remains a highly privileged project-wide secret and must never reach browser or desktop builds. Vercel Services deploy the pharmacy web app at `/` and the Developer dashboard at `/developer/`; `/developer`, `/developer/`, and dashboard deep links explicitly serve the dashboard's built `index.html`, while `/developer/assets/*` maps to its built assets. The central API remains on Supabase Edge Functions, and the loopback-only encrypted local backend stays in the Electron desktop. No Vercel service bindings are needed because there are no server-to-server Vercel calls.

## Desktop update delivery

The desktop uses a manually initiated update flow rather than silent installation. A separately generated Ed25519 key authenticates a stable-version manifest that binds an HTTPS installer URL and its SHA-512 digest. The app verifies the manifest, refuses redirects/HTTP, streams the installer under a size limit, verifies the digest, and only opens it after an explicit user choice. The manifest key is not the license-signing key. Feed hosting, signed Windows Authenticode releases, upgrade/rollback testing, and key rotation remain deployment/release requirements; a signed manifest alone does not make an unsigned installer publisher-verified.

## Desktop workflow drafts

POS held bills and purchase drafts are shop-local workflow state, so desktop mode stores them in encrypted SQLite by authenticated user instead of browser storage. Reads and writes require the corresponding POS or Purchases entitlement/permission, have bounded payload sizes, and cannot target another user. The web application keeps its existing browser-local draft behavior; no draft data is synchronized to the Developer service.

Appearance, saved-filter, and alert-acknowledgement preferences remain per-user/device UI state in browser storage. They do not affect pharmacy records or business calculations and are not synchronized or included in backups. This is an intentional boundary, not a local-backend fallback; business records and operational drafts must use the encrypted local database.

## Developer shop monitoring and announcements

The central service records the last successful check-in, app/OS version, and a boolean indicating whether initial Shop Admin setup completed. It never uploads local account names, passwords, password hashes, or pharmacy business records for this display. The Developer Owner dashboard shows the timestamp and a 24-hour stale-status indicator, not live connectivity.

Offline grace and the warning-before-lockout window are configured centrally and included in the signed license token. The local backend verifies the signature and blocks new transactions after its cached grace period; changes to the signed policy take effect on the next successful check-in. A published announcement is targeted to one or more shops (or all shops) and synced into the local encrypted database on check-in. Only the local Shop Admin can read or mark those announcements; other staff receive no message content. Drafts are central-only and private to authorized Developer Owners; unpublishing/removing a message reaches an offline shop only after it reconnects.

Do not add a covert, hidden Super Admin account, hard-coded credentials, or remote shell/control. The Developer Owner is a central licensing role, distinct from local shop users. Current check-ins report only whether Shop Admin setup is complete; they do not prove or disclose any Super Admin account. The announcement facility provides messages, not automatic software download/installation.

## 2026-11-22 desktop entitlement and E2E continuation

The existing page/feature permission keys are carried in the central signed license, persisted and verified by the local backend, and used by desktop navigation and local route authorization. Licenses predating these fields retain the backward-compatible all-enabled default. The separate return-request/review workflow and unsupported Shops, Demo, WhatsApp Reminders, and Print Requests are hidden in desktop mode; direct medicine returns within POS use the local API.

The Playwright Electron test uses a freshly generated temporary Ed25519 keypair, temporary profile/database, and test-only development file selection for portable backup/restore. It does not read or modify `central-backend/.dev/`, `.env`, or the user's real Electron profile. Keep test file-path overrides disabled for packaged builds. Purchases and returns must create their parent transaction rows before dependent items inside the same SQLite transaction; the E2E regression covers both operations.

The Electron E2E now covers activation/admin setup, every supported v1 sidebar page, Manager/Seller/Cashier navigation and API-denial rules, representative catalog/supplier/customer/staff lifecycle actions, purchase and void, cash and split sales, POS return, expenses, export download requests, encrypted/portable backup and restore, signed Settings entitlement check-in and offline enforcement, and offline reopen. It also silently installs the generated NSIS package into a temporary directory, activates it, creates an admin, posts a sale, uninstalls it, and verifies that the isolated user database is retained. The test drives many mutations through the local API bridge rather than the page controls; read-only and immutable-transaction screens do not have literal add/edit/delete lifecycles. Printer hardware, production central licensing and reissue acceptance, and clean-machine qualification remain unverified.

## 2026-11-21 desktop continuation

The local Windows packaging environment successfully rebuilt the SQLite native module and produced an unsigned NSIS installer. A packaged-app startup smoke test exposed and fixed the backend standalone-runner guard and an IPC packaged-renderer URL check. At that validation point the installer had not been tested through activation or business workflows; a later local-only licensing service now has API activation/check-in coverage, but packaged workflows and production central activation remain unverified.

`npm audit fix` was used without `--force`. It fixed compatible transitive findings; the remaining Electron/Electron Builder chain advisories require major-version changes that were not taken because of Electron/SQLite ABI compatibility risk. See `docs/WINDOWS_DESKTOP_AUDIT.md`.

## 2026-11-21 desktop continuation

Added loopback development central licensing (`central:dev`, `desktop:local`), local-only Ed25519 key generation and one-time test activation, recovery-key-gated portable backup/restore, and CSV/XLSX export controls for several filtered screens. Focused central, portable backup, CSV, local-backend, and renderer checks pass. The local workflows do not establish full renderer/backend parity or validate production Supabase deployment; remaining acceptance gaps are tracked in `docs/PROJECT_CONTEXT.md` and `docs/WINDOWS_DESKTOP_AUDIT.md`.

## 2026-11-21 desktop parity and icon continuation

Use the supplied `public/pharma-care-512.png` as the sole desktop identity asset. Generate a transparent 16/24/32/48/64/128/256px multi-frame ICO and retain an exact 512px PNG copy under `desktop-app/build/`. Apply the ICO to the BrowserWindow, Windows executable, NSIS installer/uninstaller/header, and shortcuts; use the builder `appId` as the Windows AppUserModelID. Package the assets in resources so development and packaged paths are both explicit and checked.

Local routes and UI adapters were extended for master data, products/import preview, stock views, purchase history, sidebar preferences, stock alerts, and cashbook persistence. A focused backend test expectation was corrected to refer to the product's edited code (`MED-002`), rather than the stale pre-edit code; product behavior did not change.

Do not treat this as full parity. `docs/PARITY_GAPS.md` is the current per-screen source inventory. In particular, the sale-return request/review workflow is still Supabase-only, browser-local state remains for some preferences/drafts, receipt QR links are disabled offline, and UI mutation/role acceptance is outstanding. Do not make a release-readiness claim based solely on a successful installer build or API tests.
