# Project workspaces

## Model

A project (the user-facing folder such as "Spawn Partners", `ProjectLabel` in
contracts; not the per-repository workspace record) is a folder. The folder is the source of truth; Cogenly indexes it,
it does not own a copy.

```
<projectsRoot>/                 default <COGENLY_HOME>/projects
  Spawn Partners/               the project directory
    platform/                   a repository (any git work tree)
    server/                     another repository
    worktrees/                  reserved: worktrees of the project's repositories
      platform/
        fix-login-redirect/     the worktree for branch c/fix-login-redirect
    Resources/                  project files: anything the user drops here
      brief.pdf
      notes/
    .cogenly-project.json       project id, so a renamed folder keeps its identity
  Repositories/                 repositories no project holds
    acme/                       an unfiled repository
    worktrees/                  reserved: worktrees of the unfiled repositories
      acme/
        fix-login-redirect/
```

- Repositories are git work trees directly inside the project directory.
  Everything else at the top level, and anything under `Resources/`, is a
  project resource. Adding a file from the UI writes it into the folder; adding
  it in Finder is equivalent. A watcher keeps the index current.
- Worktrees live inside the project: `<project>/worktrees/<repo>/<slug>/`,
  where the slug is the branch name without its `c/` prefix. The branch is
  decided before the worktree is created (a deterministic slug from the
  request), so the folder never moves and provider sessions keyed by cwd
  keep resuming. `worktrees/` is a reserved name: project files, the
  watcher and folder reconcile all ignore it, and it is never listed as a
  resource or a repository. Repositories outside any project but under the
  projects root (under `Repositories/`) get a sibling `worktrees/` the same
  way; repositories elsewhere, and any repository when the user sets an
  explicit worktrees directory in Settings, keep the configured location.
  Existing worktrees never move.
- Links and notes are files too (`.url` / `.md`), so the folder stays complete
  without the database.
- A chat in a project runs with the project directory as its working directory.
  Work in a repository runs in that repository (its worktree), as today. Work
  started in a project with no repository runs in the project directory too:
  the launch records it as the thread's worktree path (made if missing), so its
  cwd stays put when the Work is later re-filed, and provider sessions, which
  are keyed by cwd, keep resuming.
- Moving a chat to a project re-homes it: the same thread is re-filed, and
  its next turn runs with the project directory as its working directory (an
  unfiled chat runs in its scratch folder again). Provider sessions are
  keyed by cwd, so the next turn starts a fresh provider session in the new
  cwd, seeded with a portable context handoff of the prior history — the
  same resume-fallback path as a provider switch, for Claude, Codex and
  Muse alike. Moving never happens mid-turn: a thread with an active run
  refuses until that run settles. An explicit "fork to project" action still
  creates a copy carrying the history and leaves the original where it was.
- A persistent agent's project is its conversation's folder membership, not a
  field on the agent. That conversation is the agent's single ongoing thread:
  moving an agent re-files the same thread, which then runs in the new
  project dir with its manifest.
- Agents reach resources through the `cogenly` MCP server: list, read (paged
  text), and recall (search across the project's files). Threads in a project
  get a short manifest of its resources in their context.
- Project instructions and the project chat's own system prompt ride inside
  that manifest (`buildProjectManifest`), so every adapter carries them with
  no per-provider code. Codex and Muse resend it every turn; Claude bakes it
  into the system prompt when its process opens, so an instructions edit
  reaches a live Claude thread only after that process restarts.
- Projects are managed on a page (`/project`, opened from the rail's footer),
  and agents in any thread change them with the project MCP tools; there is
  no per-project conversation in the client any more. The server still keeps
  `projectLabels.ensureProjectChat` and a label's `projectChatThreadId` for
  projects that have one: clients now list that thread with the project's
  other chats, and the server keeps refusing to move it out of its project.
- Archiving a project only sets `archivedAt` on the label. Its threads, chat,
  repositories and filing are untouched; clients drop archived projects from
  every picker and move menu (the label directory's `active`) but still name
  them on threads already filed there.
- The server refuses to file a thread or link a repository into an archived
  project (`ProjectLabelService.readActive`, failing `archived`), so every
  transport and agent gets the same refusal; moving out, unfiling and work in
  threads already there stay allowed. Work started in a linked repository
  without naming a project still follows that repository, archived or not.

## Rules that keep cross-environment projects possible

Projects must eventually span environments (Mac, VPS, hosted). These rules hold
now, while only one environment holds a project:

1. Never persist absolute paths in shared state. Store project-relative paths;
   resolve against the local `projectsRoot` at the edge.
2. Project identity is the id in `.cogenly-project.json`, not the folder name
   or path.
3. Repositories are identified portably by their remote, never by local
   path. Each label↔repository link stores the normalized remote
   (`host/owner/repo`: lowercase host, ssh/https unified, no `.git`) and the
   repository's directory name under the project folder, filled on link and
   on clone and backfilled from the checkout's git remote on read. A
   repository with no remote stores null and is local-only on this machine.
   Source links (GitHub owner/repo) remain a separate, coarser grouping.
4. Resource identity is a content hash plus a relative path, so two copies of a
   project can be compared without trusting timestamps.
5. File access goes through one project-files service (list, read, write,
   watch, search). No caller touches the filesystem directly, so the service
   can later be backed by a synced store.
