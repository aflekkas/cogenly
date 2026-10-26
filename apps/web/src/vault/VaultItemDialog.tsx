import type {
  AgentId,
  ProjectLabelId,
  ProjectLabelWithRepositories,
  VaultItemMetadata,
  VaultItemType,
  VaultPortabilityReason,
} from "@cogenly/contracts";
import { useId, useState } from "react";

import { vaultPortabilityExplanation } from "../machines/peerSync.logic";
import { SecretInput } from "../components/settings/SecretInput";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import {
  VAULT_FIELDS_BY_TYPE,
  VAULT_TYPE_LABELS,
  VAULT_TYPES,
  vaultDraftFromItem,
  vaultDraftProblem,
  vaultTypeHasDomains,
  type VaultDraft,
  type VaultFormField,
} from "./vault.logic";
import { VaultAccessOptions } from "./VaultAccessOptions";

const ALL_PROJECTS = "all";

/** Metadata field names, which the server reports for stored secrets. */
const METADATA_FIELD = {
  username: "username",
  password: "password",
  totpSecret: "totp",
  value: "value",
  cardNumber: "cardNumber",
  cardExpiryMonth: "cardExpiry",
  cardExpiryYear: "cardExpiry",
  cardCvc: "cardCvc",
  cardholderName: "cardholderName",
} as const;

/**
 * Add or edit one vault item. Saved secrets never come back to the client, so
 * on edit the secret inputs start blank and only typed ones are sent.
 */
export function VaultItemDialog(props: {
  readonly item: VaultItemMetadata | null;
  readonly defaultScopeProjectId: ProjectLabelId | null;
  /** The type a new item starts as; "Add login" opens it as a login. */
  readonly defaultType?: VaultItemType;
  readonly labels: ReadonlyArray<ProjectLabelWithRepositories>;
  readonly agents: ReadonlyArray<{ readonly id: AgentId; readonly name: string }>;
  /** Whether this machine shares with others, so keeping an item here means something. */
  readonly paired: boolean;
  readonly onClose: () => void;
  readonly onSave: (draft: VaultDraft) => Promise<void>;
}) {
  const mode = props.item ? "edit" : "create";
  const idPrefix = useId();
  const [draft, setDraft] = useState(() =>
    vaultDraftFromItem(props.item, {
      scopeProjectId: props.defaultScopeProjectId,
      ...(props.defaultType ? { type: props.defaultType } : {}),
    }),
  );
  const [saving, setSaving] = useState(false);
  const problem = vaultDraftProblem(draft, mode);
  const update = (patch: Partial<VaultDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const save = async () => {
    if (problem !== null || saving) return;
    setSaving(true);
    try {
      await props.onSave(draft);
    } finally {
      setSaving(false);
    }
  };
  const fieldPlaceholder = (field: VaultFormField) => {
    if (field.key === "label") return field.placeholder;
    if (props.item?.fields.includes(METADATA_FIELD[field.key])) return "Unchanged";
    return props.item ? "Not set" : field.placeholder;
  };
  const scopeName = (id: ProjectLabelId | null) =>
    id === null
      ? "All projects"
      : (props.labels.find((label) => label.id === id)?.name ?? "A removed project");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{props.item ? `Edit ${props.item.name}` : "Add vault item"}</DialogTitle>
          <DialogDescription>
            Agents can use this without seeing it. Saved secrets cannot be viewed again.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="vault-item-editor"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={saving} className="space-y-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`${idPrefix}-type`}>Type</Label>
                  <Select
                    value={draft.type}
                    disabled={mode === "edit"}
                    onValueChange={(value) => {
                      if (value) update({ type: value as VaultItemType });
                    }}
                  >
                    <SelectTrigger id={`${idPrefix}-type`}>
                      <SelectValue>{VAULT_TYPE_LABELS[draft.type]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {VAULT_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {VAULT_TYPE_LABELS[type]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${idPrefix}-name`}>Name</Label>
                  <Input
                    id={`${idPrefix}-name`}
                    autoFocus
                    value={draft.name}
                    maxLength={200}
                    placeholder={draft.type === "login" ? "GitHub" : "github"}
                    aria-describedby={`${idPrefix}-name-hint`}
                    onChange={(event) => update({ name: event.currentTarget.value })}
                  />
                  <p id={`${idPrefix}-name-hint`} className="text-xs text-muted-foreground">
                    {draft.type === "login"
                      ? "The site's name. Several logins for one site share it."
                      : "Agents ask for the item by this name."}
                  </p>
                </div>
              </div>
              {VAULT_FIELDS_BY_TYPE[draft.type].map((field) => {
                const id = `${idPrefix}-${field.key}`;
                const placeholder = fieldPlaceholder(field);
                return (
                  <div key={`${draft.type}-${field.key}`} className="space-y-1.5">
                    <Label htmlFor={id}>{field.title}</Label>
                    {field.key === "label" ? (
                      <Input
                        id={id}
                        value={draft.label}
                        maxLength={200}
                        {...(placeholder ? { placeholder } : {})}
                        onChange={(event) => update({ label: event.currentTarget.value })}
                      />
                    ) : field.multiline ? (
                      <Textarea
                        id={id}
                        value={draft.secrets[field.key]}
                        spellCheck={false}
                        {...(placeholder ? { placeholder } : {})}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          update({ secrets: { ...draft.secrets, [field.key]: value } });
                        }}
                      />
                    ) : (
                      <SecretInput
                        id={id}
                        revealable
                        value={draft.secrets[field.key]}
                        {...(placeholder ? { placeholder } : {})}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          update({ secrets: { ...draft.secrets, [field.key]: value } });
                        }}
                      />
                    )}
                  </div>
                );
              })}
              {vaultTypeHasDomains(draft.type) ? (
                <div className="space-y-1.5">
                  <Label htmlFor={`${idPrefix}-domains`}>Allowed sites</Label>
                  <Input
                    id={`${idPrefix}-domains`}
                    value={draft.allowedDomains}
                    placeholder="github.com"
                    onChange={(event) => update({ allowedDomains: event.currentTarget.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Comma separated. Agents fill this item on these sites and their subdomains; any
                    other site asks you first.
                  </p>
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-scope`}>Available in</Label>
                <Select
                  value={draft.scopeProjectId ?? ALL_PROJECTS}
                  onValueChange={(value) =>
                    update({
                      scopeProjectId:
                        value === null || value === ALL_PROJECTS ? null : (value as ProjectLabelId),
                    })
                  }
                >
                  <SelectTrigger id={`${idPrefix}-scope`}>
                    <SelectValue>{scopeName(draft.scopeProjectId)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                    {props.labels.map((label) => (
                      <SelectItem key={label.id} value={label.id}>
                        {label.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <VaultPolicyFields
                idPrefix={idPrefix}
                draft={draft}
                agents={props.agents}
                onChange={update}
              />
              {props.paired && draft.portability !== null ? (
                <VaultPortabilityField
                  draft={draft}
                  reason={props.item?.portabilityReason}
                  onChange={update}
                />
              ) : null}
            </fieldset>
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button
            type="submit"
            form="vault-item-editor"
            disabled={problem !== null || saving}
            {...(problem ? { title: problem } : {})}
          >
            {props.item ? "Save" : "Add item"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Keep a shared item on this machine. A rule-held item shows checked and can't be changed. */
function VaultPortabilityField(props: {
  readonly draft: VaultDraft;
  readonly reason: VaultPortabilityReason | undefined;
  readonly onChange: (patch: Partial<VaultDraft>) => void;
}) {
  const byRule = props.reason !== undefined;
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={byRule || props.draft.portability === "machine"}
          disabled={byRule}
          onCheckedChange={(checked) =>
            props.onChange({ portability: checked === true ? "machine" : "shared" })
          }
        />
        Keep on this machine only
      </label>
      <p className="ps-6 text-xs text-muted-foreground">
        {byRule
          ? vaultPortabilityExplanation(props.reason)
          : "Machines you share the vault with don't get it. Machines that already have it keep their copy."}
      </p>
    </div>
  );
}

function VaultPolicyFields(props: {
  readonly idPrefix: string;
  readonly draft: VaultDraft;
  readonly agents: ReadonlyArray<{ readonly id: AgentId; readonly name: string }>;
  readonly onChange: (patch: Partial<VaultDraft>) => void;
}) {
  return (
    <VaultAccessOptions
      idPrefix={props.idPrefix}
      mode={props.draft.policyMode}
      agentIds={props.draft.policyAgentIds}
      agents={props.agents}
      onChange={(patch) =>
        props.onChange({
          ...(patch.mode === undefined ? {} : { policyMode: patch.mode }),
          ...(patch.agentIds === undefined ? {} : { policyAgentIds: patch.agentIds }),
          policyOwnerSet: true,
        })
      }
    />
  );
}
