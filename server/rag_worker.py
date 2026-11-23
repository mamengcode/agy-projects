#!/usr/bin/env python3
"""Self-bootstrapping RAG & Headless Antigravity SDK worker for agy-projects."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import fcntl
import inspect
import io
import json
import os
import random
import re
import signal
import sqlite3
import struct
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


def get_data_dir() -> Path:
    env_dir = os.environ.get("AGY_PROJECTS_DATA_DIR", "").strip()
    if env_dir:
        p = Path(env_dir).expanduser().resolve()
    else:
        app_dir = os.environ.get("ANTIGRAVITY_APP_DATA_DIR", "").strip()
        base = Path(app_dir).expanduser().resolve() if app_dir else (Path.home() / ".gemini" / "antigravity")
        p = base / "plugin_data" / "agy-projects"
    p.mkdir(parents=True, exist_ok=True)
    return p


def ensure_venv_and_reexec() -> None:
    data_dir = get_data_dir()
    venv_dir = data_dir / "venv"
    venv_python = venv_dir / "bin" / "python"
    marker = venv_dir / ".deps_ready_v2"

    current_exe = Path(sys.executable).resolve()
    if venv_python.exists() and marker.exists():
        if current_exe != venv_python.resolve():
            os.execv(str(venv_python), [str(venv_python), *sys.argv])
        return

    # Bootstrap isolated uv venv using Python 3.11/3.12 (for prebuilt onnxruntime + SDK wheels)
    uv_bin = "uv"
    for candidate in ("/opt/homebrew/bin/uv", "/usr/local/bin/uv", str(Path.home() / ".local" / "bin" / "uv")):
        if Path(candidate).exists():
            uv_bin = candidate
            break

    if not venv_python.exists():
        res = subprocess.run(
            [uv_bin, "venv", "--python", "3.11", str(venv_dir)],
            capture_output=True,
            text=True,
        )
        if res.returncode != 0:
            subprocess.run([uv_bin, "venv", str(venv_dir)], check=True, capture_output=True, text=True)

    # Install Dual-Provider RAG + PDF/Image extractor + Antigravity Python SDK packages
    packages = ["fastembed", "google-genai", "pypdf", "pillow", "google-antigravity"]
    install_res = subprocess.run(
        [uv_bin, "pip", "install", "--python", str(venv_python), *packages],
        capture_output=True,
        text=True,
    )
    if install_res.returncode != 0:
        # Install core RAG/extraction deps even if google-antigravity wheel requires separate install
        subprocess.run(
            [uv_bin, "pip", "install", "--python", str(venv_python), "fastembed", "google-genai", "pypdf", "pillow"],
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            [uv_bin, "pip", "install", "--python", str(venv_python), "google-antigravity"],
            capture_output=True,
            text=True,
        )

    marker.write_text("ok\n", encoding="utf-8")
    if current_exe != venv_python.resolve():
        os.execv(str(venv_python), [str(venv_python), *sys.argv])


def load_project_config(workspace: Path) -> dict:
    cfg_path = workspace / ".agy-project" / "config.json"
    if not cfg_path.exists():
        return {}
    return json.loads(cfg_path.read_text(encoding="utf-8"))


def get_active_embedding_spec(cfg: dict) -> tuple[str, str]:
    mem = cfg.get("memory") or {}
    provider = mem.get("embeddingProvider") or "local_onnx"
    if provider == "gemini_cloud":
        return ("gemini_cloud", mem.get("cloudEmbeddingModel") or "gemini-embedding-2")
    return ("local_onnx", mem.get("localEmbeddingModel") or "BAAI/bge-small-en-v1.5")


def get_header_mode(cfg: dict) -> str:
    mem = cfg.get("memory") or {}
    return str(mem.get("contextualHeaderMode") or "structural_offline")


def pack_f32(vec: list[float]) -> bytes:
    return struct.pack(f"<{len(vec)}f", *[float(x) for x in vec])


def _is_retryable_gemini_error(exc: Exception) -> bool:
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    if code in (429, 503, "429", "503"):
        return True
    msg = str(exc).upper()
    return any(tok in msg for tok in ("429", "RESOURCE_EXHAUSTED", "503", "UNAVAILABLE", "RATE LIMIT", "TOO MANY REQUESTS"))


def call_gemini_with_backoff(fn, max_retries: int = 4, base_delay: float = 1.0, sleep_fn=time.sleep):
    attempt = 0
    while True:
        try:
            return fn()
        except Exception as exc:
            if attempt >= max_retries or not _is_retryable_gemini_error(exc):
                raise
            delay = base_delay * (2 ** attempt) + random.uniform(0.05, 0.35)
            sleep_fn(delay)
            attempt += 1


def _extract_pdf(file_path: Path) -> dict:
    from pypdf import PdfReader

    reader = PdfReader(str(file_path))
    page_count = len(reader.pages)
    if page_count > 1000:
        return {
            "ok": False,
            "pageCount": page_count,
            "error": f"Uploaded file '{file_path.name}' is too large ({page_count} pages; maximum supported is 1,000 pages).",
        }
    pdf_mode = "visual_and_text" if page_count <= 100 else "text_only"
    pages: list[str] = []
    for idx, page in enumerate(reader.pages):
        try:
            txt = (page.extract_text() or "").strip()
        except Exception:
            txt = ""
        pages.append(f"## Page {idx + 1}\n{txt}" if txt else f"## Page {idx + 1}\n[Visual / Non-Text Page]")
    return {
        "ok": True,
        "pageCount": page_count,
        "pdfMode": pdf_mode,
        "text": "\n\n".join(pages),
    }


def _extract_docx(file_path: Path) -> str:
    w_ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    paragraphs: list[str] = []
    with zipfile.ZipFile(file_path, "r") as zf:
        if "word/document.xml" not in zf.namelist():
            return ""
        root = ET.fromstring(zf.read("word/document.xml"))
        for p in root.iter(f"{w_ns}p"):
            runs = [t.text for t in p.iter(f"{w_ns}t") if t.text]
            line = "".join(runs).strip()
            if line:
                paragraphs.append(line)
    return "\n".join(paragraphs)


def _extract_xlsx(file_path: Path) -> str:
    s_ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    sections: list[str] = []
    with zipfile.ZipFile(file_path, "r") as zf:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            s_root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in s_root.iter(f"{s_ns}si"):
                shared.append("".join(t.text or "" for t in si.iter(f"{s_ns}t")))

        sheet_names = sorted(n for n in zf.namelist() if re.match(r"^xl/worksheets/sheet\d+\.xml$", n))
        for s_path in sheet_names:
            w_root = ET.fromstring(zf.read(s_path))
            rows_out: list[str] = []
            for row in w_root.iter(f"{s_ns}row"):
                cells: list[str] = []
                for c in row.iter(f"{s_ns}c"):
                    c_type = c.attrib.get("t", "")
                    if c_type == "inlineStr":
                        val = "".join(t.text or "" for t in c.iter(f"{s_ns}t"))
                    else:
                        v_el = c.find(f"{s_ns}v")
                        raw_v = v_el.text if v_el is not None and v_el.text is not None else ""
                        if c_type == "s" and raw_v.isdigit():
                            idx = int(raw_v)
                            val = shared[idx] if 0 <= idx < len(shared) else raw_v
                        else:
                            val = raw_v
                    cells.append(val)
                if any(cell != "" for cell in cells):
                    rows_out.append("\t".join(cells))
            if rows_out:
                sections.append(f"## Sheet ({Path(s_path).stem})\n" + "\n".join(rows_out))
    return "\n\n".join(sections)


def _extract_image_summary(file_path: Path) -> str:
    try:
        from PIL import Image

        with Image.open(file_path) as img:
            return f"[Image Asset: {file_path.name} ({img.width}x{img.height} {img.format or 'IMG'})]"
    except Exception:
        return f"[Image Asset: {file_path.name}]"


def cmd_extract_doc(file_path: Path, mime_type: str) -> int:
    if not file_path.exists():
        print(json.dumps({"ok": False, "error": f"File not found: {file_path}"}))
        return 1
    suffix = file_path.suffix.lower()
    if mime_type == "application/pdf" or suffix == ".pdf":
        res = _extract_pdf(file_path)
        print(json.dumps(res))
        return 0 if res.get("ok") else 2
    if suffix == ".docx" or "wordprocessingml" in mime_type:
        print(json.dumps({"ok": True, "text": _extract_docx(file_path)}))
        return 0
    if suffix == ".xlsx" or "spreadsheetml" in mime_type:
        print(json.dumps({"ok": True, "text": _extract_xlsx(file_path)}))
        return 0
    if mime_type.startswith("image/") or suffix in (".png", ".jpg", ".jpeg", ".webp"):
        print(json.dumps({"ok": True, "text": _extract_image_summary(file_path)}))
        return 0
    print(json.dumps({"ok": True, "text": file_path.read_text(encoding="utf-8", errors="replace")}))
    return 0


def embed_texts_local(
    texts: list[str], model_name: str, is_query: bool = False, embedder=None
) -> list[list[float]]:
    if embedder is None:
        from fastembed import TextEmbedding

        cache_dir = get_data_dir() / "models"
        cache_dir.mkdir(parents=True, exist_ok=True)
        embedder = TextEmbedding(model_name=model_name, cache_dir=str(cache_dir))
    if is_query and hasattr(embedder, "query_embed"):
        vecs = list(embedder.query_embed(texts))
    else:
        vecs = list(embedder.embed(texts))
    return [v.tolist() if hasattr(v, "tolist") else list(v) for v in vecs]


def _get_gemini_client(cfg: dict):
    mem = cfg.get("memory") or {}
    if not mem.get("cloudPaidTierConfirmed"):
        raise RuntimeError("Cloud Gemini features require Paid-Tier confirmation in Settings > Memory.")
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set for gemini_cloud provider.")
    from google import genai

    return genai.Client(api_key=api_key)


def embed_texts_gemini_cloud(texts: list[str], model_name: str, cfg: dict) -> list[list[float]]:
    client = _get_gemini_client(cfg)
    resp = call_gemini_with_backoff(lambda: client.models.embed_content(model=model_name, contents=texts))
    out: list[list[float]] = []
    for emb in resp.embeddings:
        out.append([float(v) for v in emb.values])
    return out


def _generate_flash_lite_prefix(client, title: str, rel_path: str, raw_text: str) -> str:
    prompt = (
        "Provide a concise 1-2 sentence (40-80 token) situational context prefix explaining where this chunk fits "
        f"inside document '{title}' ({rel_path}). Output only the plain situational context sentence(s).\n\n"
        f"Chunk:\n{raw_text[:2800]}"
    )

    def _call(model_id: str):
        return call_gemini_with_backoff(lambda: client.models.generate_content(model=model_id, contents=prompt))

    try:
        resp = _call("gemini-3.5-flash-lite")
    except Exception:
        resp = _call("gemini-flash-lite-latest")
    return f"[{str(getattr(resp, 'text', '') or '').strip()[:360]}]"


def _extract_pdf_page_numbers(raw_text: str, context_prefix: str = "") -> list[int]:
    pages: set[int] = {
        int(m) for m in re.findall(r"^##\s+Page\s+(\d+)\b", raw_text or "", flags=re.MULTILINE | re.IGNORECASE)
    }
    prefix = context_prefix or ""
    for a_str, b_str in re.findall(r"\bPages?:\s*(\d+)(?:\s*-\s*(\d+))?\b", prefix):
        a = int(a_str)
        if b_str:
            b = int(b_str)
            if a <= b and (b - a) <= 500:
                pages.update(range(a, b + 1))
            else:
                pages.add(a)
        else:
            pages.add(a)
    for m in re.findall(r"\bSection:\s*Page\s*(\d+)\b", prefix):
        pages.add(int(m))
    return sorted(p for p in pages if p > 0)


def _slice_pdf_pages_bytes(pdf_path: Path, raw_text: str, context_prefix: str = "") -> bytes | None:
    page_nums = _extract_pdf_page_numbers(raw_text, context_prefix)
    if not page_nums:
        return None
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(str(pdf_path))
    writer = PdfWriter()
    added = 0
    for pno in page_nums[:6]:  # gemini-embedding-2 supports up to 6 PDF pages per request
        if 1 <= pno <= len(reader.pages):
            writer.add_page(reader.pages[pno - 1])
            added += 1
    if added == 0:
        return None
    buf = io.BytesIO()
    writer.write(buf)
    raw = buf.getvalue()
    return raw if len(raw) <= 10 * 1024 * 1024 else None


def _ensure_chunk_header_col(conn: sqlite3.Connection) -> None:
    cols = {r[1] for r in conn.execute("PRAGMA table_info(library_chunks)").fetchall()}
    if "header_mode" not in cols:
        try:
            conn.execute("ALTER TABLE library_chunks ADD COLUMN header_mode TEXT NOT NULL DEFAULT 'structural_offline'")
        except sqlite3.OperationalError as exc:
            if "duplicate column name" not in str(exc).lower():
                raise


@contextlib.contextmanager
def _workspace_embed_lock(workspace: Path, timeout_seconds: float = 120.0):
    state_dir = workspace / ".agy-project" / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    lock_path = state_dir / "embed.lock"
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
    deadline = time.monotonic() + timeout_seconds
    locked = False
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Timed out waiting for embed lock: {lock_path}")
                time.sleep(0.05)
        yield
    finally:
        if locked:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
        os.close(fd)


def cmd_embed_workspace(workspace: Path) -> int:
    db_path = workspace / ".agy-project" / "state" / "project_index.db"
    if not db_path.exists():
        print(json.dumps({"ok": False, "error": "project_index.db not found"}))
        return 1

    with _workspace_embed_lock(workspace):
        cfg = load_project_config(workspace)
        provider, active_model = get_active_embedding_spec(cfg)
        header_mode = get_header_mode(cfg)
        mem = cfg.get("memory") or {}

        conn = sqlite3.connect(str(db_path), timeout=10.0)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA busy_timeout = 5000")
            _ensure_chunk_header_col(conn)

            can_llm_header = (
                header_mode == "gemini_flash_lite"
                and bool(mem.get("cloudPaidTierConfirmed"))
                and bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"))
            )
            client = _get_gemini_client(cfg) if (provider == "gemini_cloud" or can_llm_header) else None

            # Step 1 (optional): Enrich structural prefixes with Gemini Flash-Lite + refresh FTS5
            prefix_enriched = 0
            prefix_failed = 0
            prefix_last_error = ""
            if can_llm_header and client is not None:
                hdr_rows = conn.execute(
                    """
                    SELECT c.chunk_id, c.item_id, c.raw_text, c.context_prefix, c.contextualized_text, li.title, li.rel_path
                    FROM library_chunks c
                    JOIN library_items li ON li.item_id = c.item_id
                    WHERE c.header_mode != 'gemini_flash_lite'
                    ORDER BY c.chunk_id ASC
                    """
                ).fetchall()
                for r in hdr_rows:
                    try:
                        llm_prefix = _generate_flash_lite_prefix(client, r["title"], r["rel_path"], r["raw_text"])
                        if llm_prefix and llm_prefix != "[]":
                            structural_prefix = str(r["context_prefix"] or "").strip()
                            combined_prefix = f"{structural_prefix} {llm_prefix}".strip() if structural_prefix else llm_prefix
                            new_ctx = f"{combined_prefix}\n\n{r['raw_text']}"
                            with conn:
                                cur = conn.execute(
                                    """
                                    UPDATE library_chunks
                                    SET context_prefix = ?, contextualized_text = ?, header_mode = 'gemini_flash_lite', embedding_f32 = NULL
                                    WHERE chunk_id = ? AND contextualized_text = ? AND header_mode != 'gemini_flash_lite'
                                    """,
                                    (combined_prefix, new_ctx, r["chunk_id"], r["contextualized_text"]),
                                )
                                if cur.rowcount > 0:
                                    conn.execute("DELETE FROM library_chunks_fts WHERE chunk_id = ?", (r["chunk_id"],))
                                    conn.execute(
                                        "INSERT INTO library_chunks_fts (chunk_id, item_id, contextualized_text) VALUES (?, ?, ?)",
                                        (r["chunk_id"], r["item_id"], new_ctx),
                                    )
                                    prefix_enriched += 1
                    except Exception as exc:
                        prefix_failed += 1
                        prefix_last_error = str(exc)[:300]
                        print(
                            f"[rag_worker] flash-lite prefix failed for {r['chunk_id']}: {prefix_last_error}",
                            file=sys.stderr,
                        )

            # Step 2: Embed pending or stale-model chunks
            rows = conn.execute(
                """
                SELECT c.chunk_id, c.raw_text, c.context_prefix, c.contextualized_text, c.embedding_model AS orig_embedding_model, li.rel_path, li.mime_type, li.pdf_mode
                FROM library_chunks c
                JOIN library_items li ON li.item_id = c.item_id
                WHERE c.embedding_f32 IS NULL OR c.embedding_model != ?
                ORDER BY c.chunk_id ASC
                """,
                (active_model,),
            ).fetchall()

            if not rows:
                early_out = {
                    "ok": True,
                    "embedded": 0,
                    "model": active_model,
                    "provider": provider,
                    "headerMode": header_mode,
                    "prefixEnriched": prefix_enriched,
                    "prefixFailed": prefix_failed,
                }
                if prefix_failed > 0:
                    early_out["prefixLastError"] = prefix_last_error
                print(json.dumps(early_out))
                return 0

            project_dir = workspace / ".agy-project"
            total_embedded = 0

            if provider == "gemini_cloud" and active_model == "gemini-embedding-2":
                from google.genai import types

                text_batch: list = []

                def _flush_text_batch() -> None:
                    nonlocal total_embedded
                    if not text_batch:
                        return
                    vectors = embed_texts_gemini_cloud([str(r["contextualized_text"]) for r in text_batch], active_model, cfg)
                    with conn:
                        for row, vec in zip(text_batch, vectors):
                            blob = pack_f32(vec)
                            cur = conn.execute(
                                """
                                UPDATE library_chunks
                                SET embedding_model = ?, embedding_dim = ?, embedding_f32 = ?
                                WHERE chunk_id = ? AND contextualized_text = ? AND embedding_model = ?
                                """,
                                (
                                    active_model,
                                    len(vec),
                                    sqlite3.Binary(blob),
                                    row["chunk_id"],
                                    str(row["contextualized_text"]),
                                    str(row["orig_embedding_model"]),
                                ),
                            )
                            total_embedded += cur.rowcount
                    text_batch.clear()

                for row in rows:
                    abs_asset = project_dir / row["rel_path"]
                    mime = str(row["mime_type"] or "")
                    multimodal_part = None
                    if abs_asset.exists():
                        if mime.startswith("image/") and abs_asset.stat().st_size <= 10 * 1024 * 1024:
                            multimodal_part = types.Part.from_bytes(data=abs_asset.read_bytes(), mime_type=mime)
                        elif mime == "application/pdf" and row["pdf_mode"] == "visual_and_text":
                            try:
                                pdf_bytes = _slice_pdf_pages_bytes(abs_asset, row["raw_text"], row["context_prefix"] or "")
                                if pdf_bytes:
                                    multimodal_part = types.Part.from_bytes(data=pdf_bytes, mime_type="application/pdf")
                            except Exception:
                                multimodal_part = None

                    if multimodal_part is not None and client is not None:
                        _flush_text_batch()
                        try:
                            resp = call_gemini_with_backoff(
                                lambda: client.models.embed_content(
                                    model=active_model,
                                    contents=[[multimodal_part, str(row["contextualized_text"])]],
                                )
                            )
                            vec = [float(v) for v in resp.embeddings[0].values]
                            blob = pack_f32(vec)
                            with conn:
                                cur = conn.execute(
                                    """
                                    UPDATE library_chunks
                                    SET embedding_model = ?, embedding_dim = ?, embedding_f32 = ?
                                    WHERE chunk_id = ? AND contextualized_text = ? AND embedding_model = ?
                                    """,
                                    (
                                        active_model,
                                        len(vec),
                                        sqlite3.Binary(blob),
                                        row["chunk_id"],
                                        str(row["contextualized_text"]),
                                        str(row["orig_embedding_model"]),
                                    ),
                                )
                                total_embedded += cur.rowcount
                            continue
                        except Exception:
                            pass

                    text_batch.append(row)
                    if len(text_batch) >= 32:
                        _flush_text_batch()
                _flush_text_batch()
            else:
                local_embedder = None
                accepts_embedder = False
                if provider != "gemini_cloud":
                    sig = inspect.signature(embed_texts_local)
                    accepts_embedder = (
                        "embedder" in sig.parameters
                        or any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
                    )
                    if accepts_embedder:
                        from fastembed import TextEmbedding

                        cache_dir = get_data_dir() / "models"
                        cache_dir.mkdir(parents=True, exist_ok=True)
                        local_embedder = TextEmbedding(model_name=active_model, cache_dir=str(cache_dir))

                batch_size = 32
                for i in range(0, len(rows), batch_size):
                    batch = rows[i : i + batch_size]
                    texts = [str(r["contextualized_text"]) for r in batch]
                    if provider == "gemini_cloud":
                        vectors = embed_texts_gemini_cloud(texts, active_model, cfg)
                    elif accepts_embedder:
                        vectors = embed_texts_local(texts, active_model, is_query=False, embedder=local_embedder)
                    else:
                        vectors = embed_texts_local(texts, active_model, is_query=False)

                    with conn:
                        for row, vec in zip(batch, vectors):
                            blob = pack_f32(vec)
                            cur = conn.execute(
                                """
                                UPDATE library_chunks
                                SET embedding_model = ?, embedding_dim = ?, embedding_f32 = ?
                                WHERE chunk_id = ? AND contextualized_text = ? AND embedding_model = ?
                                """,
                                (
                                    active_model,
                                    len(vec),
                                    sqlite3.Binary(blob),
                                    row["chunk_id"],
                                    str(row["contextualized_text"]),
                                    str(row["orig_embedding_model"]),
                                ),
                            )
                            total_embedded += cur.rowcount

            final_out = {
                "ok": True,
                "embedded": total_embedded,
                "model": active_model,
                "provider": provider,
                "headerMode": header_mode,
                "prefixEnriched": prefix_enriched,
                "prefixFailed": prefix_failed,
            }
            if prefix_failed > 0:
                final_out["prefixLastError"] = prefix_last_error
            print(json.dumps(final_out))
            return 0
        finally:
            conn.close()


def cmd_embed_query(workspace: Path, query: str) -> int:
    cfg = load_project_config(workspace)
    provider, active_model = get_active_embedding_spec(cfg)
    if provider == "gemini_cloud":
        vecs = embed_texts_gemini_cloud([query], active_model, cfg)
    else:
        vecs = embed_texts_local([query], active_model, is_query=True)
    vec = vecs[0] if vecs else []
    print(json.dumps({"vector": vec, "dim": len(vec), "model": active_model, "provider": provider}))
    return 0


def has_headless_sdk_auth(env: dict[str, str] | None = None) -> bool:
    src = env if env is not None else os.environ
    vertex = str(src.get("GOOGLE_GENAI_USE_VERTEXAI", "")).strip().lower()
    enterprise = str(src.get("GOOGLE_GENAI_USE_ENTERPRISE", "")).strip().lower()
    use_vertex = vertex in ("1", "true") or enterprise in ("1", "true")
    api_key = str(src.get("GEMINI_API_KEY", "")).strip() or str(src.get("GOOGLE_API_KEY", "")).strip()
    if use_vertex:
        project = str(src.get("GOOGLE_CLOUD_PROJECT", "")).strip()
        location = str(src.get("GOOGLE_CLOUD_LOCATION", "")).strip()
        return bool((project and location) or api_key)
    return bool(api_key)


def resolve_sdk_model(model_tier: str) -> str | None:
    tier = str(model_tier or "").strip()
    if not tier or tier == "inherit":
        return None
    if tier == "flash":
        from google.antigravity.models import DEFAULT_MODEL

        return DEFAULT_MODEL
    if tier == "pro":
        return "gemini-3.8-pro"
    if tier == "flash_lite":
        return "gemini-3.5-flash-lite"
    return tier


READONLY_MCP_TOOLS = [
    "search_project_library",
    "get_project_overview",
    "list_projects",
    "update_thread_state",
    "upsert_memory",
    "get_dispatch_context",
]

BLOCKED_CHILD_ENV_KEYS = {
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "NODE_OPTIONS",
    "PYTHONSTARTUP",
    "AGY_PROJECTS_DATA_DIR",
    "ANTIGRAVITY_APP_DATA_DIR",
}


def load_project_env_vars(workspace: Path | None) -> dict[str, str]:
    if workspace is None:
        return {}
    cfg_path = Path(workspace).resolve() / ".agy-project" / "config.json"
    if not cfg_path.exists():
        return {}
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        raw_vars = (cfg.get("environment") or {}).get("envVars") or {}
        if not isinstance(raw_vars, dict):
            return {}
        out: dict[str, str] = {}
        for k, v in raw_vars.items():
            ks = str(k or "").strip()
            if not ks or not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", ks):
                continue
            if ks.upper() in BLOCKED_CHILD_ENV_KEYS:
                continue
            out[ks] = "" if v is None else str(v)
        return out
    except Exception:
        return {}


def build_mcp_server_env(workspace: Path | None = None) -> dict[str, str]:
    env: dict[str, str] = {
        k: str(v)
        for k, v in os.environ.items()
        if k.upper() not in BLOCKED_CHILD_ENV_KEYS
    }
    env.update(load_project_env_vars(workspace))
    app_data = os.environ.get("ANTIGRAVITY_APP_DATA_DIR", "").strip()
    if app_data:
        env["ANTIGRAVITY_APP_DATA_DIR"] = str(Path(app_data).expanduser().resolve())
    env["AGY_PROJECTS_DATA_DIR"] = str(get_data_dir())
    disable_embed = os.environ.get("AGY_DISABLE_ASYNC_RAG_EMBED", "").strip()
    if disable_embed:
        env["AGY_DISABLE_ASYNC_RAG_EMBED"] = disable_embed
    return env

WRITE_ADMIN_DISABLED_MCP_TOOLS = [
    "create_project",
    "select_project",
    "update_project_settings",
    "update_project_lifecycle",
    "rollover_coordinator_session",
    "bind_repository",
    "upsert_schedule",
]


def load_project_environment_policy(workspace: Path | None) -> dict[str, str]:
    policy_out = {"sandboxMode": "inherit", "networkPolicy": "inherit"}
    if workspace is None:
        return policy_out
    cfg_path = Path(workspace).resolve() / ".agy-project" / "config.json"
    if not cfg_path.exists():
        return policy_out
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        env_cfg = cfg.get("environment") or {}
        if isinstance(env_cfg, dict):
            sm = str(env_cfg.get("sandboxMode") or "inherit").strip()
            if sm in ("inherit", "enabled", "disabled"):
                policy_out["sandboxMode"] = sm
            np = str(env_cfg.get("networkPolicy") or "inherit").strip()
            if np in ("inherit", "allow", "ask", "deny"):
                policy_out["networkPolicy"] = np
    except Exception:
        pass
    return policy_out


_HEADLESS_NETWORK_CMD_RE = re.compile(
    r"(?:^|(?:&&|\|\||[;&|\n])\s*)"
    r"(?:(?:sudo|command)\s+|env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)*"
    r"(?:"
    r"(?:curl|wget|http|https|ssh|scp|sftp|rsync|nc|ncat|netcat|gh)\b"
    r"|git\s+(?:push|fetch|pull|clone|ls-remote)\b"
    r"|(?:npm|pnpm|yarn)\s+(?:install|i|add|ci|publish|update)\b"
    r"|(?:pip|pip3)\s+install\b"
    r"|uv\s+(?:pip|sync|add)\b"
    r")",
    re.IGNORECASE,
)


def is_headless_network_command_call(call: object) -> bool:
    args = getattr(call, "args", None)
    if args is None and isinstance(call, dict):
        args = call.get("args", call)
    if not isinstance(args, dict):
        return False
    cmd = str(args.get("CommandLine") or args.get("command") or "")
    return bool(_HEADLESS_NETWORK_CMD_RE.search(cmd))


def build_local_agent_config(
    mode: str,
    cwd: Path,
    system_instructions: str,
    model_tier: str = "",
    workspace: Path | None = None,
):
    from google.antigravity import BuiltinTools, CapabilitiesConfig, LocalAgentConfig
    from google.antigravity.hooks import policy
    from google.antigravity.types import McpStdioServer

    resolved_cwd = str(Path(cwd).resolve())
    proj_ws = workspace if workspace is not None else cwd
    mcp_server_path = str(Path(__file__).resolve().parent / "mcp_server.cjs")
    mcp_env = build_mcp_server_env(proj_ws)
    env_policy = load_project_environment_policy(proj_ws)
    sandbox_mode = env_policy["sandboxMode"]
    network_policy = env_policy["networkPolicy"]

    kwargs: dict = {
        "system_instructions": system_instructions,
        "workspaces": [resolved_cwd],
    }

    use_vertex = (
        str(os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "")).strip().lower() in ("1", "true")
        or str(os.environ.get("GOOGLE_GENAI_USE_ENTERPRISE", "")).strip().lower() in ("1", "true")
    )
    api_key = str(os.environ.get("GEMINI_API_KEY", "")).strip() or str(os.environ.get("GOOGLE_API_KEY", "")).strip()
    if use_vertex:
        project = str(os.environ.get("GOOGLE_CLOUD_PROJECT", "")).strip()
        location = str(os.environ.get("GOOGLE_CLOUD_LOCATION", "")).strip()
        kwargs["vertex"] = True
        if project and location:
            kwargs["project"] = project
            kwargs["location"] = location
        elif api_key:
            kwargs["api_key"] = api_key
    elif api_key:
        kwargs["api_key"] = api_key

    resolved_model = resolve_sdk_model(model_tier)
    if resolved_model is not None:
        kwargs["model"] = resolved_model

    if mode == "write":
        mcp_server = McpStdioServer(
            name="agy_projects_mcp",
            command="node",
            args=[mcp_server_path],
            env=mcp_env,
            disabled_tools=list(WRITE_ADMIN_DISABLED_MCP_TOOLS),
        )
        kwargs["mcp_servers"] = [mcp_server]
        kwargs["capabilities"] = CapabilitiesConfig(enable_subagents=False)
        write_policies = []
        if sandbox_mode != "disabled":
            write_policies.extend(policy.workspace_only([resolved_cwd]))
        write_policies.extend(policy.deny(mcp_server, list(WRITE_ADMIN_DISABLED_MCP_TOOLS)))
        if network_policy in ("deny", "ask"):
            net_reason = (
                "Outbound network access denied by project environment.networkPolicy='deny'."
                if network_policy == "deny"
                else "Outbound network access blocked in non-interactive headless worker because project environment.networkPolicy='ask' requires interactive confirmation."
            )
            if hasattr(BuiltinTools, "SEARCH_WEB"):
                write_policies.append(policy.deny(BuiltinTools.SEARCH_WEB.value, reason=net_reason))
            if hasattr(BuiltinTools, "READ_URL_CONTENT"):
                write_policies.append(policy.deny(BuiltinTools.READ_URL_CONTENT.value, reason=net_reason))
            if hasattr(BuiltinTools, "RUN_COMMAND"):
                write_policies.append(
                    policy.deny(
                        BuiltinTools.RUN_COMMAND.value,
                        when=is_headless_network_command_call,
                        reason=net_reason,
                    )
                )
        write_policies.append(policy.allow_all())
        kwargs["policies"] = write_policies
    else:
        mcp_server = McpStdioServer(
            name="agy_projects_mcp",
            command="node",
            args=[mcp_server_path],
            env=mcp_env,
            enabled_tools=list(READONLY_MCP_TOOLS),
        )
        kwargs["mcp_servers"] = [mcp_server]
        kwargs["capabilities"] = CapabilitiesConfig(
            enable_subagents=False,
            enabled_tools=[
                BuiltinTools.LIST_DIR,
                BuiltinTools.SEARCH_DIR,
                BuiltinTools.FIND_FILE,
                BuiltinTools.VIEW_FILE,
            ],
        )
        ro_policies = []
        if sandbox_mode == "enabled":
            ro_policies.extend(policy.workspace_only([resolved_cwd]))
        ro_policies.extend(
            [
                policy.deny_all(),
                policy.allow(BuiltinTools.LIST_DIR.value),
                policy.allow(BuiltinTools.SEARCH_DIR.value),
                policy.allow(BuiltinTools.FIND_FILE.value),
                policy.allow(BuiltinTools.VIEW_FILE.value),
                policy.allow(BuiltinTools.FINISH.value),
                *policy.allow(mcp_server, list(READONLY_MCP_TOOLS)),
            ]
        )
        kwargs["policies"] = ro_policies

    return LocalAgentConfig(**kwargs)


async def _run_sdk_agent_async(
    mode: str,
    cwd: Path,
    system_instructions: str,
    prompt: str,
    model_tier: str = "",
    workspace: Path | None = None,
) -> int:
    proj_ws = workspace if workspace is not None else cwd
    for k, v in load_project_env_vars(proj_ws).items():
        os.environ[k] = v
    if not has_headless_sdk_auth():
        print(
            json.dumps(
                {
                    "type": "error",
                    "code": "AUTH_REQUIRED",
                    "error": "Headless SDK worker requires GEMINI_API_KEY (or GOOGLE_GENAI_USE_VERTEXAI=1). Set GEMINI_API_KEY or run this task interactively via Coordinator Chat.",
                }
            ),
            flush=True,
        )
        return 3

    os.environ["AGY_HEADLESS_SDK_WORKER"] = "1"
    os.chdir(str(cwd))

    try:
        from google.antigravity import Agent

        config = build_local_agent_config(
            mode=mode,
            cwd=cwd,
            system_instructions=system_instructions,
            model_tier=model_tier,
            workspace=proj_ws,
        )
    except ImportError as exc:
        print(
            json.dumps(
                {
                    "type": "error",
                    "error": f"google-antigravity SDK is unavailable in venv: {exc}",
                }
            ),
            flush=True,
        )
        return 2

    collected_tokens: list[str] = []

    loop = asyncio.get_running_loop()
    main_task = asyncio.current_task()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, lambda: main_task.cancel() if main_task else None)
        except NotImplementedError:
            pass

    try:
        async with Agent(config) as agent:
            response = await agent.chat(prompt)

            async def drain_thoughts() -> None:
                if hasattr(response, "thoughts"):
                    async for thought in response.thoughts:
                        print(json.dumps({"type": "thought", "text": str(thought)[:300]}), flush=True)

            async def drain_tools() -> None:
                if hasattr(response, "tool_calls"):
                    async for call in response.tool_calls:
                        print(
                            json.dumps(
                                {
                                    "type": "tool_call",
                                    "tool": getattr(call, "name", "tool"),
                                    "args": str(getattr(call, "args", ""))[:240],
                                }
                            ),
                            flush=True,
                        )

            async def drain_tokens() -> None:
                async for token in response:
                    s = str(token)
                    collected_tokens.append(s)
                    print(json.dumps({"type": "token", "text": s}), flush=True)

            await asyncio.gather(drain_thoughts(), drain_tools(), drain_tokens())

        summary = "".join(collected_tokens).strip()[-800:]
        print(json.dumps({"type": "done", "summary": summary}), flush=True)
        return 0
    except asyncio.CancelledError:
        print(json.dumps({"type": "cancelled", "reason": "Paused or cancelled via SIGTERM"}), flush=True)
        return 130
    except Exception as exc:
        print(json.dumps({"type": "error", "error": str(exc)[:500]}), flush=True)
        return 1


def main() -> int:
    ensure_venv_and_reexec()

    parser = argparse.ArgumentParser(prog="rag_worker")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("ensure-venv")

    p_emb_ws = sub.add_parser("embed-workspace")
    p_emb_ws.add_argument("--workspace", required=True)

    p_extract = sub.add_parser("extract-doc")
    p_extract.add_argument("--file", required=True)
    p_extract.add_argument("--mime", default="")

    p_emb_q = sub.add_parser("embed-query")
    p_emb_q.add_argument("--workspace", required=True)
    p_emb_q.add_argument("--query", required=True)

    p_agent = sub.add_parser("run-agent")
    p_agent.add_argument("--workspace", required=True)
    p_agent.add_argument("--thread-id", required=True)
    p_agent.add_argument("--mode", choices=["readonly", "write"], default="readonly")
    p_agent.add_argument("--cwd", required=True)
    p_agent.add_argument("--prompt", required=True)
    p_agent.add_argument("--system-file", default="")
    p_agent.add_argument("--model", default="")

    args = parser.parse_args()

    if args.cmd == "ensure-venv":
        has_sdk = False
        try:
            import google.antigravity  # noqa: F401

            has_sdk = True
        except Exception:
            has_sdk = False
        print(
            json.dumps(
                {
                    "ok": True,
                    "python": sys.executable,
                    "hasFastembed": True,
                    "hasAntigravitySdk": has_sdk,
                }
            )
        )
        return 0

    if args.cmd == "extract-doc":
        return cmd_extract_doc(Path(args.file).resolve(), args.mime)

    if args.cmd == "embed-workspace":
        return cmd_embed_workspace(Path(args.workspace).resolve())

    if args.cmd == "embed-query":
        return cmd_embed_query(Path(args.workspace).resolve(), args.query)

    if args.cmd == "run-agent":
        sys_inst = "You are a headless AGY Project worker."
        if args.system_file and Path(args.system_file).exists():
            sys_inst = Path(args.system_file).read_text(encoding="utf-8")
        return asyncio.run(
            _run_sdk_agent_async(
                mode=args.mode,
                cwd=Path(args.cwd).resolve(),
                system_instructions=sys_inst,
                prompt=args.prompt,
                model_tier=args.model,
                workspace=Path(args.workspace).resolve(),
            )
        )

    return 1


if __name__ == "__main__":
    sys.exit(main())
