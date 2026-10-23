/** Fixed adapters: never accept arbitrary env names, commands, args or native credential files. */
export const cliAdapters = {
  cloudflare: {
    command: "wrangler",
    args: ["whoami"],
    tokenVariable: "CLOUDFLARE_API_TOKEN",
    setupUrl: "https://dash.cloudflare.com/profile/api-tokens",
    instructions:
      "Create a scoped Cloudflare API token. For an existing Worker, grant that Worker's Editor access; add zone Workers Routes Write only when changing routes or custom domains.",
  },
  github: {
    command: "gh",
    args: ["auth", "status"],
    tokenVariable: "GH_TOKEN",
    setupUrl: "https://github.com/settings/personal-access-tokens",
    instructions:
      "Create a fine-grained GitHub token for the repositories and permissions this task needs.",
  },
} as const;
export type CliService = keyof typeof cliAdapters;
export const cliAdapter = (service: string) =>
  service === "cloudflare" || service === "github" ? cliAdapters[service] : undefined;

/** Authentication succeeds independently of permission for a later deployment. Never return CLI output. */
export const verificationState = (input: {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}) => {
  const output = `${input.stdout}\n${input.stderr}`.toLowerCase();
  if (
    input.timedOut ||
    /enotfound|econn|network|fetch failed|timed? ?out|dns|tls|certificate|service unavailable|502|503/.test(
      output,
    )
  )
    return "network_failure" as const;
  if (/expired/.test(output)) return "expired" as const;
  if (/insufficient|forbidden|missing.*scope|permission denied|403/.test(output))
    return "insufficient_scope" as const;
  if (input.code === 0) return "verified" as const;
  return "invalid" as const;
};
