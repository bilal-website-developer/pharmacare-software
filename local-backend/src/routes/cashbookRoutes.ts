import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';
import crypto from 'crypto';
import { localIsoDate } from '../services/fefoEngine';

export function registerCashbookRoutes(app: FastifyInstance, db: Database.Database): void {
  // 1. Get cash transactions
  app.get('/api/cashbook/transactions', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as { date?: string; from?: string; to?: string };
      const today = localIsoDate();

      let whereClause = 'WHERE 1=1';
      const params: any[] = [];

      if (query.date) {
        whereClause += ' AND date = ?';
        params.push(query.date);
      } else if (query.from && query.to) {
        whereClause += ' AND date >= ? AND date <= ?';
        params.push(query.from, query.to);
      } else {
        whereClause += ' AND date = ?';
        params.push(today);
      }

      const rows = db.prepare(`
        SELECT id, time, date, type, description, amount_paisa, is_outflow, handled_by, created_at
        FROM cash_transactions
        ${whereClause}
        ORDER BY created_at DESC
      `).all(...params) as any[];

      const transactions = rows.map((r) => ({
        id: r.id,
        time: r.time,
        date: r.date,
        type: r.type,
        description: r.description,
        amountPaisa: r.amount_paisa,
        isOutflow: r.is_outflow === 1,
        handledBy: r.handled_by,
      }));

      return reply.send(transactions);
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // 2. Add cash expense / transaction
  app.post('/api/cashbook/transactions', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const user = request.user as { username: string };
      const body = request.body as {
        description: string;
        amountPaisa: number;
        isOutflow?: boolean;
        type?: string;
      };

      if (!body.description || !body.amountPaisa || body.amountPaisa <= 0) {
        return reply.status(400).send({ error: 'Description and positive amount are required.' });
      }

      const today = localIsoDate();
      const now = Math.floor(Date.now() / 1000);
      const id = crypto.randomUUID();

      db.prepare(`
        INSERT INTO cash_transactions (
          id, time, date, type, description, amount_paisa, is_outflow, handled_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        today,
        body.type || (body.isOutflow ? 'EXPENSE' : 'MANUAL_IN'),
        body.description.trim(),
        body.amountPaisa,
        body.isOutflow ? 1 : 0,
        user.username,
        now
      );

      return reply.status(201).send({
        id,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        date: today,
        type: body.type || (body.isOutflow ? 'EXPENSE' : 'MANUAL_IN'),
        description: body.description.trim(),
        amountPaisa: body.amountPaisa,
        isOutflow: Boolean(body.isOutflow),
        handledBy: user.username,
      });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // 3. End of day cash summary
  app.get('/api/cashbook/summary', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as { date?: string };
      const targetDate = query.date || localIsoDate();

      const rows = db.prepare(`
        SELECT type, is_outflow, SUM(amount_paisa) as total_paisa
        FROM cash_transactions
        WHERE date = ?
        GROUP BY type, is_outflow
      `).all(targetDate) as any[];

      let cashSalesPaisa = 0;
      let creditRecoveryPaisa = 0;
      let expensesPaisa = 0;
      let supplierPaymentsPaisa = 0;

      for (const r of rows) {
        if (r.type === 'SALE' && r.is_outflow === 0) cashSalesPaisa += r.total_paisa;
        else if (r.type === 'CREDIT_RECOVERY' && r.is_outflow === 0) creditRecoveryPaisa += r.total_paisa;
        else if (r.type === 'EXPENSE' && r.is_outflow === 1) expensesPaisa += r.total_paisa;
        else if (r.type === 'SUPPLIER_PAYMENT' && r.is_outflow === 1) supplierPaymentsPaisa += r.total_paisa;
      }

      const totalInflowPaisa = cashSalesPaisa + creditRecoveryPaisa;
      const totalOutflowPaisa = expensesPaisa + supplierPaymentsPaisa;
      const netCashInHandPaisa = Math.max(0, totalInflowPaisa - totalOutflowPaisa);

      return reply.send({
        date: targetDate,
        cashSalesPaisa,
        creditRecoveryPaisa,
        expensesPaisa,
        supplierPaymentsPaisa,
        totalInflowPaisa,
        totalOutflowPaisa,
        netCashInHandPaisa,
      });
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });
}
