import type { EnvironmentId } from "@cogenly/contracts";
import { useEffect, useMemo, useState } from "react";

import { useEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { chatGreeting, chatGreetingRequest, isSpecialGreetingDay } from "./chatGreeting";

// The last AI greeting this browser saw, so a reload paints it straight away
// instead of the built-in line and a fade a moment later.
const REMEMBERED_GREETING_KEY = "cogenly:chat-greeting";

function rememberedKey(environmentId: EnvironmentId, day: string, bucket: string): string {
  return `${environmentId}:${day}:${bucket}`;
}

function readRemembered(key: string): string | null {
  try {
    const raw = window.localStorage.getItem(REMEMBERED_GREETING_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const entry = parsed as { readonly key?: unknown; readonly text?: unknown };
    return entry.key === key && typeof entry.text === "string" ? entry.text : null;
  } catch {
    return null;
  }
}

function writeRemembered(key: string, text: string): void {
  try {
    window.localStorage.setItem(REMEMBERED_GREETING_KEY, JSON.stringify({ key, text }));
  } catch {
    // Storage is a nicety; the server keeps the greeting either way.
  }
}

/**
 * The new-chat greeting: written by the environment's text generation model a
 * few times a day when AI greetings are on, otherwise the built-in line. Fixed
 * when the screen opens, apart from a written greeting arriving.
 */
export function useChatGreeting(environmentId: EnvironmentId | null): string {
  const [now] = useState(() => new Date());
  const fallback = useMemo(() => chatGreeting(now), [now]);
  const request = useMemo(() => chatGreetingRequest(now), [now]);
  const environment = useEnvironment(environmentId);
  const enabled =
    environmentId !== null &&
    environment?.serverConfig?.settings.aiGreetings === true &&
    !isSpecialGreetingDay(now);
  const key =
    environmentId === null ? null : rememberedKey(environmentId, request.day, request.bucket);
  const [remembered] = useState(() => (key === null ? null : readRemembered(key)));
  const query = useEnvironmentQuery(
    enabled && environmentId !== null
      ? serverEnvironment.chatGreeting({ environmentId, input: request })
      : null,
  );
  const written = query.data?.text ?? null;
  useEffect(() => {
    if (key !== null && written !== null) writeRemembered(key, written);
  }, [key, written]);
  if (!enabled) return fallback;
  return written ?? (query.data === null ? remembered : null) ?? fallback;
}
