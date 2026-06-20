declare module "@kevlar/pro-runtime" {
  import type { StrategyProvider } from "./strategy.js";
  export function createProStrategyProvider(): Promise<StrategyProvider>;
}
