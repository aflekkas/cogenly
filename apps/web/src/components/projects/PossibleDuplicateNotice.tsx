import { CopyIcon } from "lucide-react";
import { useState } from "react";

import type { PossibleDuplicateProjects } from "../../projectLabels/projectLabels.logic";
import { useMergeDuplicateProjects } from "../../projectLabels/useMergeDuplicateProjects";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

/**
 * "Possible duplicate: merge these projects?" for two same-name projects
 * created apart. Merge asks first; Keep separate stops the question on every
 * machine.
 */
export function PossibleDuplicateNotice(props: { readonly pair: PossibleDuplicateProjects }) {
  const { pair } = props;
  const { mergePair, keepSeparate } = useMergeDuplicateProjects();
  const [busy, setBusy] = useState(false);
  const run = (action: (pair: PossibleDuplicateProjects) => Promise<boolean>) => {
    setBusy(true);
    void action(pair).finally(() => setBusy(false));
  };
  const unavailable = pair.environmentId === null;
  return (
    // Fades in when the question arrives.
    <div className="reveal-motion">
      <Alert variant="info">
        <CopyIcon aria-hidden />
        <AlertTitle>Possible duplicate: merge these projects?</AlertTitle>
        <AlertDescription>
          {unavailable
            ? `Two projects are named ${pair.into.label.name}. They can be merged once one machine has both.`
            : `Two projects are named ${pair.into.label.name}, created separately. Merging keeps every repository, thread and file in one.`}
        </AlertDescription>
        <AlertAction>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || unavailable}
            onClick={() => run(keepSeparate)}
          >
            Keep separate
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || unavailable}
            onClick={() => run(mergePair)}
          >
            Merge…
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
