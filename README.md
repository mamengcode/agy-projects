# AGY Projects (`agy-projects` v1.0.0)

Clean-sheet native Google Antigravity plugin replicating **Claude Code Projects** (`claude.ai/code` Coordinator + Parallel Worker Threads + Contextual Retrieval Library + `MEMORY.md` + Multi-Repo PR Auto-Fix + Scheduled Routines).

## Highlights
- **Collision-Free Storage:** Stores global registry, `uv` Python venv, and cached ONNX models in `$PLUGIN_DATA`, and per-workspace project state in `<workspace>/.agy-project/` backed by Node 26 `node:sqlite` (`WAL` + `FTS5`).
- **Strict Opt-In Scoping:** Lifecycle hooks (`hooks.json`) return `{}` in `<10ms` for unbound chats so normal Antigravity sessions are untouched.
- **Dual-Provider Contextual Retrieval (2C):** Defaults to 100% air-gapped Local ONNX (`BAAI/bge-small-en-v1.5` via `fastembed`) + SQLite FTS5 BM25 + Reciprocal Rank Fusion (`RRF`), with an optional `Settings > Memory` switch to `gemini-embedding-2` (`8,192`-token multimodal) or `gemini-embedding-001` on a Paid `GEMINI_API_KEY`.
- **Typed SDK Background Loops (3A):** Sidecar daemon (`sidecars/project_hub/daemon.cjs`) runs a 60s `gh pr view` Auto-Fix watcher (3-strike circuit breaker) and 30s Cron scheduler via `google.antigravity.Agent` with live SSE telemetry and instant `Pause Project` cancellation.
