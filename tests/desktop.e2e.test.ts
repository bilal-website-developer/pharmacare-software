import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { buildDevelopmentLicensingServer } from '../central-backend/src/devServer.js';
import { hashActivationCode } from '../central-backend/src/licensingCrypto.js';
import type { FastifyInstance } from 'fastify';
import type { ElectronApplication, Page } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'desktop-app', 'package.json'));
const electronExecutable = require('electron') as string;
const adminUsername = 'e2e-admin';
const adminPassword = 'PharmaCare-E2E-Password-1';
const hardwareId = 'a'.repeat(64);

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
type ApiBridge = {
  request(request: { path: string; method?: ApiMethod; body?: unknown }): Promise<unknown>;
  createBackup(): Promise<string | null>;
};

async function localApi<T>(page: Page, request: {
  path: string;
  method?: ApiMethod;
  body?: unknown;
}): Promise<T> {
  return page.evaluate(async (value) => {
    const api = (window as Window & { pharmaAPI?: ApiBridge }).pharmaAPI;
    if (!api) throw new Error('Desktop API bridge is unavailable.');
    return api.request(value) as Promise<T>;
  }, request);
}

async function runNpm(script: string, env: NodeJS.ProcessEnv): Promise<void> {
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', `npm run ${script}`]
    : ['run', script];
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 240_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${script} failed${result.error ? `: ${result.error.message}` : ''}\n${result.stdout}\n${result.stderr}`,
    );
  }
}

async function assertScreenIsUsable(page: Page, route: string): Promise<void> {
  await page.waitForFunction((expectedRoute) => window.location.hash === `#${expectedRoute}`, route);
  await page.locator('body').waitFor({ state: 'visible' });
  const text = await page.locator('body').innerText();
  assert.doesNotMatch(text, /page not found|requested page does not exist/i, route);
  assert.doesNotMatch(text, /supabase/i, route);
  assert.ok(text.trim().length > 100, `${route} rendered an empty screen`);
}

test('desktop v1 activation, offline workflows, exports, recovery, and reopen', { timeout: 600_000 }, async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(tmpdir(), 'pharmacare-desktop-e2e-'));
  const centralConfig = path.join(temporaryRoot, 'central');
  const profilePath = path.join(temporaryRoot, 'profile');
  const backupPath = path.join(temporaryRoot, 'portable-backup.pharmabackup');
  await fs.mkdir(centralConfig, { recursive: true });

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const activationCode = randomBytes(24).toString('hex').toUpperCase();
  const signingPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const signingPublicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  await fs.writeFile(path.join(centralConfig, 'license-private.pem'), signingPrivateKey);
  await fs.writeFile(path.join(centralConfig, 'state.json'), `${JSON.stringify({
    shopId: randomUUID(),
    shopName: 'Pharma Care E2E',
    shopStatus: 'ACTIVE',
    licenseStatus: 'ACTIVE',
    expiresAt: expiry,
    graceDays: 30,
    activationCodeHash: hashActivationCode(activationCode),
    activationUsed: false,
    hardwareId: null,
  })}\n`);

  let central: FastifyInstance | null = null;
  let electronApp: ElectronApplication | null = null;
  try {
    central = buildDevelopmentLicensingServer(centralConfig);
    const address = await central.listen({ host: '127.0.0.1', port: 0 });
    const centralUrl = new URL(address).origin;
    const buildEnv = {
      ...process.env,
      CENTRAL_API_URL: centralUrl,
      CENTRAL_LICENSE_PUBLIC_KEY: signingPublicKey,
      PHARMA_LOCAL_LICENSE_DEV: 'true',
    };

    await runNpm('desktop:renderer', buildEnv);
    await runNpm('build --workspace=desktop-app', buildEnv);

    const profileEnv = {
      ...buildEnv,
      PHARMA_TEST_PROFILE: profilePath,
      PHARMA_TEST_HARDWARE_ID: hardwareId,
      PHARMA_TEST_DATABASE_KEY: randomBytes(32).toString('hex'),
      PHARMA_TEST_BACKUP_PATH: backupPath,
      PHARMA_TEST_RESTORE_PATH: backupPath,
    };
    const firstElectronApp = await import('playwright').then(({ _electron }) => _electron.launch({
      executablePath: electronExecutable,
      args: [path.join(root, 'desktop-app')],
      env: profileEnv,
      timeout: 60_000,
    }));
    electronApp = firstElectronApp;
    let page = await firstElectronApp.firstWindow();
    await page.getByPlaceholder('Enter activation code').fill(activationCode);
    await page.getByRole('button', { name: 'Activate', exact: true }).click();
    await page.getByText('Activation complete for Pharma Care E2E').waitFor();

    await page.getByLabel('FULL NAME').fill('E2E Shop Admin');
    await page.getByLabel('USERNAME').fill(adminUsername);
    await page.locator('#password').fill(adminPassword);
    await page.getByRole('button', { name: 'Create Shop Admin', exact: true }).click();
    const recoveryKeyInput = page.getByRole('textbox', { name: 'Pharmacy recovery key', exact: true });
    await recoveryKeyInput.waitFor();
    const recoveryKey = await recoveryKeyInput.inputValue();
    assert.match(recoveryKey, /^[A-Za-z0-9_-]{43}$/);
    await page.getByLabel('I have saved this recovery key somewhere safe.').check();
    await page.getByRole('button', { name: 'Continue to Pharma Care' }).click();

    const navigation = page.getByRole('navigation', { name: 'Main navigation' });
    await navigation.waitFor();
    const screens = [
      ['Dashboard', '/'],
      ['POS Billing', '/pos'],
      ['Products', '/products'],
      ['Categories', '/categories'],
      ['Stock Inventory', '/stock-inventory'],
      ['Suppliers', '/suppliers'],
      ['Purchases', '/purchases'],
      ['Purchase History', '/purchase-history'],
      ['Customer Ledger', '/customer-ledger'],
      ['Sales History', '/sales-history'],
      ['Expenses', '/expenses'],
      ['Business Analytics', '/reports'],
      ['Manage Users', '/users'],
      ['Settings', '/settings'],
      ['Trash Bin', '/trash-bin'],
    ] as const;
    for (const [label, route] of screens) {
      await navigation.getByRole('button', { name: label, exact: true }).click();
      await assertScreenIsUsable(page, route);
    }

    const category = await localApi<{ id: string }>(page, {
      path: '/api/master-data/values',
      method: 'POST',
      body: { kind: 'category', name: 'E2E Category' },
    });
    await localApi(page, {
      path: '/api/master-data/values',
      method: 'POST',
      body: { kind: 'category', id: category.id, name: 'E2E Category Edited' },
    });
    const brand = await localApi<{ id: string }>(page, {
      path: '/api/master-data/values',
      method: 'POST',
      body: { kind: 'brand', name: 'E2E Manufacturer' },
    });

    const supplier = await localApi<{ id: string }>(page, {
      path: '/api/suppliers',
      method: 'POST',
      body: { name: 'E2E Supplier', phone: '03000000000', payment_terms: 'CASH' },
    });
    await localApi(page, {
      path: '/api/suppliers',
      method: 'POST',
      body: { id: supplier.id, name: 'E2E Supplier Edited', phone: '03000000001', payment_terms: 'CASH' },
    });

    const product = await localApi<{ id: string }>(page, {
      path: '/api/inventory/products',
      method: 'POST',
      body: {
        code: 'E2E-MED-001',
        brandName: 'E2E Medicine',
        genericName: 'E2E Generic',
        strength: '10 mg',
        categoryId: category.id,
        brandId: brand.id,
        drugClass: 'OTC',
        storageCondition: 'ROOM_TEMPERATURE',
        units: [{ name: 'Tablet', conversionFactor: 1, isDefaultSaleUnit: true, pricePerUnitPaisa: 1000 }],
      },
    });
    const products = await localApi<{ products: Array<{ id: string; units: Array<{ id: string }> }> }>(page, {
      path: '/api/inventory/products?search=E2E-MED-001',
    });
    const savedProduct = products.products.find((item) => item.id === product.id);
    assert.ok(savedProduct?.units[0]?.id, 'medicine unit was not saved');
    await localApi(page, {
      path: '/api/inventory/products',
      method: 'POST',
      body: {
        id: product.id,
        code: 'E2E-MED-002',
        brandName: 'E2E Medicine Edited',
        genericName: 'E2E Generic',
        strength: '10 mg',
        categoryId: category.id,
        brandId: brand.id,
        drugClass: 'OTC',
        storageCondition: 'ROOM_TEMPERATURE',
        units: [{
          id: savedProduct.units[0].id,
          name: 'Tablet',
          conversionFactor: 1,
          isDefaultSaleUnit: true,
          pricePerUnitPaisa: 1000,
        }],
      },
    });

    const customer = await localApi<{ id: string }>(page, {
      path: '/api/customers',
      method: 'POST',
      body: { name: 'E2E Customer', phone: '03000000002', creditLimitPaisa: 100000 },
    });
    await localApi(page, {
      path: '/api/customers',
      method: 'POST',
      body: { id: customer.id, name: 'E2E Customer Edited', phone: '03000000003', creditLimitPaisa: 100000 },
    });

    const purchase = await localApi<{ purchaseId?: string; id?: string }>(page, {
      path: '/api/purchases',
      method: 'POST',
      body: {
        supplierId: supplier.id,
        invoiceNumber: 'E2E-PURCHASE-001',
        purchaseDate: new Date().toISOString().slice(0, 10),
        items: [{
          medicineId: product.id,
          unitName: 'Tablet',
          quantity: 20,
          packSize: 1,
          costPerPackPaisa: 500,
          mrpPaisa: 1000,
          batchNumber: 'E2E-BATCH-001',
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        }],
        paidAmountPaisa: 10000,
        paymentMethod: 'CASH',
        discountPaisa: 0,
      },
    });
    assert.ok(purchase.purchaseId || purchase.id, 'purchase was not created');

    const cashSale = await localApi<{ id: string }>(page, {
      path: '/api/pos/checkout',
      method: 'POST',
      body: {
        customerName: 'Walk-in Customer',
        customerType: 'WALK_IN',
        items: [{ medicineId: product.id, unitId: savedProduct.units[0].id, quantityInUnit: 1 }],
        payments: [{ paymentMethod: 'CASH', amountPaisa: 1000 }],
        tenderedPaisa: 1000,
      },
    });
    await localApi(page, {
      path: '/api/pos/checkout',
      method: 'POST',
      body: {
        customerId: customer.id,
        customerName: 'E2E Customer Edited',
        customerType: 'REGISTERED',
        items: [{ medicineId: product.id, unitId: savedProduct.units[0].id, quantityInUnit: 2 }],
        payments: [
          { paymentMethod: 'CASH', amountPaisa: 1000 },
          { paymentMethod: 'CARD', amountPaisa: 1000 },
        ],
        tenderedPaisa: 2000,
      },
    });
    const returnSales = await localApi<Array<{ id: string; items: Array<{ saleItemId: string }> }>>(page, {
      path: '/api/pos/return-sales',
    });
    const returnSale = returnSales.find((sale) => sale.id === cashSale.id);
    assert.ok(returnSale?.items[0]?.saleItemId, 'cash sale item was not available for return');
    await localApi(page, {
      path: '/api/reports/returns',
      method: 'POST',
      body: {
        saleId: cashSale.id,
        reason: 'E2E return',
        disposition: 'QUARANTINE',
        items: [{ saleItemId: returnSale.items[0].saleItemId, quantityInUnit: 1 }],
      },
    });

    await localApi(page, {
      path: '/api/cashbook/transactions',
      method: 'POST',
      body: { description: 'E2E expense', amountPaisa: 250, isOutflow: true },
    });
    await page.reload();
    await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
    const refreshedNavigation = page.getByRole('navigation', { name: 'Main navigation' });
    await refreshedNavigation.getByRole('button', { name: 'Expenses', exact: true }).click();
    await assertScreenIsUsable(page, '/expenses');
    await page.evaluate(() => {
      Object.defineProperty(window, '__e2eDownloads', { value: [], writable: true });
      Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
        configurable: true,
        value: new Function('if (this.download) window.__e2eDownloads.push(this.download);'),
      });
    });
    for (const format of ['CSV', 'XLSX'] as const) {
      await page.getByRole('button', { name: format, exact: true }).click();
      await page.waitForFunction(
        (expectedCount) => ((window as Window & { __e2eDownloads?: string[] }).__e2eDownloads?.length ?? 0) >= expectedCount,
        format === 'CSV' ? 1 : 2,
      );
      const downloads = await page.evaluate(
        () => (window as Window & { __e2eDownloads?: string[] }).__e2eDownloads ?? [],
      );
      const lastDownload = downloads.at(-1);
      assert.ok(lastDownload);
      assert.match(lastDownload, new RegExp(`\\.${format.toLowerCase()}$`));
    }

    const ordinaryBackup = await page.evaluate(async () => {
      const api = (window as Window & { pharmaAPI?: ApiBridge }).pharmaAPI;
      if (!api) throw new Error('Desktop API bridge is unavailable.');
      return api.createBackup();
    });
    assert.ok(ordinaryBackup, 'manual encrypted backup did not produce a file');
    await fs.access(ordinaryBackup);

    await navigation.getByRole('button', { name: 'Settings', exact: true }).click();
    await assertScreenIsUsable(page, '/settings');
    const recoveryInput = page.getByLabel('Recovery key', { exact: true });
    await recoveryInput.fill(recoveryKey);
    await page.getByRole('button', { name: 'Export portable backup', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Portable backup saved' }).waitFor();
    await fs.access(backupPath);

    const postBackupCustomer = await localApi<{ id: string }>(page, {
      path: '/api/customers',
      method: 'POST',
      body: { name: 'E2E Post-backup Record', phone: '03000000004' },
    });
    assert.ok(postBackupCustomer.id);
    await page.getByRole('button', { name: 'Restore portable backup', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[name="email"]') !== null);
    assert.ok(central, 'central service was not running');
    await central.close();
    central = null;

    await page.getByLabel('USERNAME').fill(adminUsername);
    await page.locator('#password').fill(adminPassword);
    await page.getByRole('button', { name: 'Sign In to System', exact: true }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
    const restoredCustomers = await localApi<{ customers: Array<{ name: string }> }>(page, {
      path: '/api/customers',
    });
    assert.ok(restoredCustomers.customers.some((entry) => entry.name === 'E2E Customer Edited'));
    assert.ok(!restoredCustomers.customers.some((entry) => entry.name === 'E2E Post-backup Record'));

    await firstElectronApp.close();
    electronApp = null;
    const reopenedElectronApp = await import('playwright').then(({ _electron }) => _electron.launch({
      executablePath: electronExecutable,
      args: [path.join(root, 'desktop-app')],
      env: profileEnv,
      timeout: 60_000,
    }));
    electronApp = reopenedElectronApp;
    page = await reopenedElectronApp.firstWindow();
    await page.getByLabel('USERNAME').fill(adminUsername);
    await page.locator('#password').fill(adminPassword);
    await page.getByRole('button', { name: 'Sign In to System', exact: true }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
    const reopenedProducts = await localApi<{ products: Array<{ id: string; code: string }> }>(page, {
      path: '/api/inventory/products?search=E2E-MED-002',
    });
    assert.ok(reopenedProducts.products.some((entry) => entry.id === product.id));
    const reopenedSales = await localApi<unknown[]>(page, { path: '/api/reports/sales' });
    assert.ok(reopenedSales.length >= 2, 'sales were not persisted after offline reopen');
    const bodyText = await page.locator('body').innerText();
    assert.doesNotMatch(bodyText, /supabase/i);
  } finally {
    if (electronApp) await electronApp.close().catch(() => undefined);
    if (central) await central.close().catch(() => undefined);
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
