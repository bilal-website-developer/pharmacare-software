import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify, { type FastifyInstance } from 'fastify';
import { hashActivationCode, signLicenseToken, type LicenseClaims } from './licensingCrypto.js';

interface DevelopmentLicenseState {
  shopId: string;
  shopName: string;
  shopStatus: string;
  licenseStatus: LicenseClaims['status'];
  expiresAt: string;
  graceDays: number;
  activationCodeHash: string;
  activationUsed: boolean;
  hardwareId: string | null;
}

export function buildDevelopmentLicensingServer(configDir: string): FastifyInstance {
  const statePath = path.join(configDir, 'state.json');
  const privateKeyPath = path.join(configDir, 'license-private.pem');
  if (!fs.existsSync(statePath) || !fs.existsSync(privateKeyPath)) {
    throw new Error('Local development license files are missing; run `npm run central:dev:seed`.');
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as DevelopmentLicenseState;
  const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  const app = fastify({ logger: false, bodyLimit: 16 * 1024 });

  const persistState = () => {
    const temporaryPath = `${statePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, statePath);
  };

  const makeToken = (hardwareId: string): string => signLicenseToken({
    shopId: state.shopId,
    shopName: state.shopName,
    expiresAt: state.expiresAt,
    hardwareId,
    status: state.shopStatus === 'ACTIVE' ? state.licenseStatus : 'SUSPENDED',
    graceDays: state.graceDays,
  }, privateKey);

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.post('/api/licensing/activate', async (request, reply) => {
    const body = request.body as { activationCode?: string; hardwareId?: string };
    if (!body?.activationCode || !body.hardwareId || !/^[a-f0-9]{64}$/i.test(body.hardwareId)) {
      return reply.code(400).send({ error: 'Activation code and device fingerprint are required.' });
    }
    if (
      state.activationUsed
      || hashActivationCode(body.activationCode.trim()) !== state.activationCodeHash
      || Date.parse(state.expiresAt) <= Date.now()
      || state.shopStatus !== 'ACTIVE'
      || state.licenseStatus !== 'ACTIVE'
    ) {
      return reply.code(403).send({ error: 'Development activation code is invalid, expired, used, or inactive.' });
    }
    state.activationUsed = true;
    state.hardwareId = body.hardwareId;
    persistState();
    return reply.send({
      success: true,
      shop: { id: state.shopId, shop_name: state.shopName, status: state.shopStatus },
      licenseToken: makeToken(body.hardwareId),
    });
  });

  app.post('/api/licensing/check-in', async (request, reply) => {
    const body = request.body as { shopId?: string; hardwareId?: string };
    if (body?.shopId !== state.shopId || body?.hardwareId !== state.hardwareId) {
      return reply.code(403).send({ error: 'Development device is not registered for this pharmacy.' });
    }
    return reply.send({ success: true, licenseToken: makeToken(body.hardwareId) });
  });

  return app;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisPath = fileURLToPath(import.meta.url);
if (entryPath === thisPath) {
  const configDir = path.resolve(path.dirname(thisPath), '../.dev');
  const app = buildDevelopmentLicensingServer(configDir);
  const port = Number(process.env.CENTRAL_DEV_PORT || 4000);
  await app.listen({ host: '127.0.0.1', port });
  console.log(`Local development licensing service listening on http://127.0.0.1:${port}`);
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
