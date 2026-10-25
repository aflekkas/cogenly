import {
  HERO_INLINE_ICON_STYLE,
  ProjectFolderIcon,
  type ProjectIconProject,
} from "./ProjectFolderMark";

/** The headline owns motion; this slot keeps name changes from rewrapping it. */
export function HeroProjectSuffixText(props: {
  readonly name: string | null;
  readonly project: ProjectIconProject | null;
}) {
  if (props.name === null) return null;
  return (
    <span className="inline-flex w-[calc(16rem+3em)] max-w-full items-baseline justify-center whitespace-nowrap align-baseline">
      <span aria-hidden className="whitespace-pre">
        {" · in "}
      </span>
      <span className="inline-block max-w-64 min-w-0 truncate text-center underline decoration-foreground/30 decoration-from-font underline-offset-4 transition-colors duration-(--motion-duration-fast) group-hover/hero-suffix:decoration-foreground group-data-popup-open/hero-suffix:decoration-foreground">
        <ProjectFolderIcon
          project={props.project}
          className="inline-block"
          style={HERO_INLINE_ICON_STYLE}
        />
        {props.name}
      </span>
    </span>
  );
}
