# Muse

Cogenly uses Muse Code's login on the environment's machine. Install it there:

```bash
curl -fsSL https://api.meta.ai/install.sh | bash
muse login
```

The default Muse provider is enabled without configuration. If Cogenly cannot
find the CLI, set its **Binary path** in **Settings → Providers**. Authentication
problems surface on the first turn rather than in provider status, so run
`muse login` on that machine if a turn fails to start. Cogenly ignores an
inherited `META_API_KEY` so Muse uses its login; set the variable on the
instance itself to override that.

Add another Muse instance in **Settings → Providers** for a separate account or
configuration, each with its own binary path and environment variables.

## Permissions

Muse threads run with full access: Cogenly's permission modes and approval
prompts do not apply yet. Muse's own workspace trust and sandbox settings
still apply outside Cogenly.

## Usage and limits

Muse work appears on **Usage** alongside the other providers, including
sessions run outside Cogenly. Muse models have no automatic price, so their
tokens count but show no cost until you [set a price](./usage.md#set-custom-model-prices).

Subscription session and weekly windows appear under **Usage → Limits** once
Muse reports them. A freshly started environment may show no limits until the
first turn or status refresh produces a reading.
