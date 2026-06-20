import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  NullProRuntimeLoader,
  MockProRuntimeLoader,
  DynamicImportProRuntimeLoader,
  resolveStrategyProvider,
} from "../execution/proRuntime.js";

describe("NullProRuntimeLoader", () => {
  it("returns null", async () => {
    const loader = new NullProRuntimeLoader();
    assert.equal(await loader.tryLoad(), null);
  });
});

describe("MockProRuntimeLoader", () => {
  it("returns a strategy provider", async () => {
    const loader = new MockProRuntimeLoader();
    const provider = await loader.tryLoad();
    assert.ok(provider);
    const plan = await provider!.getReviewPlan();
    assert.equal(plan.tier, "pro");
  });
});

describe("DynamicImportProRuntimeLoader", () => {
  it("returns null when package is not installed (no crash)", async () => {
    const loader = new DynamicImportProRuntimeLoader();
    const result = await loader.tryLoad();
    // @kevlar/pro-runtime is not installed, so this should return null gracefully
    assert.equal(result, null);
  });

  it("caches result on second call", async () => {
    const loader = new DynamicImportProRuntimeLoader();
    const first = await loader.tryLoad();
    const second = await loader.tryLoad();
    assert.equal(second, first);
  });

  it("reset clears cache", async () => {
    const loader = new DynamicImportProRuntimeLoader();
    await loader.tryLoad();
    loader.reset();
    const after = await loader.tryLoad();
    assert.equal(after, null);
  });
});

describe("resolveStrategyProvider", () => {
  it("returns FreeStrategyProvider when loader returns null", async () => {
    const provider = await resolveStrategyProvider(new NullProRuntimeLoader());
    const plan = await provider.getReviewPlan();
    assert.equal(plan.tier, "free");
  });

  it("returns Pro provider when loader returns mock", async () => {
    const provider = await resolveStrategyProvider(new MockProRuntimeLoader());
    const plan = await provider.getReviewPlan();
    assert.equal(plan.tier, "pro");
  });
});
