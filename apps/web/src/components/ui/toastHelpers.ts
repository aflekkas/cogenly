"use client";

import type { ToastManagerAddOptions } from "@base-ui/react/toast";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import type { ThreadToastData } from "./toast";

export type StackedThreadToastOptions = {
  type: "error" | "warning" | "success" | "info" | "loading";
  title: ReactNode;
  description?: ReactNode;
  timeout?: number;
  priority?: "low" | "high";
  actionProps?: ComponentPropsWithoutRef<"button">;
  /** Merged into `data`. */
  actionVariant?: ThreadToastData["actionVariant"];
  data?: ThreadToastData;
};

/**
 * Defined `actionProps` that hide a previous toast CTA on `toastManager.update`.
 * Passing `actionProps: undefined` is a no-op because updates omit undefined keys.
 */
export const hiddenToastActionProps = {
  children: null,
} as const satisfies Pick<ComponentPropsWithoutRef<"button">, "children">;

/**
 * Builds a toast payload from flat options. Every toast renders through the
 * same card (text, then an end-aligned action row); this only shapes the
 * options, it does not pick a different style.
 */
export function stackedThreadToast(
  options: StackedThreadToastOptions,
): ToastManagerAddOptions<ThreadToastData> {
  const { type, title, description, timeout, priority, actionProps, actionVariant, data } = options;

  const mergedData: ThreadToastData = { ...data };
  if (actionVariant !== undefined) {
    mergedData.actionVariant = actionVariant;
  }

  const payload: ToastManagerAddOptions<ThreadToastData> = {
    type,
    title,
    data: mergedData,
  };

  if (description !== undefined) {
    payload.description = description;
  }
  if (timeout !== undefined) {
    payload.timeout = timeout;
  }
  if (priority !== undefined) {
    payload.priority = priority;
  }
  if (actionProps !== undefined) {
    payload.actionProps = actionProps;
  }

  return payload;
}
