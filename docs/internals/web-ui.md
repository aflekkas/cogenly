# Web UI

## Primitives

Controls come from [`components/ui`](../../apps/web/src/components/ui).
[AGENTS.md](../../AGENTS.md#taste) says how to use and extend them.

Don't style a raw `<button>`, `<input>`, `<select>`, or `<textarea>` to look like a control a
primitive provides. Raw elements are right when the element isn't that control: semantic rows, tabs,
resize handles, swatches, editor surfaces, anything whose behavior or geometry differs by design.

## Styles

Style with Tailwind classes in the component that renders the element.

- Global CSS, in [`index.css`](../../apps/web/src/index.css) or any other stylesheet, is only for
  what classes on the owning component can't express: generated Markdown or imperative DOM, custom
  elements and shadow roots, animations, runtime theme variables, and browser or Electron
  integration.
- No `style={{ ... }}` or inline `<style>` for static values a class covers. Values computed at
  runtime are fine.
- Theme-only rules use `@variant dark` and `@variant light`, not `.dark` selectors.
- Main content width comes from the `--content-*` tokens in `index.css`: pages render
  [`PageContent`](../../apps/web/src/components/PageContent.tsx) and the chat lane reads the same
  tokens. No page-level `max-w-*` or `mx-auto`; a wider page uses its `wide` variant.
- Interactive states (hover, focus-visible, pressed, selected) transition through the
  `interactive` utility in `index.css`; `state-hover` and `state-selected` include it, and the
  `require-interactive-transition` lint flags a raw `hover:bg-*` without it.

## Composition

The composer banners are the reference.

- [`ComposerBanner.tsx`](../../apps/web/src/components/chat/ComposerBanner.tsx) exports one object
  of small slots. Slots own their classes, take `className`, and spread the rest of their props,
  merging classes with `cn`. Variants and density are props on `Root`. A slot that needs a control
  renders `Button`.
- [`ComposerBannerStack.tsx`](../../apps/web/src/components/chat/ComposerBannerStack.tsx) composes
  the slots and owns only stack behavior: priority, expand and collapse, dismiss transitions.
- Consumers are a few lines of slots, and the slots carry the styling:
  [`ComposerActivityStatus.tsx`](../../apps/web/src/components/chat/ComposerActivityStatus.tsx).

Build new UI the same way. Compose or extend a component instead of copying its markup and classes.
When a call site repeats a treatment another one already uses, make it a variant or a slot on the
shared component. A new composer banner or notice uses the `ComposerBanner` slots.

## Panel motion

The sidebar and the inline right panel open and close without per-frame layout: the page lays
out once at its final size, the panel slides on `translate`, and content marked `data-panel-flip`
glides from where it was drawn on the same curve. See
[`lib/panelFlip.ts`](../../apps/web/src/lib/panelFlip.ts).

- Never transform the main pane or the chat column. A transform makes it the containing block of
  its `position: fixed` titlebar controls, so they jump with it. Mark the content instead.
- A new page marks its centered frame (`PageContent` already does) and a leading title
  that isn't a `WorkspaceBreadcrumb` with `data-panel-flip="start"`. Unmarked content snaps.
- Don't animate panel widths or header padding. Every frame would rerun the chat's
  `observeResize` callbacks, each a synchronous React render.
- Start a flip in the layout effect that commits the change. An animation started from a
  ResizeObserver callback lands a frame late, and that frame shows content at its final place.
- Don't clip a pane's left edge horizontally. Content gliding in from where it was drawn crosses
  the pane's new edge while the sidebar opens. The sidebar wrapper clips at the window's edges.
- A maximized right panel's tabs ride the edge, but its body snaps. The body fills the pane, so a
  translate would push its right-anchored content off-screen.

## Dialog motion

Dialogs, alert dialogs and sheets fade and scale in from 97% and leave faster on
`ease-popup-exit`. Base UI only animates a root whose `open` changes while it stays mounted.

- A dialog its parent mounts conditionally (`{x ? <EditorDialog/> : null}`, `open` hard-coded)
  renders through [`OverlayPresence`](../../apps/web/src/components/ui/overlay-presence.tsx).
  It keeps the dialog mounted for its exit. Its enter comes from `@starting-style` on the popup.
- A dialog that stays mounted and reads a value its close clears reads `useLastPresent(value)`,
  so its copy holds while it animates out.
- Don't switch between dialog roots, or between a dialog and other content, with an early return
  or a `key` that changes on open. Render both and close one as the other opens.

## Handlers in large components

V8 gives every closure created in one render a single shared scope. A memoized handler keeps
the scope of the render that created it, and that scope holds the other memoized values of that
render. When handlers in one component change at different times, each keeps an older scope that
holds older handlers, and old renders, with their server config and thread data, stay in memory
for as long as the component is mounted. React Compiler's memoized closures do the same.

In large, long-lived components such as `ChatView` and `ChatComposer`, write handlers as plain
functions and wrap them with [`useStableCallback`](../../apps/web/src/hooks/useStableCallback.ts)
only where they leave the component: props, hook dependency arrays, and effect or memo bodies.
Calls inside the component keep the plain function, so work that resumes after an `await` still
acts on the render it started in. A function that a child calls during render, or after an
`await`, comes from a module-level factory memoized on its inputs, so its closure keeps only
those inputs.
