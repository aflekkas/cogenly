const { test } = require("node:test");
const assert = require("node:assert/strict");
const { releasePlan, assertProdVersionAdvances, assertSourceRef } = require("./release-plan.cjs");

test("prod defaults to the package next-version with an optional override", () => {
  const input = { packageVersion: "1.2.3" };
  assert.deepEqual(releasePlan(input), { version: "1.2.3", tag: "v1.2.3" });
  assert.equal(releasePlan({ ...input, version: "1.3.0" }).tag, "v1.3.0");
  for (const version of ["v1.2.3", "1.2.3-staging.1", "1.2.3\nx=1", "01.2.3"]) {
    assert.throws(() => releasePlan({ ...input, version }));
  }
  for (const packageVersion of ["", "1.2", "1.2.3-staging.1"]) {
    assert.throws(() => releasePlan({ ...input, packageVersion }));
  }
});

test("the source ref is main or a commit SHA, never another ref", () => {
  for (const ref of ["main", "a84c508", "a84c508f".padEnd(40, "0")]) {
    assert.equal(assertSourceRef(ref), ref);
  }
  for (const ref of [
    "",
    "HEAD",
    "a84c50",
    "v1.2.3",
    "feature",
    "-x",
    "A84C508",
    "main~1",
    "a".repeat(41),
  ]) {
    assert.throws(() => assertSourceRef(ref));
  }
});

test("prod versions advance latest instead of silently downgrading users", () => {
  assert.doesNotThrow(() => assertProdVersionAdvances("1.3.0", "v1.2.9"));
  assert.throws(() => assertProdVersionAdvances("1.2.9", "v1.2.9"));
  assert.throws(() => assertProdVersionAdvances("1.2.8", "v1.2.9"));
});
