import { type EnvironmentId, sessionGrantsScope } from "@cogenly/contracts";
import { AUTH_SCOPE_OPTIONS } from "@cogenly/shared/authScopeOptions";
import { useEnvironmentSessionState } from "~/state/session";

import { SettingsStatusText } from "./SettingsStatus";

/**
 * What this client's session may do on a machine. In a route list
 * (`routeContext`) it says the list is for the active route; elsewhere the
 * row that folds it names what it is.
 */
export function SessionPermissions({
  environmentId,
  connected,
  routeContext = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly routeContext?: boolean;
}) {
  const session = useEnvironmentSessionState(environmentId);
  return connected && !session.hasError && !session.isPending && session.data?.authenticated ? (
    <div className="space-y-3 py-3 text-xs">
      {routeContext ? (
        <p className="text-muted-foreground">
          These permissions apply to your active route. Other routes may have different permissions.
        </p>
      ) : null}
      <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {AUTH_SCOPE_OPTIONS.map(({ scope, title }) => {
          const allowed = sessionGrantsScope(session.data!, scope);
          return (
            <li key={scope} className="flex items-start justify-between gap-3">
              <span>{title}</span>
              <SettingsStatusText
                tone={allowed ? "success" : "neutral"}
                className="shrink-0 text-muted-foreground"
              >
                {allowed ? "Allowed" : "Not granted"}
              </SettingsStatusText>
            </li>
          );
        })}
      </ul>
    </div>
  ) : (
    <p className="py-3 text-xs text-muted-foreground">
      Permissions not checked. Connect to this machine to view this session’s permissions.
    </p>
  );
}
