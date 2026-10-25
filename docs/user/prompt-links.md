# Prompt links

A prompt link opens Cogenly with a prompt ready to send. Use one in a bookmark, a script, or a
pull request comment to start a draft in one click.

A link never runs anything. It opens a draft. You read the prompt, then press Send. A link cannot
change your permission mode, branch, or worktree. Your own defaults apply.

## Make a link

Write the link against the address you open Cogenly at, such as your server's Tailscale address.
The desktop app also opens `cogenly://new?…` links with the same parameters.

```
https://your-cogenly-address/new?prompt=Rate%20my%20swearing
https://your-cogenly-address/new?prompt=Fix%20the%20build&repo=owner/name&provider=codex&model=gpt-5.5
https://your-cogenly-address/new?pr=owner/name/123&prompt=Fix%20the%20failing%20check
```

| Parameter  | Meaning                                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| `prompt`   | The prompt. Required, except on pull request links. At most 8,000 characters. |
| `repo`     | A GitHub repository, as `owner/name` or its URL.                              |
| `provider` | A provider such as `codex` or `claude`.                                       |
| `model`    | A model of that provider, by its id or name.                                  |
| `pr`       | A GitHub pull request, as `owner/name/123` or its URL.                        |

Encode the prompt for a URL. In JavaScript, use `encodeURIComponent`.

## Open a link

- **No `repo`**: the draft opens without a project, on the machine you used last.
- **`repo`**: the draft opens in your most recently used project for that repository. A fork
  counts only for its own owner. When you do not have the repository, choose **Clone** or **Use
  without project**.
- **`provider` and `model`**: used when you have that provider set up. Otherwise your default
  model is used, and Cogenly tells you.
- **`pr`**: opens the thread linked to that pull request on any connected machine, with the prompt
  in its composer. When no thread is linked, the draft goes on the pull request branch in a new
  worktree. Cogenly checks the code out only after you confirm, because the checkout runs your
  setup script on it.

A thread link with a prompt, such as `https://your-cogenly-address/<environment>/<thread>?prompt=…`,
puts the prompt in that thread's composer. If you already typed a draft there, Cogenly asks
before it replaces it.

Cogenly removes characters you cannot see, such as zero-width and hidden tag characters, because
they can hide instructions for the agent. When a prompt had them, Cogenly warns you that it may be
malicious.
