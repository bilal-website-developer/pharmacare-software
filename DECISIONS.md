# Implementation decisions

## Preserve the existing application

The existing React/Vite application remains the web experience. Desktop support is added alongside it rather than replacing the UI or removing the existing Supabase paths. Desktop feature parity is incomplete and is not represented as a finished offline product.

## Desktop renderer configuration

The desktop renderer is built into `desktop-app/renderer/` using the existing Vite configuration. Its build sets `envDir: false` so local `.env` files are not loaded into the renderer bundle. The central licensing service URL is a public endpoint configured at Electron main-process build time; private Supabase and signing credentials must remain server-side.

## Local database and key storage

The local database uses `better-sqlite3-multiple-ciphers` with its configured database key and encrypted file backups. This is not SQLCipher compatibility mode. Electron `safeStorage` protects the database key using the current Windows user's protected storage; moving the database to another profile or machine requires a recovery mechanism that is not implemented.

## License entitlement signatures

License entitlements use Ed25519 signatures. `CENTRAL_LICENSE_PRIVATE_KEY` stays in the central service; the desktop build receives only the matching `CENTRAL_LICENSE_PUBLIC_KEY`. Local verification fails closed for invalid signatures, expiry, device mismatch, suspended/revoked status, or offline-grace exhaustion. The central service must be redeployed with the private key and the desktop installer rebuilt with the matching public key; the HMAC token format is not accepted.

## Desktop-only data access

The desktop Vite build aliases the Supabase client module to a `null` shim, so the Supabase SDK and client are not used in the desktop renderer. This prevents desktop builds from connecting to Supabase through that client, but it does not migrate browser-local/mock screens or provide missing local backend endpoints; offline parity remains incomplete.

## Authentication and permissions

Local passwords are Argon2id-hashed, and the local Fastify API checks user roles/permissions. Seller discount enforcement uses the cashier percentage setting because the existing shop-settings UI has no separate Seller cap. Backend enforcement, not hidden UI controls, is authoritative for the local checkout route.

## Licensing and production gates

Activation uses the central API and a one-time activation redemption procedure. Local Ed25519 signature, expiry, device binding, status, clock high-water mark, and grace-period checks are implemented. The central API still requires a deployed matching key pair, applied schema, Owner allowlist, and end-to-end check-in verification before activation is trusted.

## Native code and packaging

No business logic is moved into custom native code: the expected reverse-engineering protection is limited, while ABI and platform maintenance costs are high. Native SQLite and Argon2 modules still require Electron-compatible Windows builds. Packaging is not considered successful until a clean installer is built and exercised on a Windows machine with the required C++ toolchain.

## Known release limitations

The desktop feature set is a vertical-slice foundation, not complete offline parity. A code-signing certificate, portable encrypted-backup recovery, migration of remaining browser/in-memory workflows, filtered exports, and clean-machine install/upgrade acceptance remain outstanding. See the project audit for the full acceptance gates.

## 2026-11-21 desktop continuation

The local Windows packaging environment successfully rebuilt the SQLite native module and produced an NSIS installer. A packaged-app startup smoke test exposed and fixed the backend standalone-runner guard and an IPC packaged-renderer URL check. The installer remains unsigned and was not tested through activation or business workflows because no central endpoint/key pair is configured.

`npm audit fix` was used without `--force`. It fixed compatible transitive findings; the remaining Electron/Electron Builder chain advisories require major-version changes that were not taken because of Electron/SQLite ABI compatibility risk. See `docs/WINDOWS_DESKTOP_AUDIT.md`.
