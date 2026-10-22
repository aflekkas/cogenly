const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// A short or full commit SHA, or `main` for the branch head. Nothing else is
// accepted, so the input never names an arbitrary branch or tag.
const SOURCE_REF = /^(main|[0-9a-f]{7,40})$/;

function assertSourceRef(ref) {
  if (!SOURCE_REF.test(ref || ""))
    throw new Error("ref must be main or a 7-40 character commit SHA on main.");
  return ref;
}

// Release publishes prod only; apps/desktop/package.json holds the next version.
function releasePlan({ packageVersion, version }) {
  if (!VERSION.test(packageVersion || "")) {
    throw new Error("apps/desktop/package.json must hold an X.Y.Z next-version.");
  }
  const resolved = version || packageVersion;
  if (!VERSION.test(resolved))
    throw new Error("Prod version must be X.Y.Z without a prefix or prerelease.");
  return { version: resolved, tag: `v${resolved}` };
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

module.exports = { releasePlan, assertProdVersionAdvances, assertSourceRef };
