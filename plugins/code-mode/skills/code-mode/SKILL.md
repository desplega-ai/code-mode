---
description: Use code-mode to save, search, and re-run typed TypeScript scripts instead of writing throwaway code
---

# code-mode

You have access to a persistent script library via the `code-mode` MCP server. Before writing a new throwaway script, **search first**.

## When to use

- The user asks you to do a task that looks like "hit an API, parse JSON, transform X, write a file" — these tend to repeat across sessions.
- You're about to write >20 lines of TypeScript that the user might want to re-run later.
- The user references a past script ("that thing we did last week for…").

## How to use

1. **`search`** with 2–3 keywords from the user's request. If a script matches, prefer `run` over writing new code.
2. **`queryTypes`** when you need a type signature from an indexed SDK before writing a script.
3. **`save`** after writing a useful script. Give it a short kebab-case name and a one-line doc-comment. The hook will reindex automatically.
4. **`run`** to execute a saved script. Pass args as JSON.
5. **`listSdks`** when the user asks what integrations are available.

## Don't

- Don't save one-off scripts the user explicitly called throwaway.
- Don't re-save a script that already exists under a similar name — update instead.
- Don't skip `search` at the start of a task. Duplicates are the main failure mode.
