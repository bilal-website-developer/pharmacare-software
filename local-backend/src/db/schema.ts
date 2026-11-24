import Database from 'better-sqlite3-multiple-ciphers';

export function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    -- 1. Users (Local Shop Accounts)
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      email TEXT,
      role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'seller', 'cashier', 'accountant')),
      permissions TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 1,
      deleted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

    -- 2. Master Data: Categories
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 3. Master Data: Brands / Manufacturers
    CREATE TABLE IF NOT EXISTS brands (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      manufacturer TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 4. Medicine Catalog
    CREATE TABLE IF NOT EXISTS medicines (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      barcode TEXT,
      brand_name TEXT NOT NULL,
      generic_name TEXT NOT NULL,
      strength TEXT,
      category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
      brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL,
      drug_class TEXT NOT NULL DEFAULT 'OTC' CHECK(drug_class IN ('OTC', 'RX', 'CONTROLLED', 'NARCOTIC')),
      storage_condition TEXT NOT NULL DEFAULT 'ROOM_TEMPERATURE' CHECK(storage_condition IN ('ROOM_TEMPERATURE', 'COOL', 'COLD_REFRIGERATED')),
      rack_location TEXT,
      min_stock_alert INTEGER NOT NULL DEFAULT 0,
      requires_prescription INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      opening_stock_recorded INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_medicines_barcode ON medicines(barcode);
    CREATE INDEX IF NOT EXISTS idx_medicines_brand_name ON medicines(brand_name);
    CREATE INDEX IF NOT EXISTS idx_medicines_generic_name ON medicines(generic_name);
    CREATE INDEX IF NOT EXISTS idx_medicines_active ON medicines(is_active);

    -- 5. Medicine Units (Sale and Conversion Units)
    CREATE TABLE IF NOT EXISTS medicine_units (
      id TEXT PRIMARY KEY,
      medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      conversion_factor INTEGER NOT NULL DEFAULT 1,
      is_default_sale_unit INTEGER NOT NULL DEFAULT 0,
      price_per_unit_paisa INTEGER NOT NULL DEFAULT 0,
      barcode TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_medicine_units_medicine_id ON medicine_units(medicine_id);

    -- 6. Suppliers
    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      contact_person TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      licence_or_tax_number TEXT NOT NULL DEFAULT '',
      payment_terms TEXT NOT NULL DEFAULT 'CASH',
      balance_paisa INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      deleted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 7. Supplier Ledger
    CREATE TABLE IF NOT EXISTS supplier_ledger (
      id TEXT PRIMARY KEY,
      supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('PURCHASE', 'PAYMENT', 'RETURN')),
      reference_no TEXT,
      description TEXT,
      debit_paisa INTEGER NOT NULL DEFAULT 0,
      credit_paisa INTEGER NOT NULL DEFAULT 0,
      running_balance_paisa INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_supplier_ledger_supplier_id ON supplier_ledger(supplier_id);

    -- 8. Stock Batches
    CREATE TABLE IF NOT EXISTS stock_batches (
      id TEXT PRIMARY KEY,
      medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
      batch_number TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      received_date TEXT NOT NULL,
      cost_price_paisa INTEGER NOT NULL DEFAULT 0,
      mrp_paisa INTEGER NOT NULL DEFAULT 0,
      quantity_smallest_unit INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'NEAR_EXPIRY', 'EXPIRED', 'QUARANTINE', 'DAMAGED', 'RETURNED')),
      supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
      supplier_name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_stock_batches_medicine_id ON stock_batches(medicine_id);
    CREATE INDEX IF NOT EXISTS idx_stock_batches_expiry ON stock_batches(expiry_date);
    CREATE INDEX IF NOT EXISTS idx_stock_batches_status ON stock_batches(status);

    -- 9. Stock Movements Audit
    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      medicine_id TEXT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
      batch_id TEXT REFERENCES stock_batches(id) ON DELETE SET NULL,
      movement_type TEXT NOT NULL CHECK(movement_type IN ('PURCHASE', 'SALE', 'RETURN_RESTOCK', 'ADJUSTMENT', 'WRITE_OFF', 'INITIAL')),
      quantity_smallest_units INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reference_id TEXT,
      notes TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_stock_movements_medicine_id ON stock_movements(medicine_id);

    -- 10. Purchases
    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      purchase_number TEXT UNIQUE NOT NULL,
      supplier_id TEXT NOT NULL REFERENCES suppliers(id),
      invoice_number TEXT NOT NULL,
      purchase_date TEXT NOT NULL,
      total_amount_paisa INTEGER NOT NULL DEFAULT 0,
      subtotal_amount_paisa INTEGER NOT NULL DEFAULT 0,
      discount_amount_paisa INTEGER NOT NULL DEFAULT 0,
      paid_amount_paisa INTEGER NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'CASH',
      payment_status TEXT NOT NULL DEFAULT 'PAID' CHECK(payment_status IN ('PAID', 'PARTIAL', 'CREDIT')),
      notes TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      is_voided INTEGER NOT NULL DEFAULT 0,
      voided_at INTEGER,
      voided_by TEXT,
      void_reason TEXT,
      created_at INTEGER NOT NULL
    );

    -- 11. Purchase Items
    CREATE TABLE IF NOT EXISTS purchase_items (
      id TEXT PRIMARY KEY,
      purchase_id TEXT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      unit_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      bonus_qty INTEGER NOT NULL DEFAULT 0,
      pack_size INTEGER NOT NULL DEFAULT 1,
      cost_per_pack_paisa INTEGER NOT NULL,
      total_cost_paisa INTEGER NOT NULL,
      mrp_paisa INTEGER NOT NULL DEFAULT 0,
      batch_number TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase_id ON purchase_items(purchase_id);

    -- 12. Customers
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      cnic TEXT,
      address TEXT,
      credit_limit_paisa INTEGER NOT NULL DEFAULT 0,
      current_balance_paisa INTEGER NOT NULL DEFAULT 0,
      store_credit_paisa INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

    -- 13. Customer Ledger
    CREATE TABLE IF NOT EXISTS customer_ledger (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('INVOICE', 'PAYMENT', 'RETURN')),
      reference_no TEXT NOT NULL,
      description TEXT,
      debit_paisa INTEGER NOT NULL DEFAULT 0,
      credit_paisa INTEGER NOT NULL DEFAULT 0,
      running_balance_paisa INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_customer_ledger_customer_id ON customer_ledger(customer_id);

    -- 14. Sales
    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      invoice_number TEXT UNIQUE NOT NULL,
      short_invoice_number TEXT NOT NULL,
      customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
      customer_name TEXT NOT NULL DEFAULT 'Walk-in Customer',
      customer_type TEXT NOT NULL DEFAULT 'WALK_IN',
      customer_phone TEXT,
      customer_whatsapp TEXT,
      customer_address TEXT,
      customer_notes TEXT,
      subtotal_paisa INTEGER NOT NULL,
      discount_paisa INTEGER NOT NULL DEFAULT 0,
      rounding_paisa INTEGER NOT NULL DEFAULT 0,
      total_paisa INTEGER NOT NULL,
      tendered_paisa INTEGER NOT NULL DEFAULT 0,
      change_paisa INTEGER NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL,
      cashier_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      cashier_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sales_invoice_number ON sales(invoice_number);
    CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at);

    -- 15. Sale Items
    CREATE TABLE IF NOT EXISTS sale_items (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      medicine_id TEXT NOT NULL REFERENCES medicines(id),
      medicine_name TEXT NOT NULL,
      generic_name TEXT NOT NULL,
      drug_class TEXT NOT NULL,
      unit_id TEXT,
      unit_name TEXT NOT NULL,
      conversion_factor INTEGER NOT NULL DEFAULT 1,
      quantity_in_unit INTEGER NOT NULL,
      mrp_paisa_per_unit INTEGER NOT NULL,
      cost_paisa_per_unit INTEGER,
      discount_percent REAL NOT NULL DEFAULT 0,
      line_total_paisa INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);

    -- 16. Sale Item Batch Allocations (FEFO Tracking)
    CREATE TABLE IF NOT EXISTS sale_item_batch_allocations (
      id TEXT PRIMARY KEY,
      sale_item_id TEXT NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
      batch_id TEXT NOT NULL REFERENCES stock_batches(id),
      batch_number TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      quantity_smallest_unit INTEGER NOT NULL,
      cost_price_paisa INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_allocations_item_id ON sale_item_batch_allocations(sale_item_id);

    -- 17. Sale Payments (Split / Multi-Payment)
    CREATE TABLE IF NOT EXISTS sale_payments (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      payment_method TEXT NOT NULL,
      provider_id TEXT,
      amount_paisa INTEGER NOT NULL,
      reference TEXT,
      created_at INTEGER NOT NULL
    );

    -- 18. Sale Returns
    CREATE TABLE IF NOT EXISTS sale_returns (
      id TEXT PRIMARY KEY,
      return_number TEXT UNIQUE NOT NULL,
      sale_id TEXT NOT NULL REFERENCES sales(id),
      invoice_number TEXT NOT NULL,
      customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      total_refund_paisa INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      auto_processed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- 19. Sale Return Items
    CREATE TABLE IF NOT EXISTS sale_return_items (
      id TEXT PRIMARY KEY,
      return_id TEXT NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
      sale_item_id TEXT NOT NULL REFERENCES sale_items(id),
      batch_id TEXT NOT NULL REFERENCES stock_batches(id),
      quantity_smallest_unit INTEGER NOT NULL,
      refund_paisa INTEGER NOT NULL,
      disposition TEXT NOT NULL DEFAULT 'RESTOCK' CHECK(disposition IN ('RESTOCK', 'QUARANTINE', 'WRITE_OFF')),
      created_at INTEGER NOT NULL
    );

    -- 20. Cash Transactions (Cash Book & Expenses)
    CREATE TABLE IF NOT EXISTS cash_transactions (
      id TEXT PRIMARY KEY,
      time TEXT NOT NULL,
      date TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      amount_paisa INTEGER NOT NULL,
      is_outflow INTEGER NOT NULL DEFAULT 0,
      handled_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cash_transactions_date ON cash_transactions(date);

    -- 21. Print Requests
    CREATE TABLE IF NOT EXISTS print_requests (
      id TEXT PRIMARY KEY,
      sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
      invoice_number TEXT NOT NULL,
      requested_by TEXT NOT NULL REFERENCES users(id),
      requested_by_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'APPROVED', 'REJECTED', 'CLAIMED')),
      reason TEXT NOT NULL,
      reviewed_by TEXT REFERENCES users(id),
      reviewed_at INTEGER,
      print_snapshot TEXT,
      request_key TEXT,
      note TEXT,
      printed_at INTEGER,
      created_at INTEGER NOT NULL
    );

    -- 22. Trash Bin Events
    CREATE TABLE IF NOT EXISTS trash_bin_events (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('product', 'supplier', 'user', 'purchase')),
      entity_id TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('deactivate', 'restore', 'void', 'permanent_delete')),
      reason TEXT NOT NULL,
      performed_by TEXT NOT NULL REFERENCES users(id),
      performed_by_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- 23. Audit Logs
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT REFERENCES users(id),
      actor_name TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at INTEGER NOT NULL
    );

    -- 24. Shop Settings (Singleton)
    CREATE TABLE IF NOT EXISTS shop_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      shop_name TEXT NOT NULL DEFAULT 'Pharma Care',
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      logo_path TEXT NOT NULL DEFAULT '',
      receipt_template TEXT NOT NULL DEFAULT 'memo',
      paper_size TEXT NOT NULL DEFAULT '80mm',
      memo_settings TEXT NOT NULL DEFAULT '{}',
      operational_settings TEXT NOT NULL DEFAULT '{}',
      approval_settings TEXT NOT NULL DEFAULT '{}',
      receipt_qr_settings TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    -- 25. License Store (Singleton)
    CREATE TABLE IF NOT EXISTS license_store (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      shop_id TEXT NOT NULL DEFAULT '',
      shop_name TEXT NOT NULL DEFAULT '',
      license_token TEXT NOT NULL DEFAULT '',
      hardware_id TEXT NOT NULL DEFAULT '',
      last_verified_online INTEGER NOT NULL DEFAULT 0,
      last_system_time INTEGER NOT NULL DEFAULT 0,
      offline_grace_seconds INTEGER NOT NULL DEFAULT 2592000,
      enabled_pages TEXT NOT NULL DEFAULT '["pos","products","categories","suppliers","customers","sales_history","purchase_history","purchases","expenses","stock_inventory","reports","manage_users","settings"]',
      enabled_features TEXT NOT NULL DEFAULT '["pos_print_sale","pos_print_payment","settings_shop_profile","settings_receipt_memo","settings_receipt_qr","settings_operations","settings_demo_data","settings_whatsapp_templates"]',
      status TEXT NOT NULL DEFAULT 'UNACTIVATED' CHECK(status IN ('UNACTIVATED', 'ACTIVE', 'WARNING', 'RESTRICTED'))
    );

    -- 26. User Sidebar & Preferences
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      favorite_pages TEXT NOT NULL DEFAULT '[]',
      tip_dismissed INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    -- Ensure singletons exist
    INSERT OR IGNORE INTO shop_settings (id, shop_name, updated_at)
    VALUES (1, 'Pharma Care', strftime('%s', 'now'));

    INSERT OR IGNORE INTO license_store (id, status)
    VALUES (1, 'UNACTIVATED');
  `);
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations (version, applied_at)
    VALUES (1, ?)
  `).run(Math.floor(Date.now() / 1000));

  const userTable = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'
  `).get() as { sql: string } | undefined;
  if (userTable && !userTable.sql.includes("'seller'")) {
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE users_with_seller (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            full_name TEXT,
            email TEXT,
            role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'seller', 'cashier', 'accountant')),
            permissions TEXT NOT NULL DEFAULT '[]',
            is_active INTEGER NOT NULL DEFAULT 1,
            deleted_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          INSERT INTO users_with_seller
            SELECT id, username, password_hash, full_name, email, role, permissions, is_active, deleted_at, created_at, updated_at
            FROM users;
          DROP TABLE users;
          ALTER TABLE users_with_seller RENAME TO users;
          CREATE INDEX idx_users_username ON users(username);
          CREATE INDEX idx_users_role ON users(role);
        `);
      }).immediate();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    db.prepare(`
      INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)
    `).run(Math.floor(Date.now() / 1000));
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length) throw new Error('The local user-role migration found invalid foreign-key references.');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS recovery_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      recovery_key_verifier TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations (version, applied_at)
    VALUES (3, ?)
  `).run(Math.floor(Date.now() / 1000));

  const printRequestColumns = new Set(
    (db.pragma('table_info(print_requests)') as Array<{ name: string }>).map((column) => column.name),
  );
  if (!printRequestColumns.has('request_key')) {
    db.exec('ALTER TABLE print_requests ADD COLUMN request_key TEXT');
  }
  if (!printRequestColumns.has('note')) {
    db.exec('ALTER TABLE print_requests ADD COLUMN note TEXT');
  }
  if (!printRequestColumns.has('printed_at')) {
    db.exec('ALTER TABLE print_requests ADD COLUMN printed_at INTEGER');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_print_requests_request_key ON print_requests(request_key)');
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations (version, applied_at)
    VALUES (4, ?)
  `).run(Math.floor(Date.now() / 1000));

  const unitColumns = new Set(
    (db.pragma('table_info(medicine_units)') as Array<{ name: string }>).map((column) => column.name),
  );
  if (!unitColumns.has('barcode')) {
    db.exec('ALTER TABLE medicine_units ADD COLUMN barcode TEXT');
  }
  const supplierColumns = new Set(
    (db.pragma('table_info(suppliers)') as Array<{ name: string }>).map((column) => column.name),
  );
  if (!supplierColumns.has('licence_or_tax_number')) {
    db.exec("ALTER TABLE suppliers ADD COLUMN licence_or_tax_number TEXT NOT NULL DEFAULT ''");
  }
  if (!supplierColumns.has('payment_terms')) {
    db.exec("ALTER TABLE suppliers ADD COLUMN payment_terms TEXT NOT NULL DEFAULT 'CASH'");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_categories_name ON categories(name COLLATE NOCASE)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_brands_name ON brands(name COLLATE NOCASE)');
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations (version, applied_at)
    VALUES (5, ?)
  `).run(Math.floor(Date.now() / 1000));

  const purchaseColumns = new Set(
    (db.pragma('table_info(purchases)') as Array<{ name: string }>).map((column) => column.name),
  );
  if (!purchaseColumns.has('subtotal_amount_paisa')) {
    db.exec('ALTER TABLE purchases ADD COLUMN subtotal_amount_paisa INTEGER NOT NULL DEFAULT 0');
  }
  if (!purchaseColumns.has('discount_amount_paisa')) {
    db.exec('ALTER TABLE purchases ADD COLUMN discount_amount_paisa INTEGER NOT NULL DEFAULT 0');
  }
  if (!purchaseColumns.has('payment_method')) {
    db.exec("ALTER TABLE purchases ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'CASH'");
  }
  const purchaseItemColumns = new Set(
    (db.pragma('table_info(purchase_items)') as Array<{ name: string }>).map((column) => column.name),
  );
  if (!purchaseItemColumns.has('bonus_qty')) {
    db.exec('ALTER TABLE purchase_items ADD COLUMN bonus_qty INTEGER NOT NULL DEFAULT 0');
  }
  if (!purchaseItemColumns.has('mrp_paisa')) {
    db.exec('ALTER TABLE purchase_items ADD COLUMN mrp_paisa INTEGER NOT NULL DEFAULT 0');
  }
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations (version, applied_at)
    VALUES (7, ?)
  `).run(Math.floor(Date.now() / 1000));
  const shopSettingsColumns = new Set(
    (db.pragma('table_info(shop_settings)') as Array<{ name: string }>).map((column) => column.name),
  );
  if (!shopSettingsColumns.has('receipt_qr_settings')) {
    db.exec("ALTER TABLE shop_settings ADD COLUMN receipt_qr_settings TEXT NOT NULL DEFAULT '{}'");
  }
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations (version, applied_at)
    VALUES (8, ?)
  `).run(Math.floor(Date.now() / 1000));
  const licenseColumns = new Set(
    (db.pragma('table_info(license_store)') as Array<{ name: string }>).map((column) => column.name),
  );
  if (!licenseColumns.has('enabled_pages')) {
    db.exec(`ALTER TABLE license_store ADD COLUMN enabled_pages TEXT NOT NULL DEFAULT '["pos","products","categories","suppliers","customers","sales_history","purchase_history","purchases","expenses","stock_inventory","reports","manage_users","settings"]'`);
  }
  if (!licenseColumns.has('enabled_features')) {
    db.exec(`ALTER TABLE license_store ADD COLUMN enabled_features TEXT NOT NULL DEFAULT '["pos_print_sale","pos_print_payment","settings_shop_profile","settings_receipt_memo","settings_receipt_qr","settings_operations","settings_demo_data","settings_whatsapp_templates"]'`);
  }
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations (version, applied_at)
    VALUES (9, ?)
  `).run(Math.floor(Date.now() / 1000));

  const medicineColumns = new Set(
    (db.pragma('table_info(medicines)') as Array<{ name: string }>).map((column) => column.name),
  );
  if (!medicineColumns.has('opening_stock_recorded')) {
    db.exec('ALTER TABLE medicines ADD COLUMN opening_stock_recorded INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`
    UPDATE medicines
    SET opening_stock_recorded = 1
    WHERE is_active = 1
       OR EXISTS (SELECT 1 FROM stock_batches WHERE stock_batches.medicine_id = medicines.id)
  `);
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations (version, applied_at)
    VALUES (10, ?)
  `).run(Math.floor(Date.now() / 1000));

  db.exec(`
    CREATE TABLE IF NOT EXISTS developer_announcements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      published_at TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      read_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_developer_announcements_published
      ON developer_announcements(published_at DESC);
  `);
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations (version, applied_at)
    VALUES (11, ?)
  `).run(Math.floor(Date.now() / 1000));

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_workflow_drafts (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workflow TEXT NOT NULL CHECK(workflow IN ('held-bills', 'purchase-drafts')),
      items TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, workflow)
    );
  `);
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations (version, applied_at)
    VALUES (12, ?)
  `).run(Math.floor(Date.now() / 1000));
}
