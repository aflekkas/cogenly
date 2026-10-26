import type { AgentId } from "@cogenly/contracts";

import { Badge } from "../components/ui/badge";
import { Checkbox } from "../components/ui/checkbox";
import { Label } from "../components/ui/label";
import { Radio, RadioGroup } from "../components/ui/radio-group";
import type { VaultPolicyMode } from "./vault.logic";

const ACCESS_OPTIONS: ReadonlyArray<{
  readonly mode: VaultPolicyMode;
  readonly title: string;
  readonly description: string;
}> = [
  {
    mode: "allow",
    title: "Allow for agents on its allowed sites",
    description:
      "Your chats, Work and agents fill it on its sites without asking. Any other site asks you first.",
  },
  {
    mode: "ask",
    title: "Ask me first",
    description: "Every agent use waits for your approval.",
  },
  {
    mode: "deny",
    title: "Block agents",
    description: "Agents can't use it. You can still use it yourself.",
  },
];

/**
 * Who may use a vault item without asking, as the item dialog and the Logins
 * detail pane both edit it. The default rule comes first and says so.
 */
export function VaultAccessOptions(props: {
  readonly idPrefix: string;
  readonly mode: VaultPolicyMode;
  readonly agentIds: ReadonlyArray<AgentId>;
  readonly agents: ReadonlyArray<{ readonly id: AgentId; readonly name: string }>;
  readonly disabled?: boolean;
  readonly onChange: (patch: {
    readonly mode?: VaultPolicyMode;
    readonly agentIds?: ReadonlyArray<AgentId>;
  }) => void;
}) {
  const labelId = `${props.idPrefix}-access`;
  const toggleAgent = (id: AgentId, checked: boolean) =>
    props.onChange({
      agentIds: checked ? [...props.agentIds, id] : props.agentIds.filter((other) => other !== id),
    });
  return (
    <div className="space-y-2">
      <Label id={labelId} render={<div />}>
        Access
      </Label>
      <RadioGroup
        aria-labelledby={labelId}
        value={props.mode}
        disabled={props.disabled}
        onValueChange={(value) => props.onChange({ mode: value as VaultPolicyMode })}
      >
        {ACCESS_OPTIONS.map((option) => (
          <label key={option.mode} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 flex">
              <Radio value={option.mode} />
            </span>
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-1.5">
                {option.title}
                {option.mode === "allow" ? (
                  <Badge size="sm" variant="outline">
                    Default
                  </Badge>
                ) : null}
              </span>
              <span className="block text-xs text-muted-foreground">{option.description}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
      {props.mode === "allow" && props.agents.length > 0 ? (
        <div className="reveal-motion space-y-2 ps-6">
          {props.agents.map((agent) => (
            <label key={agent.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={props.agentIds.includes(agent.id)}
                disabled={props.disabled}
                onCheckedChange={(checked) => toggleAgent(agent.id, checked === true)}
              />
              Only {agent.name}
            </label>
          ))}
          <p className="text-xs text-muted-foreground">
            {props.agentIds.length === 0
              ? "None selected allows every chat and agent."
              : "Other chats and agents ask first."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
