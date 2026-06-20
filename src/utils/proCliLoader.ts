import type { PathLike } from "node:fs";

export interface ProCliModule {
  runActivate(code?: string): Promise<void>;
  runStatus(): void;
  runLogout(): Promise<void>;
  runDoctor(): Promise<void>;
  runSync(): Promise<void>;
}

export async function getProCli(): Promise<ProCliModule | null> {
  try {
    // Dynamic path resolved relative to this file at runtime
    return await import("../pro/credentialCli.js") as ProCliModule;
  } catch {
    return null;
  }
}
