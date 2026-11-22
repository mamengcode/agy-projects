"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const STRICT_UUID_CONV_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-zA-Z0-9_-]{8,64})$/i;
const SYSTEM_ROLE_NAME_RE = /^(?:coordinator|narrator|monitor)(?:-\d+)?$/i;
const DONE_LINE_RE = /^\s*(?:@[a-z0-9_-]+\s+)+\[done\](?=\s|$)/i;
const BLOCKED_LINE_RE = /^\s*(?:@[a-z0-9_-]+\s+)+\[(?:blocked|question)\](?=\s|$)/i;

const ANCHOR_CHECK_BYTES = 64;
const TRANSCRIPT_TAIL_LINES = 1024;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const TRANSCRIPT_MAX_TAIL_BYTES = 2 * 1024 * 1024;
const BOARD_TAIL_BYTES = 128 * 1024;

const NO_TRANSCRIPT = Object.freeze({ key: "-", summary: null });

const boardFileCache = new Map();
const transcriptCache = new Map();
let nextEpoch = 0;

function getDbMod() {
  return require("./db.cjs");
}

function escapeRegExp(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function oneLine(s, maxLen = 96) {
  const out = String(s || "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > maxLen ? `${out.slice(0, maxLen - 1).trimEnd()}…` : out;
}

/**
 * Resolve the local Swarm directory for a validated Coordinator conversation ID.
 * Rejects '.' and '/' via STRICT_UUID_CONV_RE to prevent path traversal.
 */
function getSwarmDir(appDataDir, coordId) {
  if (!appDataDir || typeof appDataDir !== "string") return null;
  if (typeof coordId !== "string" || !STRICT_UUID_CONV_RE.test(coordId)) return null;
  const brainRoot = path.resolve(appDataDir, "brain");
  const candidate = path.join(brainRoot, coordId, ".system_generated", "swarm");
  const rel = path.relative(brainRoot, candidate);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return candidate;
}

function getTranscriptPath(appDataDir, convId) {
  if (!appDataDir || typeof appDataDir !== "string") return null;
  if (typeof convId !== "string" || !STRICT_UUID_CONV_RE.test(convId)) return null;
  const brainRoot = path.resolve(appDataDir, "brain");
  const candidate = path.join(brainRoot, convId, ".system_generated", "logs", "transcript.jsonl");
  const rel = path.relative(brainRoot, candidate);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return candidate;
}

function statOf(filePath) {
  try {
    const s = fs.statSync(filePath);
    return { mtime: s.mtimeMs, size: s.size, ino: s.ino };
  } catch {
    return { mtime: 0, size: -1, ino: 0 };
  }
}

function readExact(fd, length, position) {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const n = fs.readSync(fd, buf, total, length - total, position + total);
    if (n <= 0) return null;
    total += n;
  }
  return buf;
}

function parseBoard(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m && typeof m === "object") out.push(m);
    } catch {
      // Torn trailing lines settle on the next read.
    }
  }
  return out;
}

function nonEmptyLines(buf) {
  const out = [];
  for (let pos = 0; pos < buf.length;) {
    const nl = buf.indexOf(0x0a, pos);
    const end = nl < 0 ? buf.length : nl;
    if (end > pos) {
      const line = buf.toString("utf8", pos, end);
      if (line.trim()) out.push(line);
    }
    pos = end + 1;
  }
  return out;
}

function nextTailAnchor(prevAnchor, slice, completeLen) {
  if (completeLen >= ANCHOR_CHECK_BYTES) {
    return Buffer.from(slice.subarray(completeLen - ANCHOR_CHECK_BYTES, completeLen));
  }
  const keep = Buffer.concat([prevAnchor, slice.subarray(0, completeLen)]);
  return Buffer.from(keep.subarray(Math.max(0, keep.length - ANCHOR_CHECK_BYTES)));
}

function nextHeadAnchor(prevHead, slice, completeLen) {
  if (prevHead.length >= ANCHOR_CHECK_BYTES || completeLen <= 0) return prevHead;
  const keep = Buffer.concat([prevHead, slice.subarray(0, completeLen)]);
  return Buffer.from(keep.subarray(0, Math.min(ANCHOR_CHECK_BYTES, keep.length)));
}

function readAppendedTail(filePath, hit) {
  let fd = -1;
  try {
    fd = fs.openSync(filePath, "r");
    const st = fs.fstatSync(fd);
    if (st.ino !== hit.ino || st.size < hit.size || hit.readOffset > st.size) return null;
    if (hit.headAnchor.length > 0) {
      const head = readExact(fd, hit.headAnchor.length, 0);
      if (!head || !head.equals(hit.headAnchor)) return null;
    }
    if (hit.anchor.length > 0) {
      const tail = readExact(fd, hit.anchor.length, hit.readOffset - hit.anchor.length);
      if (!tail || !tail.equals(hit.anchor)) return null;
    }
    const slice = readExact(fd, st.size - hit.readOffset, hit.readOffset);
    if (!slice) return null;
    if (hit.rem.length > 0 && (slice.length < hit.rem.length || !slice.subarray(0, hit.rem.length).equals(hit.rem))) {
      return null;
    }
    const lastNl = slice.lastIndexOf(0x0a);
    let readOffset = hit.readOffset;
    let anchor = hit.anchor;
    let headAnchor = hit.headAnchor;
    let completeBuf = null;
    if (lastNl >= 0) {
      const completeLen = lastNl + 1;
      completeBuf = slice.subarray(0, completeLen);
      readOffset = hit.readOffset + completeLen;
      anchor = nextTailAnchor(hit.anchor, slice, completeLen);
      headAnchor = nextHeadAnchor(hit.headAnchor, slice, completeLen);
    }
    const remBuf = Buffer.from(slice.subarray(lastNl + 1));
    return { size: st.size, mtime: st.mtimeMs, ino: st.ino, readOffset, anchor, headAnchor, completeBuf, remBuf };
  } catch {
    return null;
  } finally {
    if (fd >= 0) try { fs.closeSync(fd); } catch {}
  }
}

function touchCache(cache, key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function putCache(cache, key, entry, limit) {
  touchCache(cache, key, entry);
  if (cache.size > limit) cache.delete(cache.keys().next().value);
  return entry;
}

function probeFile(cache, filePath, maxAppendBytes = Infinity) {
  const s = statOf(filePath);
  if (s.size < 0) {
    cache.delete(filePath);
    return { status: "missing", s };
  }
  const hit = cache.get(filePath);
  if (hit && hit.size === s.size && hit.mtime === s.mtime && hit.ino === s.ino) {
    return { status: "hit", s, hit: touchCache(cache, filePath, hit) };
  }
  if (hit && hit.readOffset > 0 && s.size >= hit.size && s.ino === hit.ino && s.size - hit.readOffset <= maxAppendBytes) {
    const delta = readAppendedTail(filePath, hit);
    if (delta) return { status: "append", s, hit, delta };
  }
  return { status: "miss", s, hit };
}

function readFullFile(filePath) {
  let fd = -1;
  try {
    fd = fs.openSync(filePath, "r");
    const st = fs.fstatSync(fd);
    const buf = readExact(fd, st.size, 0);
    if (!buf) return null;
    const lastNl = buf.lastIndexOf(0x0a);
    const readOffset = lastNl >= 0 ? lastNl + 1 : 0;
    return {
      size: st.size,
      mtime: st.mtimeMs,
      ino: st.ino,
      readOffset,
      anchor: Buffer.from(buf.subarray(Math.max(0, readOffset - ANCHOR_CHECK_BYTES), readOffset)),
      headAnchor: Buffer.from(buf.subarray(0, Math.min(ANCHOR_CHECK_BYTES, readOffset))),
      completeBuf: lastNl >= 0 ? buf.subarray(0, lastNl + 1) : null,
      remBuf: Buffer.from(buf.subarray(lastNl + 1))
    };
  } catch {
    return null;
  } finally {
    if (fd >= 0) try { fs.closeSync(fd); } catch {}
  }
}

/**
 * Incrementally read and parse board.jsonl from the last newline byte offset.
 */
function readBoardCached(filePath) {
  const p = probeFile(boardFileCache, filePath);
  if (p.status === "missing") return { msgs: [], epoch: 0, ...p.s };
  if (p.status === "hit") return { msgs: p.hit.msgs, epoch: p.hit.epoch, ...p.s };
  const isAppend = p.status === "append";
  const chunk = isAppend ? p.delta : readFullFile(filePath);
  if (!chunk) {
    boardFileCache.delete(filePath);
    return { msgs: [], epoch: 0, ...p.s };
  }
  const added = chunk.completeBuf ? parseBoard(chunk.completeBuf.toString("utf8")) : [];
  const base = isAppend ? p.hit.completeMsgs : [];
  const completeMsgs = added.length ? base.concat(added) : base;
  const remMsgs = chunk.remBuf.length ? parseBoard(chunk.remBuf.toString("utf8")) : [];
  const msgs = remMsgs.length ? completeMsgs.concat(remMsgs) : completeMsgs;
  const epoch = isAppend && p.hit.msgs.length === p.hit.completeMsgs.length ? p.hit.epoch : ++nextEpoch;
  const { size, mtime, ino, readOffset, anchor, headAnchor, remBuf: rem } = chunk;
  putCache(boardFileCache, filePath, { size, mtime, ino, readOffset, anchor, headAnchor, rem, completeMsgs, msgs, epoch }, 256);
  return { msgs, epoch, mtime, size, ino };
}

/**
 * Bounded EOF tail read of board.jsonl (max 128 KB) for short-lived hooks.
 */
function readBoardTailSync(filePath, maxBytes = BOARD_TAIL_BYTES) {
  let fd = -1;
  try {
    fd = fs.openSync(filePath, "r");
    const st = fs.fstatSync(fd);
    if (st.size <= 0) return { msgs: [], head: 0, size: st.size, mtime: st.mtimeMs, ino: st.ino, partial: false };
    const readLen = Math.min(st.size, Math.max(1024, Number(maxBytes) || BOARD_TAIL_BYTES));
    const startPos = st.size - readLen;
    const buf = readExact(fd, readLen, startPos);
    if (!buf) return { msgs: [], head: 0, size: st.size, mtime: st.mtimeMs, ino: st.ino, partial: false };
    let slice = buf;
    let partial = false;
    if (startPos > 0) {
      partial = true;
      const firstNl = buf.indexOf(0x0a);
      if (firstNl < 0) {
        return { msgs: [], head: 0, size: st.size, mtime: st.mtimeMs, ino: st.ino, partial: true };
      }
      slice = buf.subarray(firstNl + 1);
    }
    const msgs = parseBoard(slice.toString("utf8"));
    const head = msgs.length ? (Number(msgs[msgs.length - 1].seq) || msgs.length) : 0;
    return { msgs, head, size: st.size, mtime: st.mtimeMs, ino: st.ino, partial };
  } catch {
    return { msgs: [], head: 0, size: -1, mtime: 0, ino: 0, partial: false };
  } finally {
    if (fd >= 0) try { fs.closeSync(fd); } catch {}
  }
}

function unquote(v) {
  if (typeof v !== "string") return v == null ? "" : String(v);
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

const BOARD_ACTIVITY = {
  swarm_wait: "Waiting for posts",
  read_board: "Reading the board",
  post_message: "Posting to the board"
};

function describeToolCall(tc) {
  const name = tc?.name || "";
  if (!name) return "";
  if (BOARD_ACTIVITY[name]) return BOARD_ACTIVITY[name];
  const args = tc.args && typeof tc.args === "object" ? tc.args : {};
  const summary = unquote(args.toolSummary) || unquote(args.toolAction);
  if (summary) return oneLine(summary);
  const filePath = unquote(args.Path || args.AbsolutePath || args.TargetFile);
  if (filePath) {
    const verb = { read_file: "Read", write_file: "Write", edit_file: "Edit" }[name];
    if (verb) return `${verb} ${path.basename(filePath)}`;
  }
  if (name === "code_search" && args.Query) return oneLine(`Search ${unquote(args.Query)}`);
  if (name === "swarm" && args.action) return oneLine(`swarm ${unquote(args.action)} ${unquote(args.name)}`);
  return name;
}

function thinkingHeading(thinking) {
  if (typeof thinking !== "string") return "";
  const hs = [...thinking.matchAll(/(?:^|\n)\s*\*\*([^*\n]{3,96})\*\*\s*(?=\n|$)/g)];
  return hs.length ? oneLine(hs[hs.length - 1][1]) : "";
}

/**
 * Determine whether the newest transcript steps indicate a completed turn.
 * Matches swarm_board/main.mjs turnEnded semantics.
 */
function turnEnded(lines) {
  const results = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!raw || !String(raw).trim()) continue;
    let step;
    try {
      step = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!step || typeof step !== "object") return false;
    if (step.type === "GENERIC") {
      results.unshift(step);
      continue;
    }
    if (step.type !== "PLANNER_RESPONSE") return false;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    if (calls.length === 0) return results.length === 0;
    const wait = calls.findIndex((c) => c?.name === "swarm_wait");
    return wait >= 0 && results.length >= calls.length && results[wait].status === "DONE";
  }
  return false;
}

function finalReply(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!raw || !String(raw).trim()) continue;
    let step;
    try {
      step = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!step || typeof step !== "object") return null;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    return step.type === "PLANNER_RESPONSE" && calls.length === 0 ? String(step.content || "") : null;
  }
  return null;
}

/**
 * Extract the trailing question from a reply after stripping code blocks, links, URLs, and quotes.
 */
function replyQuestion(text) {
  const plain = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`\n]*)`/g, (_, s) => s.replace(/\?/g, ""))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/"[^"\n]*"|“[^”\n]*”/g, " ")
    .replace(/\*\*|__/g, "");
  const qs = plain
    .split(/\n+|(?<=[.!?])\s+/)
    .map((x) => x.replace(/^[\s>*-]+/, "").trim())
    .filter((x) => /\?$/.test(x) && x.length > 3);
  return qs.length ? oneLine(qs[qs.length - 1], 200) : "";
}

function summarizeLines(lines, totalLines, mtime, isPartial = false) {
  let steps = totalLines;
  let activity = "";
  let activityKind = "";
  let last = null;
  let bounded = !isPartial;
  for (let i = lines.length - 1; i >= 0; i--) {
    let step;
    try {
      step = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!step || typeof step !== "object") continue;
    if (!last && Number.isFinite(step.step_index) && step.step_index >= 0) {
      steps = Math.max(steps, Math.floor(step.step_index) + 1 + (lines.length - 1 - i));
    }
    if (!last) {
      last = {
        type: String(step.type || ""),
        status: String(step.status || ""),
        error: typeof step.error === "string" ? oneLine(step.error, 240) : ""
      };
    }
    if (step.type === "USER_INPUT") {
      bounded = true;
      break;
    }
    if (step.type !== "PLANNER_RESPONSE") continue;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    if (calls.some((tc) => tc?.name === "swarm_wait")) {
      bounded = true;
      break;
    }
    const labeled = calls.filter((tc) => describeToolCall(tc)).pop();
    const label = labeled ? describeToolCall(labeled) : "";
    const heading = thinkingHeading(step.thinking);
    if (label) {
      activity = label;
      activityKind = "tool";
    } else if (heading) {
      activity = heading;
      activityKind = "thinking";
    } else {
      continue;
    }
    bounded = true;
    break;
  }
  if (!bounded) return null;
  const idle = turnEnded(lines);
  const reply = finalReply(lines);
  const replied = reply !== null;
  const replyAsk = replied ? replyQuestion(reply) : "";
  return { steps, activity, activityKind, last, idle, replied, replyAsk, mtime };
}

function inferStepCountFromTail(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let step;
    try {
      step = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!step || typeof step !== "object") continue;
    if (!Number.isFinite(step.step_index) || step.step_index < 0) {
      return { ok: false, missingIndex: true };
    }
    const inferred = Math.floor(step.step_index) + 1 + (lines.length - 1 - i);
    if (inferred < lines.length) return { ok: false, missingIndex: true };
    return { ok: true, count: inferred };
  }
  return { ok: false, missingIndex: false };
}

function readTranscriptTailFromEOF(filePath, summarizeFn) {
  let fd = -1;
  try {
    fd = fs.openSync(filePath, "r");
    const st = fs.fstatSync(fd);
    if (st.size <= TRANSCRIPT_TAIL_BYTES) return null;
    for (
      let windowBytes = TRANSCRIPT_TAIL_BYTES;
      windowBytes < st.size && windowBytes <= TRANSCRIPT_MAX_TAIL_BYTES;
      windowBytes *= 2
    ) {
      const startPos = st.size - windowBytes;
      const buf = readExact(fd, windowBytes, startPos);
      if (!buf) return null;
      const firstNl = buf.indexOf(0x0a);
      if (firstNl < 0) continue;
      const tailBuf = buf.subarray(firstNl + 1);
      const lastNl = tailBuf.lastIndexOf(0x0a);
      if (lastNl < 0) continue;
      const completeBuf = tailBuf.subarray(0, lastNl + 1);
      const remBuf = tailBuf.subarray(lastNl + 1);
      const completeLines = nonEmptyLines(completeBuf);
      if (!completeLines.length) continue;
      const rem = remBuf.toString("utf8");
      const hasRem = Boolean(rem.trim());
      const workLines = hasRem ? completeLines.concat([rem]) : completeLines;
      const inferred = inferStepCountFromTail(workLines);
      if (!inferred.ok) {
        if (inferred.missingIndex) return null;
        continue;
      }
      const totalLines = inferred.count;
      const completeCount = totalLines - (hasRem ? 1 : 0);
      const summary = summarizeFn(workLines, totalLines, st.mtimeMs, true);
      if (!summary) continue;

      const readOffset = startPos + firstNl + 1 + lastNl + 1;
      const inBufEnd = firstNl + 1 + lastNl + 1;
      const anchor =
        inBufEnd >= ANCHOR_CHECK_BYTES
          ? Buffer.from(buf.subarray(inBufEnd - ANCHOR_CHECK_BYTES, inBufEnd))
          : readExact(fd, Math.min(ANCHOR_CHECK_BYTES, readOffset), Math.max(0, readOffset - ANCHOR_CHECK_BYTES));
      const headAnchor = readExact(fd, Math.min(ANCHOR_CHECK_BYTES, readOffset), 0);
      if (!anchor || !headAnchor) return null;
      return {
        key: `${st.mtimeMs}:${st.size}:${st.ino}`,
        size: st.size,
        mtime: st.mtimeMs,
        ino: st.ino,
        readOffset,
        anchor,
        headAnchor,
        rem: Buffer.from(remBuf),
        completeCount,
        tailLines: completeLines.slice(-TRANSCRIPT_TAIL_LINES),
        isPartial: true,
        summary
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd >= 0) try { fs.closeSync(fd); } catch {}
  }
}

function applyTranscriptAppend(filePath, hit, app, summarizeFn) {
  let { completeCount, tailLines, isPartial } = hit;
  if (app.completeBuf) {
    const added = nonEmptyLines(app.completeBuf);
    if (added.length) {
      completeCount += added.length;
      tailLines = tailLines.concat(added);
      if (tailLines.length > TRANSCRIPT_TAIL_LINES) {
        tailLines = tailLines.slice(-TRANSCRIPT_TAIL_LINES);
        isPartial = true;
      }
    }
  }
  const remText = app.remBuf.toString("utf8");
  const hasRem = Boolean(remText.trim());
  const workLines = hasRem ? tailLines.concat([remText]) : tailLines;
  const summary = summarizeFn(workLines, completeCount + (hasRem ? 1 : 0), app.mtime, isPartial);
  if (!summary) return null;
  const { size, mtime, ino, readOffset, anchor, headAnchor, remBuf: rem } = app;
  return putCache(
    transcriptCache,
    filePath,
    {
      key: `${mtime}:${size}:${ino}`,
      size,
      mtime,
      ino,
      readOffset,
      anchor,
      headAnchor,
      rem,
      completeCount,
      tailLines,
      isPartial,
      summary
    },
    500
  );
}

function readTranscriptCached(filePath, summarizeFn = summarizeLines) {
  if (!filePath) return NO_TRANSCRIPT;
  const p = probeFile(transcriptCache, filePath, TRANSCRIPT_TAIL_BYTES);
  if (p.status === "missing") return NO_TRANSCRIPT;
  if (p.status === "hit") return p.hit;
  if (p.status === "append") {
    const updated = applyTranscriptAppend(filePath, p.hit, p.delta, summarizeFn);
    if (updated) return updated;
  }
  if (p.s.size > TRANSCRIPT_TAIL_BYTES) {
    const tailed = readTranscriptTailFromEOF(filePath, summarizeFn);
    if (tailed) return putCache(transcriptCache, filePath, tailed, 500);
  }
  if (
    p.status === "miss" &&
    p.hit?.readOffset > 0 &&
    p.s.size >= p.hit.size &&
    p.s.ino === p.hit.ino &&
    p.s.size - p.hit.readOffset > TRANSCRIPT_TAIL_BYTES
  ) {
    const delta = readAppendedTail(filePath, p.hit);
    if (delta) {
      const updated = applyTranscriptAppend(filePath, p.hit, delta, summarizeFn);
      if (updated) return updated;
    }
  }
  const full = readFullFile(filePath);
  if (!full) {
    transcriptCache.delete(filePath);
    return NO_TRANSCRIPT;
  }
  const completeLines = full.completeBuf ? nonEmptyLines(full.completeBuf) : [];
  const remText = full.remBuf.toString("utf8");
  const allLines = remText.trim() ? completeLines.concat([remText]) : completeLines;
  const summary = summarizeFn(allLines, allLines.length, full.mtime, false);
  const isPartial = completeLines.length > TRANSCRIPT_TAIL_LINES;
  const tailLines = isPartial ? completeLines.slice(-TRANSCRIPT_TAIL_LINES) : completeLines;
  const { size, mtime, ino, readOffset, anchor, headAnchor, remBuf: rem } = full;
  return putCache(
    transcriptCache,
    filePath,
    {
      key: `${mtime}:${size}:${ino}`,
      size,
      mtime,
      ino,
      readOffset,
      anchor,
      headAnchor,
      rem,
      completeCount: completeLines.length,
      tailLines,
      isPartial,
      summary
    },
    500
  );
}

/**
 * Derive a Swarm member's live status ('working' | 'waiting' | 'killed')
 * preferring transcript turn state and falling back to wake_mode.
 */
function statusOf(m, trSummary) {
  if (!m) return "working";
  if (m.killed || m.desired_state === "KILLED" || m.phase === "KILLED") return "killed";
  if (typeof trSummary?.idle === "boolean") return trSummary.idle ? "waiting" : "working";
  if (m.wake_mode === "mentions" || m.wake_mode === "anything") return "waiting";
  return "working";
}

/**
 * Bounded tail derivation for short-lived hook processes (256 KB initial window,
 * widening up to 2 MB only when lacking a turn boundary; never reads multi-MB full files).
 */
function deriveSingleMemberState(appDataDir, member) {
  if (!member || typeof member !== "object") {
    return { status: "working", steps: 0, replied: false, replyAsk: "", hasTranscript: false, bytesRead: 0 };
  }
  if (member.killed || member.desired_state === "KILLED" || member.phase === "KILLED") {
    return { status: "killed", steps: 0, replied: false, replyAsk: "", hasTranscript: false, bytesRead: 0 };
  }
  const trPath = getTranscriptPath(appDataDir, member.conversation_id);
  if (!trPath) {
    return {
      status: statusOf(member, null),
      steps: 0,
      replied: false,
      replyAsk: "",
      hasTranscript: false,
      bytesRead: 0
    };
  }

  let fd = -1;
  let bytesRead = 0;
  try {
    fd = fs.openSync(trPath, "r");
    const st = fs.fstatSync(fd);
    if (st.size <= 0) {
      return {
        status: statusOf(member, null),
        steps: 0,
        replied: false,
        replyAsk: "",
        hasTranscript: false,
        bytesRead: 0
      };
    }

    let lastWorkLines = null;
    let lastInferredCount = 0;
    for (
      let windowBytes = TRANSCRIPT_TAIL_BYTES;
      ;
      windowBytes *= 2
    ) {
      const actualWindow = Math.min(st.size, windowBytes);
      const startPos = st.size - actualWindow;
      const buf = readExact(fd, actualWindow, startPos);
      if (!buf) break;
      bytesRead += buf.length;

      let slice = buf;
      const isPartial = startPos > 0;
      if (isPartial) {
        const firstNl = buf.indexOf(0x0a);
        if (firstNl < 0) {
          if (actualWindow >= st.size || windowBytes >= TRANSCRIPT_MAX_TAIL_BYTES) break;
          continue;
        }
        slice = buf.subarray(firstNl + 1);
      }

      const lastNl = slice.lastIndexOf(0x0a);
      const completeBuf = lastNl >= 0 ? slice.subarray(0, lastNl + 1) : Buffer.alloc(0);
      const remText = (lastNl >= 0 ? slice.subarray(lastNl + 1) : slice).toString("utf8");
      const completeLines = nonEmptyLines(completeBuf);
      const hasRem = Boolean(remText.trim());
      const workLines = hasRem ? completeLines.concat([remText]) : completeLines;
      if (!workLines.length) {
        if (actualWindow >= st.size || windowBytes >= TRANSCRIPT_MAX_TAIL_BYTES) break;
        continue;
      }

      const inferred = inferStepCountFromTail(workLines);
      const totalLines = inferred.ok ? inferred.count : workLines.length;
      lastWorkLines = workLines;
      lastInferredCount = totalLines;

      const summary = summarizeLines(workLines, totalLines, st.mtimeMs, isPartial);
      if (summary) {
        return {
          status: statusOf(member, summary),
          steps: summary.steps,
          replied: summary.replied,
          replyAsk: summary.replyAsk,
          hasTranscript: true,
          bytesRead,
          mtime: st.mtimeMs
        };
      }
      if (actualWindow >= st.size || windowBytes >= TRANSCRIPT_MAX_TAIL_BYTES) break;
    }

    // Even if a single turn exceeds 2 MB, still derive turnEnded from the 2 MB tail without reading further.
    if (lastWorkLines && lastWorkLines.length > 0) {
      const idle = turnEnded(lastWorkLines);
      const reply = finalReply(lastWorkLines);
      return {
        status: statusOf(member, { idle }),
        steps: lastInferredCount || lastWorkLines.length,
        replied: reply !== null,
        replyAsk: reply !== null ? replyQuestion(reply) : "",
        hasTranscript: true,
        bytesRead,
        mtime: st.mtimeMs
      };
    }

    return {
      status: statusOf(member, null),
      steps: 0,
      replied: false,
      replyAsk: "",
      hasTranscript: false,
      bytesRead
    };
  } catch {
    return {
      status: statusOf(member, null),
      steps: 0,
      replied: false,
      replyAsk: "",
      hasTranscript: false,
      bytesRead
    };
  } finally {
    if (fd >= 0) try { fs.closeSync(fd); } catch {}
  }
}

function hasExactMention(text, name) {
  if (!name || typeof text !== "string" || !text) return false;
  const escaped = escapeRegExp(String(name));
  const re = new RegExp(`(?:^|[^\\w-])@${escaped}(?![\\w-])`, "i");
  return re.test(text);
}

function matchesMemberMention(text, memberName, { includeAll = true } = {}) {
  if (!memberName || typeof text !== "string" || !text) return false;
  if (hasExactMention(text, memberName)) return true;
  const baseMatch = /^(.+)-\d+$/.exec(String(memberName));
  if (baseMatch && hasExactMention(text, baseMatch[1])) return true;
  if (includeAll && hasExactMention(text, "all")) return true;
  return false;
}

function controlOf(m) {
  return m?.control && typeof m.control === "object" && !Array.isArray(m.control) ? m.control : null;
}

function isSystemSwarmRole(name, m) {
  if (!m || typeof m !== "object") return true;
  if (m.role !== "worker") return true;
  if (SYSTEM_ROLE_NAME_RE.test(String(name || ""))) return true;
  return false;
}

function readJsonObjSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read the active Swarm state on disk (swarm.json backend check, members.json,
 * incremental board.jsonl tail, and transcript-first member status).
 */
function readActiveSwarmState(workspacePath, opts = {}) {
  const dbMod = getDbMod();
  const absWs = workspacePath ? path.resolve(workspacePath) : "";
  const cfg = opts.coordinatorConversationId ? null : (absWs && dbMod.hasProjectInitialized(absWs) ? dbMod.loadProjectConfig(absWs) : null);
  const coordId = opts.coordinatorConversationId ?? cfg?.coordinatorConversationId ?? null;
  const appDataDir = opts.appDataDir || dbMod.getAppDataDir();

  const empty = (extra = {}) => ({
    active: false,
    backend: null,
    unsupportedReason: null,
    coordinatorConversationId: coordId,
    swarmDir: null,
    title: "",
    head: 0,
    members: {},
    memberList: [],
    messages: [],
    counts: { total: 0, working: 0, waiting: 0, killed: 0 },
    ...extra
  });

  if (!coordId) return empty();
  const swarmDir = getSwarmDir(appDataDir, String(coordId));
  if (!swarmDir) return empty({ unsupportedReason: "invalid_coordinator_id" });

  const swarmJson = readJsonObjSafe(path.join(swarmDir, "swarm.json"));
  if (swarmJson && typeof swarmJson.backend === "string" && swarmJson.backend !== "local") {
    return empty({
      backend: swarmJson.backend,
      unsupportedReason: "remote_swarm",
      swarmDir
    });
  }

  const membersPath = path.join(swarmDir, "members.json");
  const boardPath = path.join(swarmDir, "board.jsonl");
  const membersExists = fs.existsSync(membersPath);
  const boardExists = fs.existsSync(boardPath);
  if (!membersExists && !boardExists) {
    return empty({
      backend: swarmJson?.backend || "local",
      swarmDir
    });
  }

  const roster = readJsonObjSafe(membersPath) || { title: "", members: {} };
  const rawMembers = roster.members && typeof roster.members === "object" && !Array.isArray(roster.members)
    ? roster.members
    : {};
  const board = boardExists ? readBoardCached(boardPath) : { msgs: [], epoch: 0, mtime: 0, size: -1, ino: 0 };
  const msgs = board.msgs || [];
  const head = msgs.length ? (Number(msgs[msgs.length - 1].seq) || msgs.length) : 0;

  const latestPostByAgent = new Map();
  for (const msg of msgs) {
    if (controlOf(msg)) continue;
    const agent = String(msg.agent || "");
    if (!agent) continue;
    const prev = latestPostByAgent.get(agent);
    if (!prev || (Number(msg.seq) || 0) >= (Number(prev.seq) || 0)) {
      latestPostByAgent.set(agent, msg);
    }
  }

  const members = {};
  const memberList = [];
  const counts = { total: 0, working: 0, waiting: 0, killed: 0 };

  for (const [name, m] of Object.entries(rawMembers)) {
    if (!m || typeof m !== "object") continue;
    const trPath = getTranscriptPath(appDataDir, m.conversation_id);
    const tr = trPath ? readTranscriptCached(trPath, summarizeLines) : NO_TRANSCRIPT;
    const status = statusOf(m, tr.summary);
    const isSystem = isSystemSwarmRole(name, m);
    const lastPost = latestPostByAgent.get(name) || null;
    const info = {
      name,
      role: typeof m.role === "string" ? m.role : "",
      isSystem,
      conversation_id: m.conversation_id ? String(m.conversation_id) : "",
      model: m.model ? String(m.model) : "",
      wake_mode: m.wake_mode ? String(m.wake_mode) : "",
      workspace_mode: typeof m.workspace_mode === "string" ? m.workspace_mode : "",
      killed: Boolean(m.killed || m.desired_state === "KILLED" || m.phase === "KILLED"),
      status,
      steps: tr.summary?.steps || 0,
      hasTranscript: Boolean(tr.summary),
      replied: Boolean(tr.summary?.replied),
      replyAsk: tr.summary?.replyAsk || "",
      transcriptKey: tr.key || "-",
      lastPostSeq: lastPost ? (Number(lastPost.seq) || 0) : 0,
      lastPostText: lastPost ? String(lastPost.text || "") : "",
      lastPostTime: lastPost ? String(lastPost.time || "") : "",
      lastPost
    };
    members[name] = info;
    memberList.push(info);
    if (!isSystem) {
      counts.total += 1;
      if (status === "working") counts.working += 1;
      else if (status === "waiting") counts.waiting += 1;
      else if (status === "killed") counts.killed += 1;
    }
  }

  return {
    active: true,
    backend: swarmJson?.backend || "local",
    unsupportedReason: null,
    coordinatorConversationId: String(coordId),
    swarmDir,
    title: typeof roster.title === "string" ? roster.title : "",
    head,
    members,
    memberList,
    messages: msgs,
    counts
  };
}

/**
 * Read board messages relevant to a thread's Swarm worker (authored by the worker,
 * or addressing @member, group @base, or @all) from its swarm_origin_coordinator_id.
 */
function getThreadBoardMessages(workspacePath, threadId, opts = {}) {
  const dbMod = getDbMod();
  const absWs = path.resolve(workspacePath);
  const db = dbMod.openProjectDb(absWs);
  const thread = db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadId);
  if (!thread) {
    return { found: false, threadId, memberName: null, coordinatorConversationId: null, messages: [], head: 0 };
  }
  const cfg = dbMod.loadProjectConfig(absWs);
  const coordId = opts.coordinatorConversationId || thread.swarm_origin_coordinator_id || cfg?.coordinatorConversationId || null;
  const memberName = thread.swarm_member_name || null;
  if (!coordId || !memberName) {
    return { found: true, threadId, memberName, coordinatorConversationId: coordId, messages: [], head: 0 };
  }

  const appDataDir = opts.appDataDir || dbMod.getAppDataDir();
  const swarmDir = getSwarmDir(appDataDir, coordId);
  if (!swarmDir) {
    return { found: true, threadId, memberName, coordinatorConversationId: coordId, messages: [], head: 0 };
  }
  const swarmJson = readJsonObjSafe(path.join(swarmDir, "swarm.json"));
  if (swarmJson && typeof swarmJson.backend === "string" && swarmJson.backend !== "local") {
    return {
      found: true,
      threadId,
      memberName,
      coordinatorConversationId: coordId,
      backend: swarmJson.backend,
      unsupportedReason: "remote_swarm",
      messages: [],
      head: 0
    };
  }
  const boardPath = path.join(swarmDir, "board.jsonl");
  if (!fs.existsSync(boardPath)) {
    return { found: true, threadId, memberName, coordinatorConversationId: coordId, messages: [], head: 0 };
  }
  const board = readBoardCached(boardPath);
  const msgs = board.msgs || [];
  const head = msgs.length ? (Number(msgs[msgs.length - 1].seq) || msgs.length) : 0;
  const filtered = msgs.filter((m) => {
    if (controlOf(m)) return false;
    if (String(m.agent || "") === memberName) return true;
    return matchesMemberMention(String(m.text || ""), memberName, { includeAll: true });
  });
  const limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : null;
  return {
    found: true,
    threadId,
    memberName,
    coordinatorConversationId: coordId,
    head,
    messages: limit ? filtered.slice(-limit) : filtered
  };
}

/**
 * Read project-wide Swarm Board state, roster metadata, and filtered visible messages.
 */
function getProjectSwarmBoard(workspacePath, opts = {}) {
  const absWs = path.resolve(workspacePath);
  const snap = readActiveSwarmState(absWs, opts);
  const member = typeof opts.member === "string" ? opts.member.trim() : "";
  const rawMsgs = Array.isArray(snap.messages) ? snap.messages : [];
  const nonControlMsgs = rawMsgs.filter((m) => !controlOf(m));
  const visibleMsgs = member
    ? nonControlMsgs.filter(
        (m) =>
          String(m.agent || "") === member ||
          matchesMemberMention(String(m.text || ""), member, { includeAll: true })
      )
    : nonControlMsgs;
  const rawLimit = opts.limit === undefined ? 150 : Number(opts.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, Math.floor(rawLimit)) : 150;
  const limitedMsgs = visibleMsgs.slice(-limit);
  return {
    active: Boolean(snap.active),
    backend: snap.backend || null,
    unsupportedReason: snap.unsupportedReason || null,
    coordinatorConversationId: snap.coordinatorConversationId || null,
    title: snap.title || "",
    head: snap.head || 0,
    counts: snap.counts || { total: 0, working: 0, waiting: 0, killed: 0 },
    members: (snap.memberList || []).map((m) => ({
      name: m.name,
      role: m.role,
      isSystem: Boolean(m.isSystem),
      conversation_id: m.conversation_id || "",
      model: m.model || "",
      workspace_mode: m.workspace_mode || "",
      status: m.status || "waiting",
      steps: Number(m.steps || 0),
      lastPostSeq: Number(m.lastPostSeq || 0),
      lastPostTime: m.lastPostTime || ""
    })),
    memberFilter: member || null,
    totalMessages: visibleMsgs.length,
    messages: limitedMsgs
  };
}

function formatSwarmLastMessage(msg) {
  if (!msg) return null;
  const seq = Number(msg.seq) || 0;
  const agent = String(msg.agent || "member");
  const body = oneLine(msg.text || "", 180);
  return seq > 0 ? `#${seq} @${agent}: ${body}` : `@${agent}: ${body}`;
}

function stripDonePrefix(text) {
  return oneLine(String(text || "").replace(/^\s*(?:@[a-z0-9_-]+\s+)+\[done\]\s*/i, ""), 240);
}

function extractBlockedQuestion(text) {
  const cleaned = oneLine(
    String(text || "").replace(/^\s*(?:@[a-z0-9_-]+\s+)+\[(?:blocked|question)\]\s*/i, ""),
    240
  );
  if (cleaned) return cleaned;
  const q = replyQuestion(text);
  return q || oneLine(text, 240) || "Worker requested input.";
}

function inferSwarmRole(name, briefText = "") {
  const hay = `${name} ${briefText}`.toLowerCase();
  if (/\bpr[-_\s]?fix/.test(hay)) return "pr-fixer";
  if (/\b(verif|review|audit|qa)\b/.test(hay)) return "verifier";
  if (/\b(explor|research|map|read-only|readonly)\b/.test(hay)) return "explorer";
  return "implementer";
}

function matchesSwarmTargetName(targetName, memberName) {
  if (!targetName || !memberName) return false;
  const re = new RegExp(`^${escapeRegExp(String(targetName))}(?:-\\d+)?$`, "i");
  return re.test(String(memberName));
}

function findVerifiedBriefForMember(msgs, memberName, db, parseMarkerFn, rosterMembers = {}) {
  const startRe = new RegExp(`^\\s*@${escapeRegExp(memberName)}(?=\\s|$)`, "i");
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (!msg || controlOf(msg) || msg.kind !== "brief") continue;
    if (String(msg.agent || "") !== "coordinator") continue;
    const text = String(msg.text || "");
    if (!startRe.test(text)) continue;
    const parsed = parseMarkerFn(text);
    if (!parsed) continue;
    const dispatchRow = db
      .prepare("SELECT * FROM hub_dispatches WHERE dispatch_id = ? AND thread_id = ?")
      .get(parsed.dispatchId, parsed.threadId);
    if (!dispatchRow) continue;
    const target = dispatchRow.target_member_name;
    if (
      target &&
      !matchesSwarmTargetName(target, memberName) &&
      Object.prototype.hasOwnProperty.call(rosterMembers || {}, target)
    ) {
      continue;
    }
    return { msg, parsed, dispatchRow };
  }
  return null;
}

function findBriefSeqForMember(msgs, memberName) {
  const startRe = new RegExp(`^\\s*@${escapeRegExp(memberName)}(?=\\s|$)`, "i");
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (!msg || controlOf(msg) || msg.kind !== "brief") continue;
    if (String(msg.agent || "") !== "coordinator") continue;
    if (startRe.test(String(msg.text || ""))) {
      return Number(msg.seq) || 0;
    }
  }
  return 0;
}

function extractBriefTitle(briefMsg, memberName) {
  if (!briefMsg) return `Swarm @${memberName}`;
  const cleaned = String(briefMsg)
    .replace(new RegExp(`^(?:\\s*@${escapeRegExp(memberName)}(?=\\s|$))+\\s*`, "gi"), "")
    .replace(/\[agy-thread:[^\]]*\]/gi, "")
    .trim();
  return cleaned ? oneLine(cleaned, 80) : `Swarm @${memberName}`;
}

function runImmediateTx(db, fn, { maxRetries = 8, baseDelayMs = 15 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      db.exec("BEGIN IMMEDIATE");
      break;
    } catch (err) {
      const msg = String(err?.message || err);
      if ((/SQLITE_BUSY|database is locked|busy/i.test(msg)) && attempt < maxRetries) {
        const waitMs = Math.min(120, baseDelayMs * Math.pow(2, attempt));
        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
        } catch {}
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
  try {
    const res = fn();
    db.exec("COMMIT");
    return res;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    throw err;
  }
}

function buildPlanForMember({
  m,
  row,
  coordId,
  msgs,
  boardHead = 0,
  allMembers = {},
  isNewlyCreatedAdHoc = false,
  latestPost,
  verifiedBrief,
  db,
  cfgStatus,
  nowTs
}) {
  const name = m.name;
  const liveSwarmState = m.status;
  const prevSwarmState = row ? (row.swarm_state || null) : null;
  const prevHandledSeq = row ? Number(row.swarm_handled_seq || 0) : 0;
  const prevLastSeq = row ? Number(row.swarm_last_seq || 0) : 0;

  let nextBucket = row ? row.ui_bucket : (liveSwarmState === "killed" ? "resolved" : (cfgStatus !== "active" ? "paused" : (liveSwarmState === "waiting" ? "idle" : "working")));
  let nextServerStatus = row ? row.server_status : getDbMod().uiBucketToServerStatus(nextBucket);
  let nextBlockingQuestion = row ? row.blocking_question : null;
  let nextBlockingIsError = row ? Number(row.blocking_is_error || 0) : 0;
  let nextSummary = row ? row.last_summary : null;
  let nextPrePauseBucket = row ? row.pre_pause_bucket : null;
  let nextWorkingSince = row ? row.working_since : (nextBucket === "working" ? nowTs : null);
  let nextResolvedAt = row ? row.resolved_at : (nextBucket === "resolved" ? nowTs : null);
  let nextHandledSeq = prevHandledSeq;
  const nextLastSeq = latestPost ? Math.max(prevLastSeq, Number(latestPost.seq || 0)) : prevLastSeq;
  const nextLastMessage = latestPost ? formatSwarmLastMessage(latestPost) : (row ? row.swarm_last_message : null);
  const nextSwarmModel = m.model ? String(m.model) : (row ? row.swarm_model : null);
  const nextConvId = m.conversation_id ? String(m.conversation_id) : (row ? row.conversation_id : null);
  let nextActiveDispatchId = row ? row.active_dispatch_id : null;

  // Per-action fallback matching for pending/claimed dispatches
  const dispatchesToMatch = [];
  let activeDispatchRow = null;
  if (nextActiveDispatchId) {
    activeDispatchRow = db
      .prepare("SELECT * FROM hub_dispatches WHERE dispatch_id = ?")
      .get(nextActiveDispatchId);
  }
  const openDispatches = row
    ? db
        .prepare("SELECT * FROM hub_dispatches WHERE thread_id = ? AND status IN ('pending', 'claimed')")
        .all(row.thread_id)
    : (verifiedBrief ? [verifiedBrief.dispatchRow] : []);

  const workerCandidates = Object.values(allMembers || {}).filter((cand) => cand && !cand.isSystem);
  let spawnMatchedByDispatch = false;
  for (const d of openDispatches) {
    if (!d || (d.status !== "pending" && d.status !== "claimed")) continue;
    const isVerifiedForThisMember = Boolean(verifiedBrief && verifiedBrief.dispatchRow.dispatch_id === d.dispatch_id);
    if (d.target_member_name && !matchesSwarmTargetName(d.target_member_name, name) && !isVerifiedForThisMember) {
      continue;
    }
    if (d.action === "start" || d.action === "cron" || d.action === "pr_autofix") {
      if (liveSwarmState !== "killed" && (isVerifiedForThisMember || m.conversation_id || (row && row.swarm_member_name === name))) {
        dispatchesToMatch.push(d);
        spawnMatchedByDispatch = true;
        if (nextActiveDispatchId === d.dispatch_id) {
          nextActiveDispatchId = null;
          activeDispatchRow = null;
        }
      }
    } else if (d.action === "steer") {
      const baseSeq = Number(d.baseline_head_seq || 0);
      const steerPosted = msgs.some(
        (msg) =>
          !controlOf(msg) &&
          String(msg.agent || "") === "coordinator" &&
          (Number(msg.seq) || 0) > baseSeq &&
          matchesMemberMention(String(msg.text || ""), name, { includeAll: false })
      );
      if (steerPosted) {
        dispatchesToMatch.push(d);
        if (nextActiveDispatchId === d.dispatch_id) {
          nextActiveDispatchId = null;
          activeDispatchRow = null;
        }
      }
    } else if (d.action === "switch_model") {
      let targetModel = null;
      let isInherit = false;
      try {
        const p = JSON.parse(d.payload_json || "{}");
        targetModel = p.resolvedModel || getDbMod().resolveSwarmModel(p.model);
        isInherit = !targetModel && String(p.model || "inherit") === "inherit";
      } catch {}
      const groupMembers = d.target_member_name
        ? workerCandidates.filter((cand) => matchesSwarmTargetName(d.target_member_name, cand.name))
        : [m];
      const coordModel = allMembers?.coordinator?.model ? String(allMembers.coordinator.model) : null;
      const expectedModel = targetModel ? String(targetModel) : (isInherit ? coordModel : null);
      const allModelsMatch =
        expectedModel && groupMembers.length > 0
          ? groupMembers.every((cand) => cand.model && String(cand.model) === expectedModel)
          : (isInherit && m.model && row && m.model !== row.swarm_model);
      if (allModelsMatch) {
        dispatchesToMatch.push(d);
        if (nextActiveDispatchId === d.dispatch_id) {
          nextActiveDispatchId = null;
          activeDispatchRow = null;
        }
      }
    } else if (d.action === "kill") {
      const groupMembers = d.target_member_name
        ? workerCandidates.filter((cand) => matchesSwarmTargetName(d.target_member_name, cand.name))
        : [m];
      if (groupMembers.length > 0 && groupMembers.every((cand) => cand.status === "killed")) {
        dispatchesToMatch.push(d);
        if (nextActiveDispatchId === d.dispatch_id) {
          nextActiveDispatchId = null;
          activeDispatchRow = null;
        }
      }
    }
  }

  if (spawnMatchedByDispatch) {
    const briefSeq = verifiedBrief?.msg?.seq ? Number(verifiedBrief.msg.seq) : findBriefSeqForMember(msgs, name);
    if (briefSeq > nextHandledSeq) nextHandledSeq = briefSeq;
  }

  const hasInFlightDispatch = Boolean(
    activeDispatchRow &&
      ((activeDispatchRow.status === "pending" && activeDispatchRow.claim_expires_at > nowTs) ||
        (activeDispatchRow.status === "claimed" && activeDispatchRow.match_expires_at && activeDispatchRow.match_expires_at > nowTs)) &&
      !dispatchesToMatch.some((d) => d.dispatch_id === activeDispatchRow.dispatch_id)
  );

  const uiBucketToServerStatus = getDbMod().uiBucketToServerStatus;

  // 1. Killed -> resolved (always clears pre_pause_bucket and active_dispatch_id)
  if (liveSwarmState === "killed") {
    nextBucket = "resolved";
    nextServerStatus = "resolved";
    nextPrePauseBucket = null;
    nextWorkingSince = null;
    nextResolvedAt = (row && row.resolved_at) || nowTs;
    nextBlockingQuestion = null;
    nextBlockingIsError = 0;
    nextActiveDispatchId = null;
  } else if (nextBucket === "resolved" || nextBucket === "landing" || nextBucket === "paused") {
    // 2. Protected buckets are never auto-reopened by @all wakes or working/waiting changes
  } else {
    // 3. Seq-only completion/blocked edges from member's newest post
    let edgeApplied = false;
    if (latestPost && (Number(latestPost.seq) || 0) > nextHandledSeq) {
      const postSeq = Number(latestPost.seq) || 0;
      const postText = String(latestPost.text || "");
      if (DONE_LINE_RE.test(postText)) {
        nextBucket = "ready_for_review";
        nextServerStatus = uiBucketToServerStatus("ready_for_review");
        nextSummary = stripDonePrefix(postText) || nextSummary || "Completed via Swarm.";
        nextBlockingQuestion = null;
        nextBlockingIsError = 0;
        nextWorkingSince = null;
        nextHandledSeq = postSeq;
        nextActiveDispatchId = null;
        edgeApplied = true;
      } else if (
        liveSwarmState === "waiting" &&
        hasExactMention(postText, "coordinator") &&
        (BLOCKED_LINE_RE.test(postText) || Boolean(replyQuestion(postText)))
      ) {
        nextBucket = "waiting_on_you";
        nextServerStatus = uiBucketToServerStatus("waiting_on_you");
        nextBlockingQuestion = extractBlockedQuestion(postText);
        nextBlockingIsError = 0;
        nextWorkingSince = null;
        nextHandledSeq = postSeq;
        nextActiveDispatchId = null;
        edgeApplied = true;
      }
    }

    // 4. Active wake edge (require mention newer than BOTH swarm_handled_seq and member's last post)
    if (
      !edgeApplied &&
      cfgStatus === "active" &&
      (nextBucket === "suggested" ||
        nextBucket === "idle" ||
        nextBucket === "waiting_on_you" ||
        nextBucket === "ready_for_review")
    ) {
      const wakeFloor = Math.max(nextHandledSeq, nextLastSeq);
      const directWakeMsgs = msgs.filter(
        (msg) =>
          !controlOf(msg) &&
          String(msg.agent || "") !== name &&
          (Number(msg.seq) || 0) > wakeFloor &&
          matchesMemberMention(String(msg.text || ""), name, { includeAll: false })
      );
      const hasDirectMentionWake = directWakeMsgs.length > 0;
      if (
        (spawnMatchedByDispatch &&
          (nextBucket === "suggested" ||
            nextBucket === "idle" ||
            nextBucket === "ready_for_review" ||
            nextBucket === "waiting_on_you")) ||
        (liveSwarmState === "working" && prevSwarmState !== "working" && (hasDirectMentionWake || spawnMatchedByDispatch))
      ) {
        nextBucket = "working";
        nextServerStatus = "working";
        nextBlockingQuestion = null;
        nextBlockingIsError = 0;
        nextWorkingSince = (row && row.working_since) || nowTs;
        if (hasDirectMentionWake) {
          const newestWakeSeq = Number(directWakeMsgs[directWakeMsgs.length - 1].seq || 0);
          if (newestWakeSeq > nextHandledSeq) nextHandledSeq = newestWakeSeq;
        }
        edgeApplied = true;
      }
    }

    // 5. Guarded park edge (working -> idle): requires observed working -> waiting + Turn 1 steps > 0 + no active dispatch
    if (
      !edgeApplied &&
      nextBucket === "working" &&
      prevSwarmState === "working" &&
      liveSwarmState === "waiting" &&
      m.steps > 0 &&
      !hasInFlightDispatch
    ) {
      nextBucket = "idle";
      nextServerStatus = "idle";
      nextWorkingSince = null;
      if (Number(boardHead || 0) > nextHandledSeq) {
        nextHandledSeq = Number(boardHead || 0);
      }
    } else if (!edgeApplied && isNewlyCreatedAdHoc && nextBucket === "idle" && Number(boardHead || 0) > nextHandledSeq) {
      nextHandledSeq = Number(boardHead || 0);
    }
  }

  // Keep newborn steps===0 workers marked 'working' in SQLite so Turn-1 completion observes working -> waiting
  const nextSwarmState =
    liveSwarmState === "waiting" && m.steps === 0 && nextBucket === "working"
      ? "working"
      : liveSwarmState;

  return {
    name,
    liveSwarmState,
    nextSwarmState,
    nextBucket,
    nextServerStatus,
    nextBlockingQuestion,
    nextBlockingIsError,
    nextSummary,
    nextPrePauseBucket,
    nextWorkingSince,
    nextResolvedAt,
    nextHandledSeq,
    nextLastSeq,
    nextLastMessage,
    nextSwarmModel,
    nextConvId,
    nextActiveDispatchId,
    nextOriginCoordId: coordId,
    dispatchesToMatch
  };
}

/**
 * Reconcile Swarm disk state into SQLite project_index.db and boundConversations.
 * Never invoked inside openProjectDb; uses BEGIN IMMEDIATE with busy retry and
 * strict diff guards so idle polls emit zero SQLite/registry writes.
 */
function syncSwarmIntoProjectDb(workspacePath, opts = {}) {
  const dbMod = getDbMod();
  const absWs = path.resolve(workspacePath);
  if (!dbMod.hasProjectInitialized(absWs)) {
    return { synced: false, reason: "uninitialized", changes: 0 };
  }
  const cfg = dbMod.loadProjectConfig(absWs);
  if (!cfg) return { synced: false, reason: "no_config", changes: 0 };

  const swarmState = readActiveSwarmState(absWs, opts);
  if (!swarmState.active) {
    return {
      synced: false,
      reason: swarmState.unsupportedReason || "inactive",
      changes: 0,
      swarm: swarmState
    };
  }

  const db = dbMod.openProjectDb(absWs);
  const coordId = swarmState.coordinatorConversationId;
  const workerMembers = swarmState.memberList.filter((m) => !m.isSystem);
  const nowTs = dbMod.nowIso();

  const resolveMatchForMember = (m) => {
    let row = null;
    if (m.conversation_id) {
      row = db.prepare("SELECT * FROM threads WHERE conversation_id = ?").get(m.conversation_id);
    }
    if (!row) {
      const candidate = db
        .prepare("SELECT * FROM threads WHERE swarm_origin_coordinator_id = ? AND swarm_member_name = ?")
        .get(coordId, m.name);
      if (candidate && (!candidate.conversation_id || !m.conversation_id || candidate.conversation_id === m.conversation_id)) {
        row = candidate;
      }
    }
    let verifiedBrief = null;
    if (!row) {
      verifiedBrief = findVerifiedBriefForMember(swarmState.messages, m.name, db, dbMod.parseDispatchMarker, swarmState.members);
      if (verifiedBrief) {
        const candidate = db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(verifiedBrief.parsed.threadId);
        if (candidate && (!candidate.conversation_id || !m.conversation_id || candidate.conversation_id === m.conversation_id)) {
          row = candidate;
        } else {
          verifiedBrief = null;
        }
      }
    }
    return { row, verifiedBrief };
  };

  const needsSyncCheck = () => {
    for (const m of workerMembers) {
      const { row, verifiedBrief } = resolveMatchForMember(m);
      if (!row) return true;
      const memberPost = m.lastPost || findLatestPostByAgent(swarmState.messages, m.name);
      const plan = buildPlanForMember({
        m,
        row,
        coordId,
        msgs: swarmState.messages,
        boardHead: swarmState.head,
        allMembers: swarmState.members,
        isNewlyCreatedAdHoc: false,
        latestPost: memberPost,
        verifiedBrief,
        db,
        cfgStatus: cfg.status,
        nowTs
      });
      if (plan.dispatchesToMatch.length > 0) return true;
      if (hasRowDiff(row, plan, m.name)) return true;
    }
    return false;
  };

  if (!needsSyncCheck()) {
    const regBindings = collectNeededRegistryBindings(db, absWs, cfg.projectId, workerMembers, dbMod.loadRegistry());
    for (const b of regBindings) {
      dbMod.syncConversationBinding(b.conversationId, b.binding);
    }
    return { synced: true, changes: 0, swarm: swarmState };
  }

  let txChanges = 0;
  const touchedThreadIds = [];

  runImmediateTx(db, () => {
    const txNow = dbMod.nowIso();
    for (const m of workerMembers) {
      let { row, verifiedBrief } = resolveMatchForMember(m);
      const latestPost = m.lastPost || findLatestPostByAgent(swarmState.messages, m.name);
      let isNewlyCreatedAdHoc = false;

      if (!row) {
        const adHocId = `swarm-${dbMod.sha256Hex(`${coordId}:${m.name}`).slice(0, 8)}`;
        const briefMsg = findAnyBriefTextForMember(swarmState.messages, m.name);
        const initialRole = inferSwarmRole(m.name, briefMsg);
        const initialBucket =
          m.status === "killed"
            ? "resolved"
            : cfg.status !== "active"
            ? "paused"
            : m.status === "waiting"
            ? "idle"
            : "working";
        const initialStatus = dbMod.uiBucketToServerStatus(initialBucket);
        const existingByConv = m.conversation_id
          ? db.prepare("SELECT thread_id FROM threads WHERE conversation_id = ?").get(m.conversation_id)
          : null;
        const safeConvId = existingByConv ? null : (m.conversation_id || null);

        const ins = db
          .prepare(`
            INSERT INTO threads (
              thread_id, title, description, role, ui_bucket, server_status,
              conversation_id, model, workspace_mode,
              swarm_member_name, swarm_model, swarm_state, swarm_origin_coordinator_id,
              swarm_last_seq, swarm_handled_seq, swarm_last_message, execution_backend,
              created_at, updated_at, working_since, resolved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'inherit', ?, ?, ?, ?, ?, ?, 0, ?, 'swarm', ?, ?, ?, ?)
            ON CONFLICT DO NOTHING
          `)
          .run(
            adHocId,
            extractBriefTitle(briefMsg, m.name),
            briefMsg || `Ad-hoc Swarm worker @${m.name}`,
            initialRole,
            initialBucket,
            initialStatus,
            safeConvId,
            m.workspace_mode || "inherit",
            m.name,
            m.model || null,
            m.status,
            coordId,
            latestPost ? (Number(latestPost.seq) || 0) : 0,
            latestPost ? formatSwarmLastMessage(latestPost) : null,
            txNow,
            txNow,
            initialBucket === "working" ? txNow : null,
            initialBucket === "resolved" ? txNow : null
          );
        if (ins.changes > 0) {
          txChanges += 1;
          isNewlyCreatedAdHoc = true;
        }
        row =
          db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(adHocId) ||
          (m.conversation_id ? db.prepare("SELECT * FROM threads WHERE conversation_id = ?").get(m.conversation_id) : null);
        if (!row) continue;
      }

      const plan = buildPlanForMember({
        m,
        row,
        coordId,
        msgs: swarmState.messages,
        boardHead: swarmState.head,
        allMembers: swarmState.members,
        isNewlyCreatedAdHoc,
        latestPost,
        verifiedBrief,
        db,
        cfgStatus: cfg.status,
        nowTs: txNow
      });

      // Avoid UNIQUE constraint violation if another thread already holds m.conversation_id
      if (plan.nextConvId && plan.nextConvId !== row.conversation_id) {
        const owner = db.prepare("SELECT thread_id FROM threads WHERE conversation_id = ?").get(plan.nextConvId);
        if (owner && owner.thread_id !== row.thread_id) {
          plan.nextConvId = row.conversation_id;
        }
      }

      for (const d of plan.dispatchesToMatch) {
        const res = db
          .prepare(`
            UPDATE hub_dispatches SET
              status = 'matched',
              reserved_slots = 0,
              consumed_at = COALESCE(consumed_at, ?),
              target_member_name = COALESCE(target_member_name, ?)
            WHERE dispatch_id = ? AND status IN ('pending', 'claimed')
          `)
          .run(txNow, m.name, d.dispatch_id);
        if (res.changes > 0) txChanges += 1;
      }

      if (hasRowDiff(row, plan, m.name)) {
        const bumpUpdated = hasLifecycleDiff(row, plan);
        const nextUpdatedAt = bumpUpdated ? txNow : row.updated_at;
        db.prepare(`
          UPDATE threads SET
            ui_bucket = ?,
            server_status = ?,
            blocking_question = ?,
            blocking_is_error = ?,
            last_summary = ?,
            pre_pause_bucket = ?,
            working_since = ?,
            resolved_at = ?,
            conversation_id = ?,
            swarm_member_name = ?,
            swarm_model = ?,
            swarm_state = ?,
            swarm_origin_coordinator_id = ?,
            swarm_last_seq = ?,
            swarm_handled_seq = ?,
            swarm_last_message = ?,
            active_dispatch_id = ?,
            execution_backend = 'swarm',
            updated_at = ?
          WHERE thread_id = ?
        `).run(
          plan.nextBucket,
          plan.nextServerStatus,
          plan.nextBlockingQuestion ?? null,
          plan.nextBlockingIsError,
          plan.nextSummary ?? null,
          plan.nextPrePauseBucket ?? null,
          plan.nextWorkingSince ?? null,
          plan.nextResolvedAt ?? null,
          plan.nextConvId ?? null,
          m.name,
          plan.nextSwarmModel ?? null,
          plan.nextSwarmState,
          plan.nextOriginCoordId,
          plan.nextLastSeq,
          plan.nextHandledSeq,
          plan.nextLastMessage ?? null,
          plan.nextActiveDispatchId ?? null,
          nextUpdatedAt,
          row.thread_id
        );
        txChanges += 1;
        touchedThreadIds.push(row.thread_id);
      }
    }
  });

  const regBindings = collectNeededRegistryBindings(db, absWs, cfg.projectId, workerMembers, dbMod.loadRegistry());
  for (const b of regBindings) {
    dbMod.syncConversationBinding(b.conversationId, b.binding);
  }

  return { synced: true, changes: txChanges, touchedThreadIds, swarm: swarmState };
}

function findLatestPostByAgent(msgs, agentName) {
  let latest = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (!msg || controlOf(msg)) continue;
    if (String(msg.agent || "") === agentName) {
      if (!latest || (Number(msg.seq) || 0) >= (Number(latest.seq) || 0)) {
        latest = msg;
      }
      if (Number(msg.seq) > 0) break;
    }
  }
  return latest;
}

function findAnyBriefTextForMember(msgs, memberName) {
  const startRe = new RegExp(`^\\s*@${escapeRegExp(memberName)}(?=\\s|$)`, "i");
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (!msg || controlOf(msg) || msg.kind !== "brief") continue;
    const text = String(msg.text || "");
    if (startRe.test(text)) return text;
  }
  return "";
}

function hasLifecycleDiff(row, plan) {
  return (
    plan.nextBucket !== row.ui_bucket ||
    plan.nextServerStatus !== row.server_status ||
    (plan.nextBlockingQuestion ?? null) !== (row.blocking_question ?? null) ||
    (plan.nextSummary ?? null) !== (row.last_summary ?? null)
  );
}

function hasRowDiff(row, plan, memberName) {
  return (
    hasLifecycleDiff(row, plan) ||
    plan.nextBlockingIsError !== Number(row.blocking_is_error || 0) ||
    (plan.nextPrePauseBucket ?? null) !== (row.pre_pause_bucket ?? null) ||
    (plan.nextWorkingSince ?? null) !== (row.working_since ?? null) ||
    (plan.nextResolvedAt ?? null) !== (row.resolved_at ?? null) ||
    (plan.nextConvId ?? null) !== (row.conversation_id ?? null) ||
    memberName !== (row.swarm_member_name ?? null) ||
    (plan.nextSwarmModel ?? null) !== (row.swarm_model ?? null) ||
    plan.nextSwarmState !== (row.swarm_state ?? null) ||
    plan.nextOriginCoordId !== (row.swarm_origin_coordinator_id ?? null) ||
    plan.nextLastSeq !== Number(row.swarm_last_seq || 0) ||
    plan.nextHandledSeq !== Number(row.swarm_handled_seq || 0) ||
    (plan.nextLastMessage ?? null) !== (row.swarm_last_message ?? null) ||
    (plan.nextActiveDispatchId ?? null) !== (row.active_dispatch_id ?? null) ||
    row.execution_backend !== "swarm"
  );
}

function collectNeededRegistryBindings(db, absWs, projectId, workerMembers, reg) {
  const out = [];
  const boundMap = reg?.boundConversations || {};
  for (const m of workerMembers) {
    if (!m.conversation_id) continue;
    const row = db.prepare("SELECT thread_id FROM threads WHERE conversation_id = ?").get(m.conversation_id);
    if (!row) continue;
    const cur = boundMap[m.conversation_id];
    const same =
      cur &&
      cur.workspacePath &&
      path.resolve(cur.workspacePath) === absWs &&
      cur.role === "worker" &&
      (cur.threadId || null) === row.thread_id &&
      (cur.projectId || null) === (projectId || null);
    if (!same) {
      out.push({
        conversationId: m.conversation_id,
        binding: {
          workspacePath: absWs,
          role: "worker",
          threadId: row.thread_id,
          projectId: projectId || null
        }
      });
    }
  }
  return out;
}

function clearSwarmCaches() {
  boardFileCache.clear();
  transcriptCache.clear();
  nextEpoch = 0;
}

module.exports = {
  STRICT_UUID_CONV_RE,
  DONE_LINE_RE,
  BLOCKED_LINE_RE,
  getSwarmDir,
  getTranscriptPath,
  hasExactMention,
  matchesMemberMention,
  replyQuestion,
  turnEnded,
  statusOf,
  readBoardCached,
  readBoardTailSync,
  deriveSingleMemberState,
  readActiveSwarmState,
  getThreadBoardMessages,
  getProjectSwarmBoard,
  syncSwarmIntoProjectDb,
  runImmediateTx,
  formatSwarmLastMessage,
  oneLine,
  clearSwarmCaches
};
