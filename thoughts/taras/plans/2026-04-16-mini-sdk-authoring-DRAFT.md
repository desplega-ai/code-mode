---
date: 2026-04-16
status: draft — expand with /desplega:create-plan after N=3+2 sweep confirms base win
owner: taras+claude
parent:
  - bench-log/2026-04-16-mcpbench-metwiki-phase-d-compounding.md (Phase D negative: named-call reuse didn't fire because auto-saved scripts are task-instance-specific)
  - thoughts/taras/plans/2026-04-16-metwiki-N3-plus-two-tasks-sweep.md (prerequisite: confirm code-mode wins at all before building on top)
---

# DRAFT — Mini-SDK authoring as a reusable-helper workflow

Seed for a future full plan. Not ready for implementation. Expand with
`/desplega:create-plan` once the N=3+2 sweep validates that code-mode's
base win on Met+Wiki generalizes — otherwise this is premature.

## Hypothesis

The right compounding primitive isn't "auto-save every successful run"
(Phase D showed those end up task-instance-specific and get used as
reference at best, never called). The right primitive is **typed,
parameterized helpers under `.code-mode/sdks/user/<area>/`** — mini
SDKs that evolve over time and that orchestration scripts call by name.

Scripts are orchestration (throwaway; bake in this-run's data); SDKs
are reusable (typed inputs; compose). The directory split already
exists (`.code-mode/sdks/` vs `.code-mode/scripts/`); what's missing
is tool UX + agent incentives to build SDKs deliberately.

## Taras's design calls (2026-04-16 session)

1. **Who writes `sdks/user/`?** The agent, via an extended `save` tool
   (not a new tool).
2. **Edit semantics?** Agent or human. Filesystem is source of truth;
   reindex catches disk-side edits.
3. **What enforces quality?** The existing typecheck gate at save
   time. "You can only be in a good state" — no broken helpers on disk.
4. **How does the agent discover helpers?** Sessionstart gains a tiny
   mention of available user-SDK helpers alongside the stdlib list.

## Minimum-viable feature scope

Extension of existing surface; no new tools, no new subsystem.

- **`save` tool** gains `scope: "script" | "sdk"` (default `"script"`):
  - `scope: "script"` → `.code-mode/scripts/<name>.ts` (today's behavior).
  - `scope: "sdk"` → `.code-mode/sdks/<name>.ts` (name may nest:
    `user/met/fetchMonetByIds` → `sdks/user/met/fetchMonetByIds.ts`;
    sdk_name derived from dir).
  - Same `intent` requirement, same typecheck gate, same reindex path.
- **Validation rules for `scope: "sdk"`** (before typecheck):
  1. Must contain at least one `export function` / `export const = fn` /
     `export class`.
  2. Exported function parameters must have explicit types (detected
     via the ts-morph pass already in the typecheck flow — zero extra
     cost).
  3. Reject bodies whose only export is `default async function main(...)`
     — that's orchestration, wrong scope. Helpful error message pointing
     at `scope: "script"`.
  4. All rejections flow through the existing typecheck failure path
     (diagnostics in response, file removed).
- **Sessionstart** adds a user-SDK callout — render only when non-empty.
  `scanSdks` already enumerates; we split into stdlib / generated /
  user buckets in the rendered summary.
- **Tool descriptions** teach the split:
  - `run`: unchanged — orchestration, calls SDK helpers.
  - `save scope: "script"`: "promote a useful orchestration pattern."
  - `save scope: "sdk"`: "extract a typed, parameterized helper that
    other scripts (and future sessions) can call by name."
  - Sessionstart routing block gains one line: "when you write an
    inline helper that could run again with different inputs, promote
    it to `sdks/user/<area>/` via `save` with `scope: 'sdk'`."

## Trade-offs to resolve during full plan

1. **Collision policy when `sdks/user/met/fetchByIds.ts` already exists:**
   default `overwrite: false`, hash-dedupe on match, reject if hash
   differs and `overwrite !== true`. Matches current `save` behavior
   for scripts. Keeps human edits safe from accidental agent clobber.
2. **Signature evolution.** First cut has no versioning. If the agent
   changes a helper signature, existing scripts that called the old
   signature fail typecheck on next use. Accept this cost; revisit
   if it becomes a real pain point.
3. **SDK bloat prevention.** Helpers with one caller are probably
   noise; helpers with 3+ callers are gold. Out of scope for v1 —
   filesystem growth on its own isn't the pain point; search-corpus
   noise is, and that gets mitigated by the "default SDK search scope"
   plus the typed-signature gate already filtering out low-quality
   saves.
4. **Does auto-save stay?** Yes — still useful as an audit trail and
   as reference material for the agent. But get a small description
   nudge pointing at SDK promotion as the explicit reuse path.

## Explicit non-goals (v1)

- Auto-extract: no automatic "detect a reusable function in an inline
  run and write it to sdks/ on the agent's behalf." Explicit, agent-
  initiated promotion only.
- Edit-in-place beyond save-with-overwrite.
- Versioning / semver / migration tooling.
- Per-helper test scaffolding. Typecheck is the only gate.
- Cross-session discovery of popular helpers across workspaces — v1
  is per-workspace only.

## Open design questions for the full plan

1. **Naming convention.** `user/<area>/<name>.ts` (what I sketched)
   vs flat `user-<area>-<name>.ts` vs anything-agent-wants? Nesting
   makes `scanSdks` treat each subdirectory as its own SDK, which
   matches the current generated/* shape.
2. **What does the agent see at session start?** Just helper names +
   counts, or full typed signatures inline? Full signatures are more
   useful but inflate context. Maybe "top N most-recently-saved" plus
   pointer to `__query_types` for full lookup.
3. **Promote-after-the-fact UX.** When the agent writes an inline run
   that contains a reusable-looking function, should the `run` result
   hint at promotion? Could be: "this looks like a parameterized
   helper — consider `save` with scope: 'sdk'." Adds a second
   passive-hint surface to the MCP result shape.
4. **Auto-save + SDK coexistence.** Do we dedupe across both drawers?
   E.g., if a helper in `sdks/user/` shares a hash with an auto-save
   in `scripts/auto/`, do we garbage-collect the auto-save? Probably
   yes — once promoted, the auto-save is the inferior copy.

## Prerequisite before building

**Run the N=3+2 sweep first**
(`thoughts/taras/plans/2026-04-16-metwiki-N3-plus-two-tasks-sweep.md`).
If Met+Wiki win doesn't hold or doesn't generalize, mini-SDK is
premature optimization — we'd be building authoring UX on top of a
routing layer that doesn't pay off. Sweep results directly inform
whether this plan goes live or gets shelved.

## References

- `packages/core/src/mcp/handlers/save.ts` — current save path; needs
  scope arg + validation.
- `packages/core/src/mcp/server.ts` TOOL_DEFS — schema update.
- `packages/core/src/index/reindex.ts` — sdks/ scan logic is here;
  verify user/* bucket picks up correctly.
- `plugins/code-mode/hooks/sessionstart.mjs` — routing block + SDK
  enumeration.
- `plugins/code-mode/hooks/_shared.mjs` `scanSdks` / `renderSdkSummary`
  — user-SDK rendering split.
