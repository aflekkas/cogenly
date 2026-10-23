"use client";

import type {
  SitePermission,
  SitePermissionPrompt,
  SitePermissionPromptAnswer,
  SitePermissionSetting,
  SitePermissionsState,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { previewBridge } from "./previewBridge";

/**
 * A desktop tab's site permissions: the request its page is waiting on, and
 * the person's answers. `tabId` is the desktop's tab id; null where the tab
 * has no page of its own (streamed server tabs, web builds).
 */
export function useSitePermissions(tabId: string | null) {
  const bridge = previewBridge?.sitePermissions ?? null;
  const [prompt, setPrompt] = useState<{
    readonly tabId: string;
    readonly prompt: SitePermissionPrompt | null;
  } | null>(null);

  useEffect(() => {
    if (!bridge || tabId === null) return;
    let current = true;
    // Subscribed before it reads, so a request landing in between is never missed.
    const stop = bridge.onPromptChange((event) => {
      if (event.tabId === tabId) setPrompt({ tabId, prompt: event.prompt });
    });
    void bridge
      .get(tabId)
      .then((state) => {
        if (current) setPrompt((existing) => existing ?? { tabId, prompt: state.prompt });
      })
      .catch(() => undefined);
    return () => {
      current = false;
      stop();
    };
  }, [bridge, tabId]);

  const answer = useCallback(
    (promptId: string, choice: SitePermissionPromptAnswer) => {
      if (!bridge || tabId === null) return;
      void bridge.answer(tabId, promptId, choice).catch(() => undefined);
    },
    [bridge, tabId],
  );

  const read = useCallback(
    (): Promise<SitePermissionsState> =>
      bridge && tabId !== null
        ? bridge.get(tabId)
        : Promise.reject(new Error("This tab has no site permissions.")),
    [bridge, tabId],
  );

  const change = useCallback(
    async (permission: SitePermission, setting: SitePermissionSetting) => {
      if (!bridge || tabId === null) return null;
      const result = await bridge.set(tabId, permission, setting);
      return result.state;
    },
    [bridge, tabId],
  );

  return {
    available: bridge !== null && tabId !== null,
    prompt: prompt?.tabId === tabId ? prompt.prompt : null,
    answer,
    read,
    change,
  };
}
