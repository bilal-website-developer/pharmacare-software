export interface OfflineLicensePolicy {
  graceDays: number;
  warningDays: number;
}

export function normalizeOfflineLicensePolicy(
  graceDays: unknown,
  warningDays: unknown,
): OfflineLicensePolicy | null {
  if (
    !Number.isInteger(graceDays) || Number(graceDays) < 1 || Number(graceDays) > 365
    || !Number.isInteger(warningDays) || Number(warningDays) < 1 || Number(warningDays) > Number(graceDays)
  ) return null;
  return { graceDays: Number(graceDays), warningDays: Number(warningDays) };
}

export function defaultWarningDays(graceDays: number): number {
  return Math.min(14, graceDays);
}
