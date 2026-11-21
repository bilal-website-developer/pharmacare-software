import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';
import crypto from 'crypto';
import { authenticateLocalUser, createLocalUser, getUserById, updateLocalUserPassword } from '../services/authService';
import { checkLicenseStatus } from '../services/licenseService';

export function registerAuthRoutes(app: FastifyInstance, db: Database.Database): void {
  app.post('/api/auth/setup-admin', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { username?: string; password?: string; fullName?: string };
    if (!body?.username || !body.password || !body.fullName) {
      return reply.status(400).send({ error: 'Username, password, and full name are required.' });
    }
    if (!checkLicenseStatus(db).allowNewTransactions) {
      return reply.status(403).send({ error: 'A valid, active license is required before creating its Shop Admin.' });
    }
    const count = db.prepare('SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL').get() as { count: number };
    if (count.count !== 0) {
      return reply.status(409).send({ error: 'Initial Shop Admin setup has already been completed.' });
    }

    try {
      const permissions = [
        'pos', 'products', 'categories', 'suppliers', 'customers', 'sales_history',
        'purchase_history', 'purchases', 'expenses', 'stock_inventory', 'reports',
        'manage_users', 'settings',
      ];
      const user = await createLocalUser(db, {
        username: body.username,
        plainTextPassword: body.password,
        fullName: body.fullName,
        role: 'admin',
        permissions,
      });
      const token = app.jwt.sign({
        userId: user.id,
        username: user.username,
        role: user.role,
        permissions: user.permissions,
      });
      db.prepare(`
        INSERT INTO audit_logs (id, actor_id, actor_name, action, details, created_at)
        VALUES (?, ?, ?, 'INITIAL_ADMIN_CREATED', 'Initial Shop Admin account created.', ?)
      `).run(crypto.randomUUID(), user.id, user.username, Math.floor(Date.now() / 1000));
      return reply.status(201).send({ token, user });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Login
  app.post('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { username?: string; password?: string };
    if (!body?.username || !body?.password) {
      return reply.status(400).send({ error: 'Username and password are required.' });
    }

    try {
      const user = await authenticateLocalUser(db, body.username, body.password);
      const token = app.jwt.sign({
        userId: user.id,
        username: user.username,
        role: user.role,
        permissions: user.permissions,
      });

      return reply.send({
        token,
        user,
      });
    } catch (error: any) {
      return reply.status(401).send({ error: error.message || 'Authentication failed.' });
    }
  });

  // Current authenticated user session
  app.get('/api/auth/me', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const decoded = request.user as { userId: string };
      const user = getUserById(db, decoded.userId);
      if (!user) {
        return reply.status(404).send({ error: 'User profile not found.' });
      }

      // Also get shop identity
      const shop = db.prepare('SELECT shop_name, phone, address, logo_path FROM shop_settings WHERE id = 1').get() as any;

      return reply.send({
        user,
        shopProfile: {
          name: shop?.shop_name || 'Pharma Care',
          phone: shop?.phone || '',
          address: shop?.address || '',
          logoPath: shop?.logo_path || '',
        },
      });
    } catch (error: any) {
      return reply.status(401).send({ error: 'Unauthorized session.' });
    }
  });

  // Manage users (list)
  app.get('/api/auth/users', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const decoded = request.user as { role: string };
      if (decoded.role !== 'admin') {
        return reply.status(403).send({ error: 'Only admins can view staff users.' });
      }

      const rows = db.prepare(`
        SELECT id, username, full_name, email, role, permissions, is_active, created_at, updated_at
        FROM users
        WHERE deleted_at IS NULL
        ORDER BY created_at ASC
      `).all() as any[];

      const users = rows.map((r) => ({
        id: r.id,
        username: r.username,
        fullName: r.full_name,
        email: r.email,
        role: r.role,
        permissions: JSON.parse(r.permissions || '[]'),
        isActive: r.is_active === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));

      return reply.send(users);
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // Create new user (Admin only)
  app.post('/api/auth/users', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const decoded = request.user as { role: string };
      if (decoded.role !== 'admin') {
        return reply.status(403).send({ error: 'Only admins can create staff users.' });
      }

      const body = request.body as any;
      if (!body.username || !body.password || !body.role) {
        return reply.status(400).send({ error: 'Username, password, and role are required.' });
      }

      const user = await createLocalUser(db, {
        username: body.username,
        plainTextPassword: body.password,
        fullName: body.fullName,
        email: body.email,
        role: body.role,
        permissions: body.permissions || [],
      });

      return reply.status(201).send(user);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Change user password
  app.post('/api/auth/change-password', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const decoded = request.user as { userId: string };
      const body = request.body as { newPassword?: string };
      if (!body.newPassword || body.newPassword.length < 10) {
        return reply.status(400).send({ error: 'New password must be at least 10 characters.' });
      }

      await updateLocalUserPassword(db, decoded.userId, body.newPassword);
      return reply.send({ success: true, message: 'Password updated successfully.' });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });
}
