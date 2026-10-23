import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { DraftInput, type DraftInputProps } from "../ui/draft-input";
import { Input, type InputProps } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";

type SecretInputProps = Omit<InputProps, "type" | "autoComplete" | "defaultValue" | "value"> & {
  /** Whether the server already holds a value. Pass only the replacement draft as `value`. */
  readonly configured?: boolean;
  readonly value: string;
  readonly onCommit?: DraftInputProps["onCommit"];
  /**
   * Adds a show/hide toggle for the draft being typed. Saved values never come
   * back to the client, so this only ever reveals what the user just entered.
   */
  readonly revealable?: boolean;
};

/** Shared presentation for write-only settings. Clearing a saved value belongs to its form. */
export function SecretInput({
  configured = false,
  placeholder,
  onCommit,
  revealable = false,
  ...props
}: SecretInputProps) {
  const [revealed, setRevealed] = useState(false);
  const shared = {
    ...props,
    type: revealed ? ("text" as const) : ("password" as const),
    autoComplete: "off",
    spellCheck: false,
    placeholder: configured
      ? "Stored secret, enter a new value to replace"
      : (placeholder ?? "Not set"),
  };
  if (onCommit) {
    return (
      <DraftInput
        {...shared}
        onCommit={(next) => {
          if (configured && next === "") return;
          onCommit(next);
        }}
      />
    );
  }
  if (revealable) {
    return (
      <InputGroup>
        <InputGroupInput {...shared} />
        <InputGroupAddon align="inline-end">
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={revealed ? "Hide what you typed" : "Show what you typed"}
            aria-pressed={revealed}
            disabled={props.disabled}
            onClick={() => setRevealed((current) => !current)}
          >
            {revealed ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        </InputGroupAddon>
      </InputGroup>
    );
  }
  return <Input {...shared} />;
}
