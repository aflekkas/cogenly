import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { MicIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { BrowserVoiceRecorder } from "../../dictation/browserVoiceRecorder";
import { dictationKeyAction } from "../../dictation/composerDictation.logic";
import { createDesktopVoiceTranscriber } from "../../dictation/desktopVoiceTranscriber";
import {
  dictationLocale,
  readDictationBridge,
  useDictationAvailable,
} from "../../dictation/dictationAvailability";
import { useStableCallback } from "../../hooks/useStableCallback";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { isPreviewFocused } from "../../lib/previewFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerDictationControlProps {
  /** The draft being dictated into; a change cancels the run. */
  readonly ownerKey: string;
  readonly disabled: boolean;
  readonly keybindings: ResolvedKeybindingsConfig;
  /** Plain draft text and selection in the prompt's expanded (Markdown) coordinates. */
  readonly readDraft: () => Omit<VoiceDraftSnapshot, "ownerKey" | "revision"> | null;
  readonly commitDraft: (
    previous: Omit<VoiceDraftSnapshot, "ownerKey" | "revision">,
    text: string,
  ) => void;
  /** True from the first click until the transcript lands or the run is cancelled. */
  readonly onActiveChange: (active: boolean) => void;
}

/** Mic button for on-device dictation. Renders nothing where no transcriber exists. */
export function ComposerDictationControl(props: ComposerDictationControlProps) {
  const available = useDictationAvailable();
  if (!available) return null;
  return <ComposerDictationButton {...props} />;
}

const IDLE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

function ComposerDictationButton({
  ownerKey,
  disabled,
  keybindings,
  readDraft,
  commitDraft,
  onActiveChange,
}: ComposerDictationControlProps) {
  const [state, setState] = useState<VoiceInputState>(IDLE);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const levelRef = useRef<HTMLSpanElement>(null);
  const ownerKeyStable = useStableCallback(() => ownerKey);
  const readDraftStable = useStableCallback(readDraft);
  const commitDraftStable = useStableCallback(commitDraft);
  const [runtime] = useState(() => {
    const bridge = readDictationBridge();
    if (!bridge) return null;
    const recorder = new BrowserVoiceRecorder((status) => {
      void controller.handleRecorderStatus(status);
    });
    const transcriber = createDesktopVoiceTranscriber(bridge, {
      locale: dictationLocale,
      readRecording: (uri) => recorder.readRecording(uri),
    });
    const controller: VoiceInputController = new VoiceInputController({
      recorder,
      getTranscriber: () => transcriber,
      requestPermission: () => bridge.requestMicrophoneAccess(),
      configureRecording: () => recorder.configure(),
      releaseRecording: () => recorder.release(),
      deleteRecording: (uri) => recorder.deleteRecording(uri),
      readDraft: () => {
        const draft = readDraftStable();
        // The editor is frozen while dictation runs, so text equality is the revision.
        return draft ? { ...draft, ownerKey: ownerKeyStable(), revision: 0 } : null;
      },
      commitDraft: (text) => {
        // The controller commits only when the draft still matches its capture.
        const current = readDraftStable();
        if (current) commitDraftStable(current, text);
      },
      onStateChange: setState,
    });
    return { controller, recorder };
  });

  const active = voiceInputBlocksSubmission(state);
  const onActiveChangeStable = useStableCallback(onActiveChange);
  useEffect(() => {
    onActiveChangeStable(active);
  }, [active, onActiveChangeStable]);

  useEffect(() => {
    if (!runtime) return;
    return () => runtime.controller.dispose();
  }, [runtime]);

  const previousOwnerKey = useRef(ownerKey);
  useEffect(() => {
    if (previousOwnerKey.current === ownerKey) return;
    previousOwnerKey.current = ownerKey;
    runtime?.controller.ownerChanged();
  }, [ownerKey, runtime]);

  // The level dot follows the input at audio rate without re-rendering the composer.
  // Speech drives its scale; under reduced motion only its opacity follows the level.
  useEffect(() => {
    if (!runtime || state.phase !== "recording") return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const unsubscribe = runtime.recorder.subscribeLevel((level) => {
      const dot = levelRef.current;
      if (!dot) return;
      if (reduceMotion) dot.style.opacity = (0.45 + level * 0.55).toFixed(3);
      else dot.style.setProperty("--dictation-level", level.toFixed(3));
    });
    return () => {
      unsubscribe();
      levelRef.current?.style.removeProperty("opacity");
      levelRef.current?.style.removeProperty("--dictation-level");
    };
  }, [runtime, state.phase]);

  const toggle = useStableCallback(() => {
    if (!runtime) return;
    const { controller } = runtime;
    if (controller.currentState.phase === "recording") void controller.stop();
    else if (controller.currentState.phase === "idle" || controller.currentState.phase === "error")
      void controller.start();
  });

  useEffect(() => {
    if (!runtime) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const phase = runtime.controller.currentState.phase;
      const action = dictationKeyAction(phase, event);
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        if (action === "cancel") runtime.controller.cancel();
        else void runtime.controller.stop();
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused(), previewFocus: isPreviewFocused() },
      });
      if (command !== "composer.dictate") return;
      // Several composers can be mounted; start only in the focused one, but let
      // the shortcut stop whichever is recording.
      const running = phase !== "idle" && phase !== "error";
      const form = buttonRef.current?.closest("form");
      const focusedHere = form != null && form.contains(document.activeElement);
      if (!running && (!focusedHere || disabled)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggle();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [disabled, keybindings, runtime, toggle]);

  useEffect(() => {
    if (!runtime || state.phase !== "error" || !state.error) return;
    const { controller } = runtime;
    const settings = state.errorAction === "settings";
    toastManager.add({
      type: settings ? "warning" : "error",
      title: settings ? "Microphone access is off" : state.error,
      ...(settings
        ? {
            description:
              "Allow Cogenly in System Settings > Privacy & Security > Microphone, then try again.",
          }
        : {}),
      ...(settings
        ? {
            actionProps: {
              children: "Open System Settings",
              onClick: () => void window.desktopBridge?.openSystemSettings?.("microphone"),
            },
          }
        : state.errorAction === "retry"
          ? { actionProps: { children: "Try again", onClick: () => void controller.start() } }
          : {}),
    });
    // The toast carries the message; the button returns to its resting state.
    controller.cancel();
  }, [runtime, state]);

  if (!runtime) return null;
  const shortcutLabel = shortcutLabelForCommand(keybindings, "composer.dictate");
  const busy = state.phase === "preparing" || state.phase === "transcribing";
  const label =
    state.phase === "recording"
      ? "Stop dictation"
      : state.phase === "preparing"
        ? "Preparing dictation"
        : state.phase === "transcribing"
          ? "Transcribing"
          : "Dictate";
  const hint =
    state.phase === "recording"
      ? "Enter or click to insert, Esc to cancel"
      : shortcutLabel
        ? `Dictate (${shortcutLabel})`
        : "Dictate";

  return (
    <span className="flex motion-safe:transition-opacity motion-safe:duration-(--motion-duration-fast) motion-safe:ease-out motion-safe:starting:opacity-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={buttonRef}
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={disabled && !active}
              aria-pressed={state.phase === "recording"}
              aria-label={label}
              data-dictation-phase={state.phase}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => (state.phase === "transcribing" ? undefined : toggle())}
            />
          }
        >
          <span className="relative grid size-4 place-items-center [&>*]:col-start-1 [&>*]:row-start-1">
            <MicIcon
              aria-hidden
              className={cn(
                "transition-opacity duration-(--motion-duration-fast) ease-out",
                state.phase === "idle" || state.phase === "error" ? "opacity-100" : "opacity-0",
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
            <span
              ref={levelRef}
              aria-hidden
              className={cn(
                "size-2.5 rounded-full bg-destructive transition-[opacity,scale] duration-(--motion-duration-fast) ease-out",
                "motion-safe:scale-[calc(0.55+var(--dictation-level,0)*0.75)] motion-reduce:transition-opacity",
                state.phase === "recording" ? "opacity-100" : "opacity-0",
              )}
            />
          </span>
        </TooltipTrigger>
        <TooltipPopup>{hint}</TooltipPopup>
      </Tooltip>
    </span>
  );
}
