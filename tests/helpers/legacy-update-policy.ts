import Module, { createRequire } from "node:module";
import { afterAll } from "vitest";

const require = createRequire(import.meta.url);

/** Exercise retained OTA protocol/signature logic without enabling it in the shipped product. */
export function allowLegacyUpdatesForProtocolTests() {
  const policyPath = require.resolve("../../packages/shared/distribution-policy.cjs");
  const original = require.cache[policyPath];
  const realPolicy = require(policyPath);
  const stub = new Module(policyPath);
  stub.exports = {
    ...realPolicy,
    isLocalManagedDistribution: () => false,
    assertRemoteUpdatesAllowed: () => {},
  };
  stub.loaded = true;
  require.cache[policyPath] = stub;
  afterAll(() => {
    if (original) require.cache[policyPath] = original;
    else delete require.cache[policyPath];
  });
}
