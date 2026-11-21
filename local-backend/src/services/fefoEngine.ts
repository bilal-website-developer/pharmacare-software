import Database from 'better-sqlite3-multiple-ciphers';

export interface BatchAllocationResult {
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  quantitySmallestUnit: number;
  costPricePaisa: number;
}

export function localIsoDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function allocateFefoStock(
  db: Database.Database,
  medicineId: string,
  requiredSmallestUnits: number,
  today = localIsoDate()
): BatchAllocationResult[] {
  if (!Number.isSafeInteger(requiredSmallestUnits) || requiredSmallestUnits <= 0) {
    throw new RangeError('Sale quantity must be a positive whole number of smallest units.');
  }

  const eligibleBatches = db.prepare(`
    SELECT id, batch_number, expiry_date, received_date, cost_price_paisa, quantity_smallest_unit
    FROM stock_batches
    WHERE medicine_id = ?
      AND quantity_smallest_unit > 0
      AND status IN ('ACTIVE', 'NEAR_EXPIRY')
      AND expiry_date >= ?
    ORDER BY expiry_date ASC, received_date ASC, id ASC
  `).all(medicineId, today) as Array<{
    id: string;
    batch_number: string;
    expiry_date: string;
    received_date: string;
    cost_price_paisa: number;
    quantity_smallest_unit: number;
  }>;

  let remaining = requiredSmallestUnits;
  const allocations: BatchAllocationResult[] = [];

  for (const batch of eligibleBatches) {
    const take = Math.min(remaining, batch.quantity_smallest_unit);
    allocations.push({
      batchId: batch.id,
      batchNumber: batch.batch_number,
      expiryDate: batch.expiry_date,
      quantitySmallestUnit: take,
      costPricePaisa: batch.cost_price_paisa,
    });
    remaining -= take;
    if (remaining === 0) break;
  }

  if (remaining > 0) {
    throw new RangeError(
      `Insufficient eligible stock. ${requiredSmallestUnits - remaining} of ${requiredSmallestUnits} smallest units are available.`
    );
  }

  // Deduct from stock_batches
  const updateStmt = db.prepare(`
    UPDATE stock_batches
    SET quantity_smallest_unit = quantity_smallest_unit - ?,
        updated_at = strftime('%s', 'now')
    WHERE id = ?
  `);

  for (const alloc of allocations) {
    updateStmt.run(alloc.quantitySmallestUnit, alloc.batchId);
  }

  return allocations;
}

export function restoreBatchStock(
  db: Database.Database,
  allocations: Array<{ batchId: string; quantitySmallestUnit: number }>,
  disposition: 'RESTOCK' | 'QUARANTINE' | 'WRITE_OFF'
): void {
  if (disposition !== 'RESTOCK') {
    // Quarantine or Write-off does not restore to sellable inventory
    return;
  }

  const updateStmt = db.prepare(`
    UPDATE stock_batches
    SET quantity_smallest_unit = quantity_smallest_unit + ?,
        updated_at = strftime('%s', 'now')
    WHERE id = ?
  `);

  for (const alloc of allocations) {
    if (alloc.quantitySmallestUnit <= 0) continue;
    updateStmt.run(alloc.quantitySmallestUnit, alloc.batchId);
  }
}
