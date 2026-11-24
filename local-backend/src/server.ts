import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import Database from 'better-sqlite3-multiple-ciphers';
import { createDatabaseConnection } from './db/database';
import { initializeSchema } from './db/schema';
import { registerAuthRoutes } from './routes/authRoutes';
import { registerPosRoutes } from './routes/posRoutes';
import { registerInventoryRoutes } from './routes/inventoryRoutes';
import { registerPurchaseRoutes } from './routes/purchaseRoutes';
import { registerCustomerRoutes } from './routes/customerRoutes';
import { registerCashbookRoutes } from './routes/cashbookRoutes';
import { registerReportRoutes } from './routes/reportRoutes';
import { registerSettingsRoutes } from './routes/settingsRoutes';
import { registerPrintRequestRoutes } from './routes/printRequestRoutes';
import { registerMasterDataRoutes } from './routes/masterDataRoutes';
import { registerTrashRoutes } from './routes/trashRoutes';
import { registerNotificationRoutes } from './routes/notificationRoutes';
import { registerStockRoutes } from './routes/stockRoutes';
import { registerPreferenceRoutes } from './routes/preferenceRoutes';
import { registerWorkflowDraftRoutes } from './routes/workflowDraftRoutes';
import { backupDatabase } from './db/database';
import { activateShopLicense, checkLicenseStatus, recordSuccessfulCheckin } from './services/licenseService';
import { getUserById } from './services/authService';

export interface ServerOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  jwtSecret?: string;
  localAuthToken?: string;
}

export function buildServer(options: ServerOptions = {}): { app: FastifyInstance; db: Database.Database } {
  const jwtSecret = options.jwtSecret || process.env.LOCAL_JWT_SECRET;
  if (!jwtSecret) throw new Error('LOCAL_JWT_SECRET must be provided.');
  const app = fastify({ logger: false });
  const db = createDatabaseConnection(options.dbPath);

  // Initialize schema
  initializeSchema(db);

  // Plugins
  app.register(cors, {
    origin: ['null', 'http://localhost:3000', 'http://127.0.0.1:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  app.register(jwt, {
    secret: jwtSecret,
    trusted: async (_request, decodedToken) => {
      const identity = decodedToken as { userId?: unknown; role?: unknown; permissions?: unknown };
      if (typeof identity.userId !== 'string'
        || typeof identity.role !== 'string') {
        return false;
      }
      const user = getUserById(db, identity.userId);
      if (!user || !user.isActive || identity.role !== user.role) return false;
      if (user.role === 'admin') return true;
      if (!Array.isArray(identity.permissions)
        || identity.permissions.some((permission) => typeof permission !== 'string')) return false;
      const tokenPermissions = [...identity.permissions].sort();
      const currentPermissions = [...user.permissions].sort();
      return JSON.stringify(tokenPermissions) === JSON.stringify(currentPermissions);
    },
  });

  // Health check
  app.get('/api/health', async () => ({ status: 'ok', time: Date.now() }));

  if (options.localAuthToken) {
    app.addHook('preHandler', async (request, reply) => {
      if (request.url === '/api/health') return;
      const suppliedToken = request.headers['x-local-auth-token'];
      if (suppliedToken !== options.localAuthToken) {
        return reply.status(401).send({ error: 'Unauthorized local connection.' });
      }
    });
  }

  const unauthenticatedRoutes = new Set([
    '/api/health',
    '/api/license/status',
    '/api/license/activate',
    '/api/license/check-in',
    '/api/license/announcements',
    '/api/auth/login',
    '/api/auth/setup-admin',
  ]);
  app.addHook('preHandler', async (request, reply) => {
    const routePath = request.url.split('?')[0];
    if (unauthenticatedRoutes.has(routePath)) return;

    try {
      await request.jwtVerify();
    } catch {
      return reply.status(401).send({ error: 'Authentication is required.' });
    }

    const identity = request.user as { userId?: string };
    const user = identity.userId ? getUserById(db, identity.userId) : null;
    if (!user || !user.isActive) {
      return reply.status(401).send({ error: 'This account is unavailable.' });
    }
    request.user = {
      userId: user.id,
      username: user.username,
      role: user.role,
      permissions: user.permissions,
    };

    const requiredPermissions = routePath === '/api/reports/returns'
      ? ['pos']
      : routePath === '/api/workflow-drafts/held-bills'
        ? ['pos']
        : routePath === '/api/workflow-drafts/purchase-drafts'
          ? ['purchases']
      : routePath.startsWith('/api/pos/')
      ? ['pos']
      : routePath.startsWith('/api/inventory/products')
        ? (request.method === 'GET' ? ['products', 'stock_inventory'] : ['products'])
        : routePath.startsWith('/api/inventory/')
          ? ['stock_inventory']
          : routePath.startsWith('/api/purchases/history')
            ? ['purchase_history']
            : routePath.startsWith('/api/purchases/')
              ? ['purchases']
              : routePath.startsWith('/api/suppliers')
                ? ['suppliers']
                : routePath.startsWith('/api/customers')
                  ? ['customers']
                  : routePath.startsWith('/api/cashbook/')
                    ? ['expenses']
                    : routePath.startsWith('/api/reports/profit-summary')
                      ? ['reports']
                      : routePath.startsWith('/api/reports/')
                        ? ['sales_history']
                        : routePath.startsWith('/api/master-data/')
                          ? (request.method === 'GET' ? ['categories', 'products', 'stock_inventory'] : ['categories'])
                        : routePath.startsWith('/api/settings/')
                          ? ['settings']
                          : routePath.startsWith('/api/auth/users')
                            ? ['manage_users']
                            : routePath.startsWith('/api/trash/')
                              ? ['manage_users']
                              : routePath.startsWith('/api/notifications/developer-announcements')
                                ? []
                                : routePath.startsWith('/api/notifications/')
                                ? ['stock_inventory', 'products']
                            : [];

    const licenseAccess = checkLicenseStatus(db);
    if (requiredPermissions.length > 0 && !requiredPermissions.some(
      (permission) => licenseAccess.enabledPages.some((enabledPage) => enabledPage === permission),
    )) {
      return reply.status(403).send({ error: 'This page is not included in the pharmacy license plan.' });
    }

    if (routePath.startsWith('/api/backup/')) {
      if (user.role !== 'admin') {
        return reply.status(403).send({ error: 'Only the Shop Admin can create backups.' });
      }
    } else if (
      requiredPermissions.length > 0
      && user.role !== 'admin'
      && !requiredPermissions.some((permission) => user.permissions.includes(permission))
    ) {
      return reply.status(403).send({ error: `One of these permissions is required: ${requiredPermissions.join(', ')}.` });
    }

    const isTransactionWrite = request.method !== 'GET' && (
      routePath.startsWith('/api/pos/')
      || routePath === '/api/reports/returns'
      || routePath.startsWith('/api/purchases')
      || routePath.startsWith('/api/cashbook/')
      || (routePath.startsWith('/api/customers/') && routePath.includes('/payment'))
    );
    if (isTransactionWrite && !checkLicenseStatus(db).allowNewTransactions) {
      return reply.status(403).send({ error: 'The license does not allow new transactions.' });
    }
  });

  app.get('/api/license/status', async () => {
    const status = checkLicenseStatus(db);
    const users = db.prepare('SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL').get() as { count: number };
    return { ...status, requiresAdminSetup: status.allowNewTransactions && users.count === 0 };
  });

  app.post('/api/license/activate', async (request, reply) => {
    const body = request.body as {
      shopId?: string;
      shopName?: string;
      licenseToken?: string;
      hardwareId?: string;
    };
    if (!body.shopId || !body.shopName || !body.licenseToken || !body.hardwareId) {
      return reply.status(400).send({ error: 'shopId, shopName, licenseToken, and hardwareId are required.' });
    }
    activateShopLicense(db, {
      shopId: body.shopId,
      shopName: body.shopName,
      licenseToken: body.licenseToken,
      hardwareId: body.hardwareId || 'UNKNOWN',
    });
    return reply.send({ success: true });
  });

  app.post('/api/license/check-in', async (request, reply) => {
    const body = request.body as { licenseToken?: string; hardwareId?: string };
    if (!body?.licenseToken || !body.hardwareId) {
      return reply.status(400).send({ error: 'licenseToken and hardwareId are required.' });
    }
    try {
      recordSuccessfulCheckin(db, body.licenseToken, body.hardwareId);
      return reply.send(checkLicenseStatus(db));
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'License check-in failed.' });
    }
  });

  app.post('/api/backup/create', async (request, reply) => {
    try {
      await request.jwtVerify();
      const user = request.user as { role: string };
      if (user.role !== 'admin') {
        return reply.status(403).send({ error: 'Only the Shop Admin can create backups.' });
      }
      const target = await backupDatabase(db);
      return reply.send({ success: true, path: target });
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // Register route modules
  registerAuthRoutes(app, db);
  registerPosRoutes(app, db);
  registerInventoryRoutes(app, db);
  registerPurchaseRoutes(app, db);
  registerCustomerRoutes(app, db);
  registerCashbookRoutes(app, db);
  registerReportRoutes(app, db);
  registerSettingsRoutes(app, db);
  registerPrintRequestRoutes(app, db);
  registerMasterDataRoutes(app, db);
  registerTrashRoutes(app, db);
  registerNotificationRoutes(app, db);
  registerStockRoutes(app, db);
  registerPreferenceRoutes(app, db);
  registerWorkflowDraftRoutes(app, db);

  return { app, db };
}

export async function startServer(options: ServerOptions = {}): Promise<{
  app: FastifyInstance;
  db: Database.Database;
  port: number;
  host: string;
}> {
  const effectiveOptions = {
    ...options,
    localAuthToken: options.localAuthToken || process.env.LOCAL_AUTH_TOKEN,
    jwtSecret: options.jwtSecret || process.env.LOCAL_JWT_SECRET,
  };
  if (!effectiveOptions.localAuthToken) throw new Error('LOCAL_AUTH_TOKEN must be provided.');
  if (!effectiveOptions.jwtSecret) throw new Error('LOCAL_JWT_SECRET must be provided.');
  const { app, db } = buildServer(effectiveOptions);
  const host = options.host || '127.0.0.1'; // Loopback only
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('The local API must bind to loopback only.');
  }
  const port = options.port ?? parseInt(process.env.PORT || '4310', 10);

  const address = await app.listen({ port, host });
  const actualPort = Number(new URL(address).port);
  return { app, db, port: actualPort, host };
}

// Standalone execution
if (require.main === module && process.env.PHARMA_DESKTOP_HOST !== 'true') {
  startServer()
    .then(({ host, port }) => {
      console.log(`Pharma Care Local Backend running on http://${host}:${port}`);
    })
    .catch((err) => {
      console.error('Failed to start local backend:', err);
      process.exit(1);
    });
}
