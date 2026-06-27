import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  setClientCapabilities,
  isSamplingSupported,
  isTaskAugmentedSamplingSupported,
  isTaskCancelSupported,
  getHostExecutionCapability,
  setClientInfo,
} from "../execution/client.js";
import {
  CAP_SAMPLING_SERIAL,
  CAP_SAMPLING_TASK_AUGMENTED,
  CAP_TASKS_CANCEL,
  CAP_FULL_CLIENT,
  CAP_NONE,
} from "./fixtures/client-capabilities.js";

describe("Capability Detection — per audit-hybrid-execution.md", () => {
  beforeEach(() => {
    setClientInfo("TestClient", "1.0.0");
  });

  afterEach(() => {
    setClientCapabilities(null);
  });

  describe("isSamplingSupported", () => {
    it("CAP_SAMPLING_SERIAL → true (has sampling)", () => {
      setClientCapabilities(CAP_SAMPLING_SERIAL as any);
      assert.equal(isSamplingSupported(), true);
    });

    it("CAP_SAMPLING_TASK_AUGMENTED → true (has sampling)", () => {
      setClientCapabilities(CAP_SAMPLING_TASK_AUGMENTED as any);
      assert.equal(isSamplingSupported(), true);
    });

    it("CAP_NONE → false", () => {
      setClientCapabilities(CAP_NONE as any);
      assert.equal(isSamplingSupported(), false);
    });
  });

  describe("isTaskAugmentedSamplingSupported", () => {
    it("CAP_SAMPLING_SERIAL → false (no tasks.requests.sampling.createMessage)", () => {
      setClientCapabilities(CAP_SAMPLING_SERIAL as any);
      assert.equal(isTaskAugmentedSamplingSupported(), false);
    });

    it("CAP_SAMPLING_TASK_AUGMENTED → true", () => {
      setClientCapabilities(CAP_SAMPLING_TASK_AUGMENTED as any);
      assert.equal(isTaskAugmentedSamplingSupported(), true);
    });

    it("CAP_FULL_CLIENT → true", () => {
      setClientCapabilities(CAP_FULL_CLIENT as any);
      assert.equal(isTaskAugmentedSamplingSupported(), true);
    });

    it("CAP_NONE → false", () => {
      setClientCapabilities(CAP_NONE as any);
      assert.equal(isTaskAugmentedSamplingSupported(), false);
    });
  });

  describe("isTaskCancelSupported", () => {
    it("CAP_TASKS_CANCEL → true", () => {
      setClientCapabilities(CAP_TASKS_CANCEL as any);
      assert.equal(isTaskCancelSupported(), true);
    });

    it("CAP_SAMPLING_TASK_AUGMENTED (no cancel) → false", () => {
      setClientCapabilities(CAP_SAMPLING_TASK_AUGMENTED as any);
      assert.equal(isTaskCancelSupported(), false);
    });

    it("CAP_FULL_CLIENT → true", () => {
      setClientCapabilities(CAP_FULL_CLIENT as any);
      assert.equal(isTaskCancelSupported(), true);
    });

    it("CAP_NONE → false", () => {
      setClientCapabilities(CAP_NONE as any);
      assert.equal(isTaskCancelSupported(), false);
    });
  });

  describe("Capability independence (per spec: cancel is NOT bundled)", () => {
    it("task-augmented WITHOUT cancel → isTaskCancelSupported is false", () => {
      setClientCapabilities(CAP_SAMPLING_TASK_AUGMENTED as any);
      assert.equal(isTaskAugmentedSamplingSupported(), true);
      assert.equal(isTaskCancelSupported(), false);
    });

    it("cancel WITHOUT task-augmented → isTaskCancelSupported is true, isTaskAugmentedSamplingSupported is false", () => {
      setClientCapabilities(CAP_TASKS_CANCEL as any);
      assert.equal(isTaskCancelSupported(), true);
      assert.equal(isTaskAugmentedSamplingSupported(), false);
    });
  });

  describe("getHostExecutionCapability (Kevlar experimental)", () => {
    it("CAP_FULL_CLIENT → returns capability object", () => {
      setClientCapabilities(CAP_FULL_CLIENT as any);
      const cap = getHostExecutionCapability();
      assert.ok(cap);
      assert.equal(cap!.version, "1.0.0");
      assert.equal(cap!.ephemeralAgents?.supported, true);
    });

    it("CAP_SAMPLING_SERIAL (no experimental) → returns null", () => {
      setClientCapabilities(CAP_SAMPLING_SERIAL as any);
      const cap = getHostExecutionCapability();
      assert.equal(cap, null);
    });
  });
});
