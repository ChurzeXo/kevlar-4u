import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { LicenseCredential, CredentialStore } from "./index.js";
import { CREDENTIAL_FILENAME, obfuscate, deobfuscate } from "./index.js";

function defaultCredentialPath(): string {
  return path.join(os.homedir(), CREDENTIAL_FILENAME);
}

export class FileCredentialStore implements CredentialStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? defaultCredentialPath();
  }

  async load(): Promise<LicenseCredential | null> {
    try {
      const content = await fs.promises.readFile(this.filePath, "utf-8");
      const json = deobfuscate(content.trim());
      if (!json) return null;
      return JSON.parse(json) as LicenseCredential;
    } catch {
      return null;
    }
  }

  loadSync(): LicenseCredential | null {
    try {
      const content = fs.readFileSync(this.filePath, "utf-8");
      const json = deobfuscate(content.trim());
      if (!json) return null;
      return JSON.parse(json) as LicenseCredential;
    } catch {
      return null;
    }
  }

  async save(credential: LicenseCredential): Promise<void> {
    const json = JSON.stringify(credential, null, 2);
    const encoded = obfuscate(json);
    await fs.promises.writeFile(this.filePath, encoded, { mode: 0o600 });
  }

  async clear(): Promise<void> {
    try {
      await fs.promises.unlink(this.filePath);
    } catch {
      // non-fatal
    }
  }
}
