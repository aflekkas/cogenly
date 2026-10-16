# Agent face engine (vendored)

Framework-free avatar engine vendored from
[bloub](https://github.com/jeremy-prt/bloub) by Jérémy Perret, MIT licensed
(see `LICENSE`). Upstream commit: `b4bb3c1b5f93c7b87a2e8d620f667c4093d97749`,
files from `src/bot/` (`cycles.ts` and the Vue/UI layer were not taken).

The numeric constants are measurements taken frame by frame off xAI's
reference video, not settings. Do not round or "tidy" them. Upstream's
`docs/measurements.md` lists the traps that must not be corrected.

Local changes are formatting only (repo formatter, semicolons, double quotes),
plus three mechanical lint fixes that do not change behaviour:

- `new Array(n).fill(x)` became `Array.from({ length: n }, () => x)`.
- Two `for` loops of `it(...)` in the tests became `it.each`.
- Test imports point at `vite-plus/test` instead of `vitest`.

Comments are left in French, as upstream wrote them.

`sample(t)` is a pure function of time with no clock and no DOM. Keep it
that way. The React renderer in `../AgentFace.tsx` owns the clock.
