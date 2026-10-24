import { CopyButton } from "../ui/copy-button";

/** Longer values (a Slack manifest, a scope list) copy from a button instead of filling the step. */
const INLINE_MAX_LENGTH = 160;

/** "Authorized redirect URI" -> "authorized redirect URI", for use mid-sentence. */
const inSentence = (label: string) =>
  label.replace(/^[A-Z](?=[a-z])/, (first) => first.toLowerCase());

/**
 * Something a setup step asks the user to paste elsewhere: a command, a
 * redirect address. Short values show in full beside their copy button; long
 * ones are only a labelled copy button. Machines and Integrations both use it.
 */
export function CopyableValue(props: {
  readonly value: string;
  /** What it is, e.g. "Command" or "Authorized redirect URI". */
  readonly label: string;
}) {
  const name = inSentence(props.label);
  if (props.value.length > INLINE_MAX_LENGTH) {
    return (
      <CopyButton
        size="xs"
        variant="outline"
        value={props.value}
        label={`Copy ${name}`}
        target={name}
      >
        Copy {name}
      </CopyButton>
    );
  }
  return (
    <div className="flex items-start gap-1 rounded-md bg-muted/60 px-2 py-1.5">
      <code className="min-w-0 flex-1 font-mono text-xs break-all text-foreground">
        {props.value}
      </code>
      <CopyButton value={props.value} label={`Copy ${name}`} target={name} />
    </div>
  );
}
