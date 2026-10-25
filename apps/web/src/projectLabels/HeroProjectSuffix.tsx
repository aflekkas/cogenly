import { InlineButton } from "../components/ui/button";
import {
  HERO_INLINE_ICON_STYLE,
  ProjectFolderIcon,
  type ProjectIconProject,
} from "./ProjectFolderMark";

/** The headline owns motion; this slot keeps name changes from rewrapping it. */
export function HeroProjectSuffixText(props: {
  readonly name: string | null;
  readonly project: ProjectIconProject | null;
  readonly open?: boolean;
}) {
  if (props.name === null) return null;
  return (
    <span className="inline-flex w-[calc(16rem+3em)] max-w-full items-baseline justify-center whitespace-nowrap align-baseline">
      <span aria-hidden className="whitespace-pre">
        {" · in "}
      </span>
      <InlineButton
        tone="picker"
        render={<span />}
        tabIndex={-1}
        className="max-w-64 min-w-0 align-baseline"
        data-popup-open={props.open ? "" : undefined}
      >
        <span className="block min-w-0 truncate">
          <ProjectFolderIcon
            project={props.project}
            className="inline-block"
            style={HERO_INLINE_ICON_STYLE}
          />
          {props.name}
        </span>
      </InlineButton>
    </span>
  );
}
