// Builds native/speech-helper (on-device dictation) with swiftc.
//
//   node build-speech-helper.mjs [--arch arm64|x64|universal] [--output <file>] [--require]
//
// Dev launchers run it best-effort: off macOS, or without a Swift 6.2 toolchain, it
// prints why and exits 0, and the composer hides dictation. Packaging passes
// --require so a release can never ship without the helper. Set
// COGENLY_SPEECH_DEVELOPER_DIR to compile with a specific Xcode (CI's default Xcode is
// older than the macOS 26 SDK the engine needs).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// oxlint-disable-next-line t3code/no-global-process-runtime -- The native compiler targets the actual host; this script has no Effect runtime.
const hostArch = process.arch;
// oxlint-disable-next-line t3code/no-global-process-runtime -- Native compilation only runs on the actual macOS host.
const hostPlatform = process.platform;

const { values } = NodeUtil.parseArgs({
  options: {
    output: { type: "string" },
    arch: { type: "string", default: hostArch },
    require: { type: "boolean", default: false },
  },
});

const MINIMUM_SWIFT = [6, 2];
// Electron's own floor. The binary reports "unavailable" below macOS 26.
const DEPLOYMENT_TARGET = "12.0";
const SWIFT_TARGETS = { arm64: ["arm64"], x64: ["x86_64"], universal: ["arm64", "x86_64"] };

function skip(reason) {
  if (values.require) throw new Error(`Cannot build the speech helper: ${reason}`);
  console.warn(`[speech-helper] Skipped: ${reason} Dictation will be unavailable.`);
  process.exit(0);
}

if (hostPlatform !== "darwin") skip("it only builds on macOS.");
const targets = SWIFT_TARGETS[values.arch];
if (targets === undefined) throw new Error(`Unsupported macOS architecture: ${values.arch}`);

const root = NodeURL.fileURLToPath(new URL("../../../native/speech-helper/", import.meta.url));
const source = NodePath.resolve(root, "main.swift");
const output = values.output ?? NodePath.resolve(root, "build", values.arch, "cogenly-speech");

const developerDir = process.env.COGENLY_SPEECH_DEVELOPER_DIR?.trim();
const env = developerDir ? { ...process.env, DEVELOPER_DIR: developerDir } : process.env;
const xcrun = (args, options = {}) =>
  NodeChildProcess.execFileSync("xcrun", args, { env, encoding: "utf8", ...options });

let current = false;
try {
  current =
    NodeFS.statSync(output).mtimeMs >=
    Math.max(
      NodeFS.statSync(source).mtimeMs,
      NodeFS.statSync(NodeURL.fileURLToPath(import.meta.url)).mtimeMs,
    );
} catch {
  /* The first build has no output yet. */
}

if (!current) {
  let version;
  try {
    version = xcrun(["swiftc", "--version"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    skip("swiftc was not found (install the Xcode command line tools).");
  }
  const match = /Swift version (\d+)\.(\d+)/.exec(version);
  const [major, minor] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  if (major < MINIMUM_SWIFT[0] || (major === MINIMUM_SWIFT[0] && minor < MINIMUM_SWIFT[1])) {
    skip(
      `Swift ${MINIMUM_SWIFT.join(".")} (Xcode 26) is required, found ${major}.${minor}. Set COGENLY_SPEECH_DEVELOPER_DIR to an Xcode 26 Developer directory.`,
    );
  }

  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  const temporaries = targets.map((arch) => `${output}.${arch}.${process.pid}.tmp`);
  try {
    targets.forEach((arch, index) => {
      xcrun(
        [
          "swiftc",
          "-O",
          "-parse-as-library",
          "-target",
          `${arch}-apple-macos${DEPLOYMENT_TARGET}`,
          source,
          "-o",
          temporaries[index],
        ],
        { stdio: "inherit" },
      );
    });
    if (temporaries.length === 1) {
      NodeFS.renameSync(temporaries[0], output);
    } else {
      xcrun(["lipo", "-create", ...temporaries, "-output", output], { stdio: "inherit" });
    }
    NodeFS.chmodSync(output, 0o755);
  } finally {
    for (const temporary of temporaries) NodeFS.rmSync(temporary, { force: true });
  }
  console.log(`[speech-helper] Built ${NodePath.relative(process.cwd(), output)}`);
}
