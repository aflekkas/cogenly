import { Settings2Icon } from "lucide-react";

import { ProjectColorDot } from "../../../projectLabels/ProjectTag";
import type { WorkProjectHeading } from "../../../projectLabels/projectLabels.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { SidebarModeGroupLabel } from "./SidebarModeGroupLabel";

/**
 * Work's project heading, above the repository headings it links. Null is
 * the closing "Other repositories" group for repositories no project links.
 */
export function WorkProjectGroupLabel(props: {
  project: WorkProjectHeading | null;
  onManage: () => void;
}) {
  const name = props.project?.name ?? "Other repositories";
  return (
    <SidebarModeGroupLabel
      className="mt-2 font-semibold text-sidebar-foreground/75"
      icon={props.project ? <ProjectColorDot color={props.project.color} /> : null}
      action={
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={props.project ? `Manage ${name}` : "Manage projects"}
                onClick={props.onManage}
                className="flex size-6 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground/70 outline-none state-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            <Settings2Icon aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {props.project ? "Manage projects" : "Link repositories to a project"}
          </TooltipPopup>
        </Tooltip>
      }
    >
      {name}
    </SidebarModeGroupLabel>
  );
}
