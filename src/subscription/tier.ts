import { readConfig } from "../execution/config.js";
import { FileCredentialStore } from "../credential/store.js";

let credentialCache: boolean | undefined;

function hasLicenseCredential(): boolean {
  if (credentialCache !== undefined) return credentialCache;
  try {
    const store = new FileCredentialStore();
    const cred = store.loadSync();
    credentialCache = cred !== null && cred.licenseKey.length > 0;
  } catch {
    credentialCache = false;
  }
  return credentialCache;
}

export function invalidateCredentialCache(): void {
  credentialCache = undefined;
}

export function isPro(credentialPath?: string): boolean {
  if (process.env.KEVLAR_TIER === "pro") return true;
  if (process.env.KEVLAR_PRO_TOKEN) return true;
  if (readConfig().sync_token) return true;
  return hasLicenseCredential();
}

export function isProWithStore(store: { loadSync(): { licenseKey: string } | null }): boolean {
  if (process.env.KEVLAR_TIER === "pro") return true;
  if (process.env.KEVLAR_PRO_TOKEN) return true;
  if (readConfig().sync_token) return true;
  const cred = store.loadSync();
  return cred !== null && cred.licenseKey.length > 0;
}
