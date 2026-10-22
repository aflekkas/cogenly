# Importing from T3 Code

If you used T3 Code, Cogenly can bring your projects and chats over with their
full history, so you can continue them here. The import reads T3 Code's data on
the same computer and never changes it.

## What comes over

- **Projects.** Each T3 Code project you pick. A project whose folder is already
  in Cogenly is merged into it, not duplicated.
- **Full history.** Every message, tool call, and run in each thread, not a
  trimmed transcript.
- **Subagent threads and forks.** Subagent threads stay linked to the thread
  that started them, and forks stay linked to their source.
- **Attachments.** Images and files attached in T3 Code are copied. T3 Code
  keeps its own copies.
- **Providers.** Threads keep the provider they ran on. If T3 Code had extra
  provider instances, such as a second Claude account (`claude-personal` with
  its own config folder), Cogenly adds the same instance so those threads resume
  against the same Claude, Codex, or Muse sessions.
- **Keybindings and models.** Your shortcuts, default models, and favorite models.
  These only fill gaps: anything you already set in Cogenly is kept. You can
  turn this off before importing.

## What does not come over

- **Sign-ins and secrets.** Tokens, API keys, and logins are never copied.
  Providers may ask you to sign in again.
- **T3 Code's Scratch project.** It holds many one-off folders, so it is shown
  as **Later** and is not imported yet.
- **Deleted projects and threads.** Only what is live in T3 Code is imported.

## Before you start

**T3 Code and Cogenly can both stay open.** When you check what will be
imported, Cogenly copies a snapshot of T3 Code's data and imports from that
copy, then deletes it. Anything that changes in T3 Code after the check comes
over the next time you run the import.

The copy needs free disk space about the size of T3 Code's database, which can
be several gigabytes for a long history. Cogenly checks first and tells you how
much it needs if there isn't enough.

## Run the import

You can start the import from four places. They do the same thing.

- **During setup.** When Cogenly finds T3 Code on your computer, setup offers
  **Bring your projects and chats over from T3 Code**. You can skip it and come
  back later.
- **Settings → Import.** Available at any time.
- **`cogenly setup`** in a terminal walks through the same steps as setup in the
  app, including this import. See
  [Set up from the terminal](./welcome-wizard.md#set-up-from-the-terminal).
- **`cogenly t3-import`**, for scripts and agents:

  ```sh
  cogenly t3-import            # dry run: prints what would be imported, as JSON
  cogenly t3-import --apply    # import
  ```

  Add `--settings` to also bring over keybindings and models, and `--projects
<a,b>` to choose projects by T3 project id, title, or folder.

Both commands work whether Cogenly is running or not. While it runs, they import
through it, exactly like **Settings → Import**, so agents keep running and the
app shows the import as it happens. While it isn't, they import into its data
directory directly. `cogenly t3-import --source <dir>` reads T3 Code's data
from another folder than `~/.t3/userdata`; it works only while Cogenly isn't
running.

In the app, pick your projects, then select **Check what will be imported**.
This dry run reads T3 Code's data and lists the threads, messages, attachments,
providers, and settings that would change. Nothing is written. Review it, then
select **Import**. A large history can take a few minutes. You can keep using
Cogenly meanwhile, and leaving the page does not stop the import.

Imported threads are listed under **Work**, in their projects.

## Backups and restoring

Before it writes anything, every import saves a copy of Cogenly's database and
settings to `~/.cogenly/backups/`:

- `cogenly-pre-t3-import-<time>.sqlite`
- `cogenly-pre-t3-import-<time>.settings.json`
- `cogenly-pre-t3-import-<time>.keybindings.json`

The exact path is shown during and after the import. To undo an import, quit
Cogenly, then in `~/.cogenly/userdata`:

1. Copy the `.sqlite` backup over `statev2.sqlite`.
2. Delete `statev2.sqlite-wal` and `statev2.sqlite-shm` if they exist.
3. Optionally copy the settings and keybindings backups over `settings.json`
   and `keybindings.json`.

Then start Cogenly again. Copied attachments stay in `userdata/attachments`;
they are harmless and can be left there.

## Running it again

Re-running is safe. Cogenly remembers what it imported, so nothing is
duplicated:

- Threads that have not changed in T3 Code since are left alone.
- Threads that gained messages in T3 Code get only the new messages.
- Threads you continued in Cogenly after importing are left as they are. Their
  newer T3 Code activity is not applied, so your Cogenly conversation is never
  rewritten.

If an import stops, is cancelled, or fails, what was written stays. Run it
again to continue from there.

## Continue each thread in one app

Imported threads resume the same provider session that T3 Code used. If you
keep chatting in the same thread in both apps, both append to that one session
and the two copies drift apart. Once a project is imported, continue its threads
in Cogenly only.

T3 Code's worktrees and scratch folders stay where they are under `~/.t3`.
Cogenly uses them in place and never deletes them. Cleaning them up in T3 Code
removes them for Cogenly too.

## Pull request watching

Pull requests linked in T3 Code stay linked on imported threads, but watching
is turned off, so an import never wakes threads for old pull requests. To watch
one again, ask the thread's agent to watch its pull request.

## Duplicates with the session import

Setup can also import raw Claude Code and Codex session files. When T3 Code is
found, setup offers the T3 Code import instead: it carries the same
conversations with full history. Importing both lists those conversations twice,
because the session import makes its own shorter copies. Use the session import
only for conversations you had outside T3 Code.

## Troubleshooting

- **T3 Code wasn't found.** The import looks for `~/.t3/userdata/statev2.sqlite`
  on the computer you are importing into. On another computer, run the import
  there, or use `cogenly t3-import --source <dir>`.
- **T3 Code is open.** Nothing to fix. Changes T3 Code makes after the check
  come over the next time you run the import.
- **Not enough free disk space.** The snapshot of T3 Code's data didn't fit.
  Free the space the message names, then check again.
- **A Cogenly server already owns the data directory.** The command found a
  Cogenly that isn't answering. Wait for it to finish starting, or quit it, then
  run the command again. The command never writes behind a running Cogenly.
- **T3 Code's data changed since the check.** Select **Check again**, then
  import.
- **Some events can't be read.** A few T3 Code records do not fit Cogenly's
  format. They are left out and the rest of each thread still comes over.
  **Show which** lists their thread IDs.
- **A provider shows "Differs".** You already have a provider instance with that
  name in Cogenly, set up with a different config folder. Imported threads use
  your Cogenly setup and may not find their earlier sessions. Check
  **Settings → Providers**.
- **A thread asks you to sign in.** Sign-ins are never copied. Sign in to the
  provider again in Cogenly.
- **This connection needs permission to change settings to import.** Import
  from a connection with full access, such as the desktop app on that computer.
