# Activity log

On web and desktop, a run of consecutive tool calls and thinking appears as one card. While the
agent works, the card stays open and lists each call as it runs, with its result and duration once
it finishes. When the run is done the card collapses to one line, such as **Used 4 tools**, with
the total time and how many calls failed. Click the card to open it again, and click a call to
inspect its inputs, status, exit code, and output. A running command's output updates live, and
long output shows only its most recent part.

Thinking reads **Thinking** while it runs and **Thought for 4s** once it is done. Open it to read
the reasoning. Thinking between tool calls sits in the same card as the calls and does not count
as a tool.

When a call needs your approval, the card says **Waiting for approval** and the call offers Deny
and Allow in place. The approval panel above the composer answers the same request. A failed call
shows its error under its name.
