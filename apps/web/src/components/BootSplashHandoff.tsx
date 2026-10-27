import { useAtomValue } from "@effect/atom-react";
import { allEnvironmentShellsBootstrappedAtom } from "../state/shell";
import { beginAction, finishActionAfterPaint } from "../observability/actionLatency";
import { useEffect } from "react";

import { dismissBootSplash, holdBootSplashHandoff } from "../bootSplash";

let startupRecorded = false;
let threadListRecorded = false;
let threadListStarted = false;

/**
 * Mounted beside the app root: starts the boot splash hand-off after the first commit, and
 * removes the splash outright if it unmounts first.
 */
export function BootSplashHandoff() {
  const shellsReady = useAtomValue(allEnvironmentShellsBootstrappedAtom);
  useEffect(() => {
    if (!threadListStarted) {
      threadListStarted = true;
      beginAction("threads.load", "", 0);
    }
    if (!shellsReady || threadListRecorded) return;
    threadListRecorded = true;
    finishActionAfterPaint("threads.load");
  }, [shellsReady]);
  useEffect(() => {
    if (!startupRecorded) {
      startupRecorded = true;
      beginAction("app.startup", "", 0);
      finishActionAfterPaint("app.startup");
    }
    const release = holdBootSplashHandoff();
    void dismissBootSplash();
    return release;
  }, []);
  return null;
}
