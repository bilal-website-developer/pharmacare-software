export function canViewCost(role: string, permissions: string[] = []): boolean {
  if (role === 'admin' || role === 'manager') return true;
  if (role === 'accountant') {
    return permissions.includes('purchase_history') || permissions.includes('reports');
  }
  // Cashiers are strictly denied access to cost prices, purchase costs, and profit calculations
  return false;
}

export function redactProductCost<T extends { cost_price_paisa?: number | null; costPaisaPerUnit?: number | null }>(
  product: T,
  role: string,
  permissions: string[] = []
): T {
  if (canViewCost(role, permissions)) return product;

  return {
    ...product,
    cost_price_paisa: null,
    costPaisaPerUnit: null,
  };
}

export function redactSaleCost<T extends { cost_paisa_per_unit?: number | null; costPaisaPerUnit?: number | null }>(
  item: T,
  role: string,
  permissions: string[] = []
): T {
  if (canViewCost(role, permissions)) return item;

  return {
    ...item,
    cost_paisa_per_unit: null,
    costPaisaPerUnit: null,
  };
}
