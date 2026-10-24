# Source control

Cogenly integrates with GitHub to clone repositories, and agents use it to publish repositories and create pull requests.
Repositories on other hosts continue to work as plain Git repositories.

## Connect an account

Install Git and configure authentication on the machine running your Cogenly server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source Control**
and choose **Rescan**.

### GitHub

Cogenly talks to GitHub's API directly and only needs a token. Any of these works, in this
order of precedence:

1. A token saved in **Settings → Source Control → GitHub**. It is kept in the server's secret
   store, and works without the GitHub CLI.
2. `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` with `GH_HOST` for GitHub Enterprise Server) in the
   server's environment.
3. [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, signed in with `gh auth login`.

If `gh` is signed in to several accounts or hosts, expand **GitHub** in the same place to pick
the account each host uses or turn a host off. A saved token or `GH_TOKEN` takes precedence
over that choice; a host turned off stays off either way.

For GitHub Enterprise, sign in with `gh auth login --hostname YOUR_HOST`. Cogenly treats a
custom server name as GitHub once it has a credential for that host.

## Start, clone, or publish a project

To start from nothing, choose **New project** in the command palette (`Cmd/Ctrl+K`), or
**New project** under **Add Project** on any client, and type a name. Cogenly makes a Git
repository in `~/.cogenly/projects` (the `projects` folder of your Cogenly data directory) with a README,
an icon, and a first commit, then opens a new thread in it. Until the project has a thread, new
threads work in its folder, even when your default is a new worktree. The folder is named after the project,
like `pinball-stats` for "Pinball Stats". Turn on **Create private repository on GitHub** to also
publish it. If Git has no name or email on that machine, the project is created without the
first commit.

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it. The project opens right away while the
clone runs in the background: you can write your first prompt, and sending waits until the files
are in place. A toast tracks progress and lets you cancel; if the clone fails, retry it from the
toast or from the banner above the composer. Starting work in a repository that is not on this
machine yet clones it first, before the agent starts.

## Repositories in a project

A project keeps its repositories in its folder, at
`~/.cogenly/projects/<Project>/repos/`. Each one is named after its repository:
`platform` for one owned by the project's GitHub owner, and `owner/repo`, such
as `aflekkas/athens-racing`, for one from another owner. You cannot rename them.
That keeps the folder the same on every machine, and two repositories with the
same name from different owners never clash. A repository with no remote keeps
its own folder name.

A repository you cloned elsewhere before keeps working where it is. Move it into
its project folder from its menu in the project's repository list. Its worktrees
come along, and its threads follow. Folders under `~/.cogenly/projects` that no
project claims, such as those left by a deleted project, are listed in
**Settings → Projects**. Adopt one as a project, or remove it if it is empty.

## Pull requests with agents

Ask Claude Code or Codex to commit, push, publish a repository without a remote, or open, inspect
and manage a GitHub pull request. Agents can link pull requests to a thread and watch their checks and reviews. Pull request links open through your normal browser preference.
