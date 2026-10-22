import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { MicIcon } from "lucide-react";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";

import { dictationKeyAction } from "../../dictation/composerDictation.logic";
import {
  createDictationMicrophone,
  dictationLocale,
  readDictationBridge,
  useDictationAvailable,
} from "../../dictation/dictationAvailability";
import { LiveDictationSession, type LiveDictationPhase } from "../../dictation/liveDictation";
import { useStableCallback } from "../../hooks/useStableCallback";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { isPreviewFocused } from "../../lib/previewFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerDictationWaveform } from "./ComposerDictationWaveform";

export interface ComposerDictationHandle {
  /** Stops listening; resolves true once the last segment has landed, false if cancelled. */
  finish: () => Promise<boolean>;
}

interface ComposerDictationControlProps {
  /** The draft being dictated into; a change cancels the run. */
  readonly ownerKey: string;
  readonly disabled: boolean;
  readonly keybindings: ResolvedKeybindingsConfig;
  /** Volatile text to show at the caret, or null to clear it. */
  readonly onPartial: (text: string | null) => void;
  /** A settled segment to insert at the caret. */
  readonly onFinal: (text: string) => void;
  /** True from the first click until the last segment lands or the run is cancelled. */
  readonly onActiveChange: (active: boolean) => void;
  readonly handleRef?: Ref<ComposerDictationHandle>;
}

/** Mic button for on-device dictation. Renders nothing where no transcriber exists. */
export function ComposerDictationControl(props: ComposerDictationControlProps) {
  const available = useDictationAvailable();
  if (!available) return null;
  return <ComposerDictationButton {...props} />;
}

function ComposerDictationButton({
  ownerKey,
  disabled,
  keybindings,
  onPartial,
  onFinal,
  onActiveChange,
  handleRef,
}: ComposerDictationControlProps) {
  const [phase, setPhase] = useState<LiveDictationPhase>("idle");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const onPartialStable = useStableCallback(onPartial);
  const onFinalStable = useStableCallback(onFinal);
  const [session] = useState(() => {
    const bridge = readDictationBridge();
    if (!bridge) return null;
    return new LiveDictationSession(bridge, createDictationMicrophone(), dictationLocale, {
      onPhase: setPhase,
      onPartial: (text) => onPartialStable(text),
      onFinal: (text) => onFinalStable(text),
      onError: (error, retry) => {
        const settings = error.action === "settings";
        toastManager.add({
          type: settings ? "warning" : "error",
          title: settings ? "Microphone access is off" : error.message,
          ...(settings
            ? {
                description:
                  "Allow Cogenly in System Settings > Privacy & Security > Microphone, then try again.",
                actionProps: {
                  children: "Open System Settings",
                  onClick: () => void window.desktopBridge?.openSystemSettings?.("microphone"),
                },
              }
            : error.action === "retry"
              ? { actionProps: { children: "Try again", onClick: retry } }
              : {}),
        });
      },
    });
  });

  useImperativeHandle(
    handleRef,
    () => ({ finish: () => session?.finish() ?? Promise.resolve(true) }),
    [session],
  );

  const active = phase !== "idle";
  const onActiveChangeStable = useStableCallback(onActiveChange);
  useEffect(() => {
    onActiveChangeStable(active);
  }, [active, onActiveChangeStable]);

  useEffect(() => {
    if (!session) return;
    return () => session.dispose();
  }, [session]);

  const previousOwnerKey = useRef(ownerKey);
  useEffect(() => {
    if (previousOwnerKey.current === ownerKey) return;
    previousOwnerKey.current = ownerKey;
    session?.cancel();
  }, [ownerKey, session]);

  const toggle = useStableCallback(() => {
    if (!session) return;
    if (session.phase === "idle") void session.start();
    else void session.finish();
  });

  useEffect(() => {
    if (!session) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const form = buttonRef.current?.closest("form");
      const focused = document.activeElement;
      const focusedHere = form != null && form.contains(focused);
      // Escape belongs to whatever else has focus; it cancels only from this composer.
      if (
        dictationKeyAction(session.phase, event) === "cancel" &&
        (focusedHere || focused === document.body)
      ) {
        event.preventDefault();
        event.stopPropagation();
        session.cancel();
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused(), previewFocus: isPreviewFocused() },
      });
      if (command !== "composer.dictate") return;
      // Several composers can be mounted; start only in the focused one, but let
      // the shortcut stop whichever is recording.
      if (session.phase === "idle" && (!focusedHere || disabled)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggle();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [disabled, keybindings, session, toggle]);

  const readLevel = useStableCallback(() => session?.readLevel() ?? 0);

  if (!session) return null;
  const shortcutLabel = shortcutLabelForCommand(keybindings, "composer.dictate");
  const busy = phase === "starting" || phase === "finishing";
  const label =
    phase === "recording"
      ? "Dictating — click to stop"
      : phase === "starting"
        ? "Starting dictation"
        : phase === "finishing"
          ? "Finishing dictation"
          : "Dictate";
  const hint =
    phase === "recording"
      ? "Click to stop, Enter to send, Esc to cancel"
      : shortcutLabel
        ? `Dictate (${shortcutLabel})`
        : "Dictate";

  return (
    <span className="flex items-center motion-safe:transition-opacity motion-safe:duration-(--motion-duration-fast) motion-safe:ease-out motion-safe:starting:opacity-0">
      <ComposerDictationWaveform
        recording={phase === "recording"}
        readLevel={readLevel}
        onStop={toggle}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={buttonRef}
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={disabled && !active}
              aria-pressed={phase === "recording"}
              aria-label={label}
              data-dictation-phase={phase}
              // Keeps the editor's focus and caret, so dictation lands where the user was typing.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => (phase === "finishing" ? undefined : toggle())}
            />
          }
        >
          <span className="relative grid size-4 place-items-center [&>*]:col-start-1 [&>*]:row-start-1">
            <MicIcon
              aria-hidden
              className={cn(
                "transition-opacity duration-(--motion-duration-fast) ease-out",
                phase === "idle" ? "opacity-100" : "opacity-0",
              )}
            />
            <span
              aria-hidden
              className={cn(
                "flex transition-opacity duration-(--motion-duration-fast) ease-out",
                busy ? "opacity-100" : "opacity-0",
              )}
            >
              {/* Paused while hidden so an idle composer never repaints. */}
              <Spinner style={busy ? undefined : { animationPlayState: "paused" }} />
            </span>
            {/* Stop: the waveform beside the button shows the voice. */}
            <span
              aria-hidden
              className={cn(
                "size-2.5 rounded-xs bg-destructive transition-opacity duration-(--motion-duration-fast) ease-out",
                phase === "recording" ? "opacity-100" : "opacity-0",
              )}
            />
          </span>
        </TooltipTrigger>
        <TooltipPopup>{hint}</TooltipPopup>
      </Tooltip>
    </span>
  );
}
