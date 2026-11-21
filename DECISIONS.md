# Implementation decisions

## Preserve the existing application

The existing React/Vite application remains the web experience. Desktop support is added alongside it rather than replacing the UI or removing the existing Supabase paths. Desktop feature parity is incomplete and is not represented as a finished offline product.

## Desktop renderer configuration

The desktop renderer is built into `desktop-app/renderer/` using the existing Vite configuration. Its build sets `envDir: false` so local `.env` files are not loaded into the renderer bundle. The central licensing service URL is a public endpoint configured at Electron main-process build time; private Supabase and signing credentials must remain server-side.

## Local database and key storage

The local database uses `better-sqlite3-multiple-ciphers` with its configured database key and encrypted file backups. This is not SQLCipher compatibility mode. Electron `safeStorage` protects the database key using the current Windows user's protected storage; moving the database to another profile or machine requires a recovery mechanism that is not implemented.

## Authentication and permissions

Local passwords are Argon2id-hashed, and the local Fastify API checks user roles/permissions. Seller discount enforcement uses the cashier percentage setting because the existing shop-settings UI has no separate Seller cap. Backend enforcement, not hidden UI controls, is authoritative for the local checkout route.

## Licensing and production gates

Activation uses the central API and a one-time activation redemption procedure. The local app does not yet verify signed license entitlements or enforce all expiry/device-binding and periodic check-in rules. The central service, Supabase schema, Owner allowlist, and deployment configuration require environment-specific deployment and verification before activation is trusted.

## Native code and packaging

No business logic is moved into custom native code: the expected reverse-engineering protection is limited, while ABI and platform maintenance costs are high. Native SQLite and Argon2 modules still require Electron-compatible Windows builds. Packaging is not considered successful until a clean installer is built and exercised on a Windows machine with the required C++ toolchain.

## Known release limitations

The desktop feature set is a vertical-slice foundation, not complete offline parity. A code-signing certificate, portable encrypted-backup recovery, migration of remaining Supabase-backed screens, and release installer verification remain outstanding. See the project audit for the full acceptance gates.
