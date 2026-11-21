import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Database from 'better-sqlite3-multiple-ciphers';
import { checkLicenseStatus, activateShopLicense } from '../services/licenseService';
import { backupDatabase } from '../db/database';

const DEFAULT_OPERATIONAL_SETTINGS = {
  billingTemplate: 'pharmacy-memo',
  receiptFormat: 'thermal80',
  maxDiscountPaisa: 20000,
  roleDiscountPercentCap: { admin: 30, manager: 15, cashier: 10, accountant: 0 },
  expiryWarningDays: 90,
  memo: {
    notes: ['Return policy', 'Excluded items', 'Signature required'],
    terminalName: 'Main Counter',
    showBatchNumber: true,
    showExpiryDate: false,
    showBatchExpiry: false,
    roundNet: 'none',
    printTax: false,
    duplicateLabel: true,
    autoPrint: false,
    numberDigits: 6,
    printLogo: true,
  },
};

export function registerSettingsRoutes(app: FastifyInstance, db: Database.Database): void {
  // 1. Get Shop Settings
  app.get('/api/settings/shop', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const user = request.user as { role: string };
      if (user.role !== 'admin') {
        return reply.status(403).send({ error: 'Only admins can view shop settings.' });
      }
      const row = db.prepare('SELECT * FROM shop_settings WHERE id = 1').get() as any;
      if (!row) {
        return reply.send({
          shopName: 'Pharma Care',
          phone: '',
          address: '',
          logoPath: '',
          receiptTemplate: 'memo',
          paperSize: '80mm',
          memoSettings: {},
          operationalSettings: DEFAULT_OPERATIONAL_SETTINGS,
          approvalSettings: { autoApprovePrintRequests: false, autoProcessReturns: false },
          receiptQrSettings: {
            publicReceiptsEnabled: false,
            linkLifetimeDays: 30,
            showMedicineNames: false,
            qrPlacement: 'footer',
            qrBaseUrl: '',
          },
        });
      }

      const savedOperationalSettings = JSON.parse(row.operational_settings || '{}');
      return reply.send({
        shopName: row.shop_name,
        phone: row.phone,
        address: row.address,
        logoPath: row.logo_path,
        receiptTemplate: row.receipt_template,
        paperSize: row.paper_size,
        memoSettings: JSON.parse(row.memo_settings || '{}'),
        approvalSettings: JSON.parse(row.approval_settings || '{"autoApprovePrintRequests":false,"autoProcessReturns":false}'),
        receiptQrSettings: JSON.parse(row.receipt_qr_settings || '{"publicReceiptsEnabled":false,"linkLifetimeDays":30,"showMedicineNames":false,"qrPlacement":"footer","qrBaseUrl":""}'),
        operationalSettings: savedOperationalSettings.billingTemplate
          ? savedOperationalSettings
          : DEFAULT_OPERATIONAL_SETTINGS,
      });
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // 2. Update Shop Settings
  app.put('/api/settings/shop', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const user = request.user as { role: string };
      if (user.role !== 'admin') {
        return reply.status(403).send({ error: 'Only admins can update shop settings.' });
      }

      const body = request.body as any;
      const now = Math.floor(Date.now() / 1000);

      db.prepare(`
        UPDATE shop_settings
        SET shop_name = COALESCE(?, shop_name),
            phone = COALESCE(?, phone),
            address = COALESCE(?, address),
            logo_path = COALESCE(?, logo_path),
            receipt_template = COALESCE(?, receipt_template),
            paper_size = COALESCE(?, paper_size),
            memo_settings = COALESCE(?, memo_settings),
            operational_settings = COALESCE(?, operational_settings),
            approval_settings = COALESCE(?, approval_settings),
            receipt_qr_settings = COALESCE(?, receipt_qr_settings),
            updated_at = ?
        WHERE id = 1
      `).run(
        body.shopName !== undefined ? body.shopName : null,
        body.phone !== undefined ? body.phone : null,
        body.address !== undefined ? body.address : null,
        body.logoPath !== undefined ? body.logoPath : null,
        body.receiptTemplate || null,
        body.paperSize || null,
        body.memoSettings ? JSON.stringify(body.memoSettings) : null,
        body.operationalSettings ? JSON.stringify(body.operationalSettings) : null,
        body.approvalSettings ? JSON.stringify(body.approvalSettings) : null,
        body.receiptQrSettings ? JSON.stringify(body.receiptQrSettings) : null,
        now
      );

      const savedSettings = db.prepare(`
        SELECT shop_name, phone, address, logo_path, operational_settings,
               approval_settings, receipt_qr_settings
        FROM shop_settings WHERE id = 1
      `).get() as {
        shop_name: string;
        phone: string;
        address: string;
        logo_path: string;
        operational_settings: string;
        approval_settings: string;
        receipt_qr_settings: string;
      };
      return reply.send({
        success: true,
        message: 'Settings saved successfully.',
        operationalSettings: JSON.parse(savedSettings.operational_settings || '{}'),
        approvalSettings: JSON.parse(savedSettings.approval_settings || '{}'),
        receiptQrSettings: JSON.parse(savedSettings.receipt_qr_settings || '{}'),
        name: savedSettings.shop_name,
        shopName: savedSettings.shop_name,
        phone: savedSettings.phone,
        address: savedSettings.address,
        logoPath: savedSettings.logo_path,
        logo_path: savedSettings.logo_path,
      });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // 3. License Status
  app.get('/api/settings/license', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const status = checkLicenseStatus(db);
      return reply.send(status);
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });

  // 4. Activate Shop License
  app.post('/api/settings/activate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as {
        shopId: string;
        shopName: string;
        licenseToken: string;
        hardwareId: string;
      };

      if (!body.shopId || !body.shopName || !body.licenseToken || !body.hardwareId) {
        return reply.status(400).send({ error: 'Shop ID, shop name, license token, and hardware ID are required.' });
      }

      activateShopLicense(db, body);
      return reply.send({ success: true, message: 'Shop successfully activated.' });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // 5. Trigger Immediate Safe SQLite Backup
  app.post('/api/settings/backup', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const backupPath = await backupDatabase(db);
      return reply.send({ success: true, backupPath });
    } catch (error: any) {
      return reply.status(500).send({ error: error.message });
    }
  });
}
