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

// Linux server archives every release attaches. The names are what
// packages/shared/src/cliRelease.ts, the desktop SSH runner, and
// scripts/install.sh download, so a rename here breaks every installer.
const CLI_ARCHIVE_PLATFORMS = ["linux-x64", "linux-arm64"];

function cliArchiveAssets(version) {
  return CLI_ARCHIVE_PLATFORMS.map((platform) => `t3-${version}-${platform}.tar.gz`);
}

// Each build job writes a sha256sum file for its own assets. The release gets
// one SHA256SUMS, with bare file names: installers match ` <name>` at the end
// of a line, so a `./` prefix would hide an archive from them.
function mergeChecksums(texts) {
  const entries = new Map();
  for (const text of texts) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const match = /^([0-9a-fA-F]{64})\s+\*?(?:\.\/)?(\S.*)$/.exec(line);
      if (!match) throw new Error(`Not a checksum line: ${line}`);
      const [, digest, name] = match;
      const previous = entries.get(name);
      if (previous && previous !== digest.toLowerCase())
        throw new Error(`${name} has two different checksums.`);
      entries.set(name, digest.toLowerCase());
    }
  }
  return [...entries]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, digest]) => `${digest}  ${name}\n`)
    .join("");
}

function assertReleaseAssets(checksums, version) {
  const listed = new Set(checksums.split("\n").map((line) => line.slice(66)));
  const missing = cliArchiveAssets(version).filter((name) => !listed.has(name));
  if (missing.length > 0) throw new Error(`SHA256SUMS lacks ${missing.join(", ")}.`);
}

// Release notes come from the non-merge commit subjects since the previous
// prod tag, newest first; a merged PR's commits count, its merge commit does not. Conventional `type(scope): subject` lines are grouped for users;
// build, CI and test noise is left out. The app's Updates popover reads these
// `## Group` headings and bullets, and stops at `## Build`.
const NOTE_GROUPS = [
  { title: "New", types: ["feat"], more: "new features" },
  { title: "Fixes", types: ["fix"], more: "fixes" },
  { title: "Improvements", types: ["perf", null], more: "improvements" },
];
// A big release lists the newest entries of each group and counts the rest.
const MAX_NOTES_PER_GROUP = 15;
const SKIPPED_TYPES = new Set([
  "build",
  "chore",
  "ci",
  "docs",
  "refactor",
  "revert",
  "style",
  "test",
]);
const SKIPPED_SCOPES = new Set(["ci", "deps", "release"]);
const CONVENTIONAL = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.+)$/;

function releaseNoteEntry(subject) {
  const line = subject.trim();
  if (!line || /^merge\b/i.test(line)) return null;
  const match = CONVENTIONAL.exec(line);
  const type = match ? match[1] : null;
  const scopes = match && match[2] ? match[2].split(",").map((scope) => scope.trim()) : [];
  if (type && SKIPPED_TYPES.has(type)) return null;
  if (scopes.some((scope) => SKIPPED_SCOPES.has(scope))) return null;
  const text = (match ? match[3] : line).replace(/\s*\(#\d+\)$/, "").trim();
  if (!text) return null;
  // Plain subjects and unfamiliar types read as general improvements.
  const group =
    NOTE_GROUPS.find((candidate) => candidate.types.includes(type)) ||
    NOTE_GROUPS.find((candidate) => candidate.types.includes(null));
  return { group: group.title, text: text[0].toUpperCase() + text.slice(1) };
}

function renderReleaseNotes(subjects) {
  const seen = new Set();
  const grouped = new Map(NOTE_GROUPS.map((group) => [group.title, []]));
  for (const subject of subjects) {
    const entry = releaseNoteEntry(subject);
    if (!entry || seen.has(entry.text.toLowerCase())) continue;
    seen.add(entry.text.toLowerCase());
    grouped.get(entry.group).push(entry.text);
  }
  const sections = NOTE_GROUPS.filter((group) => grouped.get(group.title).length > 0).map(
    (group) => {
      const items = grouped.get(group.title);
      const shown = items.slice(0, MAX_NOTES_PER_GROUP).map((item) => `- ${item}`);
      if (items.length > MAX_NOTES_PER_GROUP) {
        shown.push(`- And ${items.length - MAX_NOTES_PER_GROUP} more ${group.more}`);
      }
      return `## ${group.title}\n\n${shown.join("\n")}\n`;
    },
  );
  return sections.length > 0
    ? sections.join("\n")
    : "## Improvements\n\n- Behind-the-scenes maintenance\n";
}

module.exports = {
  cliArchiveAssets,
  mergeChecksums,
  assertReleaseAssets,
  releasePlan,
  assertProdVersionAdvances,
  assertSourceRef,
  renderReleaseNotes,
};
