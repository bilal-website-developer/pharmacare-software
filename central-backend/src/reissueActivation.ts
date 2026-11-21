import { createActivationCode, hashActivationCode } from './licensingCrypto.js';

export interface PersistReplacementActivation {
  shopId: string;
  activationHash: string;
  expiresAt: string;
}

export async function issueReplacementActivation(
  shopId: string,
  expiresAt: string,
  persist: (activation: PersistReplacementActivation) => Promise<string | null>,
): Promise<{ activationCode: string; activationId: string } | null> {
  const activationCode = createActivationCode();
  const activationId = await persist({
    shopId,
    activationHash: hashActivationCode(activationCode),
    expiresAt,
  });
  if (!activationId) return null;
  return { activationCode, activationId };
}
