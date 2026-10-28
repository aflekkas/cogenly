import { ThreadTitleInstructionsSettings } from "./ThreadTitleInstructionsSettings";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";

/**
 * Settings → New threads: where new threads and worktrees start. Where added
 * repositories go is on Settings → Projects, and a repository's actions are on
 * its Repository page.
 */
export function NewThreadsSettingsPanel() {
  return (
    <>
      <ProjectDefaultsSettings category="new-threads" />
      <ThreadTitleInstructionsSettings />
    </>
  );
}
