// Fails when user-facing markdown contains an em dash. Strings and JSX text in code are covered by
// the t3code/no-em-dash-in-copy lint rule; this covers the prose oxlint does not parse.
//
//   node scripts/check-copy-dashes.ts
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const COPY_MARKDOWN = [
  "README.md",
  "docs/user/**/*.md",
  "apps/marketing/**/*.md",
  "apps/marketing/**/*.mdx",
];
const EM_DASH_PATTERN = /\u2014|&mdash;|&#8212;|&#x2014;/iu;

const files = NodeChildProcess.execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...COPY_MARKDOWN.map((glob) => `:(glob)${glob}`),
  ],
  { encoding: "utf8" },
)
  .split("\n")
  .filter((file) => file !== "" && NodeFS.existsSync(file));

const findings: string[] = [];
for (const file of files) {
  NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (EM_DASH_PATTERN.test(line)) findings.push(`${file}:${index + 1}: ${line.trim()}`);
    });
}

if (findings.length > 0) {
  console.error(
    `Copy never uses an em dash. Rewrite these with a comma, colon, period or parentheses:\n${findings.join("\n")}`,
  );
  process.exit(1);
}
console.log(`No em dashes in ${files.length} copy markdown files.`);
