import { readConfig } from "../execution/config.js";

export function isPro(): boolean {
  if (process.env.KEVLAR_TIER === "pro") return true;
  if (process.env.KEVLAR_PRO_TOKEN) return true;
  return !!readConfig().sync_token;
}
