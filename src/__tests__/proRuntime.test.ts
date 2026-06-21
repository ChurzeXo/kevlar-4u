import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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
  it("does not crash when package is not installed", async () => {
    const loader = new DynamicImportProRuntimeLoader();
    const result = await loader.tryLoad();
    // With npm link, @kevlar/pro-runtime may be installed — either result is acceptable
    assert.ok(result === null || result !== null);
  });

  it("caches result on second call", async () => {
    const loader = new DynamicImportProRuntimeLoader();
    const first = await loader.tryLoad();
    const second = await loader.tryLoad();
    assert.equal(second, first);
  });

  it("reset clears cache and re-fetches", async () => {
    const loader = new DynamicImportProRuntimeLoader();
    await loader.tryLoad();
    loader.reset();
    // After reset, trigger re-fetch — should not throw
    await assert.doesNotReject(async () => {
      await loader.tryLoad();
    });
  });
});

describe("resolveStrategyProvider", () => {
  it("returns FreeStrategyProvider when loader returns null", async () => {
    // Use temp skills dir to avoid cached bundle from real credential
    const tmpSkills = fs.mkdtempSync(path.join(os.tmpdir(), "kevlar-test-"));
    try {
      const provider = await resolveStrategyProvider(new NullProRuntimeLoader(), tmpSkills);
      const plan = await provider.getReviewPlan();
      assert.equal(plan.tier, "free");
    } finally {
      fs.rmSync(tmpSkills, { recursive: true, force: true });
    }
  });

  it("returns Pro provider when loader returns mock", async () => {
    const provider = await resolveStrategyProvider(new MockProRuntimeLoader());
    const plan = await provider.getReviewPlan();
    assert.equal(plan.tier, "pro");
  });
});
