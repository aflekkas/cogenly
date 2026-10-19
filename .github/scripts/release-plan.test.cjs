const { test } = require("node:test");
const assert = require("node:assert/strict");
const { releasePlan, assertProdVersionAdvances } = require("./release-plan.cjs");

test("each main run gets a staging version from the package next-version", () => {
  assert.deepEqual(
    releasePlan({ channel: "staging", packageVersion: "1.2.3", date: "20261019", runNumber: 42 }),
    {
      channel: "staging",
      version: "1.2.3-staging.20261019.42",
      tag: "v1.2.3-staging.20261019.42",
      environment: "staging",
    },
  );
});
test("promotion is pinned to an explicit staging tag with an optional prod version", () => {
  const input = { channel: "prod", stagingTag: "v1.2.3-staging.20261019.42" };
  assert.equal(releasePlan(input).version, "1.2.3");
  assert.equal(releasePlan({ ...input, version: "1.3.0" }).tag, "v1.3.0");
  for (const stagingTag of ["", "main", "v1.2.3", "v1.2.3-preview.20261019.42"]) {
    assert.throws(() => releasePlan({ ...input, stagingTag }));
  }
  for (const version of ["v1.2.3", "1.2.3-staging.1", "1.2.3\nx=1", "01.2.3"]) {
    assert.throws(() => releasePlan({ ...input, version }));
  }
});

test("prod versions advance latest instead of silently downgrading users", () => {
  assert.doesNotThrow(() => assertProdVersionAdvances("1.3.0", "v1.2.9"));
  assert.throws(() => assertProdVersionAdvances("1.2.9", "v1.2.9"));
  assert.throws(() => assertProdVersionAdvances("1.2.8", "v1.2.9"));
});
