# Pharma Care

This repository preserves the existing React/Vite pharmacy application and adds an Electron desktop shell with a local Fastify/SQLite backend. The desktop conversion is **in progress and not ready for pharmacy production use**: several feature screens still call Supabase, activation requires a deployed central service, and a working Windows installer has not been produced in this environment.

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
`npm test` includes the local and central backend test suites via `test:backends`.

## Desktop development and packaging

```powershell
npm run desktop:renderer
npm run build --workspace=desktop-app
npm start --workspace=desktop-app
npm run desktop:package
```

The Electron main process reads the public `CENTRAL_API_URL` at build time. Set it in the build environment only when using a deployed HTTPS central licensing API. Do not put Supabase service-role keys, central signing secrets, or private signing keys in desktop or renderer build variables.

The encrypted local database and safe-storage-protected key are kept under Electron's per-user `app.getPath('userData')` directory. Backups are encrypted copies that use the same local key; they are not portable to another Windows profile or machine without a separately designed recovery process.

`npm run desktop:package` currently requires a compatible Visual Studio C++ Build Tools installation to rebuild the native SQLite addon for Electron. In the checked environment it fails because those build tools are unavailable (and the workspace path contains spaces, which node-gyp also warns about). No signed installer has been produced. Code signing requires a publisher certificate and is not configured.

## Desktop readiness and limitations

- Local login, first-admin setup, activation UI, local API transport, POS/catalog, customer and sales-history adapters, shop operational settings, and encrypted database backup/restore foundations exist.
- The UI is not fully backed by the local API. Inventory management, purchases, suppliers, returns, full reports, user management, exports, and other workflows still need end-to-end migration and tests. Do not assume all visible pages work offline.
- The central SQL schema must be applied to a configured Supabase project and the central service deployed before real activation can work. No live project was configured or tested here.
- Local license signatures, expiry/device binding, periodic check-in, and complete clock-tamper handling are not enforced locally.
- JavaScript minification/obfuscation cannot prevent reverse engineering. The installer and application are unsigned.

See [DECISIONS.md](./DECISIONS.md) and [docs/WINDOWS_DESKTOP_AUDIT.md](./docs/WINDOWS_DESKTOP_AUDIT.md) for implementation choices and remaining gates.
