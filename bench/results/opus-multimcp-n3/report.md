# code-mode benchmark report

Run: `2026-04-14T13-58-37-989Z`
Runs: 9 (1 tasks × up to 8 variants × 1 model(s))
Models: `claude-opus-4-6`

## multi-mcp-upsert

| Model | Variant | Status | Wall (ms) | Tokens (total) | Cost (USD) | Tool calls | Δ wall | Δ tokens | Δ cost | Δ calls |
|---|---|---|---|---|---|---|---|---|---|---|
| `claude-opus-4-6` | `baseline` | — | — | — | — | — | — | — | — | — |
| `claude-opus-4-6` | `code-mode-generic` | — | — | — | — | — | — | — | — | — |
| `claude-opus-4-6` | `code-mode-tailored` | — | — | — | — | — | — | — | — | — |
| `claude-opus-4-6` | `code-mode-plugin` | — | — | — | — | — | — | — | — | — |
| `claude-opus-4-6` | `code-mode-subagent` | — | — | — | — | — | — | — | — | — |
| `claude-opus-4-6` | `multi-mcp-baseline` | ok | 52,813 (45,760–69,335) | 398,669 (384,274–417,826) | $0.1436 | 7.0 (6.0–7.0) | n/a | n/a | — | n/a |
| `claude-opus-4-6` | `multi-mcp-codemode` | ok | 69,023 (57,375–74,560) | 301,491 (281,051–304,227) | $0.0808 | 5.0 (4.0–5.0) | n/a | n/a | — | n/a |
| `claude-opus-4-6` | `multi-mcp-block` | ok | 105,933 (96,533–124,987) | 670,335 (669,205–868,574) | $0.1805 | 12.0 (11.0–13.0) | n/a | n/a | — | n/a |
