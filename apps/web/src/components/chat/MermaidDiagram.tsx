import DOMPurify from "dompurify";
import type { DiagramType } from "pele/lazy";
import { use, useLayoutEffect, useRef, useState } from "react";

import { Button } from "../ui/button";

type Pele = typeof import("pele/lazy");
type PeleLoad = { readonly status: "loaded"; readonly pele: Pele } | { readonly status: "failed" };

let coreLoad: Promise<PeleLoad> | null = null;
// Each diagram type is its own chunk, so a chat with one flowchart loads only
// the flowchart parser and layout.
const diagramLoads = new Map<DiagramType, Promise<PeleLoad>>();

// The renderer only loads once a diagram is actually shown.
function loadCore(): Promise<PeleLoad> {
  coreLoad ??= import("pele/lazy").then(
    (pele): PeleLoad => ({ status: "loaded", pele }),
    (): PeleLoad => ({ status: "failed" }),
  );
  return coreLoad;
}

function loadDiagramType(pele: Pele, type: DiagramType): Promise<PeleLoad> {
  let load = diagramLoads.get(type);
  if (!load) {
    load = pele.load(type).then(
      (): PeleLoad => ({ status: "loaded", pele }),
      (): PeleLoad => ({ status: "failed" }),
    );
    diagramLoads.set(type, load);
  }
  return load;
}

function detectDiagramType(pele: Pele, source: string): DiagramType | null {
  try {
    return pele.detectType(source);
  } catch {
    return null;
  }
}

const REMOTE_CSS_URL = /url\(\s*(?!['"]?#)[^)]*\)/gi;
let purifier: ReturnType<typeof DOMPurify> | null = null;

// Diagrams can come from untrusted PR descriptions. Pele escapes labels and
// links and images are off, so this is defense in depth against anything that
// could navigate, run script, or fetch remote content. A diagram's own style
// directives keep only local url(#id) references.
function sanitizeDiagramSvg(svg: string): Node {
  if (!purifier) {
    purifier = DOMPurify(window);
    purifier.addHook("uponSanitizeAttribute", (_node, data) => {
      if (data.attrName === "style")
        data.attrValue = data.attrValue.replace(REMOTE_CSS_URL, "none");
    });
  }
  return purifier.sanitize(svg, {
    FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
    FORBID_TAGS: ["a", "image", "foreignObject", "style"],
    USE_PROFILES: { svg: true, svgFilters: true },
    RETURN_DOM_FRAGMENT: true,
  });
}

// Pele colors diagrams through these, which a standalone image cannot inherit.
const PELE_COLOR_VARIABLES = [
  "--pele-bg",
  "--pele-fg",
  "--pele-muted",
  "--pele-line",
  "--pele-surface",
  "--pele-surface-alt",
  "--pele-border",
  "--pele-accent",
  "--pele-critical",
  ...Array.from({ length: 8 }, (_, index) => `--pele-series-${index + 1}`),
];

let expandedImageUrl: string | null = null;

/**
 * Converts a rendered diagram into a standalone image with fixed size, colors and
 * background. A blob URL, unlike a data URL, passes the desktop connect-src policy
 * that media save and copy actions fetch through. Only one diagram is expanded at
 * a time, so the previous URL is released.
 */
function diagramImageUrl(svg: SVGSVGElement): string {
  const element = svg.cloneNode(true) as SVGSVGElement;
  const computed = getComputedStyle(svg);
  for (const name of PELE_COLOR_VARIABLES) {
    const value = computed.getPropertyValue(name).trim();
    if (value) element.style.setProperty(name, value);
  }
  const viewBox = element.getAttribute("viewBox")?.trim().split(/\s+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    element.setAttribute("width", String(viewBox[2]));
    element.setAttribute("height", String(viewBox[3]));
  }
  element.style.maxWidth = "none";
  element.style.backgroundColor = getComputedStyle(document.body).backgroundColor;
  if (expandedImageUrl) URL.revokeObjectURL(expandedImageUrl);
  expandedImageUrl = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(element)], { type: "image/svg+xml" }),
  );
  return expandedImageUrl;
}

/**
 * Suspends until the renderer for the diagram's type loads. A diagram pele cannot
 * parse or does not support shows the error above its source.
 */
export function MermaidDiagram({
  source,
  onExpand,
}: {
  source: string;
  onExpand: (imageUrl: string) => void;
}) {
  const [, setAttempt] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const containerRef = useRef<HTMLSpanElement>(null);
  const trimmedSource = source.trim();
  const core = use(loadCore());
  const type = core.status === "loaded" ? detectDiagramType(core.pele, trimmedSource) : null;
  const load = core.status === "loaded" && type ? use(loadDiagramType(core.pele, type)) : core;

  // An unknown type mounts too, so pele reports it through onError like a parse error.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (load.status !== "loaded" || !container) return;
    const mounted = load.pele.mount(container, trimmedSource, {
      links: false,
      images: false,
      zoom: false,
      // Keep the author's direction; a wide diagram scales down to fit instead of turning vertical.
      autoDirection: false,
      sanitize: sanitizeDiagramSvg,
      onRender: () => setRenderError(null),
      onError: (error) =>
        setRenderError(
          error instanceof Error ? error.message : "The diagram could not be rendered.",
        ),
    });
    return () => mounted.destroy();
  }, [load, trimmedSource]);

  if (load.status === "failed") {
    return (
      <DiagramError
        message="The diagram renderer failed to load."
        source={source}
        onRetry={() => {
          if (core.status === "failed") coreLoad = null;
          if (type) diagramLoads.delete(type);
          setAttempt((attempt) => attempt + 1);
        }}
      />
    );
  }

  return (
    <div className="scroll-fade-x overflow-x-auto">
      {renderError ? <DiagramError message={renderError} source={source} /> : null}
      <button
        type="button"
        aria-label="Expand diagram"
        hidden={renderError !== null}
        className="block w-full cursor-zoom-in rounded-md focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => {
          const svg = containerRef.current?.querySelector("svg");
          if (svg) onExpand(diagramImageUrl(svg));
        }}
      >
        <span ref={containerRef} className="flex w-full justify-center" />
      </button>
    </div>
  );
}

function DiagramError({
  message,
  source,
  onRetry,
}: {
  message: string;
  source: string;
  onRetry?: () => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="m-0 text-xs text-destructive">Unable to render diagram: {message}</p>
        {onRetry ? (
          <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
      {/* Find matches the source through the hidden copy beside the diagram. */}
      <pre
        data-thread-find-ignore
        className="scroll-fade-y mt-2 mb-0 overflow-auto font-mono text-xs whitespace-pre-wrap"
      >
        {source}
      </pre>
    </div>
  );
}
