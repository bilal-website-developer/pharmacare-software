import { verify } from 'node:crypto';

export interface SignedUpdateManifest {
  version: string;
  downloadUrl: string;
  sha512: string;
  signature: string;
}

function isStableVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value);
}

function signedPayload(manifest: Pick<SignedUpdateManifest, 'version' | 'downloadUrl' | 'sha512'>): string {
  return JSON.stringify({
    version: manifest.version,
    downloadUrl: manifest.downloadUrl,
    sha512: manifest.sha512,
  });
}

export function parseAndVerifyUpdateManifest(
  input: unknown,
  publicKey: string,
): SignedUpdateManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('The update manifest is not an object.');
  }
  const manifest = input as Record<string, unknown>;
  if (
    typeof manifest.version !== 'string'
    || !isStableVersion(manifest.version)
    || typeof manifest.downloadUrl !== 'string'
    || typeof manifest.sha512 !== 'string'
    || !/^[A-Za-z0-9+/]{86}==$/.test(manifest.sha512)
    || typeof manifest.signature !== 'string'
    || !/^[A-Za-z0-9_-]+$/.test(manifest.signature)
  ) {
    throw new TypeError('The update manifest fields are invalid.');
  }
  let downloadUrl: URL;
  try {
    downloadUrl = new URL(manifest.downloadUrl);
  } catch {
    throw new TypeError('The update download URL is invalid.');
  }
  if (downloadUrl.protocol !== 'https:' || downloadUrl.username || downloadUrl.password) {
    throw new TypeError('The update download must use a credential-free HTTPS URL.');
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(manifest.signature, 'base64url');
  } catch {
    throw new TypeError('The update signature is invalid.');
  }
  if (!verify(
    null,
    Buffer.from(signedPayload({
      version: manifest.version,
      downloadUrl: manifest.downloadUrl,
      sha512: manifest.sha512,
    })),
    publicKey,
    signature,
  )) {
    throw new Error('The update manifest signature could not be verified.');
  }
  return {
    version: manifest.version,
    downloadUrl: manifest.downloadUrl,
    sha512: manifest.sha512,
    signature: manifest.signature,
  };
}

export function isNewerStableVersion(candidate: string, current: string): boolean {
  if (!isStableVersion(candidate) || !isStableVersion(current)) return false;
  const next = candidate.split('.').map(Number);
  const installed = current.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}
