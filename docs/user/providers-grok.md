# Grok

Cogenly runs xAI's Grok Build CLI with your Grok subscription login. Grok is off
until you add it.

## Set up

On the environment's machine, install the CLI and sign in:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok login
```

Then open **Settings → Providers**, choose **Add provider**, and pick **Grok**. If
Cogenly cannot find `grok`, set its **Binary path** (the installer puts it in
`~/.grok/bin`).

Cogenly uses your subscription, not an API key: it ignores `XAI_API_KEY` from the
machine's environment. To bill an API key instead, add it to the Grok instance's
**Environment variables**.

## What to expect

- Grok uses its own tools to read, edit, and run commands. In full-access Work,
  Cogenly approves them for you; in chats, it declines edits and commands.
- Grok cannot rewind its conversation, so restoring a checkpoint is unavailable on
  Grok threads.
- Steering a running turn is not supported; your message waits for the turn to end.

## Usage limits

**Usage → Limits** shows Grok's weekly pool and monthly limit when your plan has
them. They refresh after each Grok turn. If Grok has not reported them yet, sign
in with `grok login` on the environment's machine and refresh the provider.
