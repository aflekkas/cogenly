import { PIXEL_MARK_URL } from "./pixelMark";

/**
 * Shows startup failures before React can replace the boot splash, in the same layout as
 * components/AppErrorScreen.tsx (styled by #boot-error in index.html): the pixel mark, a
 * title, one line and Reload, then a collapsed Details disclosure holding the error report
 * and Copy error.
 */
export function showBootError(error: unknown) {
  console.error("Cogenly failed to start.", error);
  const bootShell = document.getElementById("boot-shell");
  if (!bootShell) return;
  bootShell.dataset.state = "error";
  bootShell.style.pointerEvents = "";
  bootShell.setAttribute("role", "alert");
  bootShell.removeAttribute("aria-label");

  const details = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const report = [
    `Path: ${window.location.pathname}`,
    `Time: ${new Date().toISOString()}`,
    "",
    details,
  ].join("\n");

  const content = element("div", { id: "boot-error" });
  const mark = element("img", { className: "boot-error-mark", alt: "", src: PIXEL_MARK_URL });
  const title = element("h1", { textContent: "Cogenly couldn't start" });
  const hint = element("p", { textContent: "Reload to try again." });
  const reload = element("button", { type: "button", className: "primary", textContent: "Reload" });
  reload.addEventListener("click", () => window.location.reload());

  // A quiet disclosure: the report and Copy error stay folded until asked for.
  const disclosure = element("details", {});
  const copy = element("button", { type: "button", className: "quiet", textContent: "Copy error" });
  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(report).then(() => {
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy error"), 1600);
    });
  });
  disclosure.append(
    element("summary", { textContent: "Details" }),
    element("pre", { textContent: report }),
    copy,
  );

  content.append(mark, title, hint, reload, disclosure);
  bootShell.replaceChildren(content);
  reload.focus();
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]>,
): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}
