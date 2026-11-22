---
name: contextual-rag-curator
description: Curates the AGY Project Library and Dual-Provider Contextual Retrieval Hybrid RAG index (Local ONNX fastembed default + optional gemini-embedding-2 cloud upgrade + SQLite FTS5 BM25 + RRF). Use when ingesting documents/PDFs/code into a project, promoting artifacts to the Library, or searching large project knowledge bases with line citations.
---

# Contextual Retrieval & Library Curation Runbook

## 1. Adaptive Threshold (`< 15,000` Tokens vs. Contextual RAG)
- **Below `autoPinLibraryTokenThreshold` (`15,000` tokens default):** Library items are marked `pinned` and automatically injected into the static `SessionStart` system prompt prefix for cached zero-loss reasoning.
- **At or above `15,000` tokens:** Items automatically switch to `indexed` mode using **Contextual Retrieval Hybrid RAG**:
  1. Structure-aware chunking along Markdown headings and AST class/function boundaries with exact `start_line`–`end_line` tracking.
  2. Situational `context_prefix` prepended to every chunk (`structural_offline` AST/breadcrumb header by default, or `gemini_flash_lite` semantic summary when cloud enrichment is enabled).
  3. Dual indexing into SQLite `FTS5` (`bm25` lexical rank) + dense `Float32Array` embeddings (`BAAI/bge-small-en-v1.5` `384d` local ONNX via `fastembed` by default, or `gemini-embedding-2` / `gemini-embedding-001` when `gemini_cloud` is enabled on a Paid `GEMINI_API_KEY`).
  4. Reciprocal Rank Fusion (`RRF`, `k = 60`) combining lexical + dense ranks.

## 2. File & PDF Ingestion Rules
- Call `ingest_library_item(sourcePath, category="input" | "output")`:
  - Uploaded `input` files enforce a `30 MB` default per-file cap.
  - PDFs `<= 100` pages support visual + text multimodal indexing (when `gemini-embedding-2` is active); `101–1,000` pages extract text-only; `> 1,000` pages are rejected.
- Always cite retrieved chunks using clickable `[basename](file:///absolute/path#Lstart-Lend)` links returned by `search_project_library`.
