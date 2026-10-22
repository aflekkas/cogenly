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
    Resources/                  project files: anything the user drops here
      brief.pdf
      notes/
    .cogenly-project.json       project id, so a renamed folder keeps its identity
```

- Repositories are git work trees directly inside the project directory.
  Everything else at the top level, and anything under `Resources/`, is a
  project resource. Adding a file from the UI writes it into the folder; adding
  it in Finder is equivalent. A watcher keeps the index current.
- Links and notes are files too (`.url` / `.md`), so the folder stays complete
  without the database.
- A chat in a project runs with the project directory as its working directory.
  Work in a repository runs in that repository (its worktree), as today. Work
  started in a project with no repository runs in the project directory too:
  the launch records it as the thread's worktree path (made if missing), so its
  cwd stays put when the Work is later re-filed, and provider sessions, which
  are keyed by cwd, keep resuming.
- Moving a chat to a project forks it: the new chat is created in the project,
  carries the history (context handoff), and starts in the project directory.
  The original chat is left where it was. Chats with turns are never
  re-parented; a brand-new chat with no turns yet may still be filed
  directly, and unfiling stays allowed.
- A persistent agent's project is its conversation's folder membership, not a
  field on the agent. That conversation is the agent's single ongoing thread,
  so it is exempt from the fork rule: moving an agent re-files the same
  thread, which then runs in the new project dir with its manifest.
- Agents reach resources through the `cogenly` MCP server: list, read (paged
  text), and recall (search across the project's files). Threads in a project
  get a short manifest of its resources in their context.
- Project instructions and the project chat's own system prompt ride inside
  that manifest (`buildProjectManifest`), so every adapter carries them with
  no per-provider code. Codex and Muse resend it every turn; Claude bakes it
  into the system prompt when its process opens, so an instructions edit
  reaches a live Claude thread only after that process restarts.
- Each project has one project chat (`projectLabels.ensureProjectChat`),
  an ordinary chat-surface thread the label points at. It is left out of the
  project's thread count and the Chats list, and it configures the project
  through the `project_*` MCP tools, which act on the caller's own project.

## Rules that keep cross-environment projects possible

Projects must eventually span environments (Mac, VPS, hosted). These rules hold
now, while only one environment holds a project:

1. Never persist absolute paths in shared state. Store project-relative paths;
   resolve against the local `projectsRoot` at the edge.
2. Project identity is the id in `.cogenly-project.json`, not the folder name
   or path.
3. Repositories are described portably by their source links (GitHub
   owner/repo, remote URL). A local-only folder with no remote is marked
   environment-local.
4. Resource identity is a content hash plus a relative path, so two copies of a
   project can be compared without trusting timestamps.
5. File access goes through one project-files service (list, read, write,
   watch, search). No caller touches the filesystem directly, so the service
   can later be backed by a synced store.
