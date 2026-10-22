// @effect-diagnostics globalTimers:off -- Dev-only stand-in that simulates helper latency.
import type { DesktopDictationBridge, DesktopDictationResult } from "@t3tools/contracts";

/**
 * A dev-build stand-in for the desktop speech helper, so the composer's dictation
 * UI can be exercised in a browser. Recording still uses the real microphone.
 */
export function createDevDictationBridge(): DesktopDictationBridge {
  const pending = new Map<string, (result: DesktopDictationResult) => void>();
  const settleAfter = (requestId: string, ms: number, result: DesktopDictationResult) =>
    new Promise<DesktopDictationResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(result);
      }, ms);
      pending.set(requestId, (cancelled) => {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(cancelled);
      });
    });
  return {
    isAvailable: async () => true,
    requestMicrophoneAccess: async () => ({ granted: true, canAskAgain: false }),
    prepare: ({ requestId, locale }) =>
      settleAfter(requestId, 150, { ok: true, value: locale.replaceAll("-", "_") }),
    transcribe: ({ requestId, audio }) =>
      settleAfter(requestId, 600, {
        ok: true,
        value: `hello from the dictation mock (${Math.round(audio.byteLength / 1024)} KB)`,
      }),
    cancel: async (requestId) =>
      pending.get(requestId)?.({ ok: false, code: "cancelled", message: "Cancelled." }),
  };
}
