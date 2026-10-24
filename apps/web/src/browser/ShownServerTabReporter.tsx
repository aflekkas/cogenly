"use client";

import { AuthPreviewOperateScope, type EnvironmentId } from "@cogenly/contracts";
import { useEffect, useEffectEvent, useMemo } from "react";

import { previewEnvironment } from "~/state/preview";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { type NativeServerTab, shownNativeServerTabs } from "./shownServerTabs.logic";

/**
 * Tells the desktop's own server which of its tabs the user can see. The app
 * keeps a `<webview>` alive for every tab of an open thread, so being rendered
 * says nothing about being on screen; agents read this as `visible`.
 */
export function ShownServerTabReporter(props: {
  readonly environmentId: EnvironmentId;
  readonly tabs: ReadonlyArray<NativeServerTab>;
}) {
  const { environmentId, tabs } = props;
  const canOperate = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const report = useAtomCommand(previewEnvironment.reportShown, { reportFailure: false });
  const presentations = useBrowserSurfaceStore((state) => state.byTabId);
  const shown = useMemo(() => shownNativeServerTabs(tabs, presentations), [tabs, presentations]);
  // Presentation updates on every resize; only a change in which tabs show is news.
  const shownKey = JSON.stringify(shown);

  const send = useEffectEvent(() => {
    void report({ environmentId, input: { tabs: shown.slice(0, 32) } });
  });

  useEffect(() => {
    if (canOperate) send();
  }, [canOperate, environmentId, shownKey]);

  return null;
}
