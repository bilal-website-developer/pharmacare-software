import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';
import crypto from 'crypto';
import { localIsoDate } from '../services/fefoEngine';

export function registerCustomerRoutes(app: FastifyInstance, db: Database.Database): void {
  // 1. Customers List
  app.get('/api/customers', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const rows = db.prepare(`
        SELECT id, name, phone, cnic, address, credit_limit_paisa, current_balance_paisa, store_credit_paisa, is_active
        FROM customers
        ORDER BY name ASC
      `).all() as any[];

      const customers = rows.map((r) => ({
        id: r.id,
        name: r.name,
        phone: r.phone || '',
        cnic: r.cnic || '',
        address: r.address || '',
        creditLimitPaisa: r.credit_limit_paisa,
        currentBalancePaisa: r.current_balance_paisa,
        storeCreditPaisa: r.store_credit_paisa,
        isActive: r.is_active === 1,
      }));

      // Also get ledger entries grouped by customer
      const ledgerRows = db.prepare(`
        SELECT id, customer_id, date, type, reference_no, description, debit_paisa, credit_paisa, running_balance_paisa
        FROM customer_ledger
        ORDER BY created_at ASC
      `).all() as any[];

      const ledgerEntries: Record<string, any[]> = {};
      for (const entry of ledgerRows) {
        if (!ledgerEntries[entry.customer_id]) ledgerEntries[entry.customer_id] = [];
        ledgerEntries[entry.customer_id].push({
          id: entry.id,
          customerId: entry.customer_id,
          date: entry.date,
          type: entry.type,
          referenceNo: entry.reference_no,
          description: entry.description || '',
          debitPaisa: entry.debit_paisa,
          creditPaisa: entry.credit_paisa,
          runningBalancePaisa: entry.running_balance_paisa,
        });
      }

      return reply.send({ customers, ledgerEntries });
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // 2. Save / Add Customer
  app.post('/api/customers', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const body = request.body as {
        id?: string;
        name: string;
        phone?: string;
        cnic?: string;
        address?: string;
        creditLimitPaisa?: number;
      };

      if (!body.name) return reply.status(400).send({ error: 'Customer name is required.' });

      const now = Math.floor(Date.now() / 1000);
      const isNew = !body.id;
      const customerId = body.id || crypto.randomUUID();

      if (isNew) {
        db.prepare(`
          INSERT INTO customers (id, name, phone, cnic, address, credit_limit_paisa, current_balance_paisa, store_credit_paisa, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)
        `).run(
          customerId,
          body.name.trim(),
          body.phone || null,
          body.cnic || null,
          body.address || null,
          body.creditLimitPaisa || 0,
          now,
          now
        );
      } else {
        db.prepare(`
          UPDATE customers
          SET name = ?, phone = ?, cnic = ?, address = ?, credit_limit_paisa = ?, updated_at = ?
          WHERE id = ?
        `).run(
          body.name.trim(),
          body.phone || null,
          body.cnic || null,
          body.address || null,
          body.creditLimitPaisa || 0,
          now,
          customerId
        );
      }

      const saved = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) as any;
      return reply.send({
        id: saved.id,
        name: saved.name,
        phone: saved.phone || '',
        cnic: saved.cnic || '',
        address: saved.address || '',
        creditLimitPaisa: saved.credit_limit_paisa,
        currentBalancePaisa: saved.current_balance_paisa,
        storeCreditPaisa: saved.store_credit_paisa,
      });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // 3. Record Customer Payment (Recovers Khata balance)
  app.post('/api/customers/:id/payment', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const user = request.user as { username: string };
      const { id: customerId } = request.params as { id: string };
      const body = request.body as { amountPaisa: number; note?: string };

      if (!body.amountPaisa || body.amountPaisa <= 0) {
        return reply.status(400).send({ error: 'Valid payment amount is required.' });
      }

      const today = localIsoDate();
      const now = Math.floor(Date.now() / 1000);

      const transaction = db.transaction(() => {
        const customer = db.prepare('SELECT id, name, current_balance_paisa, store_credit_paisa FROM customers WHERE id = ?').get(customerId) as any;
        if (!customer) throw new Error('Customer not found.');

        let newBalance = customer.current_balance_paisa - body.amountPaisa;
        let newStoreCredit = customer.store_credit_paisa || 0;

        if (newBalance < 0) {
          newStoreCredit += Math.abs(newBalance);
          newBalance = 0;
        }

        db.prepare(`
          UPDATE customers
          SET current_balance_paisa = ?, store_credit_paisa = ?, updated_at = ?
          WHERE id = ?
        `).run(newBalance, newStoreCredit, now, customerId);

        const refNo = `PAY-${Date.now().toString(36).toUpperCase()}`;

        db.prepare(`
          INSERT INTO customer_ledger (id, customer_id, date, type, reference_no, description, debit_paisa, credit_paisa, running_balance_paisa, created_at)
          VALUES (?, ?, ?, 'PAYMENT', ?, ?, 0, ?, ?, ?)
        `).run(
          crypto.randomUUID(),
          customerId,
          today,
          refNo,
          body.note || 'Payment Received',
          body.amountPaisa,
          newBalance,
          now
        );

        // Record cash inflow
        db.prepare(`
          INSERT INTO cash_transactions (id, time, date, type, description, amount_paisa, is_outflow, handled_by, created_at)
          VALUES (?, ?, ?, 'CREDIT_RECOVERY', ?, ?, 0, ?, ?)
        `).run(
          crypto.randomUUID(),
          new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          today,
          `Payment from ${customer.name}`,
          body.amountPaisa,
          user.username,
          now
        );

        return {
          referenceNo: refNo,
          dateTime: new Date(now * 1000).toLocaleString('en-PK'),
          balanceAfterPaisa: newBalance,
          storeCreditPaisa: newStoreCredit,
        };
      });

      const result = transaction();
      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });
}
