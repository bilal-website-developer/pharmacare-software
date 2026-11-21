import { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';
import { canViewCost } from '../services/costRedactor';

type StockUser = { role: string; permissions: string[]; userId: string };

function getStockUser(request: { user: unknown }): StockUser {
  const user = request.user as StockUser;
  return {
    role: user.role,
    permissions: user.permissions || [],
    userId: user.userId,
  };
}

function asIsoTimestamp(value: number): string {
  return new Date(value * 1000).toISOString();
}

export function registerStockRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/inventory/stock-batches', async (request, reply) => {
    try {
      const user = getStockUser(request);
      const query = request.query as Record<string, string | undefined>;
      const page = Math.max(1, Number.parseInt(query.p_page || '1', 10) || 1);
      const pageSize = Math.max(1, Math.min(500, Number.parseInt(query.p_page_size || '25', 10) || 25));
      const tab = ['near-expiry', 'expired', 'low-stock'].includes(query.p_tab || '')
        ? query.p_tab!
        : 'all';
      const today = new Date().toISOString().slice(0, 10);
      const search = query.p_search?.trim();
      const params: unknown[] = [];
      let where = 'WHERE sb.quantity_smallest_unit > 0';
      if (query.p_medicine_id) {
        where += ' AND sb.medicine_id = ?';
        params.push(query.p_medicine_id);
      }
      if (search) {
        where += ' AND (m.brand_name LIKE ? OR m.generic_name LIKE ? OR m.code LIKE ? OR sb.batch_number LIKE ?)';
        const like = `%${search}%`;
        params.push(like, like, like, like);
      }
      if (tab === 'near-expiry') {
        where += " AND sb.expiry_date >= ? AND sb.expiry_date < date(?, '+91 days')";
        params.push(today, today);
      } else if (tab === 'expired') {
        where += ' AND sb.expiry_date < ?';
        params.push(today);
      } else if (tab === 'low-stock') {
        where += ` AND (
          SELECT COALESCE(SUM(low_batch.quantity_smallest_unit), 0)
          FROM stock_batches low_batch
          WHERE low_batch.medicine_id = m.id AND low_batch.quantity_smallest_unit > 0
            AND low_batch.status IN ('ACTIVE', 'NEAR_EXPIRY') AND low_batch.expiry_date >= ?
        ) <= m.min_stock_alert AND m.min_stock_alert > 0`;
        params.push(today);
      }
      const bucket = query.p_expiry_bucket;
      if (bucket === 'expired') {
        where += ' AND sb.expiry_date < ?';
        params.push(today);
      }
      else if (bucket === '0-30') {
        where += " AND sb.expiry_date >= ? AND sb.expiry_date < date(?, '+31 days')";
        params.push(today, today);
      } else if (bucket === '31-60') {
        where += " AND sb.expiry_date >= date(?, '+31 days') AND sb.expiry_date < date(?, '+61 days')";
        params.push(today, today);
      } else if (bucket === '61-90') {
        where += " AND sb.expiry_date >= date(?, '+61 days') AND sb.expiry_date < date(?, '+91 days')";
        params.push(today, today);
      } else if (bucket === '90+') {
        where += " AND sb.expiry_date >= date(?, '+91 days')";
        params.push(today);
      }
      const from = `
        FROM stock_batches sb
        JOIN medicines m ON m.id = sb.medicine_id
        ${where}
      `;
      const totalCount = (db.prepare(`SELECT COUNT(*) AS count ${from}`).get(...params) as { count: number }).count;
      const sortColumns: Record<string, string> = {
        medicine_asc: 'm.brand_name COLLATE NOCASE ASC',
        medicine_desc: 'm.brand_name COLLATE NOCASE DESC',
        batch_asc: 'sb.batch_number COLLATE NOCASE ASC',
        batch_desc: 'sb.batch_number COLLATE NOCASE DESC',
        expiry_asc: 'sb.expiry_date ASC',
        expiry_desc: 'sb.expiry_date DESC',
        quantity_asc: 'sb.quantity_smallest_unit ASC',
        quantity_desc: 'sb.quantity_smallest_unit DESC',
        cost_asc: 'sb.cost_price_paisa ASC',
        cost_desc: 'sb.cost_price_paisa DESC',
        value_asc: '(sb.quantity_smallest_unit * sb.cost_price_paisa) ASC',
        value_desc: '(sb.quantity_smallest_unit * sb.cost_price_paisa) DESC',
      };
      const sort = sortColumns[query.p_sort || 'expiry_asc'] || sortColumns.expiry_asc;
      const showCost = canViewCost(user.role, user.permissions);
      const rows = db.prepare(`
        SELECT sb.id, sb.medicine_id, m.brand_name AS medicine_name, m.generic_name, m.code,
               sb.batch_number, sb.expiry_date, sb.received_date,
               sb.quantity_smallest_unit AS quantity_remaining, sb.status,
               m.min_stock_alert, sb.cost_price_paisa AS cost_paisa_per_base_unit,
               sb.mrp_paisa AS mrp_paisa_per_base_unit,
               sb.quantity_smallest_unit * sb.cost_price_paisa AS stock_value_cost_paisa,
               CASE WHEN sb.quantity_smallest_unit > 0 AND sb.status IN ('ACTIVE', 'NEAR_EXPIRY')
                         AND sb.expiry_date >= ? THEN 1 ELSE 0 END AS sellable
        ${from}
        ORDER BY ${sort}, sb.id
        LIMIT ? OFFSET ?
      `).all(today, ...params, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
      return reply.send({
        rows: rows.map((row) => ({
          id: row.id,
          medicine_id: row.medicine_id,
          medicine_name: row.medicine_name,
          generic_name: row.generic_name,
          code: row.code,
          batch_number: row.batch_number,
          expiry_date: row.expiry_date,
          received_date: row.received_date,
          quantity_remaining: Number(row.quantity_remaining),
          status: row.status,
          min_stock_alert: Number(row.min_stock_alert),
          cost_paisa_per_base_unit: showCost ? Number(row.cost_paisa_per_base_unit) : null,
          mrp_paisa_per_base_unit: Number(row.mrp_paisa_per_base_unit),
          stock_value_cost_paisa: showCost ? Number(row.stock_value_cost_paisa) : null,
          is_sellable: row.sellable === 1,
        })),
        total_count: totalCount,
        page,
        page_size: pageSize,
        can_view_cost: showCost,
      });
    } catch (error) {
      return reply.status(500).send({ error: error instanceof Error ? error.message : 'Could not load stock batches.' });
    }
  });

  app.get('/api/inventory/stock-overview', async (request, reply) => {
    try {
      const user = getStockUser(request);
      const showCost = canViewCost(user.role, user.permissions);
      const stats = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN sb.quantity_smallest_unit > 0 THEN sb.quantity_smallest_unit * sb.mrp_paisa ELSE 0 END), 0) AS stock_value_mrp_paisa,
          SUM(CASE WHEN sb.quantity_smallest_unit > 0 AND sb.expiry_date >= date('now')
                    AND sb.expiry_date < date('now', '+31 days') THEN 1 ELSE 0 END) AS expiring_30,
          SUM(CASE WHEN sb.quantity_smallest_unit > 0 AND sb.expiry_date < date('now') THEN 1 ELSE 0 END) AS expired_batches,
          SUM(CASE WHEN sb.quantity_smallest_unit > 0 AND sb.expiry_date < date('now')
                    THEN sb.quantity_smallest_unit * sb.cost_price_paisa ELSE 0 END) AS expired_value_at_risk_paisa,
          SUM(CASE WHEN sb.quantity_smallest_unit > 0 THEN sb.quantity_smallest_unit * sb.cost_price_paisa ELSE 0 END) AS stock_value_cost_paisa
        FROM stock_batches sb
      `).get() as Record<string, number | null>;
      const buckets = db.prepare(`
        SELECT CASE
                 WHEN expiry_date < date('now') THEN 'expired'
                 WHEN expiry_date < date('now', '+31 days') THEN '0-30'
                 WHEN expiry_date < date('now', '+61 days') THEN '31-60'
                 WHEN expiry_date < date('now', '+91 days') THEN '61-90'
                 ELSE '90+'
               END AS key,
               COUNT(*) AS count,
               COALESCE(SUM(quantity_smallest_unit), 0) AS quantity_remaining
        FROM stock_batches
        WHERE quantity_smallest_unit > 0
        GROUP BY key
      `).all() as Array<{ key: string; count: number; quantity_remaining: number }>;
      const labels: Record<string, string> = {
        expired: 'Expired',
        '0-30': '0-30 days',
        '31-60': '31-60 days',
        '61-90': '61-90 days',
        '90+': '90+ days',
      };
      return reply.send({
        stats: {
          stock_value_cost_paisa: showCost ? Number(stats.stock_value_cost_paisa || 0) : null,
          stock_value_mrp_paisa: Number(stats.stock_value_mrp_paisa || 0),
          expiring_30: Number(stats.expiring_30 || 0),
          expired_batches: Number(stats.expired_batches || 0),
          expired_value_at_risk_paisa: showCost ? Number(stats.expired_value_at_risk_paisa || 0) : null,
        },
        buckets: ['expired', '0-30', '31-60', '61-90', '90+'].map((key) => {
          const bucket = buckets.find((item) => item.key === key);
          return {
            key,
            label: labels[key],
            count: Number(bucket?.count || 0),
            quantity_remaining: Number(bucket?.quantity_remaining || 0),
          };
        }),
      });
    } catch (error) {
      return reply.status(500).send({ error: error instanceof Error ? error.message : 'Could not load stock overview.' });
    }
  });

  app.get('/api/inventory/stock-adjustments', async (request, reply) => {
    try {
      const query = request.query as Record<string, string | undefined>;
      const page = Math.max(1, Number.parseInt(query.p_page || '1', 10) || 1);
      const pageSize = Math.max(1, Math.min(500, Number.parseInt(query.p_page_size || '25', 10) || 25));
      const conditions: string[] = ["sm.movement_type IN ('ADJUSTMENT', 'WRITE_OFF')"];
      const params: unknown[] = [];
      if (query.p_reason?.trim()) {
        conditions.push('COALESCE(sm.notes, \'\') LIKE ?');
        params.push(`%${query.p_reason.trim()}%`);
      }
      if (query.p_batch_id) {
        conditions.push('sm.batch_id = ?');
        params.push(query.p_batch_id);
      }
      const where = `WHERE ${conditions.join(' AND ')}`;
      const totalCount = (db.prepare(`
        SELECT COUNT(*) AS count FROM stock_movements sm ${where}
      `).get(...params) as { count: number }).count;
      const rows = db.prepare(`
        SELECT sm.id, sm.batch_id, COALESCE(sb.batch_number, '') AS batch_number,
               sm.medicine_id, m.brand_name AS medicine_name, m.generic_name,
               sm.movement_type, sm.quantity_smallest_units AS quantity_delta,
               COALESCE(sm.notes, '') AS reason, sm.created_at, COALESCE(u.username, '') AS actor_name
        FROM stock_movements sm
        JOIN medicines m ON m.id = sm.medicine_id
        LEFT JOIN stock_batches sb ON sb.id = sm.batch_id
        LEFT JOIN users u ON u.id = sm.created_by
        ${where}
        ORDER BY sm.created_at DESC, sm.id DESC
        LIMIT ? OFFSET ?
      `).all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
      return reply.send({
        rows: rows.map((row) => ({
          ...row,
          created_at: asIsoTimestamp(Number(row.created_at)),
          quantity_delta: Number(row.quantity_delta),
        })),
        total_count: totalCount,
        page,
        page_size: pageSize,
      });
    } catch (error) {
      return reply.status(500).send({ error: error instanceof Error ? error.message : 'Could not load stock movements.' });
    }
  });
}
