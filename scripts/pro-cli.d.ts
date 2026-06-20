declare module "../src/pro/credentialCli.js" {
  export function runActivate(code?: string): Promise<void>;
  export function runStatus(): void;
  export function runLogout(): Promise<void>;
  export function runDoctor(): Promise<void>;
  export function runSync(): Promise<void>;
}
