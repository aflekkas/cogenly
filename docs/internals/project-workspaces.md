# Project workspaces

## Model

A project (the user-facing folder such as "Spawn Partners", `ProjectLabel` in
contracts; not the per-repository workspace record) is a folder. The folder is the source of truth; Cogenly indexes it,
it does not own a copy.

```
<projectsRoot>/                 default <COGENLY_HOME>/projects
  Spawn Partners/               the project directory
    repos/                      reserved: the project's repository checkouts
      platform/                 a repository of the home owner (Spawn-Partners)
      aflekkas/athens-racing/   a repository of any other owner
    .worktrees/                 reserved: worktrees, mirroring repos/
      platform/
        fix-login-redirect/     the worktree for branch c/fix-login-redirect
      aflekkas/athens-racing/
        fix-login-redirect/
    Resources/                  project files: anything the user drops here
      brief.pdf
      notes/
    .cogenly-project.json       project id, so a renamed folder keeps its identity
  Repositories/                 repositories no project holds
    acme/
```

- A project's repositories live in `repos/<directoryName>`. `directoryName`
  is derived, never chosen (`repositoryDirectoryNameFor` in contracts): the
  remote's repository name for the project's home owner, `<owner>/<repo>` for
  any other owner, so same-named repositories from two owners never collide;
  a repository with no remote keeps its folder name. The home owner is the
  project's explicitly linked GitHub owner. A connected account is only a
  suggestion until accepted. Folder names use accepted shared links, so
  machine-local GitHub credentials cannot change the layout. The
  project schema derives the names on decode and refuses to encode one that
  disagrees; the service corrects stored names on read.
- Everything at the top level except the id file, `repos/` and the worktree
  folders, and anything under `Resources/`, is a project resource. Adding a
  file from the UI writes it into the folder; adding it in Finder is
  equivalent. A watcher keeps the index current.
- New worktrees live in `<project>/.worktrees/`, mirroring `repos/`
  (`.worktrees/<owner>/<repo>/<slug>` for another owner's repository), where
  the slug is the branch name without its `c/` prefix. The branch is decided
  before the worktree is created, so the folder never moves and provider
  sessions keyed by cwd keep resuming. Worktrees made earlier under
  `<project>/worktrees/` stay where they are and are still treated as
  managed; `repos/`, `.worktrees/` and `worktrees/` are reserved names that
  project files, the watcher and folder reconcile ignore. Repositories in no
  project, and any repository when the user sets an explicit worktrees
  directory, use that directory (default `<COGENLY_HOME>/worktrees`).
- A repository a project links has a checkout on each machine, or not yet.
  On a machine with no record for it, the link's repository id is a
  `remote:<host/owner/repo>` placeholder (made when a peer's project
  arrives, or when a record is deleted). Each link reports its `checkout`
  state here (`ready`, `not_cloned`, `missing`, `cloning`, `failed`).
  `RepositoryCheckout` owns the per-machine lifecycle: `checkoutRepository`
  clones a linked remote into `repos/<directoryName>` and swaps the
  placeholder for the new record in one transaction
  (`ProjectLabelService.bindRepositoryCheckout`), rebinding scheduled tasks
  that pointed at the placeholder. A launch that names a placeholder clones
  first. A failed clone keeps its record, so the next attempt retries in
  place. `removeCheckout` deletes only the folder: the record and its threads
  stay, so a thread never loses its project. It refuses while the checkout
  holds work found nowhere else. `adoptRepository` moves a checkout kept
  elsewhere into `repos/<directoryName>` and runs `git worktree repair`.
- Checkouts follow their folder. After any project change, a reactor
  (`RepositoryCheckout.layerRelocation`) re-derives where each project's
  in-folder checkouts belong. It moves them when the home owner changed, and
  repoints records whose folder was renamed. A rename re-emits project changes
  after the folder moves on disk, because that move happens after the commit.
- Deleting a project removes its folder only when it is the bare skeleton.
  Anything else stays as an orphan ("leftover folder" in the UI): a folder
  with no marker, or with one naming a project that is gone. Listing orphans
  (Settings › Projects, `project_folders_reconcile`) removes bare-skeleton
  ones instead of returning them, once they are ten minutes old so a create
  in flight is not mistaken for one. Skeleton removal only ever `rmdir`s, so
  a file nobody expected keeps the folder. Orphans with content can be
  adopted as projects or moved to the OS Trash (`FolderDisposal.ts`), never
  deleted outright. Creating a project adopts a folder whose marker names a
  deleted project, rather than making "Name (2)" beside it.
- Links and notes are files too (`.url` / `.md`), so the folder stays complete
  without the database.
- Every way a file enters a project (upload, drop, a copied chat attachment,
  an agent's note) writes a real file into the folder, under `Resources/` or
  the folder the caller names. Nothing is a reference: the folder is what
  replicates and what agents read, so a path pointing elsewhere would be a
  different file on each machine. For the same reason, a symlinked file that
  leads outside the project is replaced by a copy at startup
  (`ProjectFiles.copyLinkedFiles`, idempotent); the original stays where it
  was. Linked folders stay links and are neither indexed nor synced.
- Project files replicate to paired machines
  ([`ProjectFileSync`](../../apps/server/src/sync/ProjectFileSync.ts)). Each
  project and relative path is one `project-file` shared document holding the
  content hash, never the bytes; a machine missing the content reads it in
  1 MiB chunks over `ProjectFileBlobRead` from the author, or through its hub.
  `project_file_sync_state` records what the disk held when this machine last
  agreed with the document, so a difference is a local edit to publish and a
  peer's change applies only over content it was made from. Otherwise the
  peer's version wins (field clocks) and the local one is kept as
  `name (conflict from <machine>)`, which then syncs like any file. A delete
  is a `deleted` flag rather than a tombstone, so the path can return; a
  rename is a delete plus an add, and the add copies the content locally.
  Files above `PROJECT_FILE_SYNC_MAX_BYTES` stay local and are never taken
  for deletes. Repositories never travel this way; they clone per machine.
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
  cwd, seeded with a portable context handoff of the prior history. This is the
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
   (`host/owner/repo`: lowercase host, ssh/https unified, no `.git`) and its
   derived `directoryName` under `repos/` (one segment, or `owner/repo`),
   synced with the project; the remote is backfilled from the checkout's git
   remote on read. A repository with no remote stores null and is local-only
   on this machine. Source links (GitHub owner/repo) remain a separate,
   coarser grouping, and the GitHub owner link also names the home owner.
4. Resource identity is a content hash plus a relative path, so two copies of a
   project can be compared without trusting timestamps.
5. File access goes through one project-files service (list, read, write,
   watch, search). Callers other than it and `ProjectFileSync`, which applies
   peers' changes to the folder, do not touch the project's files directly.
