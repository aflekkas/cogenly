import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ProjectIconColor } from "@t3tools/contracts";
import {
  getProjectFaviconResourceKey,
  isProjectFaviconFallbackUrl,
} from "@t3tools/shared/projectFavicon";
import {
  BoxesIcon,
  BoxIcon,
  FolderClosedIcon,
  FolderCodeIcon,
  FolderGitIcon,
  FolderIcon,
  HexagonIcon,
  LayersIcon,
  type LucideIcon,
} from "lucide-react";
import type { IconName } from "lucide-react/dynamic";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { projectFaviconUrlAtom } from "../state/assets";
import {
  deriveProjectIdentity,
  resolveProjectIconSource,
  type ProjectFallbackGlyph,
} from "../projectIdentity";
import { projectIconColorClassName } from "../projectIconColors";
import { cn } from "~/lib/utils";

const DynamicIcon = lazy(() =>
  import("lucide-react/dynamic").then((module) => ({ default: module.DynamicIcon })),
);

function DynamicProjectIconFallback() {
  return <FolderCodeIcon className="size-full text-inherit" />;
}

const FALLBACK_GLYPH_ICONS: Record<ProjectFallbackGlyph, LucideIcon> = {
  folder: FolderIcon,
  "folder-git": FolderGitIcon,
  "folder-code": FolderCodeIcon,
  "folder-closed": FolderClosedIcon,
  box: BoxIcon,
  boxes: BoxesIcon,
  hexagon: HexagonIcon,
  layers: LayersIcon,
};

// The slice of a project that decides its icon. Every surface must pass the
// project record itself (or a snapshot spread from it) so the saved title, favicon
// and icon override always travel together. Passing a display label as the title
// changes the automatic icon, which is how the command palette drifted once.
export type ProjectFaviconProject = Pick<
  EnvironmentProject,
  "environmentId" | "workspaceRoot" | "title" | "faviconPath" | "projectIcon"
>;

/**
 * A project's icon. Resolution order lives in `resolveProjectIconSource`:
 * the icon picked in project settings, then the repository's favicon, then a
 * neutral glyph. `fallback` replaces that glyph where a surface has its own
 * mark for a repository without an icon (Work's tinted repository badge).
 */
export function ProjectFavicon(input: {
  project: ProjectFaviconProject;
  className?: string | undefined;
  fallback?: ReactNode;
}) {
  const { project } = input;
  const url = useAtomValue(
    projectFaviconUrlAtom({
      environmentId: project.environmentId,
      cwd: project.workspaceRoot,
      faviconPath: project.faviconPath,
    }),
  );
  const source = resolveProjectIconSource({
    projectIcon: project.projectIcon,
    faviconSrc: url && !isProjectFaviconFallbackUrl(url) ? url : null,
    projectName: project.title,
  });

  if (source.kind === "favicon") {
    const cacheKey = getProjectFaviconResourceKey(
      project.environmentId,
      project.workspaceRoot,
      project.faviconPath,
    );
    return (
      <ProjectFaviconImage
        key={cacheKey}
        src={source.src}
        className={input.className}
        fallbackProjectName={project.title}
        fallback={input.fallback}
      />
    );
  }
  if (source.kind === "fallback") {
    return (
      input.fallback ?? (
        <ProjectFallbackGlyphIcon projectName={project.title} className={input.className} />
      )
    );
  }

  const icon = source.icon;
  if (icon.kind === "emoji") {
    // Emoji icons are retired. One saved earlier shows the project's neutral glyph.
    return <ProjectFallbackGlyphIcon projectName={project.title} className={input.className} />;
  }
  if (icon.kind === "monogram") {
    // Monograms are retired. One saved earlier keeps its colour on the
    // project's neutral glyph instead of showing letters.
    return (
      <ProjectFallbackGlyphIcon
        projectName={project.title}
        color={icon.color}
        className={input.className}
      />
    );
  }
  const colorClassName = projectIconColorClassName(icon.color);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center",
        colorClassName,
        input.className,
      )}
    >
      <Suspense fallback={<DynamicProjectIconFallback />}>
        <DynamicIcon
          name={icon.name as IconName}
          className={cn("size-full", colorClassName)}
          fallback={DynamicProjectIconFallback}
        />
      </Suspense>
    </span>
  );
}

/** The neutral glyph for a project with no picked icon and no favicon. */
export function ProjectFallbackGlyphIcon({
  projectName,
  color,
  className,
}: {
  readonly projectName: string;
  readonly color?: ProjectIconColor | undefined;
  readonly className?: string | undefined;
}) {
  const identity = deriveProjectIdentity(projectName);
  const Icon = FALLBACK_GLYPH_ICONS[identity.glyph];
  // Wrapped so the glyph sits where an <img> favicon would: menu items and
  // buttons pull bare svgs in with [&_svg]:-mx-0.5, which would shift it.
  return (
    <span
      aria-hidden="true"
      data-project-fallback-glyph={identity.glyph}
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center",
        color === undefined && "opacity-80",
        projectIconColorClassName(color ?? identity.color),
        className,
      )}
    >
      <Icon className="size-full" />
    </span>
  );
}

// Favicons that have loaded once. An icon that mounts again (a picked
// repository, the heading of the draft a pick opens) shows its image at once,
// instead of painting the fallback until the cached image reports in.
const loadedFaviconSrcs = new Set<string>();

function ProjectFaviconImage({
  src,
  className,
  fallbackProjectName,
  fallback,
}: {
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackProjectName: string;
  readonly fallback?: ReactNode;
}) {
  const [displayedSrc, setDisplayedSrc] = useState<string | null>(() =>
    src.startsWith("data:image/") || loadedFaviconSrcs.has(src) ? src : null,
  );
  const isLoading = displayedSrc !== src;
  const handleLoadError = (failedSrc: string) => {
    loadedFaviconSrcs.delete(failedSrc);
    setDisplayedSrc((currentSrc) => (currentSrc === failedSrc ? null : currentSrc));
  };

  return (
    <>
      {displayedSrc === null
        ? (fallback ?? (
            <ProjectFallbackGlyphIcon projectName={fallbackProjectName} className={className} />
          ))
        : null}
      {displayedSrc ? (
        <img
          src={displayedSrc}
          alt=""
          className={cn("size-3.5 shrink-0 rounded-[25%] object-contain", className)}
          onError={() => handleLoadError(displayedSrc)}
        />
      ) : null}
      {isLoading ? (
        <img
          src={src}
          alt=""
          className="hidden"
          onLoad={() => {
            loadedFaviconSrcs.add(src);
            setDisplayedSrc(src);
          }}
          onError={() => handleLoadError(src)}
        />
      ) : null}
    </>
  );
}
