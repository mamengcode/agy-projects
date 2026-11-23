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

function statFileSig(filePath) {
  if (!filePath) return "0:0";
  try {
    const st = fs.statSync(filePath);
    return `${Math.floor(st.mtimeMs)}:${st.size}`;
  } catch {
    return "0:0";
  }
}

function getCompositeVersion(workspaceHint) {
  const regPath = path.join(db.getSharedDataDir(), "projects_registry.json");
  const regSig = statFileSig(regPath);
  const ws = db.resolveActiveWorkspace(workspaceHint || undefined);
  if (!ws) return `${stateVersion}:${regSig}:none`;
  const pDir = db.getProjectDir(ws);
  const cfgPath = path.join(pDir, "config.json");
  const cfgSig = statFileSig(cfgPath);
  const dbSig = statFileSig(path.join(pDir, "state", "project_index.db"));
  const walSig = statFileSig(path.join(pDir, "state", "project_index.db-wal"));
  const shmSig = statFileSig(path.join(pDir, "state", "project_index.db-shm"));
  const memSig = statFileSig(path.join(pDir, "memory", "MEMORY.md"));

  let swarmSig = "none";
  try {
    const cfg = db.readJsonSafe(cfgPath, null);
    const coordId = cfg?.coordinatorConversationId ? String(cfg.coordinatorConversationId).trim() : "";
    if (coordId) {
      const appDataDir = db.getAppDataDir();
      const swarmDir = db.getSwarmDir(appDataDir, coordId);
      if (swarmDir) {
        const sjSig = statFileSig(path.join(swarmDir, "swarm.json"));
        const memJsonPath = path.join(swarmDir, "members.json");
        const mjSig = statFileSig(memJsonPath);
        const brdSig = statFileSig(path.join(swarmDir, "board.jsonl"));
        const trSigs = [];
        const roster = db.readJsonSafe(memJsonPath, null);
        const members =
          roster?.members && typeof roster.members === "object" && !Array.isArray(roster.members)
            ? roster.members
            : {};
        const SYSTEM_SWARM_NAME_RE = /^(?:coordinator|narrator|monitor)(?:-\d+)?$/i;
        for (const name of Object.keys(members).sort()) {
          const m = members[name];
          if (!m || typeof m !== "object" || m.role !== "worker") continue;
          if (SYSTEM_SWARM_NAME_RE.test(String(name || ""))) continue;
          if (m.killed || m.desired_state === "KILLED" || m.phase === "KILLED") continue;
          if (!m.conversation_id) continue;
          const trPath = db.getTranscriptPath(appDataDir, String(m.conversation_id));
          if (trPath) trSigs.push(`${name}=${statFileSig(trPath)}`);
        }
        swarmSig = `${sjSig}|${mjSig}|${brdSig}|${trSigs.join(",")}`;
      }
    }
  } catch {}

  return `${stateVersion}:${regSig}:${cfgSig}:${dbSig}:${walSig}:${shmSig}:${memSig}:${swarmSig}`;
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

const coordinatorStartLocks = new Map(); // absWs -> Promise

function extractNewConversationId(agentRes) {
  if (!agentRes || typeof agentRes !== "object") return null;
  return (
    agentRes.conversationId ||
    agentRes.response?.conversationId ||
    agentRes.response?.newConversation?.conversationId ||
    null
  );
}

function runAgentApi(args, projectId, opts = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (projectId) env.ANTIGRAVITY_PROJECT_ID = String(projectId);
    const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE?.trim();
    const file = exe || "agentapi";
    const execArgs = exe && path.basename(exe) !== "agentapi" ? ["agentapi", ...args] : args;
    const timeoutMs = Number(opts.timeoutMs || process.env.AGY_AGENTAPI_TIMEOUT_MS || 15000);
    const execOpts = {
      encoding: "utf8",
      env,
      timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000
    };
    if (opts.cwd) execOpts.cwd = path.resolve(opts.cwd);
    execFile(file, execArgs, execOpts, (err, stdout, stderr) => {
      if (err) {
        const spawnFailed = err.code === "ENOENT" || err.code === "EACCES";
        const timedOut = Boolean(err.killed || err.signal === "SIGTERM" || err.code === "ETIMEDOUT");
        resolve({
          ok: false,
          spawnFailed,
          timedOut,
          code: err.code ?? null,
          error: err.message,
          stderr: stderr ? String(stderr) : undefined
        });
        return;
      }
      const out = String(stdout || "").trim();
      try {
        const parsed = out ? JSON.parse(out) : { success: true };
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const hasErr = Boolean(parsed.error);
          resolve({
            ok: !hasErr,
            spawnFailed: false,
            timedOut: false,
            ...parsed
          });
        } else {
          resolve({ ok: true, spawnFailed: false, timedOut: false, data: parsed });
        }
      } catch {
        resolve({ ok: true, spawnFailed: false, timedOut: false, success: true, raw: out });
      }
    });
  });
}

async function ensureCoordinatorBound(workspacePath, { autoSpawn = true } = {}) {
  const absWs = path.resolve(workspacePath);
  if (coordinatorStartLocks.has(absWs)) {
    return coordinatorStartLocks.get(absWs);
  }
  const p = (async () => {
    const cfg = db.loadProjectConfig(absWs);
    if (!cfg) throw new Error("Project config not found.");
    if (cfg.status !== "active") {
      const err = new Error(`Project '${cfg.name}' is ${cfg.status.toUpperCase()}. Resume it before launching Coordinator.`);
      err.statusCode = 409;
      throw err;
    }
    if (cfg.coordinatorConversationId) {
      return {
        ok: true,
        alreadyBound: true,
        spawned: false,
        coordinatorConversationId: cfg.coordinatorConversationId,
        projectId: cfg.projectId
      };
    }
    if (!autoSpawn) {
      return {
        ok: false,
        spawnFailed: false,
        timedOut: false,
        error: "No coordinator conversation bound to this project."
      };
    }

    const introPrompt = [
      `You are the Project Coordinator for "${cfg.name}" (${absWs}).`,
      cfg.goal ? `Goal: ${cfg.goal}` : "",
      `Before acting on any [PROJECT HUB DISPATCH id=... nonce=...] message, ALWAYS call claim_hub_dispatch(workspacePath=${JSON.stringify(absWs)}, dispatchId, nonce) first and perform only its returned structured Swarm action.`
    ]
      .filter(Boolean)
      .join("\n\n");

    const agentRes = await runAgentApi(
      ["new-conversation", "--title", `${cfg.name} Coordinator`, introPrompt],
      cfg.projectId,
      { cwd: absWs }
    );
    if (!agentRes.ok) {
      return {
        ok: false,
        spawnFailed: Boolean(agentRes.spawnFailed),
        timedOut: Boolean(agentRes.timedOut),
        error: agentRes.error || "Failed to start Coordinator conversation."
      };
    }
    const newCoordId = extractNewConversationId(agentRes);
    if (!newCoordId || !db.VALID_CONV_ID_RE.test(String(newCoordId))) {
      return {
        ok: false,
        spawnFailed: false,
        timedOut: false,
        error: "agentapi new-conversation returned no valid conversationId."
      };
    }

    // Persist Coordinator binding BEFORE releasing lock or sending dispatch #2
    db.selectProject({
      projectId: cfg.projectId,
      workspacePath: absWs,
      bindCoordinatorConversationId: String(newCoordId)
    });
    broadcastSnapshot(absWs);
    return {
      ok: true,
      alreadyBound: false,
      spawned: true,
      coordinatorConversationId: String(newCoordId),
      projectId: cfg.projectId
    };
  })();

  coordinatorStartLocks.set(absWs, p);
  try {
    return await p;
  } finally {
    if (coordinatorStartLocks.get(absWs) === p) {
      coordinatorStartLocks.delete(absWs);
    }
  }
}

async function relayToCoordinator(
  workspacePath,
  dispatch,
  { ensureCoordinator = false, fallbackHeadless = null } = {}
) {
  const absWs = path.resolve(workspacePath);
  let cfg = db.loadProjectConfig(absWs);
  if (!cfg) throw new Error("Project config not found.");

  const handleSpawnFail = (errMsg) => {
    try {
      db.failHubDispatch(absWs, dispatch.dispatchId, dispatch.nonce, errMsg || "agentapi spawn failed (pre-delivery)");
    } catch {}
    if (typeof fallbackHeadless === "function") {
      const hlRes = fallbackHeadless();
      if (hlRes && !hlRes.headlessAuthMissing && hlRes.started !== false) {
        try {
          db.updateThreadState(absWs, {
            threadId: dispatch.threadId,
            uiBucket: "working",
            clearBlockingQuestion: true,
            summary: "Fallback to Headless SDK worker."
          });
          db.openProjectDb(absWs)
            .prepare("UPDATE threads SET execution_backend = 'headless' WHERE thread_id = ?")
            .run(dispatch.threadId);
        } catch {}
      }
      return {
        dispatchedVia: "headless",
        ...hlRes,
        dispatchId: dispatch.dispatchId,
        fallbackReason: errMsg
      };
    }
    return {
      dispatchedVia: "swarm",
      ok: false,
      started: false,
      spawnFailed: true,
      timedOut: false,
      dispatchId: dispatch.dispatchId,
      error: errMsg
    };
  };

  if (!cfg.coordinatorConversationId) {
    if (!ensureCoordinator) {
      if (typeof fallbackHeadless === "function") {
        return handleSpawnFail("No Swarm Coordinator bound.");
      }
      try {
        db.failHubDispatch(absWs, dispatch.dispatchId, dispatch.nonce, "No Swarm Coordinator bound.");
      } catch {}
      return {
        dispatchedVia: "swarm",
        ok: false,
        started: false,
        spawnFailed: false,
        timedOut: false,
        dispatchId: dispatch.dispatchId,
        error: "No Swarm Coordinator bound."
      };
    }
    const ensureRes = await ensureCoordinatorBound(absWs, { autoSpawn: true });
    if (!ensureRes.ok) {
      if (ensureRes.spawnFailed) {
        return handleSpawnFail(ensureRes.error);
      }
      if (!ensureRes.timedOut) {
        try {
          db.failHubDispatch(
            absWs,
            dispatch.dispatchId,
            dispatch.nonce,
            ensureRes.error || "Coordinator ensure failed."
          );
        } catch {}
      }
      return {
        dispatchedVia: "swarm",
        ok: false,
        started: Boolean(ensureRes.timedOut),
        spawnFailed: false,
        timedOut: Boolean(ensureRes.timedOut),
        dispatchId: dispatch.dispatchId,
        error: ensureRes.error
      };
    }
    cfg = db.loadProjectConfig(absWs);
  }

  const coordId = cfg.coordinatorConversationId;
  const relayText = `[PROJECT HUB DISPATCH id=${dispatch.dispatchId} nonce=${dispatch.nonce}] Call claim_hub_dispatch(workspacePath=${JSON.stringify(absWs)}, dispatchId=${JSON.stringify(dispatch.dispatchId)}, nonce=${JSON.stringify(dispatch.nonce)}) first and perform only the returned structured action.`;
  const sendRes = await runAgentApi(["send-message", coordId, relayText], cfg.projectId, { cwd: absWs });

  if (sendRes.ok) {
    return {
      dispatchedVia: "swarm",
      ok: true,
      started: true,
      spawnFailed: false,
      timedOut: false,
      dispatchId: dispatch.dispatchId,
      coordinatorConversationId: coordId
    };
  }
  if (sendRes.spawnFailed) {
    return handleSpawnFail(sendRes.error || "agentapi pre-delivery spawn error");
  }
  // Never fall back to Headless SDK on 15s timeout or ambiguous post-spawn error;
  // fail non-timeout relay errors so reserved_slots and active_dispatch_id do not leak.
  if (!sendRes.timedOut) {
    try {
      db.failHubDispatch(
        absWs,
        dispatch.dispatchId,
        dispatch.nonce,
        sendRes.error || "agentapi send-message failed"
      );
    } catch {}
  }
  return {
    dispatchedVia: "swarm",
    ok: false,
    started: Boolean(sendRes.timedOut),
    spawnFailed: false,
    timedOut: Boolean(sendRes.timedOut),
    dispatchId: dispatch.dispatchId,
    error: sendRes.error || "agentapi send-message failed"
  };
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

  const swarmCap = absWs ? db.computeSwarmCapability(absWs, { cfg }) : { active: false, verifiedCapable: false, backend: null, unsupportedReason: null, isEngineSwarm: false, counts: { total: 0, working: 0, waiting: 0, killed: 0 } };
  let builtinSwarmSummary = "No active project initialized";
  if (absWs && cfg) {
    if (swarmCap.unsupportedReason) {
      builtinSwarmSummary = `Built-in Swarm disabled (${swarmCap.unsupportedReason})`;
    } else if (swarmCap.verifiedCapable && swarmCap.active) {
      builtinSwarmSummary = `Local Swarm active (${swarmCap.counts.working} working, ${swarmCap.counts.waiting} waiting)`;
    } else if (swarmCap.verifiedCapable) {
      builtinSwarmSummary = "Built-in local Swarm verified and ready";
    } else if (!swarmCap.isEngineSwarm) {
      builtinSwarmSummary = `Execution engine configured as '${cfg?.orchestration?.executionEngine || "subagent"}'`;
    } else {
      builtinSwarmSummary = "Built-in Swarm unverified (no active swarm or local swarm.json detected yet)";
    }
  }

  const connectors = {
    mcpServer: { ok: true, label: "agy_projects_mcp (stdio active)" },
    builtinSwarm: {
      ok: Boolean(swarmCap.verifiedCapable),
      active: Boolean(swarmCap.active),
      verifiedCapable: Boolean(swarmCap.verifiedCapable),
      backend: swarmCap.backend || null,
      unsupportedReason: swarmCap.unsupportedReason || null,
      summary: builtinSwarmSummary
    },
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
    snap.version = getCompositeVersion(workspacePath);
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
  const effectiveModel = db.resolveHeadlessModel(thread, cfg);

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
    onSpawnAutoFix: async (payload) => {
      const absWs = path.resolve(workspacePath);
      const cfg = db.loadProjectConfig(absWs);
      const sql = db.openProjectDb(absWs);
      const threadRow = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(payload.threadId);
      const useSwarm = Boolean(cfg?.coordinatorConversationId && cfg?.orchestration?.executionEngine !== "headless");

      const runHeadlessPrFallback = () =>
        startHeadlessWorkerOrHandleAuth(absWs, {
          threadId: payload.threadId,
          mode: "write",
          cwd: payload.cwd,
          prompt: payload.prompt
        });

      if (!useSwarm) {
        return runHeadlessPrFallback();
      }

      const activeSwarm = db.readActiveSwarmState(absWs);
      const liveMember = threadRow?.swarm_member_name ? activeSwarm?.members?.[threadRow.swarm_member_name] : null;
      const hasAliveWorker = Boolean(
        threadRow?.swarm_member_name &&
          (!threadRow.swarm_origin_coordinator_id ||
            threadRow.swarm_origin_coordinator_id === cfg.coordinatorConversationId) &&
          threadRow.swarm_state !== "killed" &&
          liveMember &&
          liveMember.status !== "killed"
      );

      const externalCtx = {
        prNumber: payload.prNumber,
        prUrl: payload.prUrl,
        repoName: payload.repoName,
        headBranch: payload.headBranch,
        baseBranch: payload.baseBranch,
        cwd: payload.cwd,
        ciStatus: payload.ciStatus,
        reviewDecision: payload.reviewDecision,
        mergeStateStatus: payload.mergeStateStatus,
        failingChecks: payload.failingChecks,
        changeReqNotes: payload.changeReqNotes,
        recentCommentNotes: payload.recentCommentNotes,
        details: payload.externalContextText
      };

      const boardHead = db.getSwarmBoardHeadSync(absWs, threadRow);
      let dispatch;
      if (hasAliveWorker) {
        dispatch = db.createHubDispatch(absWs, {
          threadId: payload.threadId,
          action: "steer",
          targetMemberName: threadRow.swarm_member_name,
          payload: {
            message: `PR #${payload.prNumber} reported CI=${payload.ciStatus}, review=${payload.reviewDecision}. Fix any failures on branch '${payload.headBranch || ""}'.`
          },
          externalCtx,
          baselineHeadSeq: boardHead,
          reservedSlots: 0
        });
      } else {
        try {
          db.checkThreadQuota(absWs, {
            additionalCount: 1,
            skipCounts: threadRow?.ui_bucket === "working"
          });
        } catch (err) {
          return { started: false, reason: "quota_exceeded", error: err.message };
        }
        dispatch = db.createHubDispatch(absWs, {
          threadId: payload.threadId,
          action: "pr_autofix",
          payload: {
            role: "pr-fixer",
            title: `PR #${payload.prNumber} Auto-Fix`,
            prNumber: payload.prNumber,
            prUrl: payload.prUrl,
            repoName: payload.repoName,
            headBranch: payload.headBranch,
            baseBranch: payload.baseBranch,
            ciStatus: payload.ciStatus,
            reviewDecision: payload.reviewDecision,
            cwd: payload.cwd
          },
          externalCtx,
          baselineHeadSeq: boardHead,
          reservedSlots: threadRow?.ui_bucket === "working" ? 0 : 1
        });
      }

      return relayToCoordinator(absWs, dispatch, {
        fallbackHeadless: runHeadlessPrFallback
      });
    }
  });
}

// ---------- Autonomous Background Loops ----------

let cronTickInFlight = false;
async function runCronTick() {
  if (cronTickInFlight) return;
  cronTickInFlight = true;
  try {
    const reg = db.loadRegistry();
    const now = new Date();
    const nowIsoStr = now.toISOString();

    for (const p of reg.projects) {
      if (!p?.workspacePath || !db.hasProjectInitialized(p.workspacePath)) continue;
      let shouldBroadcast = false;
      try {
        const exp = db.reconcileExpiredDispatches(p.workspacePath, { now: nowIsoStr });
        if (exp && exp.expiredCount > 0) shouldBroadcast = true;
      } catch {}
      try {
        const syncRes = db.syncSwarmIntoProjectDb(p.workspacePath);
        if (syncRes && Number(syncRes.changes || 0) > 0) shouldBroadcast = true;
      } catch {}
      try {
        const cfg = db.loadProjectConfig(p.workspacePath);
        if (cfg && cfg.status === "active") {
          const res = await db.processDueSchedules(p.workspacePath, {
            now,
            onDispatch: async ({ workspacePath, routine, thread, normRole, dispatch, isSwarm }) => {
              const runHeadlessRoutineFallback = () =>
                startHeadlessWorkerOrHandleAuth(workspacePath, {
                  threadId: thread.thread_id,
                  mode: db.isMutatingRole(normRole) ? "write" : "readonly",
                  cwd: workspacePath,
                  prompt: routine.prompt
                });
              if (isSwarm && dispatch) {
                return relayToCoordinator(workspacePath, dispatch, {
                  fallbackHeadless: runHeadlessRoutineFallback
                });
              }
              return runHeadlessRoutineFallback();
            }
          });
          if (res.dispatched.length > 0 || res.failed.length > 0) {
            shouldBroadcast = true;
          }
        }
      } catch {}
      if (shouldBroadcast) broadcastSnapshot(p.workspacePath);
    }
  } finally {
    cronTickInFlight = false;
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
    // Parked waiting Swarm workers (ui_bucket = 'idle' AND swarm_state = 'waiting') remain asleep until explicitly killed or resolved past idleAutoResolveDays
    const stale = sql
      .prepare("SELECT thread_id, worktree_path, repo_id, execution_backend, swarm_state FROM threads WHERE ui_bucket = 'idle' AND updated_at <= ?")
      .all(cutoffIso);
    for (const t of stale) {
      db.updateThreadState(p.workspacePath, {
        threadId: t.thread_id,
        uiBucket: "resolved",
        summary: `Auto-resolved after ${days} days idle.`
      });
      const isAsleepSwarm = t.execution_backend === "swarm" && (t.swarm_state || "") === "waiting";
      if (t.worktree_path && !isAsleepSwarm) {
        try { db.manageWorktree(p.workspacePath, { action: "cleanup", threadId: t.thread_id }); } catch {}
      }
    }
    const lingeringResolved = sql
      .prepare(
        "SELECT thread_id, worktree_path, worktrees_json, repo_id FROM threads WHERE ui_bucket = 'resolved' AND (worktree_path IS NOT NULL OR worktrees_json NOT IN ('', '{}')) AND NOT (execution_backend = 'swarm' AND COALESCE(swarm_state, '') = 'waiting')"
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
      const activeWs = body.workspacePath || db.resolveActiveWorkspace(undefined, body.projectId);
      const out = await runAgentApi(args, body.projectId, activeWs ? { cwd: activeWs } : {});
      if (out && out.ok && !out.conversationId) {
        const extractedId = extractNewConversationId(out);
        if (extractedId) out.conversationId = extractedId;
      }
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
      const sseWs = parsedUrl.searchParams.get("workspacePath") || undefined;
      const snap = db.buildFullWorkspaceSnapshot(sseWs);
      snap.runningHeadlessKeys = getRunningHeadlessList();
      snap.version = getCompositeVersion(sseWs);
      snap.uiAssetMtimeMs = getUiAssetMtimeMs();
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
      snap.version = getCompositeVersion(wsHint);
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

    if (req.method === "GET" && pathname === "/api/swarm/thread-board") {
      const ws = db.resolveActiveWorkspace(
        parsedUrl.searchParams.get("workspacePath") || undefined,
        parsedUrl.searchParams.get("projectId") || undefined
      );
      if (!ws || !db.hasProjectInitialized(ws)) {
        return sendJson(res, 404, { error: "No initialized AGY Project found." });
      }
      const threadId = parsedUrl.searchParams.get("threadId") || "";
      if (!threadId) return sendJson(res, 400, { error: "Missing threadId query parameter." });
      const rawLimit = Number(parsedUrl.searchParams.get("limit") || 100);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, Math.floor(rawLimit)) : 100;
      const boardRes = db.getThreadBoardMessages(ws, threadId, { limit });
      if (!boardRes.found) {
        return sendJson(res, 404, { error: `Thread '${threadId}' not found.` });
      }
      const sql = db.openProjectDb(ws);
      const tRow = sql.prepare("SELECT swarm_state FROM threads WHERE thread_id = ?").get(threadId);
      return sendJson(res, 200, {
        threadId: boardRes.threadId,
        swarmMemberName: boardRes.memberName || null,
        swarmState: tRow?.swarm_state || null,
        coordinatorConversationId: boardRes.coordinatorConversationId || null,
        unsupportedReason: boardRes.unsupportedReason || null,
        head: boardRes.head || 0,
        messages: boardRes.messages || []
      });
    }

    if (req.method === "GET" && pathname === "/api/swarm/board") {
      const ws = db.resolveActiveWorkspace(
        parsedUrl.searchParams.get("workspacePath") || undefined,
        parsedUrl.searchParams.get("projectId") || undefined
      );
      if (!ws || !db.hasProjectInitialized(ws)) {
        return sendJson(res, 404, { error: "No initialized AGY Project found." });
      }
      const rawLimit = Number(parsedUrl.searchParams.get("limit") || 150);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, Math.floor(rawLimit)) : 150;
      const member = (parsedUrl.searchParams.get("member") || "").trim() || undefined;
      return sendJson(res, 200, db.getProjectSwarmBoard(ws, { limit, member }));
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

    if (pathname === "/api/coordinator/ensure") {
      const cfg = db.loadProjectConfig(ws);
      if (cfg && cfg.status !== "active") {
        return sendJson(res, 409, {
          error: `Project '${cfg.name}' is ${cfg.status.toUpperCase()}. Resume it before starting Coordinator.`
        });
      }
      const ensureRes = await ensureCoordinatorBound(ws, { autoSpawn: body.autoSpawn !== false });
      if (!ensureRes.ok) {
        return sendJson(res, 502, {
          ok: false,
          error: ensureRes.error || "Failed to bind Coordinator.",
          spawnFailed: Boolean(ensureRes.spawnFailed),
          timedOut: Boolean(ensureRes.timedOut)
        });
      }
      return sendJson(res, 200, ensureRes);
    }

    if (pathname === "/api/threads/action") {
      const sql = db.openProjectDb(ws);
      const cfg = db.loadProjectConfig(ws);
      const act = body.action;

      const MUTATING_ACTIONS = new Set([
        "start",
        "start_all",
        "start_selected",
        "steer",
        "switch_model",
        "kill_swarm_worker"
      ]);
      if (cfg && cfg.status !== "active" && MUTATING_ACTIONS.has(act)) {
        return sendJson(res, 409, {
          error: `Project '${cfg.name}' is ${cfg.status.toUpperCase()}. Resume it before executing '${act}'.`
        });
      }

      const isSwarmEngine = (cfg?.orchestration?.executionEngine || "swarm") === "swarm";
      const wantsSwarmStart = Boolean(
        !body.launchHeadless &&
          !body.conversationId &&
          body.launchViaSwarm !== false &&
          isSwarmEngine &&
          (cfg?.coordinatorConversationId || body.autoStartCoordinator)
      );

      const buildStartHeadlessFallback = (row) => () => {
        let started = db.registerThread(ws, {
          threadId: row.thread_id,
          role: row.role,
          workspaceMode: row.workspace_mode,
          executionBackend: "headless"
        });
        const sp = startHeadlessWorkerOrHandleAuth(ws, {
          threadId: row.thread_id,
          mode: db.isMutatingRole(row.role) ? "write" : "readonly",
          cwd: row.worktree_path || ws,
          prompt: body.prompt || `${row.title}\n\n${row.description}`
        });
        if (sp.headlessAuthMissing) {
          started = sp.thread;
        }
        return { ...sp, thread: started };
      };

      if (act === "start") {
        const row = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(body.threadId);
        if (!row) return sendJson(res, 404, { error: "Thread not found" });

        if (wantsSwarmStart) {
          if (!cfg?.coordinatorConversationId && body.autoStartCoordinator) {
            const ensureRes = await ensureCoordinatorBound(ws, { autoSpawn: true });
            if (!ensureRes.ok) {
              if (ensureRes.spawnFailed && body.launchHeadlessFallback) {
                const fb = buildStartHeadlessFallback(row)();
                broadcastSnapshot(ws);
                return sendJson(res, 200, {
                  thread: fb.thread,
                  headlessAuthMissing: Boolean(fb.headlessAuthMissing),
                  dispatchedVia: "headless"
                });
              }
              return sendJson(res, 502, {
                error: ensureRes.error || "Failed to start Coordinator.",
                spawnFailed: Boolean(ensureRes.spawnFailed),
                timedOut: Boolean(ensureRes.timedOut)
              });
            }
          }

          db.checkThreadQuota(ws, { additionalCount: 1, skipCounts: row.ui_bucket === "working" });
          const dispatch = db.createHubDispatch(ws, {
            threadId: row.thread_id,
            action: "start",
            targetMemberName: body.memberName || row.swarm_member_name || null,
            payload: {
              role: row.role,
              title: row.title,
              prompt: body.prompt || row.description,
              workspaceMode: row.workspace_mode,
              swarmModel:
                db.normalizeExplicitModel(body.swarmModel) ||
                db.normalizeExplicitModel(row.swarm_model) ||
                db.normalizeExplicitModel(row.model) ||
                null
            },
            baselineHeadSeq: db.getSwarmBoardHeadSync(ws, row),
            reservedSlots: row.ui_bucket === "working" ? 0 : 1
          });

          const relayRes = await relayToCoordinator(ws, dispatch, {
            fallbackHeadless: body.launchHeadlessFallback ? buildStartHeadlessFallback(row) : null
          });
          broadcastSnapshot(ws);
          const freshRow = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(row.thread_id);
          if (!relayRes.ok && !relayRes.timedOut && relayRes.dispatchedVia !== "headless") {
            return sendJson(res, 502, {
              error: relayRes.error || "Swarm relay failed.",
              thread: freshRow,
              dispatchId: dispatch.dispatchId,
              dispatchedVia: relayRes.dispatchedVia,
              spawnFailed: Boolean(relayRes.spawnFailed),
              timedOut: Boolean(relayRes.timedOut)
            });
          }
          return sendJson(res, 200, {
            thread: freshRow,
            dispatchId: dispatch.dispatchId,
            dispatchedVia: relayRes.dispatchedVia,
            headlessAuthMissing: Boolean(relayRes.headlessAuthMissing),
            relayTimedOut: Boolean(relayRes.timedOut),
            relayError: relayRes.error || null
          });
        }

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

      if (act === "start_all" || act === "start_selected") {
        const rows =
          act === "start_all"
            ? sql.prepare("SELECT * FROM threads WHERE ui_bucket = 'suggested' ORDER BY created_at ASC").all()
            : (Array.isArray(body.threadIds) ? body.threadIds.map(String) : [])
                .map((tid) => sql.prepare("SELECT * FROM threads WHERE thread_id = ? AND ui_bucket = 'suggested'").get(tid))
                .filter(Boolean);

        if (wantsSwarmStart) {
          if (!cfg?.coordinatorConversationId && body.autoStartCoordinator) {
            const ensureRes = await ensureCoordinatorBound(ws, { autoSpawn: true });
            if (!ensureRes.ok && !(ensureRes.spawnFailed && body.launchHeadlessFallback)) {
              return sendJson(res, 502, {
                error: ensureRes.error || "Failed to start Coordinator.",
                spawnFailed: Boolean(ensureRes.spawnFailed),
                timedOut: Boolean(ensureRes.timedOut)
              });
            }
          }
          const dispatchedThreads = [];
          const dispatchIds = [];
          let headlessAuthMissing = false;
          for (const row of rows) {
            try {
              db.checkThreadQuota(ws, { additionalCount: 1 });
              const dispatch = db.createHubDispatch(ws, {
                threadId: row.thread_id,
                action: "start",
                targetMemberName: row.swarm_member_name || null,
                payload: {
                  role: row.role,
                  title: row.title,
                  prompt: row.description,
                  workspaceMode: row.workspace_mode,
                  swarmModel:
                    db.normalizeExplicitModel(row.swarm_model) ||
                    db.normalizeExplicitModel(row.model) ||
                    null
                },
                baselineHeadSeq: db.getSwarmBoardHeadSync(ws, row),
                reservedSlots: 1
              });
              const relayRes = await relayToCoordinator(ws, dispatch, {
                fallbackHeadless: body.launchHeadlessFallback ? buildStartHeadlessFallback(row) : null
              });
              if (relayRes.headlessAuthMissing) headlessAuthMissing = true;
              const didAccept =
                relayRes.ok ||
                relayRes.timedOut ||
                (relayRes.dispatchedVia === "headless" && relayRes.started !== false);
              if (!didAccept) {
                break;
              }
              dispatchIds.push(dispatch.dispatchId);
              dispatchedThreads.push(sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(row.thread_id));
            } catch {
              break;
            }
          }
          broadcastSnapshot(ws);
          return sendJson(res, 200, {
            startedCount: dispatchedThreads.length,
            dispatchCount: dispatchIds.length,
            dispatchIds,
            threads: dispatchedThreads,
            dispatchedVia: "swarm",
            headlessAuthMissing
          });
        }

        const startedList = [];
        let headlessAuthMissing = false;
        for (const row of rows) {
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

      const failOpenThreadDispatches = (tid, reason) => {
        if (!tid) return;
        sql.prepare(`
          UPDATE hub_dispatches
          SET status = 'failed', reserved_slots = 0, error_message = COALESCE(error_message, ?)
          WHERE thread_id = ? AND status IN ('pending', 'claimed')
        `).run(reason, String(tid));
      };

      if (act === "dismiss") {
        failOpenThreadDispatches(body.threadId, "Thread dismissed.");
        const updated = db.updateThreadState(ws, {
          threadId: body.threadId,
          uiBucket: "resolved",
          summary: "Dismissed from Suggested queue.",
          activeDispatchId: null
        });
        broadcastSnapshot(ws);
        return sendJson(res, 200, { thread: updated });
      }

      if (act === "cancel_headless" || act === "interrupt") {
        const cancelled = cancelSingleHeadlessTask(ws, body.threadId);
        let updated;
        if (act === "interrupt") {
          failOpenThreadDispatches(body.threadId, "Thread interrupted by user.");
          updated = db.updateThreadState(ws, {
            threadId: body.threadId,
            uiBucket: "idle",
            summary: body.summary || "Interrupted by user.",
            activeDispatchId: null
          });
        } else {
          updated = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(body.threadId);
        }
        broadcastSnapshot(ws);
        return sendJson(res, 200, { cancelled, thread: updated });
      }

      const getEffectiveSwarmState = (row) => {
        if (row.swarm_state === "killed") return "killed";
        const activeSwarm = db.readActiveSwarmState(ws);
        const liveMember = row.swarm_member_name ? activeSwarm?.members?.[row.swarm_member_name] : null;
        return liveMember ? liveMember.status : (row.swarm_state || "working");
      };

      const getOriginMismatchError = (row) => {
        if (
          row.swarm_origin_coordinator_id &&
          cfg?.coordinatorConversationId &&
          row.swarm_origin_coordinator_id !== cfg.coordinatorConversationId
        ) {
          return `Swarm worker '@${row.swarm_member_name}' belongs to rolled-over Coordinator '${row.swarm_origin_coordinator_id}', not active Coordinator '${cfg.coordinatorConversationId}'.`;
        }
        return null;
      };

      if (act === "steer") {
        const row = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(body.threadId);
        if (!row) return sendJson(res, 404, { error: "Thread not found" });
        const msg = String(body.message || "").trim();
        if (!msg) return sendJson(res, 400, { error: "Steering message cannot be empty." });

        if (row.swarm_member_name && getEffectiveSwarmState(row) === "killed") {
          return sendJson(res, 409, { error: `Cannot steer killed Swarm worker '@${row.swarm_member_name}'.` });
        }
        const isSwarmSteer = Boolean(
          row.swarm_member_name &&
            row.swarm_state !== "killed" &&
            (row.execution_backend === "swarm" || cfg?.coordinatorConversationId)
        );
        if (isSwarmSteer && body.launchViaSwarm !== false) {
          if (!cfg?.coordinatorConversationId) {
            return sendJson(res, 409, { error: "No Swarm Coordinator bound to steer this worker." });
          }
          const originErr = getOriginMismatchError(row);
          if (originErr) {
            return sendJson(res, 409, { error: originErr });
          }
          const currentHead = db.getSwarmBoardHeadSync(ws, row);
          const dispatch = db.createHubDispatch(ws, {
            threadId: row.thread_id,
            action: "steer",
            targetMemberName: row.swarm_member_name,
            payload: { message: msg },
            baselineHeadSeq: currentHead,
            reservedSlots: 0
          });
          // Advances swarm_handled_seq to currentHead & sets active_dispatch_id while leaving swarm_state untouched
          let updated = db.updateThreadState(ws, {
            threadId: row.thread_id,
            uiBucket: "working",
            clearBlockingQuestion: true,
            summary: `Steered: ${msg.slice(0, 180)}`,
            telemetryEvent: { type: "steer", text: msg.slice(0, 300) },
            activeDispatchId: dispatch.dispatchId
          });
          const relayRes = await relayToCoordinator(ws, dispatch, {
            fallbackHeadless: body.launchHeadlessFallback
              ? () =>
                  startHeadlessWorkerOrHandleAuth(ws, {
                    threadId: row.thread_id,
                    mode: db.isMutatingRole(row.role) ? "write" : "readonly",
                    cwd: row.worktree_path || ws,
                    prompt: `${row.title}\n\nOriginal Brief:\n${row.description}\n\nUser Reply / Steering Instruction:\n${msg}`
                  })
              : null
          });
          updated = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(row.thread_id);
          broadcastSnapshot(ws);
          if (!relayRes.ok && !relayRes.timedOut && relayRes.dispatchedVia !== "headless") {
            return sendJson(res, 502, {
              error: relayRes.error || "Swarm steer relay failed.",
              thread: updated,
              dispatchId: dispatch.dispatchId,
              spawnFailed: Boolean(relayRes.spawnFailed)
            });
          }
          return sendJson(res, 200, {
            thread: updated,
            dispatchId: dispatch.dispatchId,
            dispatchedVia: relayRes.dispatchedVia,
            headlessAuthMissing: Boolean(relayRes.headlessAuthMissing),
            relayTimedOut: Boolean(relayRes.timedOut)
          });
        }

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

      if (act === "switch_model") {
        const row = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(body.threadId);
        if (!row) return sendJson(res, 404, { error: "Thread not found" });
        if (!row.swarm_member_name) {
          return sendJson(res, 400, { error: "Thread is not bound to a Swarm worker." });
        }
        if (!cfg?.coordinatorConversationId) {
          return sendJson(res, 409, { error: "No active Swarm Coordinator bound." });
        }
        const originErr = getOriginMismatchError(row);
        if (originErr) {
          return sendJson(res, 409, { error: originErr });
        }
        const rawModel = String(body.model || "").trim();
        const resolvedModel = rawModel === "inherit" ? null : db.resolveSwarmModel(rawModel);
        if (!rawModel || (rawModel !== "inherit" && !resolvedModel)) {
          return sendJson(res, 400, { error: `Invalid Swarm model '${rawModel}'.` });
        }
        const liveSwarmState = getEffectiveSwarmState(row);
        if (liveSwarmState !== "waiting") {
          return sendJson(res, 409, {
            error: `Cannot switch model while Swarm worker '@${row.swarm_member_name}' is '${liveSwarmState}'. Worker must be waiting.`
          });
        }

        const dispatch = db.createHubDispatch(ws, {
          threadId: row.thread_id,
          action: "switch_model",
          targetMemberName: row.swarm_member_name,
          payload: { model: rawModel, resolvedModel },
          baselineHeadSeq: db.getSwarmBoardHeadSync(ws, row),
          reservedSlots: 0
        });
        const relayRes = await relayToCoordinator(ws, dispatch);
        const updated = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(row.thread_id);
        broadcastSnapshot(ws);
        if (!relayRes.ok && !relayRes.timedOut) {
          return sendJson(res, 502, {
            error: relayRes.error || "Failed to relay switch_model dispatch.",
            thread: updated,
            dispatchId: dispatch.dispatchId,
            spawnFailed: Boolean(relayRes.spawnFailed)
          });
        }
        return sendJson(res, 200, {
          thread: updated,
          dispatchId: dispatch.dispatchId,
          dispatchedVia: "swarm",
          relayTimedOut: Boolean(relayRes.timedOut)
        });
      }

      if (act === "kill_swarm_worker") {
        const row = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(body.threadId);
        if (!row) return sendJson(res, 404, { error: "Thread not found" });
        if (!row.swarm_member_name) {
          return sendJson(res, 400, { error: "Thread is not bound to a Swarm worker." });
        }
        if (!cfg?.coordinatorConversationId) {
          return sendJson(res, 409, { error: "No active Swarm Coordinator bound." });
        }
        const killOriginErr = getOriginMismatchError(row);
        if (killOriginErr) {
          return sendJson(res, 409, { error: killOriginErr });
        }
        const liveSwarmState = getEffectiveSwarmState(row);
        if (liveSwarmState === "killed") {
          return sendJson(res, 409, { error: `Swarm worker '@${row.swarm_member_name}' is already killed.` });
        }

        const dispatch = db.createHubDispatch(ws, {
          threadId: row.thread_id,
          action: "kill",
          targetMemberName: row.swarm_member_name,
          payload: { memberName: row.swarm_member_name },
          baselineHeadSeq: db.getSwarmBoardHeadSync(ws, row),
          reservedSlots: 0
        });
        const relayRes = await relayToCoordinator(ws, dispatch);
        const updated = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(row.thread_id);
        broadcastSnapshot(ws);
        if (!relayRes.ok && !relayRes.timedOut) {
          return sendJson(res, 502, {
            error: relayRes.error || "Failed to relay kill dispatch.",
            thread: updated,
            dispatchId: dispatch.dispatchId,
            spawnFailed: Boolean(relayRes.spawnFailed)
          });
        }
        return sendJson(res, 200, {
          thread: updated,
          dispatchId: dispatch.dispatchId,
          dispatchedVia: "swarm",
          relayTimedOut: Boolean(relayRes.timedOut)
        });
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
      const cfg = db.loadProjectConfig(ws);
      if (cfg && cfg.status !== "active") {
        return sendJson(res, 409, {
          error: `Project '${cfg.name}' is ${cfg.status.toUpperCase()}. Resume it before running routines.`
        });
      }
      const sql = db.openProjectDb(ws);
      const r = sql.prepare("SELECT * FROM scheduled_routines WHERE routine_id = ?").get(body.routineId);
      if (!r) return sendJson(res, 404, { error: "Routine not found" });
      const normRole = db.normalizeRole(r.target_role || "explorer");
      const useSwarm = Boolean(
        cfg?.coordinatorConversationId &&
          cfg?.orchestration?.executionEngine !== "headless" &&
          !body.launchHeadless &&
          body.launchViaSwarm !== false
      );

      if (useSwarm) {
        const thread = db.createPendingRoutineThread(ws, {
          title: `[Routine] ${r.name}`,
          description: r.prompt,
          role: normRole,
          workspaceMode: r.workspace_mode || "share",
          coordinatorConversationId: cfg.coordinatorConversationId
        });
        const dispatch = db.createHubDispatch(ws, {
          threadId: thread.thread_id,
          action: "cron",
          payload: {
            role: normRole,
            title: `[Routine] ${r.name}`,
            prompt: r.prompt,
            workspaceMode: r.workspace_mode || "share"
          },
          baselineHeadSeq: db.getSwarmBoardHeadSync(ws, thread),
          reservedSlots: 1
        });
        sql.prepare("UPDATE scheduled_routines SET last_run_at = ?, last_thread_id = ? WHERE routine_id = ?")
          .run(db.nowIso(), thread.thread_id, r.routine_id);
        const relayRes = await relayToCoordinator(ws, dispatch, {
          fallbackHeadless: () =>
            startHeadlessWorkerOrHandleAuth(ws, {
              threadId: thread.thread_id,
              mode: db.isMutatingRole(normRole) ? "write" : "readonly",
              cwd: ws,
              prompt: r.prompt
            })
        });
        if (relayRes.headlessAuthMissing || relayRes.started === false) {
          const errMsg = String(relayRes.error || `Dispatch failed (${relayRes.reason || "not_started"}).`).slice(0, 500);
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
          thread: sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(thread.thread_id),
          dispatchId: dispatch.dispatchId,
          dispatchedVia: relayRes.dispatchedVia,
          headlessAuthMissing: Boolean(relayRes.headlessAuthMissing),
          relayTimedOut: Boolean(relayRes.timedOut)
        });
      }

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
