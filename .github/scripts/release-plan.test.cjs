const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  cliArchiveAssets,
  mergeChecksums,
  assertReleaseAssets,
  releasePlan,
  assertProdVersionAdvances,
  assertSourceRef,
  renderReleaseNotes,
} = require("./release-plan.cjs");

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

test("release notes group user-facing commits and drop build noise", () => {
  const notes = renderReleaseNotes([
    "feat(desktop): on-device voice dictation in the composer",
    "fix(server): recover Claude turns whose resume session is missing",
    "fix(web): the toast's close control is a quiet ghost × inside the card (#12)",
    "perf(web): opening the right panel restyles the list column once",
    "Name the prod desktop app plain Cogenly",
    "chore: bump deps",
    "ci: cache pnpm",
    "test(scripts): read the entitlements file through Effect FileSystem",
    "refactor(web): remove the floating preview mini player",
    "fix(ci): retry the registry fetch",
    "feat(release)!: publish prod only",
    "Merge branch 'main' into feature",
    "feat(desktop): on-device voice dictation in the composer",
    "",
  ]);
  assert.equal(
    notes,
    [
      "## New",
      "",
      "- On-device voice dictation in the composer",
      "",
      "## Fixes",
      "",
      "- Recover Claude turns whose resume session is missing",
      "- The toast's close control is a quiet ghost × inside the card",
      "",
      "## Improvements",
      "",
      "- Opening the right panel restyles the list column once",
      "- Name the prod desktop app plain Cogenly",
      "",
    ].join("\n"),
  );
  assert.equal(
    renderReleaseNotes(["ci: cache pnpm", "chore: tidy"]),
    "## Improvements\n\n- Behind-the-scenes maintenance\n",
  );
});

test("a big release lists the newest entries per group and counts the rest", () => {
  const fixes = Array.from({ length: 20 }, (_, index) => `fix(web): repair ${index + 1}`);
  const notes = renderReleaseNotes(["feat: one thing", ...fixes]);
  const bullets = notes.split("## Fixes")[1].trim().split("\n");
  assert.equal(bullets.length, 16);
  assert.equal(bullets[0], "- Repair 1");
  assert.equal(bullets[14], "- Repair 15");
  assert.equal(bullets[15], "- And 5 more fixes");
  assert.match(notes, /^## New\n\n- One thing\n/);
});

test("every release names the Linux server archives the installers download", () => {
  assert.deepEqual(cliArchiveAssets("1.2.3"), [
    "t3-1.2.3-linux-x64.tar.gz",
    "t3-1.2.3-linux-arm64.tar.gz",
  ]);
});

test("per-job checksum files merge into one SHA256SUMS with bare names", () => {
  const mac = `${"a".repeat(64)}  ./Cogenly-1.2.3-arm64.zip\n${"b".repeat(64)}  ./latest-mac.yml\n`;
  const x64 = `${"C".repeat(64)}  t3-1.2.3-linux-x64.tar.gz\n`;
  const arm = `${"d".repeat(64)} *t3-1.2.3-linux-arm64.tar.gz\n`;
  const merged = mergeChecksums([mac, x64, arm]);
  assert.equal(
    merged,
    [
      `${"a".repeat(64)}  Cogenly-1.2.3-arm64.zip`,
      `${"b".repeat(64)}  latest-mac.yml`,
      `${"d".repeat(64)}  t3-1.2.3-linux-arm64.tar.gz`,
      `${"c".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
      "",
    ].join("\n"),
  );
  assert.doesNotThrow(() => assertReleaseAssets(merged, "1.2.3"));
  assert.throws(() => assertReleaseAssets(mergeChecksums([mac, x64]), "1.2.3"), /linux-arm64/);
  assert.throws(() => mergeChecksums([x64, `${"e".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`]));
  assert.throws(() => mergeChecksums(["not a checksum"]));
});
