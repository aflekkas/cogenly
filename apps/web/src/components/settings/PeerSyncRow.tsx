import type { ReactNode } from "react";

import { peerSyncLabel, peerSyncTone, type PeerSyncIndicator } from "../../machines/peerSync.logic";
import { Badge } from "../ui/badge";
import { useStatusFade } from "./integrationStatusMotion";
import { SettingsRow } from "./settingsLayout";

/**
 * One paired machine and how a kind of synced data stands with it. Vault and
 * Memory both list machines with this row, so the indicator reads the same on
 * every page; `children` adds the page's own control after it.
 */
export function PeerSyncRow(props: {
  readonly machine: string;
  readonly indicator: PeerSyncIndicator;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
}) {
  const label = peerSyncLabel(props.indicator);
  const status = useStatusFade<HTMLDivElement>(label);
  return (
    <SettingsRow
      title={props.machine}
      description={props.description}
      control={
        <div className="flex items-center gap-2">
          <div ref={status} className="flex" role="status">
            <Badge size="sm" variant={peerSyncTone(props.indicator)}>
              {label}
            </Badge>
          </div>
          {props.children}
        </div>
      }
    />
  );
}
