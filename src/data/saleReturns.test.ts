import assert from 'node:assert/strict';
import test from 'node:test';
import { callSupabaseRpc } from './sales';
import { isReturnSubmission } from './saleReturns';

test('accepts pending returns and server-completed automatic quarantine returns', () => {
  assert.equal(isReturnSubmission({
    id: 'return-pending',
    status: 'PENDING',
    invoiceNumber: 'INV-000123',
  }), true);
  assert.equal(isReturnSubmission({
    id: 'return-auto',
    invoiceNumber: 'INV-000124',
    status: 'COMPLETED',
    autoProcessed: true,
    refundMethod: 'CASH',
    refundTotalPaisa: 2500,
    customerBalancePaisa: null,
    customerStoreCreditPaisa: null,
    items: [{
      productName: 'Medicine',
      unitName: 'Tablet',
      quantityBaseUnits: 1,
      disposition: 'QUARANTINE',
      refundPaisa: 2500,
    }],
  }), true);
});

test('does not access the null Supabase client from desktop RPC paths', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { pharmaAPI: {} },
  });

  try {
    await assert.rejects(
      callSupabaseRpc('sale_for_return', undefined, 'Could not load return data.', (_value): _value is true => true),
      /does not have a local desktop backend route/,
    );
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('does not accept an untagged or malformed completed return submission', () => {
  assert.equal(isReturnSubmission({
    id: 'return-completed',
    invoiceNumber: 'INV-000125',
    status: 'COMPLETED',
    autoProcessed: false,
  }), false);
  assert.equal(isReturnSubmission({
    id: 'return-auto',
    invoiceNumber: 'INV-000126',
    status: 'COMPLETED',
    autoProcessed: true,
    refundMethod: 'CASH',
    refundTotalPaisa: 2500,
    customerBalancePaisa: null,
    customerStoreCreditPaisa: null,
    items: [{
      productName: 'Medicine',
      unitName: 'Tablet',
      quantityBaseUnits: 1,
      disposition: 'RESTOCK',
      refundPaisa: 2500,
    }],
  }), false);
  assert.equal(isReturnSubmission({ id: 'return-pending', status: 'PENDING' }), false);
});
