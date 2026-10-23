/**
 * Mirrors the last input modality onto <html data-input-modality="pointer|keyboard">.
 * The `focus-visible` variant in index.css reads it, so focus rings show only
 * after keyboard use. Browsers already skip the ring on a plain click, but they
 * still match :focus-visible when script moves focus (a menu or popover handing
 * focus back to its trigger) or when a key goes down while a clicked control is
 * focused; this keeps a mouse click from ever leaving a ring. Shortcuts (⌘/Ctrl
 * combos) and lone modifier presses do not count as keyboard navigation. Before
 * any input the attribute is absent and the browser's own heuristic applies.
 * Idempotent.
 */
export function installInputModalityAttribute(): void {
  if (installed) return;
  installed = true;
  const root = document.documentElement;
  const set = (modality: "pointer" | "keyboard") => {
    if (root.dataset.inputModality !== modality) root.dataset.inputModality = modality;
  };
  document.addEventListener(
    "pointerdown",
    (event) => {
      // Screen readers' virtual clicks carry no pointer type; keep the ring for them.
      if (event.pointerType !== "") set("pointer");
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.metaKey || event.ctrlKey || MODIFIER_KEYS.has(event.key)) return;
      set("keyboard");
    },
    { capture: true, passive: true },
  );
}

const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift", "CapsLock", "Fn"]);

let installed = false;
