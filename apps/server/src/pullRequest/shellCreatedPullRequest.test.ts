import { describe, expect, it } from "vite-plus/test";
import { shellCreatedPullRequest } from "./shellCreatedPullRequest.ts";
const url = "https://github.com/acme/app/pull/42";
describe("shell-created pull requests", () => {
  it.each([
    "gh pr create --title 'Fix app'",
    "cd app && gh pr create --body-file /tmp/body",
    "GH_HOST=github.com env gh pr create",
    "timeout 60 gh pr create",
    "/bin/zsh -lc 'gh pr create --title \"Fix app\"'",
    "cat <<'BODY'\nExample: gh pr list\nBODY\ngh pr create --body-file /tmp/body",
  ])("recognizes %s", (input) =>
    expect(shellCreatedPullRequest(input, `Creating pull request...\n${url}\n`)).toEqual({
      host: "github.com",
      repository: "acme/app",
      number: 42,
      url,
    }),
  );
  it.each([
    "echo 'gh pr create'",
    "# gh pr create\ngh pr list",
    "cat <<'EOF'\ngh pr create\nEOF",
    "gh pr create#example",
    "gh pr list",
    "gh api pulls",
    "gh pr create && gh pr list",
    "gh pr view 42 && gh pr create",
    "echo '#42'; gh pr create",
    `printf '${url}\\n'; gh pr create`,
    "gh pr create; gh pr create",
    'echo "$(gh pr create)"',
    "if false; then gh pr create; fi",
  ])("rejects %s", (input) => expect(shellCreatedPullRequest(input, url)).toBeUndefined());
  it.each([
    `See ${url}`,
    `${url}\nhttps://github.com/acme/app/pull/43`,
    "https://gitlab.com/acme/app/-/merge_requests/42",
    "https://example.com/acme/app/pull/42",
    `${url}/files`,
  ])("rejects ambiguous or unrelated output %s", (output) =>
    expect(shellCreatedPullRequest("gh pr create", output)).toBeUndefined(),
  );
});
