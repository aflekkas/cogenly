import { SettingsGroup } from "./SettingsGroup";
import type { ReactNode } from "react";

import { DisclosureChevron } from "../ui/disclosure";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  SettingsDisclosure,
  SettingsSectionHeader,
  useSearchTargetFold,
  useSettingsSearchTarget,
} from "./settingsLayout";

/**
 * A grouped settings section that starts closed. `inside` puts the fold's
 * header in the card: the title, a one line summary of what is set inside,
 * and an optional control such as the section's own switch. `outside` folds
 * the whole card under a section heading, for sections kept out of the way.
 * A settings search that targets the section, or one of `targetIds` inside
 * it, opens it.
 */
export function FoldedSettingsSection({
  id,
  targetIds,
  title,
  summary,
  control,
  headerPlacement = "inside",
  children,
}: {
  readonly id: string;
  readonly targetIds?: readonly string[];
  readonly title: ReactNode;
  readonly summary?: string | null;
  readonly control?: ReactNode;
  readonly headerPlacement?: "inside" | "outside";
  readonly children: ReactNode;
}) {
  return headerPlacement === "outside" ? (
    <OutsideFold id={id} targetIds={targetIds} title={title} control={control}>
      {children}
    </OutsideFold>
  ) : (
    <InsideFold id={id} targetIds={targetIds} title={title} summary={summary} control={control}>
      {children}
    </InsideFold>
  );
}

function InsideFold({
  id,
  targetIds,
  title,
  summary,
  control,
  children,
}: {
  readonly id: string;
  readonly targetIds: readonly string[] | undefined;
  readonly title: ReactNode;
  readonly summary: string | null | undefined;
  readonly control: ReactNode;
  readonly children: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLElement>(id);
  return (
    <section id={id} ref={targetRef} tabIndex={-1} className="outline-none">
      <SettingsGroup divided={false}>
        <SettingsDisclosure
          id={id}
          {...(targetIds ? { targetIds } : {})}
          title={title}
          summary={summary}
          control={control}
        >
          {children}
        </SettingsDisclosure>
      </SettingsGroup>
    </section>
  );
}

function OutsideFold({
  id,
  targetIds,
  title,
  control,
  children,
}: {
  readonly id: string;
  readonly targetIds: readonly string[] | undefined;
  readonly title: ReactNode;
  readonly control: ReactNode;
  readonly children: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLElement>(id);
  const [open, setOpen] = useSearchTargetFold(id, targetIds);
  return (
    <section id={id} ref={targetRef} tabIndex={-1} className="outline-none">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="space-y-2.5">
          <SettingsSectionHeader
            title={
              <CollapsibleTrigger className="flex min-h-7 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                {title}
                <DisclosureChevron />
              </CollapsibleTrigger>
            }
            headerAction={control}
          />
          <CollapsiblePanel>
            <SettingsGroup>{children}</SettingsGroup>
          </CollapsiblePanel>
        </div>
      </Collapsible>
    </section>
  );
}
