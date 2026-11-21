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

## Licensing and production gates

Activation uses the central API and a one-time activation redemption procedure. Local Ed25519 signature, expiry, device binding, status, clock high-water mark, and grace-period checks are implemented. The central API still requires a deployed matching key pair, applied schema, Owner allowlist, and end-to-end check-in verification before activation is trusted.

## Native code and packaging

No business logic is moved into custom native code: the expected reverse-engineering protection is limited, while ABI and platform maintenance costs are high. Native SQLite and Argon2 modules still require Electron-compatible Windows builds. Packaging is not considered successful until a clean installer is built and exercised on a Windows machine with the required C++ toolchain.

## Known release limitations

The desktop feature set is a vertical-slice foundation, not complete offline parity. A code-signing certificate, migration of remaining browser/in-memory workflows, complete table/export coverage, device-license reissue for replacement PCs, and clean-machine install/upgrade acceptance remain outstanding. See the project audit for the full acceptance gates.

## Local licensing development and recovery

Local activation development uses a separate loopback-only Fastify service and generated Ed25519 keypair under ignored `central-backend/.dev/`; it does not reuse production Supabase state or keys. `desktop:local` opts into plain HTTP only for the explicitly marked loopback development build. Production packaged builds still require HTTPS. The development private key is not embedded in the desktop binary.

Portable backups use an authenticated AES-256-GCM envelope to wrap the random local database key with a Shop Admin recovery key derived using scrypt. The backup contains the already-encrypted SQLite file; restore validates its cipher integrity and stored recovery-key verifier before installation. This supports data recovery on another machine, but the signed license remains bound to the original device and must be reissued by the licensing operator after transfer.

Daily backups remain scheduled automatically and are portable when a recovery key is configured; Settings exposes manual portable export/restore, and the login screen allows recovery before sign-in on a replacement PC. Restore keeps rollback copies of the database and protected keys and updates the in-process database key before restarting the local API; error rollback is implemented but packaged restore acceptance remains outstanding. The license remains device-bound and requires operator reissue after transfer. CSV/XLSX exports reuse the records filtered by the respective screens. Export coverage and local data-path parity remain incomplete and are not release acceptance.

## 2026-11-21 desktop continuation

The local Windows packaging environment successfully rebuilt the SQLite native module and produced an unsigned NSIS installer. A packaged-app startup smoke test exposed and fixed the backend standalone-runner guard and an IPC packaged-renderer URL check. At that validation point the installer had not been tested through activation or business workflows; a later local-only licensing service now has API activation/check-in coverage, but packaged workflows and production central activation remain unverified.

`npm audit fix` was used without `--force`. It fixed compatible transitive findings; the remaining Electron/Electron Builder chain advisories require major-version changes that were not taken because of Electron/SQLite ABI compatibility risk. See `docs/WINDOWS_DESKTOP_AUDIT.md`.

## 2026-11-21 desktop continuation

Added loopback development central licensing (`central:dev`, `desktop:local`), local-only Ed25519 key generation and one-time test activation, recovery-key-gated portable backup/restore, and CSV/XLSX export controls for several filtered screens. Focused central, portable backup, CSV, local-backend, and renderer checks pass. The local workflows do not establish full renderer/backend parity or validate production Supabase deployment; remaining acceptance gaps are tracked in `docs/PROJECT_CONTEXT.md` and `docs/WINDOWS_DESKTOP_AUDIT.md`.

## 2026-11-21 desktop parity and icon continuation

Use the supplied `public/pharma-care-512.png` as the sole desktop identity asset. Generate a transparent 16/24/32/48/64/128/256px multi-frame ICO and retain an exact 512px PNG copy under `desktop-app/build/`. Apply the ICO to the BrowserWindow, Windows executable, NSIS installer/uninstaller/header, and shortcuts; use the builder `appId` as the Windows AppUserModelID. Package the assets in resources so development and packaged paths are both explicit and checked.

Local routes and UI adapters were extended for master data, products/import preview, stock views, purchase history, sidebar preferences, stock alerts, and cashbook persistence. A focused backend test expectation was corrected to refer to the product's edited code (`MED-002`), rather than the stale pre-edit code; product behavior did not change.

Do not treat this as full parity. `docs/PARITY_GAPS.md` is the current per-screen source inventory. In particular, the sale-return request/review workflow is still Supabase-only, browser-local state remains for some preferences/drafts, receipt QR links are disabled offline, and UI mutation/role acceptance is outstanding. Do not make a release-readiness claim based solely on a successful installer build or API tests.
