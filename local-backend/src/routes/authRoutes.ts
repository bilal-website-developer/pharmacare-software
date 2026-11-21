import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';
import crypto from 'crypto';
import { authenticateLocalUser, createLocalUser, getUserById, updateLocalUserPassword } from '../services/authService';
import { checkLicenseStatus } from '../services/licenseService';
import { hashRecoveryKey, isValidRecoveryKey } from '../services/recoveryKey';

export function registerAuthRoutes(app: FastifyInstance, db: Database.Database): void {
  app.post('/api/auth/setup-admin', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { username?: string; password?: string; fullName?: string; recoveryKey?: string };
    if (!body?.username || !body.password || !body.fullName || !isValidRecoveryKey(body.recoveryKey)) {
      return reply.status(400).send({ error: 'Username, password, full name, and a valid recovery key are required.' });
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
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`
        INSERT INTO recovery_settings (id, recovery_key_verifier, created_at, updated_at)
        VALUES (1, ?, ?, ?)
      `).run(hashRecoveryKey(body.recoveryKey), now, now);
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

  app.post('/api/auth/recovery-key', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const user = request.user as { role: string };
      if (user.role !== 'admin') {
        return reply.status(403).send({ error: 'Only the Shop Admin can configure a recovery key.' });
      }
      const body = request.body as { recoveryKey?: string };
      if (!isValidRecoveryKey(body?.recoveryKey)) {
        return reply.status(400).send({ error: 'A valid recovery key is required.' });
      }
      const existing = db.prepare('SELECT id FROM recovery_settings WHERE id = 1').get();
      if (existing) return reply.status(409).send({ error: 'A recovery key is already configured.' });
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`
        INSERT INTO recovery_settings (id, recovery_key_verifier, created_at, updated_at)
        VALUES (1, ?, ?, ?)
      `).run(hashRecoveryKey(body.recoveryKey), now, now);
      return reply.status(201).send({ success: true });
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not configure the recovery key.' });
    }
  });

  app.get('/api/auth/recovery-key', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const user = request.user as { role: string };
      if (user.role !== 'admin') {
        return reply.status(403).send({ error: 'Only the Shop Admin can view recovery-key status.' });
      }
      const configured = Boolean(db.prepare('SELECT id FROM recovery_settings WHERE id = 1').get());
      return reply.send({ configured });
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not load recovery-key status.' });
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

      app.put('/api/auth/users/:id', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const actor = request.user as { role: string; userId: string };
          if (actor.role !== 'admin') return reply.status(403).send({ error: 'Only admins can edit staff users.' });
          const { id } = request.params as { id: string };
          const body = request.body as {
            username?: unknown;
            fullName?: unknown;
            email?: unknown;
            role?: unknown;
            permissions?: unknown;
          };
          const target = getUserById(db, id);
          if (!target) return reply.status(404).send({ error: 'User not found.' });
          if (id === actor.userId && body.role !== undefined && body.role !== target.role) {
            return reply.status(400).send({ error: 'You cannot change your own role.' });
          }
          if (typeof body.username !== 'string' || !body.username.trim()
            || typeof body.fullName !== 'string' || !body.fullName.trim()
            || typeof body.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)
            || typeof body.role !== 'string'
            || !['admin', 'manager', 'seller', 'cashier', 'accountant'].includes(body.role)
            || !Array.isArray(body.permissions)
            || body.permissions.some((permission) => typeof permission !== 'string')) {
            return reply.status(400).send({ error: 'Enter valid user details, role, and permissions.' });
          }
          const duplicate = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ? AND deleted_at IS NULL')
            .get(body.username.trim(), id);
          if (duplicate) return reply.status(409).send({ error: 'That username is already in use.' });
          db.prepare(`
            UPDATE users
            SET username = ?, full_name = ?, email = ?, role = ?, permissions = ?, updated_at = ?
            WHERE id = ?
          `).run(
            body.username.trim(),
            body.fullName.trim(),
            body.email.trim(),
            body.role,
            JSON.stringify([...new Set(body.permissions as string[])]),
            Math.floor(Date.now() / 1000),
            id,
          );
          return reply.send({ success: true, id });
        } catch (error) {
          return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not update user.' });
        }
      });

      app.post('/api/auth/users/:id/password', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const actor = request.user as { role: string; userId: string };
          if (actor.role !== 'admin') return reply.status(403).send({ error: 'Only admins can reset staff passwords.' });
          const { id } = request.params as { id: string };
          const body = request.body as { password?: unknown };
          if (typeof body.password !== 'string' || body.password.length < 8) {
            return reply.status(400).send({ error: 'Password must be at least 8 characters.' });
          }
          if (!getUserById(db, id)) return reply.status(404).send({ error: 'User not found.' });
          await updateLocalUserPassword(db, id, body.password);
          return reply.send({ success: true, message: 'Password reset successfully.' });
        } catch (error) {
          return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not reset the password.' });
        }
      });

      app.put('/api/auth/users/:id/status', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const actor = request.user as { role: string; userId: string; username: string };
          if (actor.role !== 'admin') return reply.status(403).send({ error: 'Only admins can change staff access.' });
          const { id } = request.params as { id: string };
          if (id === actor.userId) return reply.status(400).send({ error: 'You cannot change your own access.' });
          const body = request.body as { status?: unknown };
          if (body.status !== 'deactivate' && body.status !== 'reactivate' && body.status !== 'remove_access') {
            return reply.status(400).send({ error: 'Choose a valid user access status.' });
          }
          const target = db.prepare('SELECT username, is_active FROM users WHERE id = ? AND deleted_at IS NULL')
            .get(id) as { username: string; is_active: number } | undefined;
          if (!target) return reply.status(404).send({ error: 'User not found.' });
          const now = Math.floor(Date.now() / 1000);
          const removed = body.status === 'remove_access';
          db.prepare(`
            UPDATE users SET is_active = ?, deleted_at = ?, updated_at = ? WHERE id = ?
          `).run(body.status === 'deactivate' ? 0 : (removed ? 0 : 1), removed ? now : null, now, id);
          if (body.status !== 'reactivate') {
            db.prepare(`
              INSERT INTO trash_bin_events (
                id, entity_type, entity_id, entity_name, action, reason,
                performed_by, performed_by_name, created_at
              ) VALUES (?, 'user', ?, ?, ?, ?, ?, ?, ?)
            `).run(
              crypto.randomUUID(),
              id,
              target.username,
              'deactivate',
              removed ? 'User access removed.' : 'User deactivated.',
              actor.userId,
              actor.username,
              now,
            );
          }
          return reply.send({ success: true, message: removed ? 'User access removed.' : `User ${body.status}d.` });
        } catch (error) {
          return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not change user access.' });
        }
      });

      app.put('/api/auth/users/:id/restore', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const actor = request.user as { role: string; userId: string; username: string };
          if (actor.role !== 'admin') return reply.status(403).send({ error: 'Only admins can restore staff users.' });
          const { id } = request.params as { id: string };
          const user = db.prepare('SELECT username FROM users WHERE id = ? AND deleted_at IS NOT NULL').get(id) as { username: string } | undefined;
          if (!user) return reply.status(404).send({ error: 'Removed user not found.' });
          const now = Math.floor(Date.now() / 1000);
          db.prepare('UPDATE users SET is_active = 1, deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, id);
          db.prepare(`
            INSERT INTO trash_bin_events (
              id, entity_type, entity_id, entity_name, action, reason,
              performed_by, performed_by_name, created_at
            ) VALUES (?, 'user', ?, ?, 'restore', 'User access restored.', ?, ?, ?)
          `).run(crypto.randomUUID(), id, user.username, actor.userId, actor.username, now);
          return reply.send({ success: true, message: 'User restored.' });
        } catch (error) {
          return reply.status(400).send({ error: error instanceof Error ? error.message : 'Could not restore user.' });
        }
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
