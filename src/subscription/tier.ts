import { readConfig } from "../execution/config.js";

let credentialCache: boolean | undefined;
let triedCredentialStore = false;

async function tryCredentialCheck(): Promise<boolean> {
  if (triedCredentialStore) return credentialCache ?? false;
  triedCredentialStore = true;
  try {
    const { FileCredentialStore } = await import("../pro/credential/store.js");
    const store = new FileCredentialStore();
    const cred = store.loadSync();
    credentialCache = cred !== null && cred.licenseKey.length > 0;
  } catch {
    credentialCache = false;
  }
  return credentialCache ?? false;
}

let credentialPromise: Promise<boolean> | null = null;

function hasLicenseCredential(): boolean {
  if (credentialCache !== undefined && triedCredentialStore) return credentialCache;
  if (!triedCredentialStore) {
    if (!credentialPromise) {
      credentialPromise = tryCredentialCheck();
    }
    return false;
  }
  return credentialCache ?? false;
}

export function invalidateCredentialCache(): void {
  credentialCache = undefined;
  triedCredentialStore = false;
  credentialPromise = null;
}

export function isPro(_credentialPath?: string): boolean {
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

export async function isProAsync(): Promise<boolean> {
  if (process.env.KEVLAR_TIER === "pro") return true;
  if (process.env.KEVLAR_PRO_TOKEN) return true;
  if (readConfig().sync_token) return true;
  return tryCredentialCheck();
}
