#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const { execFile, spawn } = require("node:child_process");
const db = require("../../server/db.cjs");

const PORT = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || "0", 10) || 0;
const HOST = "127.0.0.1";
const VALID_HOST_HEADER_RE = /^((127\.0\.0\.1|localhost|\[::1\])(:\d+)?)$/i;
const PLUGIN_ORIGIN_RE = /^plugin:\/\//i;
const AUTH_TOKEN =
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN?.trim() ||
  process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN?.trim() ||
  process.env.ANTIGRAVITY_SIDECAR_WEB_TOKEN?.trim() ||
  crypto.randomBytes(24).toString("hex");

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0"
};

const sseClients = new Set();
// Map<"workspacePath::threadId", ChildProcess>
const activeHeadlessProcs = new Map();
const cancelledHeadlessProcs = new WeakSet();
let stateVersion = 1;

function bumpStateVersion() {
  stateVersion++;
}

let lastStableUiMtimeMs = 0;

function getUiAssetMtimeMs() {
  const p = resolveUiHtmlPath();
  if (!p) return lastStableUiMtimeMs;
  try {
    const mtime = Math.floor(fs.statSync(p).mtimeMs);
    if (Date.now() - mtime < 1500) {
      return lastStableUiMtimeMs;
    }
    lastStableUiMtimeMs = mtime;
    return mtime;
  } catch {
    return lastStableUiMtimeMs;
  }
}

function statMtimeFloor(filePath) {
  if (!filePath) return 0;
  try {
    return Math.floor(fs.statSync(filePath).mtimeMs);
  } catch {
    return 0;
  }
}

function getCompositeVersion(workspaceHint) {
  const regPath = path.join(db.getSharedDataDir(), "projects_registry.json");
  const regMtime = statMtimeFloor(regPath);
  const ws = db.resolveActiveWorkspace(workspaceHint || undefined);
  if (!ws) return `${stateVersion}:${regMtime}:none`;
  const pDir = db.getProjectDir(ws);
  const cfgMtime = statMtimeFloor(path.join(pDir, "config.json"));
  const dbMtime = statMtimeFloor(path.join(pDir, "state", "project_index.db"));
  const walMtime = statMtimeFloor(path.join(pDir, "state", "project_index.db-wal"));
  const shmMtime = statMtimeFloor(path.join(pDir, "state", "project_index.db-shm"));
  const memMtime = statMtimeFloor(path.join(pDir, "memory", "MEMORY.md"));
  return `${stateVersion}:${regMtime}:${cfgMtime}:${dbMtime}:${walMtime}:${shmMtime}:${memMtime}`;
}

function verifyToken(candidate) {
  if (!candidate || typeof candidate !== "string") return false;
  const a = Buffer.from(candidate.trim(), "utf8");
  const b = Buffer.from(AUTH_TOKEN, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...NO_CACHE_HEADERS
  });
  res.end(body);
}

function resolveUiHtmlPath() {
  const candidates = [
    path.join(__dirname, "ui.html"),
    path.join(process.cwd(), "ui.html"),
    path.join(db.getPluginRootDir(), "sidecars", "project_hub", "ui.html")
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

function loadPreloadJs() {
  try {
    const p = path.join(db.getAppDataDir(), "lib", "node_modules", "sidecar_sdk", "preload.js");
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  } catch {}
  return "// AGY Project Hub preload stub\nwindow.__sidecarReady = true;\n";
}

function runAgentApi(args, projectId) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (projectId) env.ANTIGRAVITY_PROJECT_ID = String(projectId);
    const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE?.trim();
    const file = exe || "agentapi";
    const execArgs = exe && path.basename(exe) !== "agentapi" ? ["agentapi", ...args] : args;
    execFile(file, execArgs, { encoding: "utf8", env, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: err.message, stderr: stderr ? String(stderr) : undefined });
        return;
      }
      const out = String(stdout || "").trim();
      try {
        resolve(out ? JSON.parse(out) : { success: true });
      } catch {
        resolve({ success: true, raw: out });
      }
    });
  });
}

function injectSidecarBootstrap(rawHtml, token, conversationId) {
  const safeToken = String(token || "");
  const safeConv = String(conversationId || "");
  const query = safeToken
    ? `token=${encodeURIComponent(safeToken)}${safeConv ? `&conversationId=${encodeURIComponent(safeConv)}` : ""}`
    : "";

  let html = rawHtml;
  if (query) {
    html = html.replace(/\b(href|src)=(["'])(\/[^"'\s>]*)\2/g, (match, attr, quote, urlPath) => {
      if (urlPath.startsWith("//")) return match;
      const sep = urlPath.includes("?") ? "&" : "?";
      return `${attr}=${quote}${urlPath}${sep}${query}${quote}`;
    });
  }

  const bootstrap = `<script>(function(){window.__SIDECAR_TOKEN__=${JSON.stringify(safeToken)};window.__SIDECAR_CONVERSATION_ID__=${JSON.stringify(safeConv)};try{if(${JSON.stringify(safeToken)}){var u=new URL(window.location.href);if(!u.searchParams.get("token")){u.searchParams.set("token",${JSON.stringify(safeToken)});window.history.replaceState(null,"",u.toString());}}}catch(e){}})();</script>`;
  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>\n  ${bootstrap}`);
  }
  return `${bootstrap}\n${html}`;
}

function readRequestBody(req, maxBytes = 48 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("Request payload exceeds maximum allowed size."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const str = Buffer.concat(chunks).toString("utf8").trim();
        resolve(str ? JSON.parse(str) : {});
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

function getRunningHeadlessList() {
  return Array.from(activeHeadlessProcs.keys());
}

const ghAuthCache = {
  checkedAt: 0,
  installed: false,
  authenticated: false,
  summary: "Not checked yet"
};
let ghRefreshInFlight = null;

function refreshGhAuthStatus() {
  if (ghRefreshInFlight) return ghRefreshInFlight;
  ghRefreshInFlight = new Promise((resolve) => {
    execFile("gh", ["auth", "status"], { timeout: 2500, encoding: "utf8" }, (err, stdout, stderr) => {
      const combined = `${stdout || ""}\n${stderr || ""}`.trim();
      ghAuthCache.checkedAt = Date.now();
      if (!err) {
        ghAuthCache.installed = true;
        ghAuthCache.authenticated = true;
        ghAuthCache.summary = combined.split(/\r?\n/).slice(0, 3).join(" | ") || "Authenticated";
        ghRefreshInFlight = null;
        resolve(ghAuthCache);
        return;
      }
      if (err.code === "ENOENT") {
        ghAuthCache.installed = false;
        ghAuthCache.authenticated = false;
        ghAuthCache.summary = "gh CLI not found on PATH";
        ghRefreshInFlight = null;
        resolve(ghAuthCache);
        return;
      }
      execFile("gh", ["--version"], { timeout: 1500, encoding: "utf8" }, (vErr, vOut) => {
        ghAuthCache.installed = !vErr;
        ghAuthCache.authenticated = false;
        ghAuthCache.summary = !vErr
          ? combined.split(/\r?\n/)[0] || `${String(vOut || "").trim()} (not authenticated)`
          : "gh CLI unavailable";
        ghRefreshInFlight = null;
        resolve(ghAuthCache);
      });
    });
  });
  return ghRefreshInFlight;
}

function hasHeadlessSdkAuth(envObj = process.env) {
  const src = envObj && typeof envObj === "object" ? envObj : process.env;
  const vertex = String(src.GOOGLE_GENAI_USE_VERTEXAI || "").trim().toLowerCase();
  const enterprise = String(src.GOOGLE_GENAI_USE_ENTERPRISE || "").trim().toLowerCase();
  const useVertex = vertex === "1" || vertex === "true" || enterprise === "1" || enterprise === "true";
  const apiKey = String(src.GEMINI_API_KEY || "").trim() || String(src.GOOGLE_API_KEY || "").trim();
  if (useVertex) {
    const project = String(src.GOOGLE_CLOUD_PROJECT || "").trim();
    const location = String(src.GOOGLE_CLOUD_LOCATION || "").trim();
    return Boolean((project && location) || apiKey);
  }
  return Boolean(apiKey);
}

function isSameHostOrigin(origin, hostHeader) {
  if (!origin || !hostHeader) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:") return false;
    if (!VALID_HOST_HEADER_RE.test(u.host)) return false;
    const parsedHost = new URL(`http://${hostHeader}`);
    const normPort = (portStr) => portStr || "80";
    return (
      u.hostname.toLowerCase() === parsedHost.hostname.toLowerCase() &&
      normPort(u.port) === normPort(parsedHost.port)
    );
  } catch {
    return false;
  }
}

function collectDiagnostics(workspacePath) {
  const pluginsRoot = path.join(os.homedir(), ".gemini", "config", "plugins");
  const plugins = [];
  let authProviderPluginCount = 0;
  if (fs.existsSync(pluginsRoot)) {
    try {
      const entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(pluginsRoot, entry.name);
        let isDir = entry.isDirectory();
        if (!isDir && entry.isSymbolicLink()) {
          try { isDir = fs.statSync(entryPath).isDirectory(); } catch {}
        }
        if (!isDir) continue;
        const meta =
          db.readJsonSafe(path.join(entryPath, "plugin.json"), null) ||
          db.readJsonSafe(path.join(entryPath, ".gemini-plugin", "plugin.json"), null);
        if (meta && (meta.auth || meta.providers || meta.authProviders)) {
          authProviderPluginCount++;
        }
        plugins.push({
          id: entry.name,
          name: meta?.displayName || meta?.name || entry.name,
          version: meta?.version || "1.0.0",
          description: String(meta?.description || "").slice(0, 140),
          enabled: meta?.disabled !== true,
          customizationUri: `customization://${encodeURIComponent(entry.name)}`
        });
      }
      plugins.sort((a, b) => a.name.localeCompare(b.name));
    } catch {}
  }

  let secretRefs = [];
  const absWs = db.resolveActiveWorkspace(workspacePath || undefined);
  const cfg = absWs && db.hasProjectInitialized(absWs) ? db.loadProjectConfig(absWs) : null;
  if (cfg) {
    const refs = Array.isArray(cfg?.environment?.secretRefs) ? cfg.environment.secretRefs : [];
    secretRefs = refs.map((ref) => {
      const name = String(ref || "").trim();
      return {
        name,
        present: Boolean(name && process.env[name])
      };
    });
  }

  const mergedEnv = {
    ...process.env,
    ...(cfg?.environment?.envVars && typeof cfg.environment.envVars === "object" ? cfg.environment.envVars : {})
  };
  const headlessAuthOk = hasHeadlessSdkAuth(mergedEnv);
  const ragVenvReady = fs.existsSync(path.join(db.getSharedDataDir(), "venv", ".deps_ready_v2"));
  const geminiDir = path.join(os.homedir(), ".gemini");
  const hasOauthCreds = fs.existsSync(path.join(geminiDir, "oauth_creds.json"));
  const hasGoogleAccts = fs.existsSync(path.join(geminiDir, "google_accounts.json"));
  const hasPluginAccounts = hasOauthCreds || hasGoogleAccts;
  const accountFiles = [];
  if (hasOauthCreds) accountFiles.push("oauth_creds.json");
  if (hasGoogleAccts) accountFiles.push("google_accounts.json");
  const pluginAccountsSummary = hasPluginAccounts
    ? `Credentials present (${accountFiles.join(", ")})${authProviderPluginCount > 0 ? ` • ${authProviderPluginCount} plugin(s) with auth metadata` : ""}`
    : `No OAuth account files detected in ~/.gemini/${authProviderPluginCount > 0 ? ` • ${authProviderPluginCount} plugin(s) with auth metadata` : ""}`;

  const connectors = {
    mcpServer: { ok: true, label: "agy_projects_mcp (stdio active)" },
    githubCli: {
      ok: ghAuthCache.authenticated,
      installed: ghAuthCache.installed,
      summary: ghAuthCache.summary
    },
    googleDrive: {
      ok: fs.existsSync(path.join(pluginsRoot, "gdrive", "skills", "gdrive", "SKILL.md"))
    },
    ragVenv: {
      ok: ragVenvReady,
      pythonPath: db.getVenvPythonOrSystem()
    },
    headlessSdk: {
      ok: headlessAuthOk,
      summary: headlessAuthOk
        ? "GEMINI_API_KEY / GOOGLE_API_KEY / Vertex AI configured"
        : "Missing GEMINI_API_KEY (or GOOGLE_GENAI_USE_VERTEXAI=1 with GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION); interactive Coordinator Chat still works"
    },
    pluginAccounts: {
      ok: hasPluginAccounts,
      summary: pluginAccountsSummary
    }
  };

  return { plugins, connectors, secretRefs };
}

function broadcastSnapshot(workspacePath) {
  bumpStateVersion();
  if (sseClients.size === 0) return;
  try {
    const snap = db.buildFullWorkspaceSnapshot(workspacePath);
    snap.runningHeadlessKeys = getRunningHeadlessList();
    snap.version = stateVersion;
    snap.uiAssetMtimeMs = getUiAssetMtimeMs();
    const frame = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(frame);
      } catch {
        sseClients.delete(client);
      }
    }
  } catch {}
}

function cancelHeadlessTasksForWorkspace(workspacePath) {
  const absWs = path.resolve(workspacePath);
  let cancelled = 0;
  for (const [key, proc] of activeHeadlessProcs.entries()) {
    if (key.startsWith(`${absWs}::`)) {
      cancelledHeadlessProcs.add(proc);
      try {
        proc.kill("SIGTERM");
        cancelled++;
      } catch {}
      activeHeadlessProcs.delete(key);
    }
  }
  return cancelled;
}

function cancelSingleHeadlessTask(workspacePath, threadId) {
  const key = `${path.resolve(workspacePath)}::${threadId}`;
  const proc = activeHeadlessProcs.get(key);
  if (!proc) return false;
  cancelledHeadlessProcs.add(proc);
  try {
    proc.kill("SIGTERM");
  } catch {}
  activeHeadlessProcs.delete(key);
  return true;
}

function spawnHeadlessSdkWorker(workspacePath, { threadId, mode = "readonly", cwd, prompt }) {
  const absWs = path.resolve(workspacePath);
  const key = `${absWs}::${threadId}`;
  if (activeHeadlessProcs.has(key)) return { started: false, reason: "already_running" };

  const sql = db.openProjectDb(absWs);
  const thread = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadId);
  const cfg = db.loadProjectConfig(absWs);
  const envCfg = cfg?.environment || {};
  const mergedEnv = {
    ...process.env,
    ...(envCfg.envVars && typeof envCfg.envVars === "object" ? envCfg.envVars : {}),
    AGY_PROJECTS_DATA_DIR: db.getSharedDataDir(),
    AGY_HEADLESS_SDK_WORKER: "1"
  };

  if (!hasHeadlessSdkAuth(mergedEnv)) {
    return {
      started: false,
      reason: "auth_required",
      error: "Headless SDK requires GEMINI_API_KEY (or GOOGLE_GENAI_USE_VERTEXAI=1 with GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION)."
    };
  }

  let effectiveCwd = cwd ? path.resolve(cwd) : absWs;
  if (mode === "write" && effectiveCwd === absWs) {
    effectiveCwd = db.ensureThreadIsolationCwd(absWs, threadId);
  }
  const effectiveModel =
    thread?.model && thread.model !== "inherit"
      ? thread.model
      : (db.getRoleModelOverride(cfg, thread?.role) || cfg?.models?.defaultThreadModel || "inherit");

  const secretStatusList = Array.isArray(envCfg.secretRefs)
    ? envCfg.secretRefs.map((k) => `${k}=${mergedEnv[k] ? "present" : "missing"}`)
    : [];
  const runtimeNote = `\n\n<RuntimeEnvironment sandboxMode="${envCfg.sandboxMode || "inherit"}" networkPolicy="${envCfg.networkPolicy || "inherit"}" secretRefs="${secretStatusList.join(",")}" />`;
  const spawnToken = crypto.randomBytes(4).toString("hex");
  const sysPromptPath = path.join(db.getProjectDir(absWs), "state", `sys_${threadId}_${spawnToken}.txt`);
  const contextText = db.buildFourTierContextBlock(absWs, "worker", thread);
  db.writeTextAtomic(sysPromptPath, `${contextText || "You are an AGY Project background worker."}${runtimeNote}`);

  const scriptPath = path.join(db.getPluginRootDir(), "server", "rag_worker.py");
  const pyBin = db.getVenvPythonOrSystem();
  const child = spawn(
    pyBin,
    [
      scriptPath,
      "run-agent",
      "--workspace",
      absWs,
      "--thread-id",
      threadId,
      "--mode",
      mode,
      "--cwd",
      effectiveCwd,
      "--prompt",
      prompt,
      "--system-file",
      sysPromptPath,
      "--model",
      effectiveModel
    ],
    {
      env: mergedEnv,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  activeHeadlessProcs.set(key, child);
  broadcastSnapshot(absWs);

  let finalSummary = "";
  let stderrTail = "";
  let finalized = false;

  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
    });
  }

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (cancelledHeadlessProcs.has(child)) return;
    try {
      const evt = JSON.parse(line);
      if (evt.type === "thought" || evt.type === "tool_call") {
        db.updateThreadState(absWs, {
          threadId,
          telemetryEvent: evt
        });
        broadcastSnapshot(absWs);
      } else if (evt.type === "done" && evt.summary) {
        finalSummary = evt.summary;
      } else if (evt.type === "error") {
        finalSummary = evt.error || "Headless SDK execution error";
      }
    } catch {}
  });

  const cleanupChild = () => {
    if (activeHeadlessProcs.get(key) === child) {
      activeHeadlessProcs.delete(key);
    }
    try { rl.close(); } catch {}
    try { fs.unlinkSync(sysPromptPath); } catch {}
  };

  child.on("error", (err) => {
    if (finalized) return;
    finalized = true;
    cleanupChild();
    if (!cancelledHeadlessProcs.has(child)) {
      try {
        db.updateThreadState(absWs, {
          threadId,
          uiBucket: "waiting_on_you",
          blockingQuestion: `Headless SDK worker failed to spawn: ${err.message || String(err)}`,
          blockingIsError: true
        });
      } catch {}
      broadcastSnapshot(absWs);
    }
  });

  child.on("close", (code, signal) => {
    if (finalized) return;
    finalized = true;
    cleanupChild();
    if (cancelledHeadlessProcs.has(child)) {
      broadcastSnapshot(absWs);
      return;
    }
    try {
      if (code === 0) {
        db.updateThreadState(absWs, {
          threadId,
          uiBucket: mode === "write" ? "ready_for_review" : "idle",
          summary: finalSummary || "Headless SDK routine completed."
        });
      } else if (code === 130) {
        db.updateThreadState(absWs, {
          threadId,
          uiBucket: "paused",
          prePauseBucket: "working",
          summary: "Headless SDK worker paused."
        });
      } else {
        const exitDesc = signal ? `signal ${signal}` : `status ${code}`;
        const detail = finalSummary || stderrTail.trim() || `Headless SDK worker exited with ${exitDesc}.`;
        db.updateThreadState(absWs, {
          threadId,
          uiBucket: "waiting_on_you",
          blockingQuestion: detail,
          blockingIsError: true
        });
      }
    } catch {}
    broadcastSnapshot(absWs);
  });

  return { started: true, pid: child.pid, cwd: effectiveCwd };
}

function startHeadlessWorkerOrHandleAuth(workspacePath, { threadId, mode = "readonly", cwd, prompt }) {
  const sp = spawnHeadlessSdkWorker(workspacePath, { threadId, mode, cwd, prompt });
  if (!sp.started && sp.reason === "auth_required") {
    const updatedThread = db.updateThreadState(workspacePath, {
      threadId,
      uiBucket: "waiting_on_you",
      blockingQuestion: sp.error,
      blockingIsError: true
    });
    return { ...sp, headlessAuthMissing: true, thread: updatedThread };
  }
  return { ...sp, headlessAuthMissing: false };
}

async function syncWorkspacePullRequests(workspacePath, triggerAutoFix = false) {
  return db.syncPullRequestsAsync(workspacePath, {
    triggerAutoFix,
    onSpawnAutoFix: ({ threadId, cwd, prompt }) =>
      startHeadlessWorkerOrHandleAuth(workspacePath, {
        threadId,
        mode: "write",
        cwd,
        prompt
      })
  });
}

// ---------- Autonomous Background Loops ----------

function runCronTick() {
  const reg = db.loadRegistry();
  const now = new Date();

  for (const p of reg.projects) {
    if (!db.hasProjectInitialized(p.workspacePath)) continue;
    try {
      const res = db.processDueSchedules(p.workspacePath, {
        now,
        onDispatch: ({ workspacePath, routine, thread, normRole }) => {
          return startHeadlessWorkerOrHandleAuth(workspacePath, {
            threadId: thread.thread_id,
            mode: db.isMutatingRole(normRole) ? "write" : "readonly",
            cwd: workspacePath,
            prompt: routine.prompt
          });
        }
      });
      if (res.dispatched.length > 0 || res.failed.length > 0) {
        broadcastSnapshot(p.workspacePath);
      }
    } catch {}
  }
}

let prAutoFixInFlight = false;
async function runPrAutoFixTick() {
  if (prAutoFixInFlight) return;
  prAutoFixInFlight = true;
  try {
    const reg = db.loadRegistry();
    for (const p of reg.projects) {
      if (!db.hasProjectInitialized(p.workspacePath)) continue;
      const cfg = db.loadProjectConfig(p.workspacePath);
      if (!cfg || cfg.status !== "active") continue;
      try {
        await syncWorkspacePullRequests(p.workspacePath, true);
      } catch {}
    }
  } finally {
    prAutoFixInFlight = false;
  }
}

function runStaleIdleSweep() {
  const reg = db.loadRegistry();
  const nowMs = Date.now();
  for (const p of reg.projects) {
    if (!db.hasProjectInitialized(p.workspacePath)) continue;
    const cfg = db.loadProjectConfig(p.workspacePath);
    if (!cfg || cfg.status !== "active") continue;
    const days = Number(cfg.orchestration?.idleAutoResolveDays || 7);
    const cutoffIso = new Date(nowMs - days * 86400 * 1000).toISOString();
    const sql = db.openProjectDb(p.workspacePath);
    const stale = sql
      .prepare("SELECT thread_id, worktree_path, repo_id FROM threads WHERE ui_bucket = 'idle' AND updated_at <= ?")
      .all(cutoffIso);
    for (const t of stale) {
      db.updateThreadState(p.workspacePath, {
        threadId: t.thread_id,
        uiBucket: "resolved",
        summary: `Auto-resolved after ${days} days idle.`
      });
      if (t.worktree_path) {
        try { db.manageWorktree(p.workspacePath, { action: "cleanup", threadId: t.thread_id }); } catch {}
      }
    }
    const lingeringResolved = sql
      .prepare(
        "SELECT thread_id, worktree_path, worktrees_json, repo_id FROM threads WHERE ui_bucket = 'resolved' AND (worktree_path IS NOT NULL OR worktrees_json NOT IN ('', '{}'))"
      )
      .all();
    for (const t of lingeringResolved) {
      try { db.manageWorktree(p.workspacePath, { action: "cleanup", threadId: t.thread_id }); } catch {}
    }
    if (stale.length > 0 || lingeringResolved.length > 0) broadcastSnapshot(p.workspacePath);
  }
}

setInterval(runCronTick, 30 * 1000).unref();
setInterval(runPrAutoFixTick, 60 * 1000).unref();
setInterval(runStaleIdleSweep, 60 * 60 * 1000).unref();

// ---------- HTTP Server & API Router ----------

function normalizeRoute(rawPathname) {
  const p = rawPathname || "/";
  if (p === "/" || p === "/index.html" || p.endsWith("/ui.html")) return "/ui.html";
  if (p.endsWith("/preload.js")) return "/preload.js";
  const apiIdx = p.indexOf("/api/");
  if (apiIdx >= 0) return p.slice(apiIdx);
  const sidecarIdx = p.indexOf("/_sidecar/");
  if (sidecarIdx >= 0) return p.slice(sidecarIdx);
  return p;
}

const server = http.createServer(async (req, res) => {
  try {
    const hostHeader = String(req.headers.host || "").trim();
    if (!VALID_HOST_HEADER_RE.test(hostHeader)) {
      return sendJson(res, 403, { error: "Forbidden: Invalid Host Header" });
    }

    const parsedUrl = new URL(req.url || "/", `http://${HOST}`);
    const pathname = normalizeRoute(parsedUrl.pathname);
    const origin = String(req.headers.origin || "").trim();

    if (pathname === "/ui.html") {
      if (origin && (PLUGIN_ORIGIN_RE.test(origin) || isSameHostOrigin(origin, hostHeader))) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Sidecar-Token");
    }

    if ((req.method || "").toUpperCase() === "OPTIONS") {
      res.writeHead(204, NO_CACHE_HEADERS);
      res.end();
      return;
    }

    if (req.method === "GET" && pathname === "/preload.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        ...NO_CACHE_HEADERS
      });
      res.end(loadPreloadJs());
      return;
    }

    if (req.method === "GET" && pathname === "/ui.html") {
      const uiPath = resolveUiHtmlPath();
      if (!uiPath) {
        res.writeHead(503, {
          "Content-Type": "text/html; charset=utf-8",
          ...NO_CACHE_HEADERS
        });
        res.end(
          "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"refresh\" content=\"1\"></head><body><p style=\"font-family:system-ui;padding:16px\">Loading Project Hub UI...</p></body></html>"
        );
        return;
      }
      const rawHtml = fs.readFileSync(uiPath, "utf8");
      const convId = parsedUrl.searchParams.get("conversationId") || process.env.ANTIGRAVITY_CONVERSATION_ID || "";
      const injected = injectSidecarBootstrap(rawHtml, AUTH_TOKEN, convId);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        ...NO_CACHE_HEADERS
      });
      res.end(injected);
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      return sendJson(res, 200, { ok: true, pid: process.pid });
    }

    // Authenticate all /api/* and /_sidecar/* routes
    if (pathname.startsWith("/api/") || pathname.startsWith("/_sidecar/")) {
      const headerTok = req.headers["x-sidecar-token"];
      const queryTok = parsedUrl.searchParams.get("token");
      const candidate = typeof headerTok === "string" && headerTok ? headerTok : queryTok;
      if (!verifyToken(candidate)) {
        return sendJson(res, 401, { error: "Unauthorized: missing or invalid sidecar token." });
      }
    }

    // Sidecar SDK bridge endpoints (used by preload.js)
    if (req.method === "POST" && pathname === "/_sidecar/get-conversation-metadata") {
      const body = await readRequestBody(req, pathname === "/api/library/upload" ? 64 * 1024 * 1024 : 48 * 1024 * 1024);
      const convId = String(body.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || "").trim();
      if (!convId || !db.VALID_CONV_ID_RE.test(convId)) {
        return sendJson(res, 400, { error: "Invalid conversationId" });
      }
      const out = await runAgentApi(["get-conversation-metadata", convId], body.projectId);
      return sendJson(res, out && out.error ? 502 : 200, out);
    }

    if (req.method === "POST" && pathname === "/_sidecar/send-message") {
      const body = await readRequestBody(req, pathname === "/api/library/upload" ? 64 * 1024 * 1024 : 48 * 1024 * 1024);
      const convId = String(body.conversationId || "").trim();
      const message = String(body.message || "").trim();
      if (!convId || !db.VALID_CONV_ID_RE.test(convId) || !message) {
        return sendJson(res, 400, { error: "Invalid conversationId or empty message" });
      }
      const args = ["send-message"];
      if (body.title) args.push("--title", String(body.title));
      args.push(convId, message);
      const out = await runAgentApi(args, body.projectId);
      return sendJson(res, out && out.error ? 502 : 200, out);
    }

    if (req.method === "POST" && pathname === "/_sidecar/new-conversation") {
      const body = await readRequestBody(req, pathname === "/api/library/upload" ? 64 * 1024 * 1024 : 48 * 1024 * 1024);
      const message = String(body.message || "").trim();
      if (!message) return sendJson(res, 400, { error: "Missing message" });
      const args = ["new-conversation"];
      if (body.title) args.push("--title", String(body.title));
      args.push(message);
      const out = await runAgentApi(args, body.projectId);
      return sendJson(res, out && out.error ? 502 : 200, out);
    }

    // SSE real-time stream
    if (req.method === "GET" && pathname === "/api/events") {
      res.socket?.setNoDelay?.(true);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      sseClients.add(res);
      const snap = db.buildFullWorkspaceSnapshot(parsedUrl.searchParams.get("workspacePath") || undefined);
      snap.runningHeadlessKeys = getRunningHeadlessList();
      res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
      const keepAlive = setInterval(() => {
        try { res.write(": ping\n\n"); } catch {}
      }, 20000);
      req.on("close", () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/state") {
      const wsHint = parsedUrl.searchParams.get("workspacePath") || undefined;
      const uiAssetMtimeMs = getUiAssetMtimeMs();
      const currentVersion = getCompositeVersion(wsHint);
      const sinceVersion = parsedUrl.searchParams.get("sinceVersion") || "";
      if (sinceVersion && sinceVersion === currentVersion) {
        return sendJson(res, 200, {
          unchanged: true,
          version: currentVersion,
          uiAssetMtimeMs
        });
      }
      if (Date.now() - ghAuthCache.checkedAt > 30000) {
        refreshGhAuthStatus().catch(() => {});
      }
      const snap = db.buildFullWorkspaceSnapshot(wsHint);
      snap.runningHeadlessKeys = getRunningHeadlessList();
      snap.accountMemoryContent = fs.readFileSync(db.getAccountMemoryPath(), "utf8");
      snap.diagnostics = collectDiagnostics(wsHint);
      snap.version = currentVersion;
      snap.uiAssetMtimeMs = uiAssetMtimeMs;
      return sendJson(res, 200, snap);
    }

    if (req.method === "GET" && pathname === "/api/diagnostics") {
      const wsHint = parsedUrl.searchParams.get("workspacePath") || undefined;
      const force = parsedUrl.searchParams.get("force") === "1";
      if (force || Date.now() - ghAuthCache.checkedAt > 30000) {
        await refreshGhAuthStatus();
      }
      return sendJson(res, 200, collectDiagnostics(wsHint));
    }

    if (req.method === "GET" && pathname === "/api/snapshots/preview") {
      const ws = db.resolveActiveWorkspace(parsedUrl.searchParams.get("workspacePath") || undefined);
      if (!ws) return sendJson(res, 404, { error: "No active workspace" });
      const snapshotId = parsedUrl.searchParams.get("snapshotId") || "";
      const preview = db.readChatSnapshotPreview(ws, snapshotId);
      return sendJson(res, 200, preview);
    }

    if (req.method === "GET" && pathname === "/api/library/preview") {
      const ws = db.resolveActiveWorkspace(parsedUrl.searchParams.get("workspacePath") || undefined);
      if (!ws) return sendJson(res, 404, { error: "No active workspace" });
      const relPath = String(parsedUrl.searchParams.get("relPath") || "").trim();
      if (!relPath) {
        return sendJson(res, 400, { error: "Invalid or missing file path" });
      }
      const pDir = db.getProjectDir(ws);
      let realPDir;
      let realTarget;
      try {
        realPDir = fs.realpathSync.native(pDir);
        realTarget = fs.realpathSync.native(path.resolve(pDir, relPath));
      } catch {
        return sendJson(res, 400, { error: "Invalid or missing file path" });
      }
      if (!db.isPathInsideDir(realTarget, realPDir, { allowEqual: false })) {
        return sendJson(res, 400, { error: "Invalid or missing file path" });
      }
      let stat;
      try {
        stat = fs.statSync(realTarget);
      } catch {
        return sendJson(res, 400, { error: "Invalid or missing file path" });
      }
      if (!stat.isFile()) {
        return sendJson(res, 400, { error: "Preview path must be a regular file" });
      }
      const sql = db.openProjectDb(ws);
      const itemRow = sql.prepare("SELECT * FROM library_items WHERE rel_path = ?").get(relPath);
      if (itemRow) {
        const text = db.readLibraryItemText(ws, itemRow);
        if (text && text.length > 65536) {
          return sendJson(res, 200, { relPath, truncated: true, content: text.slice(0, 65536) });
        }
        return sendJson(res, 200, { relPath, truncated: false, content: text });
      }
      if (stat.size > 2 * 1024 * 1024) {
        const fd = fs.openSync(realTarget, "r");
        const buf = Buffer.alloc(65536);
        const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
        fs.closeSync(fd);
        return sendJson(res, 200, {
          relPath,
          truncated: true,
          content: buf.subarray(0, bytesRead).toString("utf8")
        });
      }
      return sendJson(res, 200, {
        relPath,
        truncated: false,
        content: fs.readFileSync(realTarget, "utf8")
      });
    }

    if (req.method !== "POST") {
      return sendJson(res, 404, { error: "Not found" });
    }

    const body = await readRequestBody(req, pathname === "/api/library/upload" ? 64 * 1024 * 1024 : 48 * 1024 * 1024);

    if (pathname === "/api/notify") {
      if (body.cancelHeadless && body.workspacePath) {
        cancelHeadlessTasksForWorkspace(body.workspacePath);
      }
      broadcastSnapshot(body.workspacePath || undefined);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/projects/create") {
      const created = db.createProject({
        name: body.name,
        workspacePath: body.workspacePath,
        goal: body.goal || "",
        instructions: body.instructions || "",
        coordinatorConversationId: body.coordinatorConversationId || null,
        createDirIfMissing: body.createDirIfMissing !== false
      });
      broadcastSnapshot(created.workspacePath);
      return sendJson(res, 200, created);
    }

    if (pathname === "/api/projects/select") {
      try {
        const sel = db.selectProject({
          projectId: body.projectId || null,
          workspacePath: body.workspacePath || null,
          bindCoordinatorConversationId: body.bindCoordinatorConversationId || null
        });
        broadcastSnapshot(sel.workspacePath);
        return sendJson(res, 200, db.buildFullWorkspaceSnapshot(sel.workspacePath));
      } catch {
        return sendJson(res, 404, { error: "Project not found" });
      }
    }

    // All remaining endpoints operate on the active or specified workspace
    const ws = db.resolveActiveWorkspace(body.workspacePath, body.projectId);
    if (!ws || !db.hasProjectInitialized(ws)) {
      return sendJson(res, 400, { error: "No initialized AGY Project found." });
    }

    if (pathname === "/api/projects/lifecycle") {
      if (body.status && body.status !== "active") {
        cancelHeadlessTasksForWorkspace(ws);
      }
      const resLife = db.transitionProjectLifecycle(ws, {
        status: body.status,
        starred: typeof body.starred === "boolean" ? body.starred : undefined
      });
      broadcastSnapshot(ws);
      return sendJson(res, 200, { config: resLife.config });
    }

    if (pathname === "/api/projects/rollover") {
      const resRoll = db.rolloverCoordinatorSession(ws, {
        newConversationId: body.newConversationId || null,
        summary: body.summary || ""
      });
      broadcastSnapshot(ws);
      return sendJson(res, 200, resRoll);
    }

    if (pathname === "/api/settings/update") {
      const resUpd = db.updateProjectSettings(ws, body);
      broadcastSnapshot(ws);
      return sendJson(res, 200, { config: resUpd.config });
    }

    if (pathname === "/api/threads/propose") {
      const created = db.proposeThreads(ws, Array.isArray(body.proposals) ? body.proposals : [body]);
      broadcastSnapshot(ws);
      return sendJson(res, 200, { threads: created });
    }

    if (pathname === "/api/threads/action") {
      const sql = db.openProjectDb(ws);
      const act = body.action;

      if (act === "start") {
        const row = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(body.threadId);
        if (!row) return sendJson(res, 404, { error: "Thread not found" });
        let started = db.registerThread(ws, {
          threadId: row.thread_id,
          role: row.role,
          workspaceMode: row.workspace_mode,
          conversationId: body.conversationId || undefined
        });
        let headlessAuthMissing = false;
        if (body.launchHeadless) {
          const sp = startHeadlessWorkerOrHandleAuth(ws, {
            threadId: row.thread_id,
            mode: db.isMutatingRole(row.role) ? "write" : "readonly",
            cwd: row.worktree_path || ws,
            prompt: `${row.title}\n\n${row.description}`
          });
          if (sp.headlessAuthMissing) {
            headlessAuthMissing = true;
            started = sp.thread;
          }
        }
        broadcastSnapshot(ws);
        return sendJson(res, 200, { thread: started, headlessAuthMissing });
      }

      if (act === "start_all") {
        const suggested = sql.prepare("SELECT * FROM threads WHERE ui_bucket = 'suggested' ORDER BY created_at ASC").all();
        const startedList = [];
        let headlessAuthMissing = false;
        for (const row of suggested) {
          try {
            let st = db.registerThread(ws, { threadId: row.thread_id, role: row.role, workspaceMode: row.workspace_mode });
            if (body.launchHeadless) {
              const sp = startHeadlessWorkerOrHandleAuth(ws, {
                threadId: row.thread_id,
                mode: db.isMutatingRole(row.role) ? "write" : "readonly",
                cwd: row.worktree_path || ws,
                prompt: `${row.title}\n\n${row.description}`
              });
              if (sp.headlessAuthMissing) {
                headlessAuthMissing = true;
                st = sp.thread;
              }
            }
            startedList.push(st);
          } catch {
            break;
          }
        }
        broadcastSnapshot(ws);
        return sendJson(res, 200, { startedCount: startedList.length, threads: startedList, headlessAuthMissing });
      }

      if (act === "start_selected") {
        const ids = Array.isArray(body.threadIds) ? body.threadIds.map(String) : [];
        const startedList = [];
        let headlessAuthMissing = false;
        for (const tid of ids) {
          const row = sql.prepare("SELECT * FROM threads WHERE thread_id = ? AND ui_bucket = 'suggested'").get(tid);
          if (!row) continue;
          try {
            let st = db.registerThread(ws, { threadId: row.thread_id, role: row.role, workspaceMode: row.workspace_mode });
            if (body.launchHeadless) {
              const sp = startHeadlessWorkerOrHandleAuth(ws, {
                threadId: row.thread_id,
                mode: db.isMutatingRole(row.role) ? "write" : "readonly",
                cwd: row.worktree_path || ws,
                prompt: `${row.title}\n\n${row.description}`
              });
              if (sp.headlessAuthMissing) {
                headlessAuthMissing = true;
                st = sp.thread;
              }
            }
            startedList.push(st);
          } catch {
            break;
          }
        }
        broadcastSnapshot(ws);
        return sendJson(res, 200, { startedCount: startedList.length, threads: startedList, headlessAuthMissing });
      }

      if (act === "dismiss") {
        const updated = db.updateThreadState(ws, {
          threadId: body.threadId,
          uiBucket: "resolved",
          summary: "Dismissed from Suggested queue."
        });
        broadcastSnapshot(ws);
        return sendJson(res, 200, { thread: updated });
      }

      if (act === "cancel_headless" || act === "interrupt") {
        const cancelled = cancelSingleHeadlessTask(ws, body.threadId);
        const updated =
          act === "interrupt"
            ? db.updateThreadState(ws, {
                threadId: body.threadId,
                uiBucket: "idle",
                summary: body.summary || "Interrupted by user."
              })
            : sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(body.threadId);
        broadcastSnapshot(ws);
        return sendJson(res, 200, { cancelled, thread: updated });
      }

      if (act === "steer") {
        const row = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(body.threadId);
        if (!row) return sendJson(res, 404, { error: "Thread not found" });
        const msg = String(body.message || "").trim();
        if (!msg) return sendJson(res, 400, { error: "Steering message cannot be empty." });

        let updated = db.updateThreadState(ws, {
          threadId: row.thread_id,
          uiBucket: "working",
          clearBlockingQuestion: true,
          summary: `Steered: ${msg.slice(0, 180)}`,
          telemetryEvent: { type: "steer", text: msg.slice(0, 300) }
        });

        let headlessAuthMissing = false;
        if (body.launchHeadlessFallback && !row.conversation_id) {
          const sp = startHeadlessWorkerOrHandleAuth(ws, {
            threadId: row.thread_id,
            mode: db.isMutatingRole(row.role) ? "write" : "readonly",
            cwd: row.worktree_path || ws,
            prompt: `${row.title}\n\nOriginal Brief:\n${row.description}\n\nUser Reply / Steering Instruction:\n${msg}`
          });
          if (sp.headlessAuthMissing) {
            headlessAuthMissing = true;
            updated = sp.thread;
          }
        }
        broadcastSnapshot(ws);
        return sendJson(res, 200, { thread: updated, headlessAuthMissing });
      }

      if (act === "update") {
        const updated = db.updateThreadState(ws, {
          threadId: body.threadId,
          uiBucket: body.uiBucket,
          summary: body.summary,
          blockingQuestion: body.blockingQuestion,
          prNumber: body.prNumber,
          prUrl: body.prUrl,
          watchingAutoFix: body.watchingAutoFix
        });
        broadcastSnapshot(ws);
        return sendJson(res, 200, { thread: updated });
      }

      return sendJson(res, 400, { error: `Unknown thread action: ${act}` });
    }

    if (pathname === "/api/library/upload") {
      let buf;
      if (body.base64Content) {
        buf = Buffer.from(String(body.base64Content), "base64");
      } else if (body.textContent !== undefined) {
        buf = Buffer.from(String(body.textContent), "utf8");
      } else if (body.sourcePath) {
        const absSrc = path.resolve(String(body.sourcePath));
        if (db.isBlockedSensitiveSourcePath(absSrc, ws)) {
          const forbiddenErr = new Error("Forbidden: sourcePath points to a sensitive or non-regular file.");
          forbiddenErr.statusCode = 403;
          throw forbiddenErr;
        }
        const out = db.ingestLibraryItem(ws, {
          sourcePath: absSrc,
          category: body.category || "input",
          sourceType: body.sourceType || "local_file",
          title: body.title,
          allowLargeLocal: Boolean(body.allowLargeLocal)
        });
        broadcastSnapshot(ws);
        return sendJson(res, 200, out);
      } else {
        return sendJson(res, 400, { error: "Provide base64Content, textContent, or sourcePath." });
      }

      const out = db.ingestLibraryItem(ws, {
        content: buf,
        filename: body.filename || "uploaded-doc.md",
        category: body.category || "input",
        sourceType: body.sourceType || "upload",
        title: body.title,
        allowLargeLocal: Boolean(body.allowLargeLocal)
      });
      broadcastSnapshot(ws);
      return sendJson(res, 200, out);
    }

    if (pathname === "/api/library/reindex") {
      const state = db.rebalanceLibraryIndexing(ws, { syncEmbeddings: false });
      db.triggerPythonRagEmbed(ws, { asyncMode: true });
      broadcastSnapshot(ws);
      return sendJson(res, 200, state);
    }

    if (pathname === "/api/library/search") {
      const results = db.searchProjectLibrary(ws, {
        query: body.query || "",
        categoryFilter: body.categoryFilter || null,
        topK: body.topK || 8
      });
      return sendJson(res, 200, results);
    }

    if (pathname === "/api/memory/save-index") {
      const stats = db.saveRawMemoryIndex(ws, body.content || "");
      broadcastSnapshot(ws);
      return sendJson(res, 200, stats);
    }

    if (pathname === "/api/memory/upsert-topic") {
      const resMem = db.upsertMemoryTopic(ws, body);
      broadcastSnapshot(ws);
      return sendJson(res, 200, resMem);
    }

    if (pathname === "/api/memory/delete-topic") {
      const slug = String(body.topicSlug || "").replace(/[^a-zA-Z0-9_-]/g, "");
      const { topicsDir } = db.getMemoryPaths(ws);
      const fp = path.join(topicsDir, `${slug}.md`);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      const resMem = db.rebuildMemoryIndex(ws, db.loadProjectConfig(ws));
      broadcastSnapshot(ws);
      return sendJson(res, 200, resMem);
    }

    if (pathname === "/api/memory/save-account") {
      db.writeTextAtomic(db.getAccountMemoryPath(), String(body.content || ""));
      broadcastSnapshot(ws);
      return sendJson(res, 200, { saved: true });
    }

    if (pathname === "/api/memory/consolidate") {
      const out = db.consolidateMemories(ws);
      broadcastSnapshot(ws);
      return sendJson(res, 200, out);
    }

    if (pathname === "/api/repos/bind") {
      const repo = db.bindRepository(ws, body);
      broadcastSnapshot(ws);
      return sendJson(res, 200, { repository: repo });
    }

    if (pathname === "/api/repos/unbind") {
      const out = db.unbindRepository(ws, { repoId: body.repoId });
      broadcastSnapshot(ws);
      return sendJson(res, 200, out);
    }

    if (pathname === "/api/prs/sync") {
      const prs = await syncWorkspacePullRequests(ws, Boolean(body.triggerAutoFix));
      broadcastSnapshot(ws);
      return sendJson(res, 200, { pullRequests: prs });
    }

    if (pathname === "/api/prs/toggle-autofix") {
      const sql = db.openProjectDb(ws);
      sql.prepare("UPDATE pull_requests SET autofix_enabled = ?, autofix_attempts = 0, updated_at = ? WHERE pr_id = ?")
        .run(body.enabled ? 1 : 0, db.nowIso(), body.prId);
      broadcastSnapshot(ws);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/prs/reorder") {
      const sql = db.openProjectDb(ws);
      const orderedIds = Array.isArray(body.orderedPrIds) ? body.orderedPrIds : [];
      orderedIds.forEach((prId, idx) => {
        sql.prepare("UPDATE pull_requests SET merge_order_rank = ?, updated_at = ? WHERE pr_id = ?")
          .run(idx + 1, db.nowIso(), prId);
      });
      broadcastSnapshot(ws);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/routines/upsert") {
      const routine = db.upsertSchedule(ws, body);
      broadcastSnapshot(ws);
      return sendJson(res, 200, { routine });
    }

    if (pathname === "/api/routines/delete") {
      const sql = db.openProjectDb(ws);
      sql.prepare("DELETE FROM scheduled_routines WHERE routine_id = ?").run(body.routineId);
      broadcastSnapshot(ws);
      return sendJson(res, 200, { deleted: true });
    }

    if (pathname === "/api/routines/run-now") {
      const sql = db.openProjectDb(ws);
      const r = sql.prepare("SELECT * FROM scheduled_routines WHERE routine_id = ?").get(body.routineId);
      if (!r) return sendJson(res, 404, { error: "Routine not found" });
      const normRole = db.normalizeRole(r.target_role || "explorer");
      const thread = db.registerThread(ws, {
        title: `[Routine] ${r.name}`,
        description: r.prompt,
        role: normRole,
        workspaceMode: r.workspace_mode || "share"
      });
      sql.prepare("UPDATE scheduled_routines SET last_run_at = ?, last_thread_id = ? WHERE routine_id = ?")
        .run(db.nowIso(), thread.thread_id, r.routine_id);
      const sp = startHeadlessWorkerOrHandleAuth(ws, {
        threadId: thread.thread_id,
        mode: db.isMutatingRole(normRole) ? "write" : "readonly",
        cwd: ws,
        prompt: r.prompt
      });
      if (sp.headlessAuthMissing || sp.started === false) {
        const errMsg = String(sp.error || `Headless dispatch failed (${sp.reason || "not_started"}).`).slice(0, 500);
        sql.prepare(`
          UPDATE scheduled_routines
          SET last_error = ?, last_error_at = ?,
              consecutive_failures = COALESCE(consecutive_failures, 0) + 1
          WHERE routine_id = ?
        `).run(errMsg, db.nowIso(), r.routine_id);
      } else {
        sql.prepare(`
          UPDATE scheduled_routines
          SET last_error = NULL, last_error_at = NULL, consecutive_failures = 0
          WHERE routine_id = ?
        `).run(r.routine_id);
      }
      broadcastSnapshot(ws);
      return sendJson(res, 200, {
        thread: sp.thread || db.openProjectDb(ws).prepare("SELECT * FROM threads WHERE thread_id = ?").get(thread.thread_id),
        headlessAuthMissing: Boolean(sp.headlessAuthMissing)
      });
    }

    if (pathname === "/api/snapshots/create") {
      const snap = db.createChatSnapshot(ws, body);
      broadcastSnapshot(ws);
      return sendJson(res, 200, snap);
    }

    if (pathname === "/api/snapshots/update") {
      const snap = db.createChatSnapshot(ws, body);
      broadcastSnapshot(ws);
      return sendJson(res, 200, snap);
    }

    if (pathname === "/api/snapshots/revoke") {
      const out = db.revokeChatSnapshot(ws, body.snapshotId);
      broadcastSnapshot(ws);
      return sendJson(res, 200, out);
    }

    return sendJson(res, 404, { error: `Unknown endpoint: ${pathname}` });
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: err.message || String(err) });
  }
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
  const info = {
    host: HOST,
    port: actualPort,
    token: AUTH_TOKEN,
    pid: process.pid,
    startedAt: db.nowIso()
  };

  // Persist server_info.json in shared data dir; only write to global sidecar_data when not running under an isolated test override
  try {
    db.writeJsonAtomic(path.join(db.getSharedDataDir(), "server_info.json"), info, 0o600);
    if (!process.env.AGY_PROJECTS_DATA_DIR?.trim()) {
      db.writeJsonAtomic(
        path.join(db.getAppDataDir(), "sidecar_data", "agy-projects", "project_hub", "data", "server_info.json"),
        info,
        0o600
      );
    }
  } catch {}

  process.stdout.write(`AGY Project Hub listening on http://${HOST}:${actualPort}/ui.html\n`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    for (const proc of activeHeadlessProcs.values()) {
      try { proc.kill("SIGTERM"); } catch {}
    }
    process.exit(0);
  });
}
