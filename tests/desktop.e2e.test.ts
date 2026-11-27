import assert from 'node:assert/strict';
import { spawnSync, type ChildProcess } from 'node:child_process';
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
  requestWithStatus?(request: { path: string; method?: ApiMethod; body?: unknown }): Promise<{
    status: number;
    body: unknown;
  }>;
  logout(): Promise<void>;
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

async function localApiWithStatus(page: Page, request: {
  path: string;
  method?: ApiMethod;
  body?: unknown;
}): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async (value) => {
    const api = (window as Window & { pharmaAPI?: ApiBridge }).pharmaAPI;
    if (!api?.requestWithStatus) throw new Error('The E2E status-aware API bridge is unavailable.');
    return api.requestWithStatus(value);
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
    timeout: 900_000,
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

async function findFile(rootPath: string, fileName: string): Promise<string | null> {
  for (const entry of await fs.readdir(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isFile() && entry.name === fileName) return entryPath;
    if (entry.isDirectory()) {
      const nested = await findFile(entryPath, fileName);
      if (nested) return nested;
    }
  }
  return null;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error('Installed Pharma Care process did not exit before uninstall.'));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
  });
}

test('desktop roles, entitlements, offline workflows, and installed-app retention', { timeout: 1_800_000 }, async (t) => {
  const trace = (message: string) => {
    if (process.env.PHARMA_E2E_TRACE === 'true') t.diagnostic(message);
  };
  const temporaryRoot = await fs.mkdtemp(path.join(tmpdir(), 'pharmacare-desktop-e2e-'));
  const centralConfig = path.join(temporaryRoot, 'central');
  const statePath = path.join(centralConfig, 'state.json');
  const profilePath = path.join(temporaryRoot, 'profile');
  const backupPath = path.join(temporaryRoot, 'portable-backup.pharmabackup');
  await fs.mkdir(centralConfig, { recursive: true });

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  let activationCode = randomBytes(24).toString('hex').toUpperCase();
  const signingPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const signingPublicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  await fs.writeFile(path.join(centralConfig, 'license-private.pem'), signingPrivateKey);
  await fs.writeFile(statePath, `${JSON.stringify({
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
  let centralPort = 0;
  let electronApp: ElectronApplication | null = null;
  try {
    central = buildDevelopmentLicensingServer(centralConfig);
    const address = await central.listen({ host: '127.0.0.1', port: 0 });
    const centralUrl = new URL(address).origin;
    centralPort = Number(new URL(address).port);
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
      PHARMA_E2E_TEST: 'true',
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
    await page.setViewportSize({ width: 1100, height: 800 });
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
      ['Help & Support', '/help'],
    ] as const;
    const intentionallyHiddenPages = [
      'Shops',
      'Demo',
      'WhatsApp Reminders',
      'My print requests',
      'Print Requests',
    ];
    const assertHiddenDesktopPages = async () => {
      for (const label of intentionallyHiddenPages) {
        await assert.rejects(() => navigation.getByRole('button', { name: label, exact: true }).waitFor({
          state: 'visible',
          timeout: 100,
        }));
      }
    };
    await assertHiddenDesktopPages();
    for (const [label, route] of screens) {
      await navigation.getByRole('button', { name: label, exact: true }).click();
      await assertScreenIsUsable(page, route);
      if (label === 'Dashboard') {
        await page.waitForFunction(() => {
          const label = Array.from(document.querySelectorAll('span'))
            .find((element) => element.textContent?.trim() === "Today's Profit (Rs)");
          const cardText = label?.parentElement?.parentElement?.textContent || '';
          return /Rs\.\s*0(?:\D|$)/.test(cardText);
        });
        const profitCardText = await page.getByText("Today's Profit (Rs)", { exact: true })
          .locator('xpath=../..').innerText();
        assert.match(profitCardText, /Rs\.\s*0(?:\D|$)/);
        assert.doesNotMatch(profitCardText, /setup required|open analytics/i);
        const layout = await page.evaluate(() => {
          const main = document.querySelector('main.pharmacy-page');
          const header = document.querySelector('header.sticky');
          return {
            mainFits: !!main && main.scrollWidth <= main.clientWidth + 1,
            headerFits: !!header && header.scrollWidth <= header.clientWidth + 1,
          };
        });
        assert.equal(layout.mainFits, true, 'Dashboard should not clip right-side metrics.');
        assert.equal(layout.headerFits, true, 'Top navigation should fit the window width.');
      }
    }
    trace('Admin navigation passed.');
    await localApi(page, {
      path: '/api/license/announcements',
      method: 'POST',
      body: {
        announcements: [{
          id: randomUUID(),
          title: 'E2E developer release notice',
          body: 'A new stability update is ready.',
          published_at: new Date().toISOString(),
        }],
      },
    });
    await page.getByRole('button', { name: /^Alerts,/ }).click();
    await page.getByRole('heading', { name: 'Developer updates' }).waitFor();
    await page.getByText('E2E developer release notice', { exact: true }).waitFor();

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
    const temporaryCategory = await localApi<{ id: string }>(page, {
      path: '/api/master-data/values',
      method: 'POST',
      body: { kind: 'category', name: 'E2E Disposable Category' },
    });
    await localApi(page, {
      path: '/api/master-data/values',
      method: 'POST',
      body: { kind: 'category', id: temporaryCategory.id, name: 'E2E Disposable Category Edited' },
    });
    await localApi(page, {
      path: `/api/master-data/values/category/${temporaryCategory.id}`,
      method: 'DELETE',
    });
    const temporaryBrand = await localApi<{ id: string }>(page, {
      path: '/api/master-data/values',
      method: 'POST',
      body: { kind: 'brand', name: 'E2E Disposable Manufacturer' },
    });
    await localApi(page, {
      path: '/api/master-data/values',
      method: 'POST',
      body: { kind: 'brand', id: temporaryBrand.id, name: 'E2E Disposable Manufacturer Edited' },
    });
    await localApi(page, {
      path: `/api/master-data/values/brand/${temporaryBrand.id}`,
      method: 'DELETE',
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
    const inactiveCatalogImport = await localApi<{ importedCount: number }>(page, {
      path: '/api/inventory/products/import',
      method: 'POST',
      body: {
        rows: [{
          line: 2,
          code: 'E2E-INACTIVE-001',
          brand_name: 'E2E Inactive Catalog Product',
          generic_name: 'E2E Inactive Generic',
          category: 'E2E Category',
          company: 'E2E Manufacturer',
          unit_name: 'Bottle',
          conversion_factor: '10',
          price_paisa: '1500',
          is_active: 'false',
        }],
      },
    });
    assert.equal(inactiveCatalogImport.importedCount, 1);
    await navigation.getByRole('button', { name: 'Products', exact: true }).click();
    await page.getByLabel('Filter active status').selectOption('inactive');
    const inactiveProductRow = page.getByRole('row').filter({ hasText: 'E2E Inactive Catalog Product' });
    await inactiveProductRow.waitFor({ state: 'visible' });
    await inactiveProductRow.getByLabel('Row actions').click();
    await page.getByRole('button', { name: 'Activate product', exact: true }).click();
    const openingStockDialog = page.getByRole('dialog', { name: 'Activate E2E Inactive Catalog Product' });
    await openingStockDialog.getByLabel('Opening stock quantity').fill('2');
    await openingStockDialog.getByLabel('Batch number *').fill('E2E-INITIAL-1');
    await openingStockDialog.getByLabel('Expiry date *').fill('2099-12-31');
    await openingStockDialog.getByLabel('Cost per sale unit (paisa) *').fill('250');
    await openingStockDialog.getByRole('button', { name: 'Activate product', exact: true }).click();
    await openingStockDialog.waitFor({ state: 'detached' });
    const activatedCatalog = await localApi<{ products: Array<{ id: string; currentStockSmallestUnit: number }> }>(page, {
      path: '/api/inventory/products?status=active&search=E2E-INACTIVE-001',
    });
    assert.equal(activatedCatalog.products.length, 1);
    assert.equal(activatedCatalog.products[0].currentStockSmallestUnit, 20);
    await page.getByLabel('Filter active status').selectOption('active');

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
    const purchasedBatches = await localApi<{ rows: Array<{ id: string; quantity_remaining: number }> }>(page, {
      path: `/api/inventory/stock-batches?p_medicine_id=${product.id}`,
    });
    const purchasedBatch = purchasedBatches.rows.find((row) => row.quantity_remaining === 20);
    assert.ok(purchasedBatch, 'stock inventory did not show the received batch');
    await localApi(page, {
      path: '/api/inventory/adjust',
      method: 'POST',
      body: { batchId: purchasedBatch.id, adjustedQuantitySmallestUnit: 21, reason: 'E2E adjustment edit' },
    });
    await localApi(page, {
      path: '/api/inventory/adjust',
      method: 'POST',
      body: { batchId: purchasedBatch.id, adjustedQuantitySmallestUnit: 20, reason: 'E2E adjustment restore' },
    });

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
      path: `/api/customers/${customer.id}/payment`,
      method: 'POST',
      body: { amountPaisa: 100, note: 'E2E customer ledger payment' },
    });

    await localApi(page, {
      path: `/api/inventory/products`,
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
          name: 'Tablet Plus',
          conversionFactor: 1,
          isDefaultSaleUnit: true,
          pricePerUnitPaisa: 1000,
        }],
      },
    });

    const voidablePurchase = await localApi<{ purchaseId?: string; id?: string }>(page, {
      path: '/api/purchases',
      method: 'POST',
      body: {
        supplierId: supplier.id,
        invoiceNumber: 'E2E-PURCHASE-VOID',
        purchaseDate: new Date().toISOString().slice(0, 10),
        items: [{
          medicineId: product.id,
          unitName: 'Tablet Plus',
          quantity: 2,
          packSize: 1,
          costPerPackPaisa: 500,
          mrpPaisa: 1000,
          batchNumber: 'E2E-BATCH-VOID',
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        }],
        paidAmountPaisa: 1000,
        paymentMethod: 'CASH',
        discountPaisa: 0,
      },
    });
    const voidablePurchaseId = voidablePurchase.purchaseId || voidablePurchase.id;
    assert.ok(voidablePurchaseId, 'second purchase was not created');
    await localApi(page, {
      path: `/api/purchases/${voidablePurchaseId}/void`,
      method: 'POST',
      body: { reason: 'E2E purchase-history void test' },
    });

    await localApi(page, {
      path: '/api/inventory/products/bulk-update',
      method: 'POST',
      body: { ids: [product.id], action: 'deactivate' },
    });
    const productTrash = await localApi<Array<{ id: string; entity_type: string; entity_id: string }>>(page, {
      path: '/api/trash',
    });
    const productTrashEvent = productTrash.find((event) => event.entity_type === 'medicine' && event.entity_id === product.id);
    assert.ok(productTrashEvent, 'product deactivation was not recorded in Trash Bin');
    await localApi(page, {
      path: `/api/trash/${productTrashEvent.id}/restore`,
      method: 'PUT',
    });

    const disposableSupplier = await localApi<{ id: string }>(page, {
      path: '/api/suppliers',
      method: 'POST',
      body: { name: 'E2E Disposable Supplier', phone: '03000000005', payment_terms: 'CASH' },
    });
    await localApi(page, {
      path: `/api/suppliers/${disposableSupplier.id}/status`,
      method: 'PUT',
      body: { isActive: false },
    });
    const supplierTrash = await localApi<Array<{ id: string; entity_type: string; entity_id: string; can_permanently_delete: boolean }>>(page, {
      path: '/api/trash',
    });
    const disposableSupplierEvent = supplierTrash.find((event) => event.entity_type === 'supplier'
      && event.entity_id === disposableSupplier.id
      && event.can_permanently_delete);
    assert.ok(disposableSupplierEvent, 'unused supplier was not eligible for audited deletion');
    await localApi(page, {
      path: `/api/trash/${disposableSupplierEvent.id}`,
      method: 'DELETE',
    });

    await localApi(page, {
      path: '/api/cashbook/transactions',
      method: 'POST',
      body: { description: 'E2E expense', amountPaisa: 250, isOutflow: true },
    });
    const settings = await localApi<Record<string, unknown>>(page, { path: '/api/settings/shop' });
    await localApi(page, {
      path: '/api/settings/shop',
      method: 'PUT',
      body: { shopName: `${String(settings.shopName || 'Pharma Care')} E2E` },
    });

    const rolePermissions = [
      'pos',
      'products',
      'categories',
      'stock_inventory',
      'suppliers',
      'purchases',
      'purchase_history',
      'customers',
      'sales_history',
      'expenses',
      'reports',
      'settings',
      'manage_users',
    ];
    const roleAccounts = [
      { role: 'manager', username: 'e2e-manager', password: 'PharmaCare-Manager-Password-1' },
      { role: 'seller', username: 'e2e-seller', password: 'PharmaCare-Seller-Password-1' },
      { role: 'cashier', username: 'e2e-cashier', password: 'PharmaCare-Cashier-Password-1' },
    ] as const;
    for (const account of roleAccounts) {
      await localApi(page, {
        path: '/api/auth/users',
        method: 'POST',
        body: {
          ...account,
          fullName: `E2E ${account.role}`,
          permissions: rolePermissions,
        },
      });
    }

    for (const account of roleAccounts) {
      await page.evaluate(async () => {
        const api = (window as Window & { pharmaAPI?: ApiBridge }).pharmaAPI;
        if (!api) throw new Error('Desktop API bridge is unavailable.');
        await api.logout();
      });
      await page.reload();
      await page.getByLabel('USERNAME').fill(account.username);
      await page.locator('#password').fill(account.password);
      await page.getByRole('button', { name: 'Sign In to System', exact: true }).click();
      const roleNavigation = page.getByRole('navigation', { name: 'Main navigation' });
      await roleNavigation.waitFor();
      const shouldHide = account.role === 'manager'
        ? ['Manage Users', 'Settings', 'Trash Bin']
        : ['Purchase History', 'Manage Users', 'Settings', 'Trash Bin'];
      for (const [label] of screens) {
        const pageButton = roleNavigation.getByRole('button', { name: label, exact: true });
        if (shouldHide.includes(label)) {
          assert.equal(await pageButton.count(), 0, `${account.role} unexpectedly sees ${label}`);
        } else {
          await pageButton.waitFor({ state: 'visible' });
        }
      }

      const restrictedRequests: Array<{ path: string; method?: ApiMethod; body?: unknown }> = [
        { path: '/api/auth/users' },
        { path: '/api/settings/shop' },
        { path: '/api/trash' },
        { path: '/api/backup/create', method: 'POST', body: {} },
        { path: '/api/pos/checkout', method: 'POST', body: {
          customerName: 'Walk-in Customer',
          customerType: 'WALK_IN',
          items: [{ medicineId: product.id, unitId: savedProduct.units[0].id, quantityInUnit: 1 }],
          discountPaisa: 250,
          payments: [{ paymentMethod: 'CASH', amountPaisa: 750 }],
          tenderedPaisa: 750,
        } },
      ];
      for (const request of restrictedRequests) {
        const response = await localApiWithStatus(page, request);
        assert.equal(response.status, 403, `${account.role} received ${response.status} for ${request.path}`);
      }
      if (account.role !== 'manager') {
        const costHistory = await localApiWithStatus(page, { path: '/api/purchases/history' });
        assert.equal(costHistory.status, 403, `${account.role} received purchase cost history`);
      }
      assert.doesNotMatch(await page.locator('body').innerText(), /supabase/i);
    }
    trace('Manager, Seller, and Cashier role checks passed.');

    await page.evaluate(async () => {
      const api = (window as Window & { pharmaAPI?: ApiBridge }).pharmaAPI;
      if (!api) throw new Error('Desktop API bridge is unavailable.');
      await api.logout();
    });
    await page.reload();
    await page.getByLabel('USERNAME').fill(adminUsername);
    await page.locator('#password').fill(adminPassword);
    await page.getByRole('button', { name: 'Sign In to System', exact: true }).click();
    await navigation.waitFor();

    const disposableUser = await localApi<{ id: string }>(page, {
      path: '/api/auth/users',
      method: 'POST',
      body: {
        username: 'e2e-disposable',
        password: 'PharmaCare-Disposable-Password-1',
        fullName: 'E2E Disposable User',
        role: 'cashier',
        permissions: ['pos'],
      },
    });
    await localApi(page, {
      path: `/api/auth/users/${disposableUser.id}`,
      method: 'PUT',
      body: {
        username: 'e2e-disposable',
        fullName: 'E2E Disposable User Edited',
        email: 'e2e-disposable@example.invalid',
        role: 'cashier',
        permissions: ['pos'],
      },
    });
    await localApi(page, {
      path: `/api/auth/users/${disposableUser.id}/status`,
      method: 'PUT',
      body: { status: 'remove_access' },
    });
    const withoutDisposableUser = await localApi<Array<{ id: string }>>(page, { path: '/api/auth/users' });
    assert.ok(!withoutDisposableUser.some((user) => user.id === disposableUser.id));
    await localApi(page, {
      path: `/api/auth/users/${disposableUser.id}/restore`,
      method: 'PUT',
    });
    const restoredDisposableUser = await localApi<Array<{ id: string; fullName: string }>>(page, { path: '/api/auth/users' });
    assert.equal(restoredDisposableUser.find((user) => user.id === disposableUser.id)?.fullName, 'E2E Disposable User Edited');

    await page.reload();
    await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
    const refreshedNavigation = page.getByRole('navigation', { name: 'Main navigation' });
    for (const [label, route] of screens) {
      await refreshedNavigation.getByRole('button', { name: label, exact: true }).click();
      await assertScreenIsUsable(page, route);
    }

    const persistedMasterData = await localApi<{
      categories: Array<{ name: string }>;
      manufacturers: Array<{ name: string }>;
    }>(page, { path: '/api/master-data/overview' });
    assert.ok(persistedMasterData.categories.some((entry) => entry.name === 'E2E Category Edited'));
    assert.ok(persistedMasterData.manufacturers.some((entry) => entry.name === 'E2E Manufacturer'));
    const persistedUnits = await localApi<Array<{ name: string }>>(page, { path: '/api/master-data/units' });
    assert.ok(persistedUnits.some((entry) => entry.name === 'Tablet Plus'));
    const persistedProducts = await localApi<{ products: Array<{ id: string; code: string }> }>(page, {
      path: '/api/inventory/products?search=E2E-MED-002',
    });
    assert.ok(persistedProducts.products.some((entry) => entry.id === product.id));
    const persistedStock = await localApi<{ rows: Array<{ batch_number: string }> }>(page, {
      path: `/api/inventory/stock-batches?p_medicine_id=${product.id}`,
    });
    assert.ok(persistedStock.rows.some((entry) => entry.batch_number === 'E2E-BATCH-001'));
    const persistedSuppliers = await localApi<Array<{ name: string }>>(page, { path: '/api/suppliers' });
    assert.ok(persistedSuppliers.some((entry) => entry.name === 'E2E Supplier Edited'));
    const persistedPurchases = await localApi<{ total_count: number }>(page, { path: '/api/purchases/history' });
    assert.ok(persistedPurchases.total_count >= 2);
    const persistedCustomers = await localApi<{
      customers: Array<{ id: string; name: string }>;
      ledgerEntries: Record<string, unknown[]>;
    }>(page, { path: '/api/customers' });
    assert.ok(persistedCustomers.customers.some((entry) => entry.id === customer.id && entry.name === 'E2E Customer Edited'));
    assert.ok((persistedCustomers.ledgerEntries[customer.id]?.length ?? 0) > 0);
    const persistedSales = await localApi<unknown[]>(page, { path: '/api/reports/sales' });
    assert.ok(persistedSales.length >= 2);
    const persistedExpenses = await localApi<Array<{ description: string }>>(page, {
      path: '/api/cashbook/transactions',
    });
    assert.ok(persistedExpenses.some((entry) => entry.description === 'E2E expense'));
    const persistedUsers = await localApi<Array<{ id: string; fullName: string }>>(page, { path: '/api/auth/users' });
    assert.ok(persistedUsers.some((entry) => entry.id === disposableUser.id
      && entry.fullName === 'E2E Disposable User Edited'));
    const persistedSettings = await localApi<{ shopName: string }>(page, { path: '/api/settings/shop' });
    assert.match(persistedSettings.shopName, /E2E$/);
    const persistedTrash = await localApi<Array<{ display_name: string }>>(page, { path: '/api/trash' });
    assert.ok(persistedTrash.some((entry) => entry.display_name === 'E2E Medicine Edited'));

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
    await page.getByRole('heading', { name: 'Product CSV import & export' }).waitFor();
    const settingsProductCsv = [
      'code,barcode,brand_name,generic_name,category,company,unit_name,conversion_factor,price_paisa,opening_stock_qty,opening_batch_number,opening_expiry_date,opening_cost_paisa',
      'E2E-SETTINGS-CSV-001,,E2E Settings CSV Product,E2E Generic,Test Category,E2E Manufacturer,Pack,10,1000,2,E2E-SETTINGS-BATCH-001,2099-12-31,400',
    ].join('\r\n');
    await page.getByLabel('Choose product CSV in Settings').setInputFiles({
      name: 'settings-products.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(settingsProductCsv, 'utf8'),
    });
    await page.getByRole('status').filter({ hasText: 'Ready to review 1 rows: 1 valid' }).waitFor();
    await page.getByRole('button', { name: 'Import 1 valid rows' }).click();
    await page.getByRole('status').filter({ hasText: 'Imported 1 products successfully.' }).waitFor();
    const settingsCsvProduct = await localApi<{
      products: Array<{ id: string; code: string }>;
    }>(page, { path: '/api/inventory/products?search=E2E-SETTINGS-CSV-001' });
    const settingsCsvMedicine = settingsCsvProduct.products.find((item) => item.code === 'E2E-SETTINGS-CSV-001');
    assert.ok(settingsCsvMedicine, 'Settings CSV import did not create its product');
    const settingsCsvBatches = await localApi<{
      rows: Array<{ quantity_remaining: number; batch_number: string }>;
    }>(page, { path: `/api/inventory/stock-batches?p_medicine_id=${settingsCsvMedicine.id}` });
    assert.ok(settingsCsvBatches.rows.some((row) =>
      row.quantity_remaining === 20 && row.batch_number === 'E2E-SETTINGS-BATCH-001'),
    'Settings CSV import did not create the opening batch');
    await page.getByRole('button', { name: 'Export all CSV', exact: true }).click();
    await page.waitForFunction(
      () => (window as Window & { __e2eDownloads?: string[] }).__e2eDownloads?.some((name) =>
        /^pharma-care-products-.*\.csv$/.test(name)) ?? false,
    );
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
    trace('Backup and restore workflow passed.');
    await page.getByRole('button', { name: 'Restore portable backup', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[name="email"]') !== null);
    await page.getByLabel('USERNAME').fill(adminUsername);
    await page.locator('#password').fill(adminPassword);
    await page.getByRole('button', { name: 'Sign In to System', exact: true }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
    const restoredCustomers = await localApi<{ customers: Array<{ name: string }> }>(page, {
      path: '/api/customers',
    });
    assert.ok(restoredCustomers.customers.some((entry) => entry.name === 'E2E Customer Edited'));
    assert.ok(!restoredCustomers.customers.some((entry) => entry.name === 'E2E Post-backup Record'));
    const restoredSettingsCsvProduct = await localApi<{ products: Array<{ code: string }> }>(page, {
      path: '/api/inventory/products?search=E2E-SETTINGS-CSV-001',
    });
    assert.ok(restoredSettingsCsvProduct.products.some((entry) => entry.code === 'E2E-SETTINGS-CSV-001'));

    const firstElectronProcess = firstElectronApp.process();
    await firstElectronApp.close();
    await waitForChildExit(firstElectronProcess, 30_000);
    electronApp = null;
    assert.ok(central, 'central service was not running');
    await central.close();
    central = null;
    const limitedLicenseState = JSON.parse(await fs.readFile(statePath, 'utf8')) as Record<string, unknown>;
    limitedLicenseState.enabledPages = [
      'pos',
      'products',
      'categories',
      'stock_inventory',
      'suppliers',
      'purchases',
      'purchase_history',
      'customers',
      'sales_history',
      'expenses',
      'reports',
      'manage_users',
    ];
    await fs.writeFile(statePath, `${JSON.stringify(limitedLicenseState, null, 2)}\n`);
    central = buildDevelopmentLicensingServer(centralConfig);
    await central.listen({ host: '127.0.0.1', port: centralPort });

    const entitlementElectronApp = await import('playwright').then(({ _electron }) => _electron.launch({
      executablePath: electronExecutable,
      args: [path.join(root, 'desktop-app')],
      env: profileEnv,
      timeout: 60_000,
    }));
    electronApp = entitlementElectronApp;
    page = await entitlementElectronApp.firstWindow();
    const usernameField = page.getByLabel('USERNAME');
    const loginVisible = await usernameField.waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (loginVisible) {
      await usernameField.fill(adminUsername);
      await page.locator('#password').fill(adminPassword);
      await page.getByRole('button', { name: 'Sign In to System', exact: true }).click();
    } else {
      await page.getByRole('navigation', { name: 'Main navigation' }).waitFor({ timeout: 10_000 });
    }
    let updatedLicense: { enabledPages: string[] } | null = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      updatedLicense = await localApi<{ enabledPages: string[] }>(page, { path: '/api/license/status' });
      if (!updatedLicense.enabledPages.includes('settings')) break;
      await page.waitForTimeout(250);
    }
    assert.ok(updatedLicense && !updatedLicense.enabledPages.includes('settings'), 'check-in did not persist the disabled Settings entitlement');
    trace('Signed entitlement check-in passed.');
    await page.evaluate(() => { window.location.hash = '#/'; });
    const entitlementNavigation = page.getByRole('navigation', { name: 'Main navigation' });
    await entitlementNavigation.waitFor();
    assert.equal(await entitlementNavigation.getByRole('button', { name: 'Settings', exact: true }).count(), 0);
    const entitlementRoute = await localApiWithStatus(page, { path: '/api/settings/shop' });
    assert.equal(entitlementRoute.status, 403, 'disabled Settings API route was not denied');
    await page.evaluate(() => { window.location.hash = '#/settings'; });
    await page.getByText(/not included in (your )?(plan|pharmacy license)/i).waitFor();
    assert.doesNotMatch(await page.locator('body').innerText(), /supabase/i);

    const savedHeldBills = [{
      id: 'offline-held-bill',
      heldAt: Date.now(),
      cart: [{
        productId: 'draft-product',
        productName: 'Offline Draft Medicine',
        genericName: 'Offline Draft Generic',
        batchId: 'draft-batch',
        batchNumber: 'DRAFT-001',
        expiryDate: '2099-12-31',
        drugClass: 'OTC',
        unitId: 'draft-unit',
        unitName: 'Tablet',
        conversionFactor: 1,
        quantityInUnit: 1,
        mrpPaisaPerUnit: 1000,
        costPaisaPerUnit: null,
        discountPercent: 0,
        lineTotalPaisa: 1000,
      }],
      discount: { mode: 'amount', value: '0' },
      customerId: '',
      customerName: '',
      customerType: 'WALK_IN',
      totalPaisa: 1000,
    }];
    const savedPurchaseDrafts = [{
      id: 'offline-purchase-draft',
      savedAt: new Date().toISOString(),
      supplierId: '',
      paymentType: 'cash',
      invoiceNumber: '',
      purchaseDate: new Date().toISOString().slice(0, 10),
      discount: '0.00',
      notes: '',
      lines: [{
        product: {
          id: 'draft-product',
          code: 'DRAFT-001',
          barcode: null,
          brand_name: 'Offline Draft Medicine',
          generic_name: 'Offline Draft Generic',
          company: 'Test Manufacturer',
          stock: 0,
          last_cost_base_paisa: null,
          units: [{
            id: 'draft-unit',
            name: 'Tablet',
            conversion_factor: 1,
            is_default_sale_unit: true,
            price_paisa: 1000,
          }],
        },
        unitId: 'draft-unit',
        quantity: 1,
        bonusQty: 0,
        batchNumber: 'DRAFT-001',
        expiryDate: '2099-12-31',
        rate: '5.00',
        mrp: '10.00',
      }],
    }];
    await localApi(page, {
      path: '/api/workflow-drafts/held-bills',
      method: 'PUT',
      body: { items: savedHeldBills },
    });
    await localApi(page, {
      path: '/api/workflow-drafts/purchase-drafts',
      method: 'PUT',
      body: { items: savedPurchaseDrafts },
    });
    await entitlementElectronApp.close();
    electronApp = null;
    await central.close();
    central = null;

    const reopenedOfflineElectronApp = await import('playwright').then(({ _electron }) => _electron.launch({
      executablePath: electronExecutable,
      args: [path.join(root, 'desktop-app')],
      env: profileEnv,
      timeout: 60_000,
    }));
    electronApp = reopenedOfflineElectronApp;
    page = await reopenedOfflineElectronApp.firstWindow();
    await page.getByLabel('USERNAME').fill(adminUsername);
    await page.locator('#password').fill(adminPassword);
    await page.getByRole('button', { name: 'Sign In to System', exact: true }).click();
    await page.evaluate(() => { window.location.hash = '#/'; });
    const offlineNavigation = page.getByRole('navigation', { name: 'Main navigation' });
    await offlineNavigation.waitFor();
    assert.equal(await offlineNavigation.getByRole('button', { name: 'Settings', exact: true }).count(), 0);
    assert.deepEqual(await localApi(page, { path: '/api/workflow-drafts/held-bills' }), { items: savedHeldBills });
    assert.deepEqual(await localApi(page, { path: '/api/workflow-drafts/purchase-drafts' }), { items: savedPurchaseDrafts });
    await offlineNavigation.getByRole('button', { name: 'POS Billing', exact: true }).click();
    const heldBillsButton = page.getByRole('button', { name: 'Held bills, 1 saved' });
    await heldBillsButton.waitFor();
    await heldBillsButton.click();
    await page.getByRole('region', { name: 'Held bills' }).waitFor();
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.getByText('Offline Draft Medicine', { exact: true }).waitFor();
    await offlineNavigation.getByRole('button', { name: 'Purchases', exact: true }).click();
    const heldPurchasesButton = page.getByRole('button', { name: 'Held purchases (1)' });
    await heldPurchasesButton.waitFor();
    await heldPurchasesButton.click();
    await page.getByRole('heading', { name: 'Held purchases' }).waitFor();
    await page.getByText(/1 items · No invoice number/).waitFor();
    const offlineSettingsRoute = await localApiWithStatus(page, { path: '/api/settings/shop' });
    assert.equal(offlineSettingsRoute.status, 403, 'disabled Settings route was not denied after offline reopen');
    const reopenedProducts = await localApi<{ products: Array<{ id: string; code: string }> }>(page, {
      path: '/api/inventory/products?search=E2E-MED-002',
    });
    assert.ok(reopenedProducts.products.some((entry) => entry.id === product.id));
    const reopenedSales = await localApi<unknown[]>(page, { path: '/api/reports/sales' });
    assert.ok(reopenedSales.length >= 2, 'sales were not persisted after offline reopen');
    const bodyText = await page.locator('body').innerText();
    assert.doesNotMatch(bodyText, /supabase/i);

    await reopenedOfflineElectronApp.close();
    electronApp = null;

    activationCode = randomBytes(24).toString('hex').toUpperCase();
    await fs.writeFile(statePath, `${JSON.stringify({
      shopId: randomUUID(),
      shopName: 'Pharma Care Installer E2E',
      shopStatus: 'ACTIVE',
      licenseStatus: 'ACTIVE',
      expiresAt: expiry,
      graceDays: 30,
      activationCodeHash: hashActivationCode(activationCode),
      activationUsed: false,
      hardwareId: null,
    }, null, 2)}\n`);
    const packageEnv = {
      ...process.env,
      CENTRAL_API_URL: centralUrl,
      CENTRAL_LICENSE_PUBLIC_KEY: signingPublicKey,
      PHARMA_LOCAL_LICENSE_DEV: 'true',
    };
    await runNpm('desktop:package', packageEnv);
    trace('Installer build is ready.');

    const desktopManifest = JSON.parse(await fs.readFile(path.join(root, 'desktop-app', 'package.json'), 'utf8')) as {
      version: string;
    };
    const installerPath = path.join(root, 'desktop-app', 'release', `PharmaCare-${desktopManifest.version}-Setup.exe`);
    await fs.access(installerPath);
    const installDir = path.join(temporaryRoot, 'installed');
    const installedDataRoot = path.join(temporaryRoot, 'installed-data');
    const appData = path.join(installedDataRoot, 'Roaming');
    const localAppData = path.join(installedDataRoot, 'Local');
    const installedProfile = path.join(installedDataRoot, 'Profile');
    await fs.mkdir(appData, { recursive: true });
    await fs.mkdir(localAppData, { recursive: true });
    const installResult = spawnSync(installerPath, ['/S', `/D=${installDir}`], {
      encoding: 'utf8',
      timeout: 300_000,
      windowsHide: true,
    });
    assert.equal(installResult.error, undefined, installResult.error?.message);
    assert.equal(installResult.status, 0, installResult.stderr);
    const installedExecutable = path.join(installDir, 'Pharma Care.exe');
    await fs.access(installedExecutable);

    central = buildDevelopmentLicensingServer(centralConfig);
    await central.listen({ host: '127.0.0.1', port: centralPort });
    const installedEnv = {
      ...process.env,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
    };
    const installedElectronApp = await import('playwright').then(({ _electron }) => _electron.launch({
      executablePath: installedExecutable,
      args: [`--user-data-dir=${installedProfile}`],
      env: installedEnv,
      timeout: 90_000,
    }));
    electronApp = installedElectronApp;
    page = await installedElectronApp.firstWindow();
    trace('Installed app window opened.');
    await page.getByPlaceholder('Enter activation code').fill(activationCode);
    await page.getByRole('button', { name: 'Activate', exact: true }).click();
    await page.getByText('Activation complete for Pharma Care Installer E2E').waitFor();
    trace('Installed activation passed.');
    await page.getByLabel('FULL NAME').fill('Installed E2E Admin');
    await page.getByLabel('USERNAME').fill('installed-admin');
    await page.locator('#password').fill(adminPassword);
    await page.getByRole('button', { name: 'Create Shop Admin', exact: true }).click();
    await page.getByRole('textbox', { name: 'Pharmacy recovery key', exact: true }).waitFor();
    await page.getByLabel('I have saved this recovery key somewhere safe.').check();
    await page.getByRole('button', { name: 'Continue to Pharma Care' }).click();
    const installedNavigation = page.getByRole('navigation', { name: 'Main navigation' });
    if (await installedNavigation.count() === 0 && await page.getByLabel('USERNAME').count() > 0) {
      await page.getByLabel('USERNAME').fill('installed-admin');
      await page.locator('#password').fill(adminPassword);
      await page.getByRole('button', { name: 'Sign In to System', exact: true }).click();
    }
    await installedNavigation.waitFor();
    trace('Installed admin setup passed.');
    await page.evaluate(async () => {
      const api = (window as Window & { pharmaAPI?: ApiBridge }).pharmaAPI;
      if (!api) throw new Error('Desktop API bridge is unavailable.');
      await api.logout();
    });
    await page.reload();
    await page.getByLabel('USERNAME').fill('installed-admin');
    await page.locator('#password').fill(adminPassword);
    await page.getByRole('button', { name: 'Sign In to System', exact: true }).click();
    await installedNavigation.waitFor();
    const installedCategory = await localApi<{ id: string }>(page, {
      path: '/api/master-data/values',
      method: 'POST',
      body: { kind: 'category', name: 'Installer E2E Category' },
    });
    const installedBrand = await localApi<{ id: string }>(page, {
      path: '/api/master-data/values',
      method: 'POST',
      body: { kind: 'brand', name: 'Installer E2E Manufacturer' },
    });
    const installedSupplier = await localApi<{ id: string }>(page, {
      path: '/api/suppliers',
      method: 'POST',
      body: { name: 'Installer E2E Supplier', phone: '03000000006', payment_terms: 'CASH' },
    });
    const installedProduct = await localApi<{ id: string }>(page, {
      path: '/api/inventory/products',
      method: 'POST',
      body: {
        code: 'INSTALLED-E2E-001',
        brandName: 'Installer E2E Medicine',
        genericName: 'Installer E2E Generic',
        strength: '10 mg',
        categoryId: installedCategory.id,
        brandId: installedBrand.id,
        drugClass: 'OTC',
        storageCondition: 'ROOM_TEMPERATURE',
        units: [{ name: 'Tablet', conversionFactor: 1, isDefaultSaleUnit: true, pricePerUnitPaisa: 1000 }],
      },
    });
    const installedUnit = await localApi<{ products: Array<{ id: string; units: Array<{ id: string }> }> }>(page, {
      path: '/api/inventory/products?search=INSTALLED-E2E-001',
    });
    const installedUnitId = installedUnit.products.find((entry) => entry.id === installedProduct.id)?.units[0]?.id;
    assert.ok(installedUnitId, 'installed product unit was not saved');
    await localApi(page, {
      path: '/api/purchases',
      method: 'POST',
      body: {
        supplierId: installedSupplier.id,
        invoiceNumber: 'INSTALLER-E2E-PURCHASE',
        purchaseDate: new Date().toISOString().slice(0, 10),
        items: [{
          medicineId: installedProduct.id,
          unitName: 'Tablet',
          quantity: 3,
          packSize: 1,
          costPerPackPaisa: 500,
          mrpPaisa: 1000,
          batchNumber: 'INSTALLER-E2E-BATCH',
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        }],
        paidAmountPaisa: 1500,
        paymentMethod: 'CASH',
        discountPaisa: 0,
      },
    });
    await localApi(page, {
      path: '/api/pos/checkout',
      method: 'POST',
      body: {
        customerName: 'Walk-in Customer',
        customerType: 'WALK_IN',
        items: [{ medicineId: installedProduct.id, unitId: installedUnitId, quantityInUnit: 1 }],
        payments: [{ paymentMethod: 'CASH', amountPaisa: 1000 }],
        tenderedPaisa: 1000,
      },
    });
    const installedSales = await localApi<unknown[]>(page, { path: '/api/reports/sales' });
    assert.equal(installedSales.length, 1, 'installed app did not complete its smoke-test sale');
    const installedDatabase = await findFile(installedDataRoot, 'pharmadata.db');
    assert.ok(installedDatabase, 'installed app did not create its local database under the isolated profile');

    const installedProcess = installedElectronApp.process();
    await installedElectronApp.close();
    await waitForChildExit(installedProcess, 30_000);
    electronApp = null;
    const installedDatabaseSize = (await fs.stat(installedDatabase)).size;
    const uninstallEntry = (await fs.readdir(installDir)).find((entry) => /^uninstall.*\.exe$/i.test(entry));
    assert.ok(uninstallEntry, 'NSIS uninstaller was not installed');
    const uninstallResult = spawnSync(path.join(installDir, uninstallEntry), ['/S'], {
      encoding: 'utf8',
      timeout: 180_000,
      windowsHide: true,
    });
    assert.equal(uninstallResult.error, undefined, uninstallResult.error?.message);
    assert.equal(uninstallResult.status, 0, uninstallResult.stderr);
    await fs.access(installedDatabase);
    assert.equal((await fs.stat(installedDatabase)).size, installedDatabaseSize);
    let applicationRemoved = false;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      try {
        await fs.access(installedExecutable);
      } catch {
        applicationRemoved = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(applicationRemoved, 'application files remain after silent uninstall');
    await central.close();
    central = null;
  } finally {
    try {
      if (electronApp) await electronApp.close();
    } finally {
      try {
        if (central) await central.close();
      } finally {
        await fs.rm(temporaryRoot, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 1000,
        });
      }
    }
  }
});
