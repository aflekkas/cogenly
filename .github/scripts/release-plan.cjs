const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const STAGING_TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-staging\.\d{8}\.\d+$/;

function releasePlan({ channel, packageVersion, stagingTag, version, date, runNumber }) {
  if (channel === "prod") {
    const match = STAGING_TAG.exec(stagingTag || "");
    if (!match) throw new Error("Promotion requires an explicit vX.Y.Z-staging.YYYYMMDD.run tag.");
    const resolved = version || match[1];
    if (!VERSION.test(resolved))
      throw new Error("Prod version must be X.Y.Z without a prefix or prerelease.");
    return { channel, version: resolved, tag: `v${resolved}`, environment: "production" };
  }
  if (channel !== "staging" || !VERSION.test(packageVersion)) {
    throw new Error("Staging requires an X.Y.Z next-version in apps/desktop/package.json.");
  }
  if (!/^\d{8}$/.test(date) || !/^\d+$/.test(String(runNumber)))
    throw new Error("Invalid staging date/run.");
  const resolved = `${packageVersion}-staging.${date}.${runNumber}`;
  return { channel, version: resolved, tag: `v${resolved}`, environment: "staging" };
}

function assertProdVersionAdvances(version, latestTag) {
  const previous = latestTag.replace(/^v/, "");
  if (!VERSION.test(previous)) throw new Error("Latest prod release must have a vX.Y.Z tag.");
  const left = version.split(".").map(Number);
  const right = previous.split(".").map(Number);
  const difference =
    left.map((value, index) => value - right[index]).find((value) => value !== 0) || 0;
  if (difference <= 0)
    throw new Error(
      "Prod version must advance the latest release. Ship a forward fix to roll back.",
    );
}

module.exports = { releasePlan, assertProdVersionAdvances };
