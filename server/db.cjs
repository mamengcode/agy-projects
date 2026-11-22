"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, execFileSync, spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const MAX_INSTRUCTIONS_CHARS = 16000;
const DEFAULT_MAX_MEMORY_LINES = 200;
const DEFAULT_MAX_MEMORY_CHARS = 16000;
const DEFAULT_PIN_TOKEN_THRESHOLD = 15000;
const MAX_UPLOAD_INPUT_BYTES = 30 * 1024 * 1024; // 30 MB default cap matching Claude Projects
const MAX_LARGE_UPLOAD_BYTES = 45 * 1024 * 1024; // 45 MB cap for large uploaded buffer payloads
const MAX_LARGE_LOCAL_BYTES = 200 * 1024 * 1024; // 200 MB cap for large local file paths
const VALID_UI_BUCKETS = new Set([
  "suggested",
  "working",
  "waiting_on_you",
  "ready_for_review",
  "landing",
  "idle",
  "paused",
  "resolved"
]);
const VALID_CONV_ID_RE = /^[a-zA-Z0-9._:-]{4,128}$/;

function normalizeRole(role) {
  const r = String(role || "explorer").trim().toLowerCase();
  if (!r) return "explorer";
  return r === "pr_fixer" ? "pr-fixer" : r;
}

function isMutatingRole(role) {
  const norm = normalizeRole(role);
  return norm === "implementer" || norm === "pr-fixer";
}

function getRoleModelOverride(cfg, role) {
  const overrides = cfg?.models?.roleOverrides || {};
  const norm = normalizeRole(role);
  return overrides[norm] ?? (norm === "pr-fixer" ? overrides["pr_fixer"] : undefined) ?? overrides[role];
}

function getVenvPythonOrSystem() {
  const candidate = path.join(getSharedDataDir(), "venv", "bin", "python");
  try {
    if (fs.existsSync(candidate)) return candidate;
  } catch {}
  return "python3";
}

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(String(text), "utf8") / 4));
}

function getAppDataDir() {
  if (process.env.ANTIGRAVITY_APP_DATA_DIR?.trim()) {
    return path.resolve(process.env.ANTIGRAVITY_APP_DATA_DIR.trim());
  }
  return path.join(os.homedir(), ".gemini", "antigravity");
}

function getPluginRootDir() {
  if (process.env.PLUGIN_ROOT?.trim()) {
    return path.resolve(process.env.PLUGIN_ROOT.trim());
  }
  return path.resolve(__dirname, "..");
}

function getSharedDataDir() {
  const custom = process.env.AGY_PROJECTS_DATA_DIR?.trim();
  const dir = custom
    ? path.resolve(custom)
    : path.join(getAppDataDir(), "plugin_data", "agy-projects");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

let _tmpSeq = 0;

function writeJsonAtomic(filePath, data, mode = 0o600) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${++_tmpSeq}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode });
  fs.renameSync(tmpPath, filePath);
}

function writeTextAtomic(filePath, content, mode = 0o644) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${++_tmpSeq}.tmp`;
  fs.writeFileSync(tmpPath, String(content), { encoding: "utf8", mode });
  fs.renameSync(tmpPath, filePath);
}

function resolveRealPathWithAncestor(targetPath) {
  const abs = path.resolve(String(targetPath || ""));
  try {
    return fs.realpathSync.native(abs);
  } catch {
    const tail = [];
    let curr = abs;
    while (curr && curr !== path.dirname(curr)) {
      const parent = path.dirname(curr);
      tail.unshift(path.basename(curr));
      curr = parent;
      try {
        const realBase = fs.realpathSync.native(curr);
        return path.join(realBase, ...tail);
      } catch {}
    }
    return abs;
  }
}

function pathsEqual(a, b) {
  const pa = path.resolve(a);
  const pb = path.resolve(b);
  if (process.platform === "darwin" || process.platform === "win32") {
    return pa.toLowerCase() === pb.toLowerCase();
  }
  return pa === pb;
}

function isPathInsideDir(targetPath, parentDir, { allowEqual = true } = {}) {
  if (!targetPath || !parentDir) return false;
  let realTarget = resolveRealPathWithAncestor(targetPath);
  let realParent = resolveRealPathWithAncestor(parentDir);
  if (process.platform === "darwin" || process.platform === "win32") {
    realTarget = realTarget.toLowerCase();
    realParent = realParent.toLowerCase();
  }
  const rel = path.relative(realParent, realTarget);
  if (!allowEqual && rel === "") return false;
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isBlockedSensitiveSourcePath(absSrc, workspacePath) {
  if (!absSrc || typeof absSrc !== "string") return true;
  const resolvedInput = path.resolve(absSrc);
  let realSrc = resolvedInput;
  let exists = false;
  try {
    realSrc = fs.realpathSync.native(resolvedInput);
    exists = true;
  } catch {
    try {
      const lst = fs.lstatSync(resolvedInput);
      if (lst.isSymbolicLink()) return true;
    } catch {}
    realSrc = resolveRealPathWithAncestor(resolvedInput);
    exists = false;
  }

  if (exists) {
    try {
      const st = fs.statSync(realSrc);
      if (!st.isFile()) return true;
    } catch {
      return true;
    }
  }

  const normLower = realSrc.split(path.sep).join("/").toLowerCase();
  if (
    normLower.includes("/.ssh/") ||
    normLower.endsWith("/.ssh") ||
    normLower.includes("/.aws/") ||
    normLower.endsWith("/.aws") ||
    normLower.includes("/.gnupg/") ||
    normLower.endsWith("/.gnupg") ||
    normLower.includes("/.kube/") ||
    normLower.endsWith("/.kube") ||
    normLower === "/etc/shadow" ||
    normLower === "/private/etc/shadow" ||
    normLower === "/etc/passwd" ||
    normLower === "/private/etc/passwd" ||
    normLower.endsWith("/.netrc") ||
    normLower.includes("/.netrc/") ||
    normLower.includes("/.config/gh/") ||
    normLower.endsWith("/.config/gh") ||
    normLower.endsWith("/.git-credentials") ||
    normLower.includes("/.git-credentials/") ||
    normLower.endsWith("/.npmrc") ||
    normLower.includes("/.npmrc/") ||
    normLower.endsWith("/.pypirc") ||
    normLower.includes("/.pypirc/") ||
    normLower.endsWith("/.docker/config.json") ||
    normLower.includes("/.docker/config.json/") ||
    normLower.includes("/.config/gcloud/") ||
    normLower.endsWith("/.config/gcloud") ||
    normLower.includes("/library/keychains/") ||
    normLower.endsWith("/library/keychains") ||
    normLower.endsWith("/.gemini/oauth_creds.json") ||
    normLower.includes("/.gemini/oauth_creds.json/") ||
    normLower.endsWith("/.gemini/google_accounts.json") ||
    normLower.includes("/.gemini/google_accounts.json/")
  ) {
    return true;
  }

  const baseLower = path.posix.basename(normLower);
  if (baseLower === ".env" || baseLower.startsWith(".env.")) {
    const allowedRoots = [];
    if (workspacePath) allowedRoots.push(resolveRealPathWithAncestor(workspacePath));
    try {
      if (workspacePath && hasProjectInitialized(workspacePath)) {
        const sql = openProjectDb(workspacePath);
        const repos = sql.prepare("SELECT local_path FROM repositories").all();
        for (const r of repos) {
          if (r && r.local_path) {
            allowedRoots.push(resolveRealPathWithAncestor(r.local_path));
          }
        }
      }
    } catch {}
    if (!allowedRoots.some((root) => isPathInsideDir(realSrc, root, { allowEqual: false }))) {
      return true;
    }
  }

  return false;
}

function getProjectDir(workspacePath) {
  return path.join(path.resolve(workspacePath), ".agy-project");
}

function hasProjectInitialized(workspacePath) {
  if (!workspacePath) return false;
  const pDir = getProjectDir(workspacePath);
  return fs.existsSync(path.join(pDir, "config.json")) && fs.existsSync(path.join(pDir, "state", "project_index.db"));
}

// ---------- Global Multi-Project Registry ($PLUGIN_DATA) ----------

function isPlainObject(val) {
  return Boolean(val) && typeof val === "object" && !Array.isArray(val);
}

function getRegistryPath() {
  return path.join(getSharedDataDir(), "projects_registry.json");
}

function hasRegistryBoundMapOnDisk() {
  const raw = readJsonSafe(getRegistryPath(), null);
  return Boolean(raw && isPlainObject(raw.boundConversations));
}

function loadRegistry() {
  const reg = readJsonSafe(getRegistryPath(), { activeProjectId: null, projects: [], boundConversations: {} });
  if (!reg || !Array.isArray(reg.projects)) {
    return { activeProjectId: null, projects: [], boundConversations: {} };
  }
  if (!isPlainObject(reg.boundConversations)) {
    reg.boundConversations = {};
  }
  return reg;
}

function saveRegistry(reg) {
  const normalized = {
    ...(isPlainObject(reg) ? reg : {}),
    activeProjectId: reg?.activeProjectId || null,
    projects: Array.isArray(reg?.projects) ? reg.projects : [],
    boundConversations: isPlainObject(reg?.boundConversations) ? reg.boundConversations : {}
  };
  writeJsonAtomic(getRegistryPath(), normalized, 0o600);
}

function withRegistryLock(fn, { timeoutMs = 5000, staleMs = 15000, deadPidGraceMs = 500 } = {}) {
  const regPath = getRegistryPath();
  const lockPath = `${regPath}.lock`;
  fs.mkdirSync(path.dirname(regPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const waitArr = new Int32Array(new SharedArrayBuffer(4));
  let acquired = false;

  const lockToken = `${process.pid}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}\n`;

  while (Date.now() <= deadline) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, lockToken, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const st = fs.statSync(lockPath);
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs > deadPidGraceMs) {
          const staleBody = fs.readFileSync(lockPath, "utf8");
          const stalePid = Number(String(staleBody).split(":")[0]);
          const validPid = Number.isInteger(stalePid) && stalePid > 0;
          let pidAlive = false;
          if (validPid) {
            if (stalePid === process.pid) {
              pidAlive = true;
            } else {
              try {
                process.kill(stalePid, 0);
                pidAlive = true;
              } catch (kErr) {
                pidAlive = kErr.code === "EPERM";
              }
            }
          }
          const safeToUnlink =
            (validPid && !pidAlive) ||
            (!validPid && ageMs > staleMs) ||
            // PID-reuse escape hatch: unlink locks far older than staleMs even if a recycled PID is alive
            ageMs > staleMs * 4;
          if (safeToUnlink) {
            const reapPath = `${lockPath}.reap`;
            let rfd = null;
            try {
              rfd = fs.openSync(reapPath, "wx", 0o600);
            } catch (reapErr) {
              if (reapErr.code === "EEXIST") {
                try {
                  const reapSt = fs.statSync(reapPath);
                  if (Date.now() - reapSt.mtimeMs > Math.max(staleMs, 2000)) {
                    fs.unlinkSync(reapPath);
                  }
                } catch {}
              }
            }
            if (rfd !== null) {
              try { fs.closeSync(rfd); } catch {}
              try {
                let currentBody = null;
                try { currentBody = fs.readFileSync(lockPath, "utf8"); } catch {}
                if (currentBody === staleBody) {
                  try { fs.unlinkSync(lockPath); } catch {}
                }
              } finally {
                try { fs.unlinkSync(reapPath); } catch {}
              }
              continue;
            }
          }
        }
      } catch {}
      Atomics.wait(waitArr, 0, 0, 5 + Math.floor(Math.random() * 10));
    }
  }

  if (!acquired) {
    throw new Error("Timed out acquiring projects_registry.json lock.");
  }

  try {
    return fn();
  } finally {
    try {
      if (fs.readFileSync(lockPath, "utf8") === lockToken) {
        fs.unlinkSync(lockPath);
      }
    } catch {}
  }
}

function updateRegistry(mutator) {
  return withRegistryLock(() => {
    const reg = loadRegistry();
    const res = mutator(reg);
    if (res !== false) {
      saveRegistry(isPlainObject(res) && Array.isArray(res.projects) ? res : reg);
    }
    return loadRegistry();
  });
}

function syncConversationBinding(conversationId, bindingEntry) {
  const cid = String(conversationId || "").trim();
  if (!cid || !bindingEntry || !bindingEntry.workspacePath) return null;
  let result = null;
  updateRegistry((reg) => {
    result = {
      workspacePath: path.resolve(bindingEntry.workspacePath),
      role: bindingEntry.role === "coordinator" ? "coordinator" : "worker",
      threadId: bindingEntry.threadId || null,
      projectId: bindingEntry.projectId || null
    };
    reg.boundConversations[cid] = result;
  });
  return result;
}

function removeConversationBinding(conversationId) {
  const cid = String(conversationId || "").trim();
  if (!cid) return false;
  let removed = false;
  updateRegistry((reg) => {
    if (!Object.prototype.hasOwnProperty.call(reg.boundConversations, cid)) {
      return false;
    }
    delete reg.boundConversations[cid];
    removed = true;
  });
  return removed;
}

function selectProject({ projectId = null, workspacePath = null, bindCoordinatorConversationId = null } = {}) {
  let target = null;
  updateRegistry((reg) => {
    target = reg.projects.find(
      (p) =>
        (projectId && p.projectId === projectId) ||
        (workspacePath && path.resolve(p.workspacePath) === path.resolve(workspacePath))
    );
    if (!target) {
      throw new Error("Matching project not found in registry.");
    }
    reg.activeProjectId = target.projectId;
  });
  const bindId = bindCoordinatorConversationId ? String(bindCoordinatorConversationId).trim() : null;
  if (bindId) {
    const cfg = loadProjectConfig(target.workspacePath);
    if (cfg) {
      cfg.coordinatorConversationId = bindId;
      saveProjectConfig(target.workspacePath, cfg);
    }
  }
  return {
    selected: loadProjectConfig(target.workspacePath),
    workspacePath: target.workspacePath,
    coordinatorBound: Boolean(bindId)
  };
}

function listProjects({ includeArchived = false } = {}) {
  const reg = loadRegistry();
  const filtered = includeArchived
    ? reg.projects
    : reg.projects.filter((p) => p.status !== "archived");

  const enriched = filtered.map((p) => {
    let activeThreadCount = 0;
    let openPrCount = 0;
    if (p.workspacePath && hasProjectInitialized(p.workspacePath)) {
      try {
        const sql = openProjectDb(p.workspacePath);
        activeThreadCount = Number(
          sql.prepare("SELECT COUNT(*) AS cnt FROM threads WHERE ui_bucket != 'resolved'").get()?.cnt || 0
        );
        openPrCount = Number(
          sql
            .prepare(
              "SELECT COUNT(*) AS cnt FROM pull_requests pr LEFT JOIN threads t ON t.thread_id = pr.thread_id WHERE COALESCE(pr.state, 'OPEN') NOT IN ('MERGED', 'CLOSED') AND COALESCE(t.ui_bucket, '') != 'resolved'"
            )
            .get()?.cnt || 0
        );
      } catch {}
    }
    return {
      ...p,
      activeThreadCount,
      openPrCount,
      isActive: p.projectId === reg.activeProjectId
    };
  });

  const sorted = [...enriched].sort(
    (a, b) =>
      Number(Boolean(b.starred)) - Number(Boolean(a.starred)) ||
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
  );

  return { activeProjectId: reg.activeProjectId, projects: sorted };
}

function getAccountMemoryPath() {
  const p = path.join(getSharedDataDir(), "account_memory", "ACCOUNT_MEMORY.md");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) {
    writeTextAtomic(
      p,
      "# Account Memory (Cross-Project Preferences)\n\n- Store personal coding preferences and workflow habits shared across projects when `useAccountMemory` is enabled.\n"
    );
  }
  return p;
}

// ---------- Project Config & Validation ----------

function defaultProjectConfig({ projectId, name, goal = "", instructions = "", coordinatorConversationId = null }) {
  return {
    projectId: projectId || crypto.randomUUID(),
    name: name || "Untitled Project",
    goal,
    status: "active",
    starred: false,
    instructions,
    coordinatorConversationId,
    memory: {
      useAccountMemory: false,
      maxIndexLines: DEFAULT_MAX_MEMORY_LINES,
      maxIndexChars: DEFAULT_MAX_MEMORY_CHARS,
      autoPinLibraryTokenThreshold: DEFAULT_PIN_TOKEN_THRESHOLD,
      embeddingProvider: "local_onnx",
      localEmbeddingModel: "BAAI/bge-small-en-v1.5",
      cloudEmbeddingModel: "gemini-embedding-2",
      cloudPaidTierConfirmed: false,
      contextualHeaderMode: "structural_offline"
    },
    models: {
      coordinatorModel: "inherit",
      defaultThreadModel: "inherit",
      roleOverrides: {}
    },
    orchestration: {
      maxConcurrentThreads: 5,
      maxNewThreadsPerDay: 200,
      idleAutoResolveDays: 7,
      requireApprovalBeforeSpawn: true,
      defaultWorkspaceMode: "share"
    },
    environment: {
      sandboxMode: "inherit",
      networkPolicy: "inherit",
      setupCommand: null,
      envVars: {},
      secretRefs: []
    },
    sharing: {
      visibility: "private",
      members: [{ principal: os.userInfo().username || "owner", role: "owner" }]
    },
    updatedAt: nowIso()
  };
}

function validateInstructions(instructions) {
  const str = String(instructions ?? "");
  if (str.length > MAX_INSTRUCTIONS_CHARS) {
    throw new Error(
      `Project instructions exceed ${MAX_INSTRUCTIONS_CHARS} character limit (received ${str.length} characters). Keep standing instructions concise and move detailed reference material to Project Memory or Library.`
    );
  }
  return str;
}

function loadProjectConfig(workspacePath) {
  const cfgPath = path.join(getProjectDir(workspacePath), "config.json");
  const raw = readJsonSafe(cfgPath, null);
  if (!raw) return null;
  const base = defaultProjectConfig({
    projectId: raw.projectId,
    name: raw.name,
    goal: raw.goal,
    instructions: raw.instructions,
    coordinatorConversationId: raw.coordinatorConversationId
  });
  const sharing = { ...base.sharing, ...(raw.sharing || {}) };
  if (sharing.visibility === "team" || sharing.visibility === "public") {
    sharing.visibility = "organization";
  }
  return {
    ...base,
    ...raw,
    memory: { ...base.memory, ...(raw.memory || {}) },
    models: { ...base.models, ...(raw.models || {}), roleOverrides: { ...(raw.models?.roleOverrides || {}) } },
    orchestration: { ...base.orchestration, ...(raw.orchestration || {}) },
    environment: { ...base.environment, ...(raw.environment || {}) },
    sharing
  };
}

function saveProjectConfig(workspacePath, cfg) {
  validateInstructions(cfg.instructions);
  cfg.updatedAt = nowIso();
  const cfgPath = path.join(getProjectDir(workspacePath), "config.json");
  writeJsonAtomic(cfgPath, cfg, 0o600);

  // Sync summary entry in global registry under lock
  const absWs = path.resolve(workspacePath);
  const nextCoordId = cfg.coordinatorConversationId ? String(cfg.coordinatorConversationId).trim() : null;
  updateRegistry((reg) => {
    const idx = reg.projects.findIndex((p) => p.projectId === cfg.projectId || path.resolve(p.workspacePath) === absWs);
    const prevCoordId = idx >= 0 ? reg.projects[idx]?.coordinatorConversationId : null;
    if (prevCoordId && prevCoordId !== nextCoordId) {
      delete reg.boundConversations[prevCoordId];
    }
    if (nextCoordId) {
      reg.boundConversations[nextCoordId] = {
        workspacePath: absWs,
        role: "coordinator",
        threadId: null,
        projectId: cfg.projectId || null
      };
    }
    const entry = {
      projectId: cfg.projectId,
      name: cfg.name,
      workspacePath: absWs,
      status: cfg.status,
      starred: Boolean(cfg.starred),
      goal: cfg.goal || "",
      coordinatorConversationId: nextCoordId,
      updatedAt: cfg.updatedAt
    };
    if (idx >= 0) reg.projects[idx] = entry;
    else reg.projects.push(entry);
    if (!reg.activeProjectId) reg.activeProjectId = cfg.projectId;
  });
  return cfg;
}

const VALID_ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseFiniteNumber(val, fieldName) {
  if (typeof val === "number") {
    if (!Number.isFinite(val)) {
      throw new Error(`${fieldName} must be a finite number.`);
    }
    return val;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) {
      throw new Error(`${fieldName} must be a finite number.`);
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      throw new Error(`${fieldName} must be a finite number.`);
    }
    return n;
  }
  throw new Error(`${fieldName} must be a finite number.`);
}

function updateProjectSettings(workspacePath, patch = {}) {
  const cfg = loadProjectConfig(workspacePath);
  if (!cfg) throw new Error("Project config not found.");
  const p = isPlainObject(patch) ? patch : {};
  const hasOwn = (obj, k) => isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, k);

  if (p.name !== undefined) {
    const nextName = String(p.name || "").trim();
    if (!nextName) throw new Error("Project name must be a non-empty string.");
    cfg.name = nextName;
  }
  if (p.goal !== undefined) {
    cfg.goal = String(p.goal ?? "");
  }
  if (p.instructions !== undefined) {
    cfg.instructions = validateInstructions(p.instructions);
  }

  // 1. Memory & RAG settings (apply cloudPaidTierConfirmed BEFORE checking cloud features)
  if (p.memory !== undefined && !isPlainObject(p.memory)) {
    throw new Error("memory must be an object.");
  }
  const memPatch = isPlainObject(p.memory) ? p.memory : {};
  const pickMem = (k) => (hasOwn(p, k) ? p[k] : (hasOwn(memPatch, k) ? memPatch[k] : undefined));

  const prevPinThreshold = cfg.memory.autoPinLibraryTokenThreshold;
  const prevActiveModel = getActiveEmbeddingModelName(cfg);
  const prevHeaderMode = cfg.memory.contextualHeaderMode;

  const nextPaidTier = pickMem("cloudPaidTierConfirmed");
  if (nextPaidTier !== undefined) {
    if (typeof nextPaidTier !== "boolean") {
      throw new Error("cloudPaidTierConfirmed must be a boolean.");
    }
    cfg.memory.cloudPaidTierConfirmed = nextPaidTier;
  }

  const nextUseAcct = pickMem("useAccountMemory");
  if (nextUseAcct !== undefined) {
    if (typeof nextUseAcct !== "boolean") {
      throw new Error("useAccountMemory must be a boolean.");
    }
    cfg.memory.useAccountMemory = nextUseAcct;
  }

  const nextMaxLines = pickMem("maxIndexLines");
  if (nextMaxLines !== undefined) {
    const n = parseFiniteNumber(nextMaxLines, "maxIndexLines");
    cfg.memory.maxIndexLines = Math.max(20, Math.min(200, Math.floor(n)));
  }

  const nextMaxChars = pickMem("maxIndexChars");
  if (nextMaxChars !== undefined) {
    const n = parseFiniteNumber(nextMaxChars, "maxIndexChars");
    cfg.memory.maxIndexChars = Math.max(1000, Math.min(16000, Math.floor(n)));
  }

  const nextPinThr = pickMem("autoPinLibraryTokenThreshold");
  if (nextPinThr !== undefined) {
    const n = parseFiniteNumber(nextPinThr, "autoPinLibraryTokenThreshold");
    cfg.memory.autoPinLibraryTokenThreshold = Math.max(500, Math.min(200000, Math.floor(n)));
  }

  const nextEmbProvider = pickMem("embeddingProvider");
  if (nextEmbProvider !== undefined) {
    if (!["local_onnx", "gemini_cloud"].includes(nextEmbProvider)) {
      throw new Error(`Invalid embeddingProvider '${nextEmbProvider}'. Must be 'local_onnx' or 'gemini_cloud'.`);
    }
    if (nextEmbProvider === "gemini_cloud" && !cfg.memory.cloudPaidTierConfirmed) {
      throw new Error(
        "Cloud Gemini Embeddings require confirming Paid-Tier API usage (cloudPaidTierConfirmed: true) to protect private code/docs from Free-Tier data logging."
      );
    }
    cfg.memory.embeddingProvider = nextEmbProvider;
  }

  const nextCloudModel = pickMem("cloudEmbeddingModel");
  if (nextCloudModel !== undefined) {
    if (!["gemini-embedding-2", "gemini-embedding-001"].includes(nextCloudModel)) {
      throw new Error(`Invalid cloudEmbeddingModel '${nextCloudModel}'. Must be 'gemini-embedding-2' or 'gemini-embedding-001'.`);
    }
    cfg.memory.cloudEmbeddingModel = nextCloudModel;
  }

  const nextHeaderMode = pickMem("contextualHeaderMode");
  if (nextHeaderMode !== undefined) {
    if (!["structural_offline", "gemini_flash_lite"].includes(nextHeaderMode)) {
      throw new Error(`Invalid contextualHeaderMode: ${nextHeaderMode}`);
    }
    if (nextHeaderMode === "gemini_flash_lite" && !cfg.memory.cloudPaidTierConfirmed) {
      throw new Error(
        "gemini_flash_lite header mode requires confirming Paid-Tier API usage (cloudPaidTierConfirmed: true)."
      );
    }
    cfg.memory.contextualHeaderMode = nextHeaderMode;
  }

  if (cfg.memory.embeddingProvider === "gemini_cloud" && !cfg.memory.cloudPaidTierConfirmed) {
    throw new Error(
      "Cloud Gemini Embeddings require confirming Paid-Tier API usage (cloudPaidTierConfirmed: true) to protect private code/docs from Free-Tier data logging."
    );
  }
  if (cfg.memory.contextualHeaderMode === "gemini_flash_lite" && !cfg.memory.cloudPaidTierConfirmed) {
    throw new Error(
      "gemini_flash_lite header mode requires confirming Paid-Tier API usage (cloudPaidTierConfirmed: true)."
    );
  }

  const pinThresholdChanged = cfg.memory.autoPinLibraryTokenThreshold !== prevPinThreshold;
  const embeddingSpecChanged = getActiveEmbeddingModelName(cfg) !== prevActiveModel;
  const headerModeChanged = cfg.memory.contextualHeaderMode !== prevHeaderMode;

  // 2. Models
  if (p.models !== undefined && !isPlainObject(p.models)) {
    throw new Error("models must be an object.");
  }
  const modelsPatch = isPlainObject(p.models) ? p.models : {};
  const pickModel = (k) => (hasOwn(p, k) ? p[k] : (hasOwn(modelsPatch, k) ? modelsPatch[k] : undefined));

  const nextCoordModel = pickModel("coordinatorModel");
  if (nextCoordModel !== undefined) {
    if (typeof nextCoordModel !== "string" || !nextCoordModel.trim()) {
      throw new Error("coordinatorModel must be a non-empty string.");
    }
    cfg.models.coordinatorModel = nextCoordModel.trim();
  }

  const nextDefModel = pickModel("defaultThreadModel");
  if (nextDefModel !== undefined) {
    if (typeof nextDefModel !== "string" || !nextDefModel.trim()) {
      throw new Error("defaultThreadModel must be a non-empty string.");
    }
    cfg.models.defaultThreadModel = nextDefModel.trim();
  }

  const nextRoleOverrides = pickModel("roleOverrides");
  if (nextRoleOverrides !== undefined) {
    if (!isPlainObject(nextRoleOverrides)) {
      throw new Error("models.roleOverrides must be an object.");
    }
    const mergedOverrides = { ...(cfg.models.roleOverrides || {}) };
    for (const [rawRole, rawModel] of Object.entries(nextRoleOverrides)) {
      const normRole = normalizeRole(rawRole);
      if (typeof rawModel !== "string" || !rawModel.trim()) {
        throw new Error(`models.roleOverrides['${rawRole}'] must be a non-empty string.`);
      }
      mergedOverrides[normRole] = rawModel.trim();
      if (rawRole === "pr_fixer" && Object.prototype.hasOwnProperty.call(mergedOverrides, "pr_fixer")) {
        delete mergedOverrides.pr_fixer;
      }
    }
    cfg.models.roleOverrides = mergedOverrides;
  }

  // 3. Orchestration
  if (p.orchestration !== undefined && !isPlainObject(p.orchestration)) {
    throw new Error("orchestration must be an object.");
  }
  const orchPatch = isPlainObject(p.orchestration) ? p.orchestration : {};
  const pickOrch = (k) => (hasOwn(p, k) ? p[k] : (hasOwn(orchPatch, k) ? orchPatch[k] : undefined));

  const nextMaxConc = pickOrch("maxConcurrentThreads");
  if (nextMaxConc !== undefined) {
    const n = parseFiniteNumber(nextMaxConc, "maxConcurrentThreads");
    cfg.orchestration.maxConcurrentThreads = Math.max(1, Math.min(25, Math.floor(n)));
  }

  const nextMaxDay = pickOrch("maxNewThreadsPerDay");
  if (nextMaxDay !== undefined) {
    const n = parseFiniteNumber(nextMaxDay, "maxNewThreadsPerDay");
    cfg.orchestration.maxNewThreadsPerDay = Math.max(1, Math.min(2000, Math.floor(n)));
  }

  const nextIdleDays = pickOrch("idleAutoResolveDays");
  if (nextIdleDays !== undefined) {
    const n = parseFiniteNumber(nextIdleDays, "idleAutoResolveDays");
    cfg.orchestration.idleAutoResolveDays = Math.max(1, Math.min(365, Math.floor(n)));
  }

  const nextReqApproval = pickOrch("requireApprovalBeforeSpawn");
  if (nextReqApproval !== undefined) {
    if (typeof nextReqApproval !== "boolean") {
      throw new Error("requireApprovalBeforeSpawn must be a boolean.");
    }
    cfg.orchestration.requireApprovalBeforeSpawn = nextReqApproval;
  }

  const nextWsMode = pickOrch("defaultWorkspaceMode");
  if (nextWsMode !== undefined) {
    if (!["share", "branch", "inherit"].includes(nextWsMode)) {
      throw new Error(`Invalid defaultWorkspaceMode '${nextWsMode}'. Must be 'share', 'branch', or 'inherit'.`);
    }
    cfg.orchestration.defaultWorkspaceMode = nextWsMode;
  }

  // 4. Environment
  if (p.environment !== undefined) {
    if (!isPlainObject(p.environment)) {
      throw new Error("environment must be an object.");
    }
    const envPatch = p.environment;
    if (envPatch.sandboxMode !== undefined) {
      if (!["inherit", "enabled", "disabled"].includes(envPatch.sandboxMode)) {
        throw new Error(`Invalid environment.sandboxMode '${envPatch.sandboxMode}'.`);
      }
      cfg.environment.sandboxMode = envPatch.sandboxMode;
    }
    if (envPatch.networkPolicy !== undefined) {
      if (!["inherit", "allow", "ask", "deny"].includes(envPatch.networkPolicy)) {
        throw new Error(`Invalid environment.networkPolicy '${envPatch.networkPolicy}'.`);
      }
      cfg.environment.networkPolicy = envPatch.networkPolicy;
    }
    if (envPatch.setupCommand !== undefined) {
      if (envPatch.setupCommand === null) {
        cfg.environment.setupCommand = null;
      } else if (typeof envPatch.setupCommand === "string") {
        const trimmedCmd = envPatch.setupCommand.trim();
        if (trimmedCmd.length > 1000) {
          throw new Error("environment.setupCommand exceeds 1000 character limit.");
        }
        cfg.environment.setupCommand = trimmedCmd || null;
      } else {
        throw new Error("environment.setupCommand must be null or a string.");
      }
    }
    if (envPatch.envVars !== undefined) {
      if (!isPlainObject(envPatch.envVars)) {
        throw new Error("environment.envVars must be a plain object.");
      }
      const nextVars = {};
      for (const [k, v] of Object.entries(envPatch.envVars)) {
        if (!VALID_ENV_VAR_NAME_RE.test(k)) {
          throw new Error(`Invalid environment variable name '${k}'.`);
        }
        nextVars[k] = String(v ?? "");
      }
      cfg.environment.envVars = nextVars;
    }
    if (envPatch.secretRefs !== undefined) {
      if (!Array.isArray(envPatch.secretRefs)) {
        throw new Error("environment.secretRefs must be an array.");
      }
      const nextRefs = [];
      for (const rawRef of envPatch.secretRefs) {
        const refName = String(rawRef || "").trim();
        if (!VALID_ENV_VAR_NAME_RE.test(refName)) {
          throw new Error(`Invalid secret reference name '${rawRef}'.`);
        }
        nextRefs.push(refName);
      }
      cfg.environment.secretRefs = nextRefs;
    }
  }

  // 5. Sharing
  if (p.sharing !== undefined) {
    if (!isPlainObject(p.sharing)) {
      throw new Error("sharing must be an object.");
    }
    const sharePatch = p.sharing;
    if (sharePatch.visibility !== undefined) {
      if (!["private", "organization"].includes(sharePatch.visibility)) {
        throw new Error(`Invalid sharing.visibility '${sharePatch.visibility}'. Must be 'private' or 'organization'.`);
      }
      cfg.sharing.visibility = sharePatch.visibility;
    }
    if (sharePatch.members !== undefined) {
      if (!Array.isArray(sharePatch.members)) {
        throw new Error("sharing.members must be an array.");
      }
      const nextMembers = [];
      for (const m of sharePatch.members) {
        if (!isPlainObject(m)) throw new Error("Each sharing member must be an object.");
        const principal = String(m.principal || "").trim();
        if (!principal) throw new Error("Sharing member principal must be a non-empty string.");
        if (!["owner", "editor", "viewer"].includes(m.role)) {
          throw new Error(`Invalid sharing member role '${m.role}'. Must be 'owner', 'editor', or 'viewer'.`);
        }
        nextMembers.push({ principal, role: m.role });
      }
      if (!nextMembers.some((m) => m.role === "owner")) {
        throw new Error("sharing.members must retain at least one 'owner'.");
      }
      cfg.sharing.members = nextMembers;
    }
  }

  saveProjectConfig(workspacePath, cfg);
  if (pinThresholdChanged || embeddingSpecChanged) {
    rebalanceLibraryIndexing(workspacePath, { syncEmbeddings: false, forceRechunk: embeddingSpecChanged });
  }
  if (embeddingSpecChanged || headerModeChanged) {
    triggerPythonRagEmbed(workspacePath, { asyncMode: true });
  }
  return { config: cfg, pinThresholdChanged, embeddingSpecChanged, headerModeChanged };
}

// ---------- SQLite WAL Connection & Schema ----------

const dbCache = new Map();

function openProjectDb(workspacePath) {
  const absWs = path.resolve(workspacePath);
  const dbPath = path.join(getProjectDir(absWs), "state", "project_index.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let db = dbCache.get(dbPath);
  if (db) {
    try {
      db.prepare("SELECT 1").get();
      return db;
    } catch {
      dbCache.delete(dbPath);
    }
  }
  db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS repositories (
      repo_id               TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      local_path            TEXT NOT NULL,
      remote_url            TEXT,
      default_branch        TEXT NOT NULL DEFAULT 'main',
      claude_md_etag        TEXT,
      added_at              TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      thread_id             TEXT PRIMARY KEY,
      title                 TEXT NOT NULL,
      description           TEXT NOT NULL,
      role                  TEXT NOT NULL,
      ui_bucket             TEXT NOT NULL CHECK (ui_bucket IN (
                              'suggested', 'working', 'waiting_on_you',
                              'ready_for_review', 'landing', 'idle', 'paused', 'resolved'
                            )),
      server_status         TEXT NOT NULL CHECK (server_status IN (
                              'pending', 'working', 'needs_input', 'idle', 'resolved', 'failed', 'archived'
                            )),
      conversation_id       TEXT UNIQUE,
      model                 TEXT NOT NULL DEFAULT 'inherit',
      workspace_mode        TEXT NOT NULL DEFAULT 'share',
      repo_id               TEXT REFERENCES repositories(repo_id),
      branch_name           TEXT,
      worktree_path         TEXT,
      worktrees_json        TEXT NOT NULL DEFAULT '{}',
      owned_globs_json      TEXT NOT NULL DEFAULT '[]',
      blocking_question     TEXT,
      blocking_is_error     INTEGER NOT NULL DEFAULT 0,
      pr_number             INTEGER,
      pr_url                TEXT,
      watching_autofix      INTEGER NOT NULL DEFAULT 0,
      last_summary          TEXT,
      pre_pause_bucket      TEXT,
      live_telemetry_json   TEXT NOT NULL DEFAULT '[]',
      token_usage_est       INTEGER NOT NULL DEFAULT 0,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      working_since         TEXT,
      resolved_at           TEXT
    );

    CREATE TABLE IF NOT EXISTS pull_requests (
      pr_id                 TEXT PRIMARY KEY,
      repo_id               TEXT NOT NULL REFERENCES repositories(repo_id),
      thread_id             TEXT NOT NULL REFERENCES threads(thread_id),
      pr_number             INTEGER NOT NULL,
      url                   TEXT NOT NULL,
      title                 TEXT NOT NULL,
      head_branch           TEXT NOT NULL,
      base_branch           TEXT NOT NULL,
      state                 TEXT NOT NULL DEFAULT 'OPEN',
      ci_status             TEXT NOT NULL DEFAULT 'pending',
      review_decision       TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED',
      merge_order_rank      INTEGER,
      autofix_enabled       INTEGER NOT NULL DEFAULT 1,
      autofix_attempts      INTEGER NOT NULL DEFAULT 0,
      last_seen_event_hash  TEXT,
      additions             INTEGER NOT NULL DEFAULT 0,
      deletions             INTEGER NOT NULL DEFAULT 0,
      changed_files         INTEGER NOT NULL DEFAULT 0,
      updated_at            TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS library_items (
      item_id               TEXT PRIMARY KEY,
      category              TEXT NOT NULL CHECK (category IN ('input', 'output')),
      source_type           TEXT NOT NULL,
      producer_thread_id    TEXT REFERENCES threads(thread_id),
      title                 TEXT NOT NULL,
      rel_path              TEXT NOT NULL UNIQUE,
      mime_type             TEXT NOT NULL,
      byte_size             INTEGER NOT NULL,
      page_count            INTEGER,
      pdf_mode              TEXT,
      token_count           INTEGER NOT NULL,
      sha256                TEXT NOT NULL,
      index_status          TEXT NOT NULL DEFAULT 'pending',
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS library_chunks (
      chunk_id              TEXT PRIMARY KEY,
      item_id               TEXT NOT NULL REFERENCES library_items(item_id) ON DELETE CASCADE,
      chunk_index           INTEGER NOT NULL,
      start_line            INTEGER,
      end_line              INTEGER,
      raw_text              TEXT NOT NULL,
      context_prefix        TEXT NOT NULL,
      contextualized_text   TEXT NOT NULL,
      header_mode           TEXT NOT NULL DEFAULT 'structural_offline',
      embedding_model       TEXT NOT NULL,
      embedding_dim         INTEGER NOT NULL DEFAULT 0,
      embedding_f32         BLOB
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS library_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      item_id UNINDEXED,
      contextualized_text,
      tokenize = 'porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS scheduled_routines (
      routine_id            TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      cron_expr             TEXT NOT NULL,
      prompt                TEXT NOT NULL,
      target_role           TEXT NOT NULL DEFAULT 'explorer',
      workspace_mode        TEXT NOT NULL DEFAULT 'share',
      enabled               INTEGER NOT NULL DEFAULT 1,
      last_run_at           TEXT,
      next_run_at           TEXT,
      last_thread_id        TEXT REFERENCES threads(thread_id),
      last_error            TEXT,
      last_error_at         TEXT,
      consecutive_failures  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS activity_snapshots (
      snapshot_id           TEXT PRIMARY KEY,
      conversation_id       TEXT NOT NULL,
      created_by            TEXT NOT NULL,
      title                 TEXT NOT NULL,
      max_step_index        INTEGER NOT NULL,
      snapshot_path         TEXT NOT NULL,
      published_to_feed     INTEGER NOT NULL DEFAULT 0,
      revoked               INTEGER NOT NULL DEFAULT 0,
      created_at            TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_hook_state (
      conversation_id       TEXT PRIMARY KEY,
      last_memory_hash      TEXT,
      last_config_hash      TEXT,
      compaction_warned     INTEGER NOT NULL DEFAULT 0,
      updated_at            TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS completed_coordinators (
      conversation_id       TEXT PRIMARY KEY,
      archived_at           TEXT NOT NULL,
      summary               TEXT
    );
  `);
  // Idempotent schema migrations for existing project databases (SQLITE_DQS=0 safe)
  const ensureColumnExists = (existingCols, tableName, colName, colDefSql) => {
    if (existingCols.has(colName)) return;
    try {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colDefSql}`);
    } catch (err) {
      if (!/duplicate column name/i.test(String(err?.message || err))) {
        throw err;
      }
    }
    existingCols.add(colName);
  };

  const threadCols = new Set(db.prepare("PRAGMA table_info(threads)").all().map((r) => r.name));
  ensureColumnExists(threadCols, "threads", "pre_pause_bucket", "TEXT");
  ensureColumnExists(threadCols, "threads", "worktrees_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumnExists(threadCols, "threads", "blocking_is_error", "INTEGER NOT NULL DEFAULT 0");
  ensureColumnExists(threadCols, "threads", "working_since", "TEXT");

  const prCols = new Set(db.prepare("PRAGMA table_info(pull_requests)").all().map((r) => r.name));
  ensureColumnExists(prCols, "pull_requests", "state", "TEXT NOT NULL DEFAULT 'OPEN'");
  ensureColumnExists(prCols, "pull_requests", "additions", "INTEGER NOT NULL DEFAULT 0");
  ensureColumnExists(prCols, "pull_requests", "deletions", "INTEGER NOT NULL DEFAULT 0");
  ensureColumnExists(prCols, "pull_requests", "changed_files", "INTEGER NOT NULL DEFAULT 0");

  const chunkCols = new Set(db.prepare("PRAGMA table_info(library_chunks)").all().map((r) => r.name));
  ensureColumnExists(chunkCols, "library_chunks", "header_mode", "TEXT NOT NULL DEFAULT 'structural_offline'");

  const routineCols = new Set(db.prepare("PRAGMA table_info(scheduled_routines)").all().map((r) => r.name));
  ensureColumnExists(routineCols, "scheduled_routines", "last_error", "TEXT");
  ensureColumnExists(routineCols, "scheduled_routines", "last_error_at", "TEXT");
  ensureColumnExists(routineCols, "scheduled_routines", "consecutive_failures", "INTEGER NOT NULL DEFAULT 0");

  const hookCols = new Set(db.prepare("PRAGMA table_info(session_hook_state)").all().map((r) => r.name));
  ensureColumnExists(hookCols, "session_hook_state", "last_config_hash", "TEXT");
  dbCache.set(dbPath, db);
  return db;
}

// ---------- Session Lookup (Fast Hook Resolution) ----------

function resolveSessionBinding(conversationId, workspacePaths = []) {
  const unbound = { bound: false, role: null, workspacePath: null, projectId: null, thread: null };
  const cid = String(conversationId || "").trim();
  if (!cid) return unbound;

  const reg = loadRegistry();

  // Step A: O(1) fast path via boundConversations index
  if (Object.prototype.hasOwnProperty.call(reg.boundConversations, cid)) {
    const entry = reg.boundConversations[cid];
    if (entry && entry.workspacePath && hasProjectInitialized(entry.workspacePath)) {
      const absWs = path.resolve(entry.workspacePath);
      if (entry.role === "coordinator") {
        const cfg = loadProjectConfig(absWs);
        if (cfg && cfg.coordinatorConversationId === cid) {
          return {
            bound: true,
            role: "coordinator",
            workspacePath: absWs,
            projectId: cfg.projectId || entry.projectId || null,
            thread: null
          };
        }
        removeConversationBinding(cid);
      } else if (entry.role === "worker") {
        const db = openProjectDb(absWs);
        const thread = db.prepare("SELECT * FROM threads WHERE conversation_id = ?").get(cid);
        if (thread) {
          const cfg = loadProjectConfig(absWs);
          return {
            bound: true,
            role: "worker",
            workspacePath: absWs,
            projectId: cfg?.projectId || entry.projectId || null,
            thread
          };
        }
        removeConversationBinding(cid);
      } else {
        removeConversationBinding(cid);
      }
    } else {
      removeConversationBinding(cid);
    }
  }

  // Step B: Direct match on Coordinator conversationId in registry projects[]
  const coordProj = reg.projects.find((p) => p && p.coordinatorConversationId === cid);
  if (coordProj && hasProjectInitialized(coordProj.workspacePath)) {
    const absWs = path.resolve(coordProj.workspacePath);
    syncConversationBinding(cid, {
      workspacePath: absWs,
      role: "coordinator",
      threadId: null,
      projectId: coordProj.projectId || null
    });
    return {
      bound: true,
      role: "coordinator",
      workspacePath: absWs,
      projectId: coordProj.projectId || null,
      thread: null
    };
  }

  // Step C: Legacy registry migration scan (only when boundConversations was absent on disk)
  if (!hasRegistryBoundMapOnDisk()) {
    const migrated = withRegistryLock(() => {
      if (hasRegistryBoundMapOnDisk()) {
        return { alreadyMigrated: true, matchedBinding: null };
      }
      const nextReg = loadRegistry();
      const candidates = new Set();
      for (const wp of workspacePaths || []) {
        if (wp) candidates.add(path.resolve(wp));
      }
      for (const p of nextReg.projects) {
        if (p && p.workspacePath) candidates.add(path.resolve(p.workspacePath));
      }

      let matchedBinding = null;
      let scannedAnyInit = false;

      for (const ws of candidates) {
        if (!hasProjectInitialized(ws)) continue;
        scannedAnyInit = true;
        const cfg = loadProjectConfig(ws);
        if (cfg?.coordinatorConversationId) {
          nextReg.boundConversations[cfg.coordinatorConversationId] = {
            workspacePath: ws,
            role: "coordinator",
            threadId: null,
            projectId: cfg.projectId || null
          };
          if (cfg.coordinatorConversationId === cid && !matchedBinding) {
            matchedBinding = {
              bound: true,
              role: "coordinator",
              workspacePath: ws,
              projectId: cfg.projectId || null,
              thread: null
            };
          }
        }
        const db = openProjectDb(ws);
        const boundThreads = db
          .prepare("SELECT * FROM threads WHERE conversation_id IS NOT NULL AND conversation_id != ''")
          .all();
        for (const t of boundThreads) {
          nextReg.boundConversations[t.conversation_id] = {
            workspacePath: ws,
            role: "worker",
            threadId: t.thread_id,
            projectId: cfg?.projectId || null
          };
          if (t.conversation_id === cid && !matchedBinding) {
            matchedBinding = {
              bound: true,
              role: "worker",
              workspacePath: ws,
              projectId: cfg?.projectId || null,
              thread: t
            };
          }
        }
      }

      if (fs.existsSync(getRegistryPath()) || scannedAnyInit) {
        saveRegistry(nextReg);
      }

      return { alreadyMigrated: false, matchedBinding };
    });

    if (migrated.matchedBinding) return migrated.matchedBinding;
    if (migrated.alreadyMigrated) {
      return resolveSessionBinding(conversationId, workspacePaths);
    }
  }

  return unbound;
}

function resolveActiveWorkspace(explicitWorkspacePath, explicitProjectId) {
  if (explicitWorkspacePath && hasProjectInitialized(explicitWorkspacePath)) {
    return path.resolve(explicitWorkspacePath);
  }
  const reg = loadRegistry();
  if (explicitProjectId) {
    const found = reg.projects.find((p) => p.projectId === explicitProjectId);
    if (found && hasProjectInitialized(found.workspacePath)) return path.resolve(found.workspacePath);
  }
  if (reg.activeProjectId) {
    const active = reg.projects.find((p) => p.projectId === reg.activeProjectId);
    if (active && hasProjectInitialized(active.workspacePath)) return path.resolve(active.workspacePath);
  }
  const firstValid = reg.projects.find((p) => hasProjectInitialized(p.workspacePath));
  return firstValid ? path.resolve(firstValid.workspacePath) : (explicitWorkspacePath ? path.resolve(explicitWorkspacePath) : null);
}

// ---------- Memory Management (<=200 lines & <=16k chars hard guard) ----------

function getMemoryPaths(workspacePath) {
  const memDir = path.join(getProjectDir(workspacePath), "memory");
  const topicsDir = path.join(memDir, "topics");
  fs.mkdirSync(topicsDir, { recursive: true });
  return {
    memDir,
    indexPath: path.join(memDir, "MEMORY.md"),
    topicsDir
  };
}

function validateMemoryIndexBounds(content, cfg) {
  const maxLines = cfg?.memory?.maxIndexLines || DEFAULT_MAX_MEMORY_LINES;
  const maxChars = cfg?.memory?.maxIndexChars || DEFAULT_MAX_MEMORY_CHARS;
  const str = String(content || "");
  const lineCount = str === "" ? 0 : str.split(/\r?\n/).length;
  if (lineCount > maxLines) {
    throw new Error(`MEMORY.md exceeds ${maxLines}-line index limit (received ${lineCount} lines). Move detailed notes into memory/topics/*.md.`);
  }
  if (str.length > maxChars) {
    throw new Error(`MEMORY.md exceeds ${maxChars}-character limit (received ${str.length} chars). Keep MEMORY.md as a concise topic index.`);
  }
  return { lineCount, charCount: str.length };
}

function rebuildMemoryIndex(workspacePath, cfg) {
  const { indexPath, topicsDir } = getMemoryPaths(workspacePath);
  const maxLines = cfg?.memory?.maxIndexLines || DEFAULT_MAX_MEMORY_LINES;
  const maxChars = cfg?.memory?.maxIndexChars || DEFAULT_MAX_MEMORY_CHARS;

  const files = fs.existsSync(topicsDir)
    ? fs.readdirSync(topicsDir).filter((f) => f.endsWith(".md")).sort()
    : [];

  const headerLines = [
    `# Project Memory Index (${cfg?.name || "AGY Project"})`,
    "",
    `> Curated anchor index loaded at session startup (\`<=${maxLines}\` lines, \`<=${maxChars}\` chars). Read detailed files under \`.agy-project/memory/topics/\` on demand.`,
    ""
  ];

  const entryLines = [];
  for (const file of files) {
    const slug = file.replace(/\.md$/, "");
    const raw = fs.readFileSync(path.join(topicsDir, file), "utf8");
    const titleMatch = raw.match(/^#\s+(.+)$/m);
    const summaryMatch = raw.match(/^>\s*Summary:\s*(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : slug;
    const summary = summaryMatch
      ? summaryMatch[1].trim()
      : raw.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"))?.trim() || "Topic note";
    entryLines.push(`- **[${title}](topics/${file})**: ${summary.slice(0, 180)}`);
  }

  let combined = [...headerLines, ...(entryLines.length ? entryLines : ["_No topic memories recorded yet._"]), ""];
  let compacted = false;
  while (combined.length > maxLines || combined.join("\n").length > maxChars) {
    compacted = true;
    // Drop oldest middle bullet and add an overflow pointer
    if (entryLines.length <= 1) break;
    entryLines.shift();
    combined = [
      ...headerLines,
      `- _Older topic entries omitted to stay within ${maxLines}-line / ${maxChars}-char index cap (browse \`.agy-project/memory/topics/\`)._`,
      ...entryLines,
      ""
    ];
  }

  const finalText = combined.join("\n").slice(0, maxChars);
  writeTextAtomic(indexPath, finalText);
  return { content: finalText, compacted, topicCount: files.length, lines: finalText.split("\n").length, chars: finalText.length };
}

function upsertMemoryTopic(workspacePath, { topicSlug, title, markdownBody, indexSummaryLine, producerThreadId }) {
  const cfg = loadProjectConfig(workspacePath);
  const cleanSlug = String(topicSlug || "general")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "general";
  const { topicsDir } = getMemoryPaths(workspacePath);
  const summary = String(indexSummaryLine || title || cleanSlug).replace(/\r?\n/g, " ").trim();
  const provenance = producerThreadId ? `\n> Updated-By-Thread: ${producerThreadId} at ${nowIso()}` : `\n> Updated-At: ${nowIso()}`;
  const doc = `# ${title || cleanSlug}\n> Summary: ${summary}${provenance}\n\n${String(markdownBody || "").trim()}\n`;
  writeTextAtomic(path.join(topicsDir, `${cleanSlug}.md`), doc);
  return rebuildMemoryIndex(workspacePath, cfg);
}

function saveRawMemoryIndex(workspacePath, rawContent) {
  const cfg = loadProjectConfig(workspacePath);
  const stats = validateMemoryIndexBounds(rawContent, cfg);
  const { indexPath } = getMemoryPaths(workspacePath);
  writeTextAtomic(indexPath, rawContent);
  return stats;
}

function consolidateMemories(workspacePath) {
  const { topicsDir } = getMemoryPaths(workspacePath);
  const cfg = loadProjectConfig(workspacePath);
  const files = fs.existsSync(topicsDir)
    ? fs
        .readdirSync(topicsDir)
        .filter((f) => f.endsWith(".md"))
        .map((file) => {
          const fullPath = path.join(topicsDir, file);
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(fullPath).mtimeMs;
          } catch {}
          return { file, slug: file.replace(/\.md$/, ""), fullPath, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file))
    : [];

  const beforeCount = files.length;
  const seenBodyHashes = new Set();
  const seenTitles = new Set();
  const removedSlugs = [];

  for (const item of files) {
    const raw = fs.readFileSync(item.fullPath, "utf8");
    const titleMatch = raw.match(/^#\s+(.+)$/m);
    const summaryMatch = raw.match(/^>\s*Summary:\s*(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : item.slug;
    const summary = summaryMatch ? summaryMatch[1].trim() : "";
    const cleanBody = raw
      .replace(/^#\s+.*$/gm, "")
      .replace(/^>\s*Summary:.*$/gm, "")
      .replace(/^>\s*Updated-By-Thread:.*$/gm, "")
      .replace(/^>\s*Updated-At:.*$/gm, "")
      .trim();

    if (!cleanBody) {
      fs.unlinkSync(item.fullPath);
      removedSlugs.push(item.slug);
      continue;
    }

    const titleKey = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const bodyHash = sha256Hex(cleanBody.toLowerCase().replace(/\s+/g, " "));
    if (seenBodyHashes.has(bodyHash) || (titleKey && seenTitles.has(titleKey))) {
      fs.unlinkSync(item.fullPath);
      removedSlugs.push(item.slug);
      continue;
    }

    seenBodyHashes.add(bodyHash);
    if (titleKey) seenTitles.add(titleKey);
    // Preserve summary reference in case needed later
    void summary;
  }

  const indexStats = rebuildMemoryIndex(workspacePath, cfg);
  return {
    beforeCount,
    afterCount: beforeCount - removedSlugs.length,
    removedSlugs,
    ...indexStats
  };
}

// ---------- Project Initialization & Day-1 Onboarding ----------

function createProject({ name, workspacePath, goal = "", instructions = "", coordinatorConversationId = null, createDirIfMissing = true }) {
  validateInstructions(instructions);
  const absWs = path.resolve(workspacePath);
  if (!fs.existsSync(absWs)) {
    if (!createDirIfMissing) throw new Error(`Workspace directory does not exist: ${absWs}`);
    fs.mkdirSync(absWs, { recursive: true });
  }

  const pDir = getProjectDir(absWs);
  fs.mkdirSync(path.join(pDir, "library", "inputs"), { recursive: true });
  fs.mkdirSync(path.join(pDir, "library", "outputs"), { recursive: true });
  fs.mkdirSync(path.join(pDir, "worktrees"), { recursive: true });
  fs.mkdirSync(path.join(pDir, "state", "snapshots"), { recursive: true });

  const existing = loadProjectConfig(absWs);
  const cfg = existing
    ? {
        ...existing,
        name: name || existing.name,
        goal: goal || existing.goal,
        instructions: instructions || existing.instructions,
        coordinatorConversationId: coordinatorConversationId || existing.coordinatorConversationId,
        status: "active"
      }
    : defaultProjectConfig({ name, goal, instructions, coordinatorConversationId });

  saveProjectConfig(absWs, cfg);
  updateRegistry((reg) => {
    reg.activeProjectId = cfg.projectId;
  });

  const db = openProjectDb(absWs);
  const { indexPath } = getMemoryPaths(absWs);
  if (!fs.existsSync(indexPath)) {
    rebuildMemoryIndex(absWs, cfg);
  }

  // Auto-bind workspace if it is a git repository
  if (fs.existsSync(path.join(absWs, ".git"))) {
    bindRepository(absWs, { localPath: absWs, name: path.basename(absWs) });
  }

  // Seed Day-1 onboarding suggestions if no threads exist yet
  const countRow = db.prepare("SELECT COUNT(*) AS cnt FROM threads").get();
  if (!countRow || Number(countRow.cnt) === 0) {
    proposeThreads(absWs, [
      {
        title: "Map repository architecture & seed MEMORY.md",
        description: "Perform a read-only structural scan of directories, entrypoints, and local CLAUDE.md/GEMINI.md rules, then populate initial Project Memory topics.",
        role: "explorer"
      },
      {
        title: "Audit build, lint, typecheck & CI workflows",
        description: "Inspect package manifests, Makefiles, and GitHub Actions workflows to record exact verification commands in MEMORY.md.",
        role: "explorer"
      }
    ]);
  }

  return { config: cfg, workspacePath: absWs, projectDir: pDir };
}

// ---------- Repositories & Git Worktrees ----------

function computeRepoRulesEtag(repoDir) {
  const absRepo = path.resolve(String(repoDir || ""));
  if (!absRepo || !fs.existsSync(absRepo)) return null;
  const candidates = [
    path.join(absRepo, "CLAUDE.md"),
    path.join(absRepo, "GEMINI.md"),
    path.join(absRepo, "AGENTS.md")
  ];
  const claudeRulesDir = path.join(absRepo, ".claude", "rules");
  if (fs.existsSync(claudeRulesDir)) {
    try {
      const extraFiles = fs.readdirSync(claudeRulesDir).filter((f) => f.endsWith(".md")).sort();
      for (const f of extraFiles) {
        candidates.push(path.join(claudeRulesDir, f));
      }
    } catch {}
  }
  const hash = crypto.createHash("sha256");
  let count = 0;
  for (const rp of candidates) {
    try {
      if (!fs.existsSync(rp) || !fs.statSync(rp).isFile()) continue;
      const relPosixPath = path.relative(absRepo, rp).split(path.sep).join("/");
      const content = fs.readFileSync(rp, "utf8");
      hash.update(`${relPosixPath}\0${content}\0`);
      count++;
    } catch {}
  }
  if (count === 0) return null;
  return hash.digest("hex").slice(0, 16);
}

function bindRepository(workspacePath, { localPath, name, defaultBranch }) {
  const absRepo = path.resolve(localPath);
  if (!fs.existsSync(absRepo)) throw new Error(`Repository path not found: ${absRepo}`);
  const db = openProjectDb(workspacePath);
  let remoteUrl = null;
  let detectedBranch = defaultBranch || "main";
  try {
    remoteUrl = execFileSync("git", ["-C", absRepo, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {}
  if (!defaultBranch) {
    try {
      const sym = execFileSync("git", ["-C", absRepo, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (sym) detectedBranch = sym;
    } catch {}
  }

  const claudeMdEtag = computeRepoRulesEtag(absRepo);

  const existing = db.prepare("SELECT repo_id FROM repositories WHERE local_path = ?").get(absRepo);
  const repoId = existing ? existing.repo_id : `repo-${sha256Hex(absRepo).slice(0, 8)}`;
  const repoName = name || path.basename(absRepo);
  db.prepare(`
    INSERT INTO repositories (repo_id, name, local_path, remote_url, default_branch, claude_md_etag, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo_id) DO UPDATE SET
      name = excluded.name,
      remote_url = excluded.remote_url,
      default_branch = excluded.default_branch,
      claude_md_etag = excluded.claude_md_etag
  `).run(repoId, repoName, absRepo, remoteUrl, detectedBranch, claudeMdEtag, nowIso());

  return db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(repoId);
}

function listLinkedGitWorktrees(repoLocalPath) {
  if (!repoLocalPath || !fs.existsSync(repoLocalPath)) return [];
  try {
    const out = execFileSync("git", ["-C", repoLocalPath, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const paths = [];
    for (const line of String(out || "").split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        paths.push(resolveRealPathWithAncestor(line.slice("worktree ".length).trim()));
      }
    }
    // Index 0 in `git worktree list --porcelain` is always the main working tree
    return paths.slice(1);
  } catch {
    return [];
  }
}

function pruneGitWorktreesSafe(repoLocalPath) {
  if (!repoLocalPath || !fs.existsSync(repoLocalPath)) return;
  try {
    execFileSync("git", ["-C", repoLocalPath, "worktree", "prune"], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"]
    });
  } catch {}
}

function validateWorktreePath(workspacePath, rawWorktreePath, sql) {
  const str = String(rawWorktreePath || "").trim();
  if (!str) return null;
  const absWt = path.resolve(str);
  const realTarget = resolveRealPathWithAncestor(absWt);
  const realWs = resolveRealPathWithAncestor(workspacePath);
  const realWorktreesRoot = resolveRealPathWithAncestor(path.join(getProjectDir(workspacePath), "worktrees"));

  const repos = sql.prepare("SELECT * FROM repositories").all();
  const repoRealPaths = repos
    .map((r) => (r && r.local_path ? resolveRealPathWithAncestor(r.local_path) : null))
    .filter(Boolean);

  if (pathsEqual(realTarget, realWs) || isPathInsideDir(realWs, realTarget, { allowEqual: true })) {
    throw new Error(`Invalid worktreePath '${rawWorktreePath}': cannot point to workspace root or an ancestor.`);
  }
  for (const rp of repoRealPaths) {
    if (pathsEqual(realTarget, rp) || isPathInsideDir(rp, realTarget, { allowEqual: true })) {
      throw new Error(`Invalid worktreePath '${rawWorktreePath}': cannot point to repository root or an ancestor.`);
    }
  }

  let targetIsSymlinkOutside = false;
  try {
    if (fs.lstatSync(absWt).isSymbolicLink() && !isPathInsideDir(realTarget, realWorktreesRoot, { allowEqual: false })) {
      targetIsSymlinkOutside = true;
    }
  } catch {}

  const insideManaged = !targetIsSymlinkOutside && isPathInsideDir(realTarget, realWorktreesRoot, { allowEqual: false });
  if (insideManaged) {
    return absWt;
  }

  const isLinked = fs.existsSync(absWt) && repos.some((r) => {
    const linked = listLinkedGitWorktrees(r.local_path);
    return linked.some((wt) => pathsEqual(wt, realTarget));
  });
  if (isLinked) {
    return absWt;
  }

  throw new Error(
    `Invalid worktreePath '${rawWorktreePath}': must be strictly inside .agy-project/worktrees/ or an existing linked git worktree of a bound repository.`
  );
}

function unbindRepository(workspacePath, { repoId }) {
  const cleanId = String(repoId || "").trim();
  if (!cleanId) throw new Error("repoId is required.");
  const sql = openProjectDb(workspacePath);
  const repo = sql.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(cleanId);

  const allThreads = sql.prepare("SELECT thread_id, repo_id, worktrees_json FROM threads").all();
  for (const t of allThreads) {
    let hasRepoInJson = false;
    try {
      const parsed = JSON.parse(t.worktrees_json || "{}");
      if (isPlainObject(parsed) && Object.prototype.hasOwnProperty.call(parsed, cleanId)) {
        hasRepoInJson = true;
      }
    } catch {}
    if (t.repo_id === cleanId || hasRepoInJson) {
      try {
        manageWorktree(workspacePath, { action: "cleanup", threadId: t.thread_id, repoId: cleanId });
      } catch {}
    }
  }

  if (repo && repo.local_path) {
    pruneGitWorktreesSafe(repo.local_path);
  }

  sql.exec("BEGIN");
  try {
    sql.prepare("UPDATE threads SET repo_id = NULL WHERE repo_id = ?").run(cleanId);
    sql.prepare("DELETE FROM pull_requests WHERE repo_id = ?").run(cleanId);
    sql.prepare("DELETE FROM repositories WHERE repo_id = ?").run(cleanId);
    sql.exec("COMMIT");
  } catch (err) {
    try { sql.exec("ROLLBACK"); } catch {}
    throw err;
  }
  return { removed: cleanId };
}

function manageWorktree(workspacePath, { action, threadId, repoId, baseBranch, runSetup = true }) {
  const db = openProjectDb(workspacePath);
  const threadRow = db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadId);
  let worktreesMap = {};
  try {
    const parsed = JSON.parse(threadRow?.worktrees_json || "{}");
    if (isPlainObject(parsed)) worktreesMap = parsed;
  } catch {}

  const repo = repoId
    ? db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(repoId)
    : db.prepare("SELECT * FROM repositories ORDER BY added_at ASC LIMIT 1").get();

  const safeSlug = String(threadId).replace(/[^a-zA-Z0-9_-]/g, "-");
  const threadWtDir = path.join(getProjectDir(workspacePath), "worktrees", safeSlug);
  const branchName = `project/${safeSlug}`;

  if (action === "status") {
    if (!repo) throw new Error("No bound repository found. Bind a Git repository via bind_repository first.");
    const wtPath = worktreesMap[repo.repo_id]?.worktreePath || path.join(threadWtDir, repo.name);
    const exists = fs.existsSync(wtPath);
    return {
      exists,
      worktreePath: wtPath,
      branchName: worktreesMap[repo.repo_id]?.branchName || branchName,
      repoId: repo.repo_id,
      worktrees: worktreesMap
    };
  }

  if (action === "create") {
    if (!repo) throw new Error("No bound repository found. Bind a Git repository via bind_repository first.");
    const wtPath = path.join(threadWtDir, repo.name);
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    const newlyCreated = !fs.existsSync(wtPath);
    if (newlyCreated) {
      const base = baseBranch || repo.default_branch || "HEAD";
      execFileSync("git", ["-C", repo.local_path, "worktree", "add", "-B", branchName, wtPath, base], {
        encoding: "utf8"
      });
    }
    worktreesMap[repo.repo_id] = {
      worktreePath: wtPath,
      branchName,
      repoId: repo.repo_id,
      repoName: repo.name
    };
    db.prepare(
      "UPDATE threads SET worktree_path = ?, branch_name = ?, repo_id = ?, worktrees_json = ?, updated_at = ? WHERE thread_id = ?"
    ).run(wtPath, branchName, repo.repo_id, JSON.stringify(worktreesMap), nowIso(), threadId);

    let setupResult = null;
    if (newlyCreated && runSetup !== false) {
      const cfg = loadProjectConfig(workspacePath);
      const setupCmd = cfg?.environment?.setupCommand ? String(cfg.environment.setupCommand).trim() : "";
      if (setupCmd) {
        const res = spawnSync("/bin/sh", ["-c", setupCmd], {
          cwd: wtPath,
          env: {
            ...process.env,
            ...(cfg.environment.envVars && typeof cfg.environment.envVars === "object" ? cfg.environment.envVars : {})
          },
          encoding: "utf8",
          timeout: 30000
        });
        setupResult = {
          ran: true,
          exitCode: res.status ?? -1,
          stdout: String(res.stdout || "").slice(0, 1000),
          stderr: String(res.stderr || "").slice(0, 1000)
        };
      }
    }

    return { created: true, worktreePath: wtPath, branchName, repoId: repo.repo_id, worktrees: worktreesMap, setupResult };
  }

  if (action === "cleanup") {
    const cleanedPaths = [];
    const realWs = resolveRealPathWithAncestor(workspacePath);
    const realWorktreesRoot = resolveRealPathWithAncestor(path.join(getProjectDir(workspacePath), "worktrees"));
    const allRepoRows = db.prepare("SELECT * FROM repositories").all();
    const repoRealPaths = allRepoRows
      .map((r) => (r && r.local_path ? resolveRealPathWithAncestor(r.local_path) : null))
      .filter(Boolean);

    const removeWorktreePath = (targetPath, targetRepoId) => {
      if (!targetPath) return;
      const absTarget = path.resolve(String(targetPath));
      const realTarget = resolveRealPathWithAncestor(absTarget);
      const repoRow = targetRepoId
        ? db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(targetRepoId)
        : null;

      // Never remove the workspace, any repository local_path, or any ancestor of them
      const touchesProtectedRoot =
        pathsEqual(realTarget, realWs) ||
        isPathInsideDir(realWs, realTarget, { allowEqual: true }) ||
        repoRealPaths.some((rp) => pathsEqual(realTarget, rp) || isPathInsideDir(rp, realTarget, { allowEqual: true }));

      let targetExists = false;
      try {
        fs.lstatSync(absTarget);
        targetExists = true;
      } catch {}

      const isSafeManagedTarget =
        !touchesProtectedRoot && isPathInsideDir(realTarget, realWorktreesRoot, { allowEqual: false });

      // Only delete worktrees strictly inside <projectDir>/worktrees/; for external paths just drop DB references
      if (!isSafeManagedTarget) {
        return;
      }

      if (targetExists) {
        if (repoRow && repoRow.local_path && fs.existsSync(repoRow.local_path)) {
          const linkedList = listLinkedGitWorktrees(repoRow.local_path);
          const isLinked = linkedList.some((wt) => pathsEqual(wt, realTarget));
          if (isLinked) {
            try {
              execFileSync("git", ["-C", repoRow.local_path, "worktree", "remove", "--force", absTarget], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"]
              });
            } catch {}
          }
        }

        let stillExists = false;
        try {
          fs.lstatSync(absTarget);
          stillExists = true;
        } catch {}
        if (stillExists) {
          let isSymlinkToOutside = false;
          try {
            if (fs.lstatSync(absTarget).isSymbolicLink() && !isPathInsideDir(realTarget, realWorktreesRoot, { allowEqual: false })) {
              isSymlinkToOutside = true;
            }
          } catch {}
          if (!isSymlinkToOutside) {
            fs.rmSync(realTarget, { recursive: true, force: true });
          }
        }
        if (repoRow && repoRow.local_path) {
          pruneGitWorktreesSafe(repoRow.local_path);
        } else {
          for (const r of allRepoRows) {
            if (r && r.local_path) pruneGitWorktreesSafe(r.local_path);
          }
        }
        cleanedPaths.push(targetPath);
      } else {
        if (repoRow && repoRow.local_path) {
          pruneGitWorktreesSafe(repoRow.local_path);
        }
        if (!cleanedPaths.includes(targetPath)) {
          cleanedPaths.push(targetPath);
        }
      }
    };

    const removeEmptyThreadDir = () => {
      try {
        if (fs.existsSync(threadWtDir) && fs.readdirSync(threadWtDir).length === 0) {
          fs.rmdirSync(threadWtDir);
        }
      } catch {}
    };

    if (repoId) {
      const targetRepoId = repo ? repo.repo_id : String(repoId);
      const fallbackThreadWt =
        threadRow?.worktree_path && (!threadRow.repo_id || threadRow.repo_id === targetRepoId)
          ? threadRow.worktree_path
          : null;
      const defaultWt = repo ? path.join(threadWtDir, repo.name) : fallbackThreadWt;
      const targetPath = worktreesMap[targetRepoId]?.worktreePath || defaultWt;
      if (targetPath) {
        removeWorktreePath(targetPath, targetRepoId);
      }
      delete worktreesMap[targetRepoId];
      const nextEntry = Object.values(worktreesMap)[0] || null;
      db.prepare(
        "UPDATE threads SET worktree_path = ?, repo_id = ?, worktrees_json = ?, updated_at = ? WHERE thread_id = ?"
      ).run(nextEntry?.worktreePath || null, nextEntry?.repoId || null, JSON.stringify(worktreesMap), nowIso(), threadId);
      removeEmptyThreadDir();
      return { cleanedUp: true, worktreePath: targetPath, cleanedPaths };
    }

    const entries = Object.entries(worktreesMap);
    if (entries.length > 0) {
      for (const [rId, entry] of entries) {
        removeWorktreePath(entry?.worktreePath, rId);
      }
    } else {
      const fallbackPath = repo ? path.join(threadWtDir, repo.name) : (threadRow?.worktree_path || null);
      const fallbackRepoId = repo ? repo.repo_id : (threadRow?.repo_id || null);
      if (fallbackPath) {
        removeWorktreePath(fallbackPath, fallbackRepoId);
      }
    }
    if (threadRow?.worktree_path && !cleanedPaths.includes(threadRow.worktree_path)) {
      removeWorktreePath(threadRow.worktree_path, threadRow.repo_id || null);
    }
    removeEmptyThreadDir();
    db.prepare("UPDATE threads SET worktree_path = NULL, worktrees_json = '{}', updated_at = ? WHERE thread_id = ?")
      .run(nowIso(), threadId);
    return { cleanedUp: true, worktreePath: cleanedPaths[0] || null, cleanedPaths };
  }

  throw new Error(`Unsupported manage_worktree action: ${action}`);
}

// ---------- Project Lifecycle, Rollover & Thread Isolation Helpers ----------

function transitionProjectLifecycle(workspacePath, { status, starred } = {}) {
  const cfg = loadProjectConfig(workspacePath);
  if (!cfg) throw new Error("Project config not found.");
  const sql = openProjectDb(workspacePath);
  const prevStatus = cfg.status;
  const ts = nowIso();

  if (status && ["active", "paused", "archived"].includes(status)) {
    cfg.status = status;
    if (status === "paused" || status === "archived") {
      sql.prepare(`
        UPDATE threads SET
          pre_pause_bucket = ui_bucket,
          ui_bucket = 'paused',
          server_status = 'idle',
          updated_at = ?
        WHERE ui_bucket IN ('working', 'landing', 'waiting_on_you')
      `).run(ts);
    } else if (status === "active" && prevStatus !== "active") {
      const pausedRows = sql.prepare("SELECT * FROM threads WHERE ui_bucket = 'paused'").all();
      for (const row of pausedRows) {
        const prevBucket = row.pre_pause_bucket || "idle";
        let nextBucket = "idle";
        let nextSummary = null;
        if (prevBucket === "waiting_on_you") {
          nextBucket = "waiting_on_you";
        } else if ((prevBucket === "working" || prevBucket === "landing") && row.conversation_id) {
          nextBucket = prevBucket;
        } else {
          nextBucket = "idle";
          if (!row.last_summary) {
            nextSummary = "Paused headless task halted; restart when ready.";
          }
        }
        sql.prepare(`
          UPDATE threads SET
            ui_bucket = ?,
            server_status = ?,
            pre_pause_bucket = NULL,
            last_summary = COALESCE(?, last_summary),
            updated_at = ?
          WHERE thread_id = ?
        `).run(nextBucket, uiBucketToServerStatus(nextBucket), nextSummary, ts, row.thread_id);
      }
    }
  }

  if (typeof starred === "boolean") {
    cfg.starred = starred;
  }

  saveProjectConfig(workspacePath, cfg);
  return { config: cfg, previousStatus: prevStatus };
}

function rolloverCoordinatorSession(workspacePath, { newConversationId = null, summary = "" } = {}) {
  const cfg = loadProjectConfig(workspacePath);
  if (!cfg) throw new Error("Project config not found.");
  const sql = openProjectDb(workspacePath);
  const previousCoordinatorId = cfg.coordinatorConversationId || null;

  if (previousCoordinatorId) {
    sql.prepare(`
      INSERT INTO completed_coordinators (conversation_id, archived_at, summary)
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET archived_at = excluded.archived_at, summary = excluded.summary
    `).run(previousCoordinatorId, nowIso(), summary || "Coordinator session rolled over");
  }

  // Ensure any existing wrapup_checkpoint.md carries Source-Coordinator so the next Coordinator consumes it once
  const wrapPath = path.join(getProjectDir(workspacePath), "state", "wrapup_checkpoint.md");
  if (fs.existsSync(wrapPath) && previousCoordinatorId) {
    const raw = fs.readFileSync(wrapPath, "utf8");
    if (!/^>\s*Source-Coordinator:/m.test(raw)) {
      writeTextAtomic(wrapPath, `${raw.trimEnd()}\n> Source-Coordinator: ${previousCoordinatorId}\n`);
    }
  }

  cfg.coordinatorConversationId = newConversationId ? String(newConversationId).trim() : null;
  saveProjectConfig(workspacePath, cfg);
  if (previousCoordinatorId && previousCoordinatorId !== cfg.coordinatorConversationId) {
    removeConversationBinding(previousCoordinatorId);
  }
  if (cfg.coordinatorConversationId) {
    syncConversationBinding(cfg.coordinatorConversationId, {
      workspacePath: path.resolve(workspacePath),
      role: "coordinator",
      threadId: null,
      projectId: cfg.projectId || null
    });
  }
  return {
    rolledOver: true,
    previousCoordinatorId,
    coordinatorConversationId: cfg.coordinatorConversationId
  };
}

function ensureThreadIsolationCwd(workspacePath, threadOrId) {
  const absWs = path.resolve(workspacePath);
  const sql = openProjectDb(absWs);
  const thread = typeof threadOrId === "string"
    ? sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadOrId)
    : threadOrId;
  if (!thread) return absWs;

  if (!isMutatingRole(thread.role) || thread.workspace_mode === "inherit") {
    return thread.worktree_path && fs.existsSync(thread.worktree_path) ? thread.worktree_path : absWs;
  }

  if (thread.worktree_path && fs.existsSync(thread.worktree_path)) {
    return thread.worktree_path;
  }

  let repoCount = Number(sql.prepare("SELECT COUNT(*) AS cnt FROM repositories").get()?.cnt || 0);
  if (repoCount === 0 && fs.existsSync(path.join(absWs, ".git"))) {
    try {
      bindRepository(absWs, { localPath: absWs, name: path.basename(absWs) });
      repoCount = Number(sql.prepare("SELECT COUNT(*) AS cnt FROM repositories").get()?.cnt || 0);
    } catch {}
  }

  if (repoCount > 0) {
    const wt = manageWorktree(absWs, {
      action: "create",
      threadId: thread.thread_id,
      repoId: thread.repo_id || undefined
    });
    return wt.worktreePath;
  }

  return absWs;
}

// ---------- Threads CRUD & Lifecycle Buckets ----------

function uiBucketToServerStatus(bucket) {
  switch (bucket) {
    case "suggested": return "pending";
    case "working":
    case "landing": return "working";
    case "waiting_on_you": return "needs_input";
    case "ready_for_review":
    case "idle":
    case "paused": return "idle";
    case "resolved": return "resolved";
    default: return "idle";
  }
}

function proposeThreads(workspacePath, proposals = []) {
  const db = openProjectDb(workspacePath);
  const created = [];
  const ts = nowIso();
  const stmt = db.prepare(`
    INSERT INTO threads (
      thread_id, title, description, role, ui_bucket, server_status,
      model, workspace_mode, repo_id, owned_globs_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'suggested', 'pending', ?, ?, ?, ?, ?, ?)
  `);
  const cfg = loadProjectConfig(workspacePath);
  for (const p of proposals) {
    const id = p.threadId || `t-${crypto.randomUUID().slice(0, 8)}`;
    const role = normalizeRole(p.role || "explorer");
    const model = getRoleModelOverride(cfg, role) || cfg?.models?.defaultThreadModel || "inherit";
    const wsMode = p.workspaceMode || (role === "explorer" ? "inherit" : (cfg?.orchestration?.defaultWorkspaceMode || "share"));
    stmt.run(
      id,
      String(p.title || "Proposed Task"),
      String(p.description || ""),
      role,
      model,
      wsMode,
      p.repoId || null,
      JSON.stringify(Array.isArray(p.ownedGlobs) ? p.ownedGlobs : []),
      ts,
      ts
    );
    created.push(db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(id));
  }
  return created;
}

function checkThreadQuota(workspacePath, { skipCounts = false } = {}) {
  const cfg = loadProjectConfig(workspacePath);
  const db = openProjectDb(workspacePath);
  if (cfg.status !== "active") {
    throw new Error(`Project '${cfg.name}' is ${cfg.status.toUpperCase()}. Resume it before spawning threads.`);
  }
  if (skipCounts) return;
  const activeCnt = Number(
    db.prepare("SELECT COUNT(*) AS cnt FROM threads WHERE ui_bucket = 'working'").get()?.cnt || 0
  );
  if (activeCnt >= cfg.orchestration.maxConcurrentThreads) {
    throw new Error(
      `Max concurrent working threads reached (${activeCnt}/${cfg.orchestration.maxConcurrentThreads}). Wait for an active thread to finish or adjust Settings > General.`
    );
  }
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const todayCnt = Number(
    db.prepare("SELECT COUNT(*) AS cnt FROM threads WHERE created_at >= ? AND ui_bucket != 'suggested'").get(dayStart.toISOString())?.cnt || 0
  );
  if (todayCnt >= cfg.orchestration.maxNewThreadsPerDay) {
    throw new Error(`Daily thread spawn cap reached (${todayCnt}/${cfg.orchestration.maxNewThreadsPerDay}).`);
  }
}

function registerThread(workspacePath, payload) {
  const db = openProjectDb(workspacePath);
  const cfg = loadProjectConfig(workspacePath);
  const ts = nowIso();
  const id = payload.threadId || `t-${crypto.randomUUID().slice(0, 8)}`;
  const existing = db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(id);
  checkThreadQuota(workspacePath, { skipCounts: Boolean(existing && existing.ui_bucket === "working") });

  const role = normalizeRole(payload.role || "implementer");
  const model = payload.model || getRoleModelOverride(cfg, role) || cfg?.models?.defaultThreadModel || "inherit";
  const wsMode = payload.workspaceMode || cfg?.orchestration?.defaultWorkspaceMode || "share";
  const validatedWorktreePath = payload.worktreePath
    ? validateWorktreePath(workspacePath, payload.worktreePath, db)
    : null;

  if (existing) {
    const nextWorkingSince = existing.ui_bucket === "working" ? (existing.working_since || existing.updated_at || ts) : ts;
    db.prepare(`
      UPDATE threads SET
        title = COALESCE(?, title),
        description = COALESCE(?, description),
        role = ?,
        ui_bucket = 'working',
        server_status = 'working',
        pre_pause_bucket = NULL,
        blocking_question = NULL,
        blocking_is_error = 0,
        conversation_id = COALESCE(?, conversation_id),
        model = ?,
        workspace_mode = ?,
        repo_id = COALESCE(?, repo_id),
        branch_name = COALESCE(?, branch_name),
        worktree_path = COALESCE(?, worktree_path),
        owned_globs_json = COALESCE(?, owned_globs_json),
        working_since = ?,
        updated_at = ?
      WHERE thread_id = ?
    `).run(
      payload.title || null,
      payload.description || null,
      role,
      payload.conversationId || null,
      model,
      wsMode,
      payload.repoId || null,
      payload.branchName || null,
      validatedWorktreePath,
      Array.isArray(payload.ownedGlobs) ? JSON.stringify(payload.ownedGlobs) : null,
      nextWorkingSince,
      ts,
      id
    );
  } else {
    db.prepare(`
      INSERT INTO threads (
        thread_id, title, description, role, ui_bucket, server_status,
        conversation_id, model, workspace_mode, repo_id, branch_name,
        worktree_path, owned_globs_json, created_at, updated_at, working_since
      ) VALUES (?, ?, ?, ?, 'working', 'working', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      String(payload.title || "Worker Thread"),
      String(payload.description || ""),
      role,
      payload.conversationId || null,
      model,
      wsMode,
      payload.repoId || null,
      payload.branchName || `project/${id}`,
      validatedWorktreePath,
      JSON.stringify(Array.isArray(payload.ownedGlobs) ? payload.ownedGlobs : []),
      ts,
      ts,
      ts
    );
  }
  if (existing && existing.conversation_id && payload.conversationId && existing.conversation_id !== payload.conversationId) {
    removeConversationBinding(existing.conversation_id);
  }
  if (payload.conversationId) {
    syncConversationBinding(payload.conversationId, {
      workspacePath: path.resolve(workspacePath),
      role: "worker",
      threadId: id,
      projectId: cfg?.projectId || null
    });
  }
  return db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(id);
}

function updateThreadState(workspacePath, { threadId, conversationId, uiBucket, prePauseBucket, clearBlockingQuestion, summary, blockingQuestion, blockingIsError, prNumber, prUrl, watchingAutoFix, telemetryEvent, tokenUsageDelta }) {
  const db = openProjectDb(workspacePath);
  const row = threadId
    ? db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadId)
    : db.prepare("SELECT * FROM threads WHERE conversation_id = ?").get(conversationId);
  if (!row) throw new Error(`Thread not found (${threadId || conversationId})`);

  const nextBucket = uiBucket || row.ui_bucket;
  if (!VALID_UI_BUCKETS.has(nextBucket)) {
    throw new Error(`Invalid uiBucket '${nextBucket}'. Expected one of: ${Array.from(VALID_UI_BUCKETS).join(", ")}`);
  }

  let telemetry = [];
  try { telemetry = JSON.parse(row.live_telemetry_json || "[]"); } catch {}
  if (telemetryEvent) {
    telemetry.push({ at: nowIso(), ...telemetryEvent });
    if (telemetry.length > 40) telemetry = telemetry.slice(-40);
  }

  const ts = nowIso();
  const resolvedAt = nextBucket === "resolved" ? ts : row.resolved_at;
  const nextBlocking =
    nextBucket === "waiting_on_you"
      ? String(blockingQuestion || summary || row.blocking_question || "Input requested")
      : (clearBlockingQuestion || uiBucket ? null : row.blocking_question);
  const nextBlockingIsError =
    nextBucket === "waiting_on_you"
      ? (blockingIsError !== undefined
          ? (blockingIsError ? 1 : 0)
          : (uiBucket ? 0 : Number(row.blocking_is_error || 0)))
      : 0;
  const nextPrePause =
    prePauseBucket !== undefined
      ? prePauseBucket
      : (nextBucket === "paused" ? row.pre_pause_bucket || row.ui_bucket : null);
  const nextWorkingSince =
    nextBucket === "working"
      ? (row.ui_bucket === "working" ? (row.working_since || row.updated_at || ts) : ts)
      : null;
  const tokenDelta = Number.isFinite(Number(tokenUsageDelta)) && Number(tokenUsageDelta) > 0
    ? Math.floor(Number(tokenUsageDelta))
    : 0;

  db.prepare(`
    UPDATE threads SET
      ui_bucket = ?,
      server_status = ?,
      pre_pause_bucket = ?,
      last_summary = COALESCE(?, last_summary),
      blocking_question = ?,
      blocking_is_error = ?,
      pr_number = COALESCE(?, pr_number),
      pr_url = COALESCE(?, pr_url),
      watching_autofix = COALESCE(?, watching_autofix),
      live_telemetry_json = ?,
      token_usage_est = token_usage_est + ?,
      working_since = ?,
      updated_at = ?,
      resolved_at = ?
    WHERE thread_id = ?
  `).run(
    nextBucket,
    uiBucketToServerStatus(nextBucket),
    nextPrePause,
    summary !== undefined ? String(summary) : null,
    nextBlocking,
    nextBlockingIsError,
    prNumber !== undefined ? Number(prNumber) : null,
    prUrl !== undefined ? String(prUrl) : null,
    watchingAutoFix !== undefined ? (watchingAutoFix ? 1 : 0) : null,
    JSON.stringify(telemetry),
    tokenDelta,
    nextWorkingSince,
    ts,
    resolvedAt,
    row.thread_id
  );

  // Upsert PR record automatically if PR metadata provided
  if (prNumber && prUrl) {
    const repo = row.repo_id
      ? db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(row.repo_id)
      : db.prepare("SELECT * FROM repositories ORDER BY added_at ASC LIMIT 1").get();
    if (repo) {
      const prId = `${repo.repo_id}#${Number(prNumber)}`;
      db.prepare(`
        INSERT INTO pull_requests (
          pr_id, repo_id, thread_id, pr_number, url, title, head_branch, base_branch, autofix_enabled, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pr_id) DO UPDATE SET
          url = excluded.url,
          autofix_enabled = excluded.autofix_enabled,
          updated_at = excluded.updated_at
      `).run(
        prId,
        repo.repo_id,
        row.thread_id,
        Number(prNumber),
        String(prUrl),
        row.title,
        row.branch_name || `project/${row.thread_id}`,
        repo.default_branch || "main",
        watchingAutoFix === false ? 0 : 1,
        ts
      );
    }
  }

  return db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(row.thread_id);
}

// ---------- Contextual Retrieval Chunking, FTS5 BM25 & Dual-Provider Embeddings ----------

function detectPdfPagesFallback(buffer) {
  const str = buffer.toString("latin1");
  const matches = str.match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : 1;
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".csv": "text/csv",
    ".html": "text/html",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".py": "text/x-python",
    ".js": "text/javascript",
    ".cjs": "text/javascript",
    ".mjs": "text/javascript",
    ".ts": "text/typescript",
    ".tsx": "text/tsx",
    ".rs": "text/x-rust",
    ".go": "text/x-go",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  };
  return map[ext] || "application/octet-stream";
}

function isStructuredBinaryMime(mimeType, filePath = "") {
  const ext = path.extname(filePath).toLowerCase();
  return (
    mimeType === "application/pdf" ||
    mimeType.startsWith("image/") ||
    ext === ".pdf" ||
    ext === ".docx" ||
    ext === ".xlsx" ||
    mimeType.includes("wordprocessingml") ||
    mimeType.includes("spreadsheetml")
  );
}

function getExtractedTextPath(workspacePath, itemId) {
  return path.join(getProjectDir(workspacePath), "state", "extracted", `${itemId}.txt`);
}

function extractDocumentSync(absFilePath, mimeType) {
  const scriptPath = path.join(getPluginRootDir(), "server", "rag_worker.py");
  if (!fs.existsSync(scriptPath)) {
    return null;
  }
  const pyBin = getVenvPythonOrSystem();
  const res = spawnSync(
    pyBin,
    [scriptPath, "extract-doc", "--file", path.resolve(absFilePath), "--mime", String(mimeType || "")],
    {
      env: { ...process.env, AGY_PROJECTS_DATA_DIR: getSharedDataDir() },
      encoding: "utf8",
      timeout: 30000
    }
  );
  const stdout = String(res.stdout || "").trim();
  if (!stdout) {
    return null;
  }
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function readLibraryItemText(workspacePath, item) {
  const extractedPath = getExtractedTextPath(workspacePath, item.item_id);
  if (fs.existsSync(extractedPath)) {
    return fs.readFileSync(extractedPath, "utf8");
  }
  const absFile = path.join(getProjectDir(workspacePath), item.rel_path);
  if (!fs.existsSync(absFile)) return "";
  if (item.mime_type === "application/pdf") {
    return `[PDF Asset: ${item.title} | Pages: ${item.page_count || 1} | Mode: ${item.pdf_mode || "visual_and_text"}]`;
  }
  if (item.mime_type.startsWith("image/")) {
    return `[Image Asset: ${item.title}]`;
  }
  if (isStructuredBinaryMime(item.mime_type, absFile)) {
    const extRes = extractDocumentSync(absFile, item.mime_type);
    if (extRes?.ok && typeof extRes.text === "string") {
      writeTextAtomic(extractedPath, extRes.text);
      return extRes.text;
    }
    return `[Document Asset: ${item.title}]`;
  }
  return fs.readFileSync(absFile, "utf8");
}

function extractStructureAwareChunks(text, title, relPath, { activeModel = "" } = {}) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines.length === 0) return [];
  const chunks = [];
  // Scale chunk target window with active model capacity (450 tok local ONNX -> 900 tok emb-001 -> 1600 tok emb-2)
  const targetMaxChars =
    activeModel === "gemini-embedding-2"
      ? 6400
      : activeModel === "gemini-embedding-001"
        ? 3600
        : 1800;
  const minBoundarySplitChars = Math.floor(targetMaxChars / 3);

  let currentHeading = "Top-Level";
  let currentSymbol = "";
  let currentPdfPage = 0;
  let buf = [];
  let bufPages = [];
  let startLine = 1;

  const headingRe = /^(#{1,4})\s+(.+)$/;
  const pageRe = /^##\s+Page\s+(\d+)\b/i;
  const symbolRe = /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|def|struct|impl)\s+([A-Za-z0-9_]+)/;

  function flush(endLine) {
    const raw = buf.join("\n").trim();
    if (!raw) return;
    const scopeParts = [`File: ${relPath}`, `Title: ${title}`, `Section: ${currentHeading}`];
    const posPages = bufPages.filter((p) => p > 0);
    if (posPages.length > 0) {
      const minPage = Math.min(...posPages);
      const maxPage = Math.max(...posPages);
      scopeParts.push(minPage === maxPage ? `Page: ${minPage}` : `Pages: ${minPage}-${maxPage}`);
    } else if (currentPdfPage > 0) {
      scopeParts.push(`Page: ${currentPdfPage}`);
    }
    if (currentSymbol) scopeParts.push(`Symbol: ${currentSymbol}`);
    scopeParts.push(`Lines: L${startLine}-L${endLine}`);
    const contextPrefix = `[${scopeParts.join(" | ")}]`;
    chunks.push({
      chunkIndex: chunks.length,
      startLine,
      endLine,
      rawText: raw,
      contextPrefix,
      contextualizedText: `${contextPrefix}\n\n${raw}`
    });
  }

  let charAcc = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const hMatch = line.match(headingRe);
    const sMatch = line.match(symbolRe);

    const isBoundary = Boolean(hMatch || sMatch);
    if (buf.length > 0 && (charAcc + line.length > targetMaxChars || (isBoundary && charAcc > minBoundarySplitChars))) {
      flush(lineNo - 1);
      // ~10% line overlap (preserving each overlapped line's active page)
      const overlap = buf.slice(-3);
      const overlapPages = bufPages.slice(-3);
      buf = [...overlap];
      bufPages = [...overlapPages];
      startLine = Math.max(1, lineNo - overlap.length);
      charAcc = buf.join("\n").length;
    }

    if (hMatch) currentHeading = hMatch[2].trim().slice(0, 80);
    const pMatch = line.match(pageRe);
    if (pMatch) {
      const pg = parseInt(pMatch[1], 10);
      if (Number.isInteger(pg) && pg > 0) currentPdfPage = pg;
    }
    if (sMatch) currentSymbol = sMatch[1].trim().slice(0, 60);
    buf.push(line);
    bufPages.push(currentPdfPage);
    charAcc += line.length + 1;
  }
  if (buf.length > 0) flush(lines.length);
  return chunks;
}

function getActiveEmbeddingModelName(cfg) {
  return cfg?.memory?.embeddingProvider === "gemini_cloud"
    ? (cfg?.memory?.cloudEmbeddingModel || "gemini-embedding-2")
    : (cfg?.memory?.localEmbeddingModel || "BAAI/bge-small-en-v1.5");
}

function triggerPythonRagEmbed(workspacePath, { asyncMode = true } = {}) {
  const scriptPath = path.join(getPluginRootDir(), "server", "rag_worker.py");
  if (!fs.existsSync(scriptPath)) return { triggered: false };
  const pyBin = getVenvPythonOrSystem();
  const env = {
    ...process.env,
    AGY_PROJECTS_DATA_DIR: getSharedDataDir()
  };
  if (asyncMode) {
    const child = spawn(pyBin, [scriptPath, "embed-workspace", "--workspace", path.resolve(workspacePath)], {
      env,
      stdio: "ignore",
      detached: true
    });
    child.unref?.();
    return { triggered: true, mode: "async" };
  }
  const res = spawnSync(pyBin, [scriptPath, "embed-workspace", "--workspace", path.resolve(workspacePath)], {
    env,
    encoding: "utf8",
    timeout: 60000
  });
  return { triggered: true, mode: "sync", status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function rebalanceLibraryIndexing(workspacePath, { syncEmbeddings = false, forceRechunk = false } = {}) {
  const cfg = loadProjectConfig(workspacePath);
  const db = openProjectDb(workspacePath);
  const threshold = cfg?.memory?.autoPinLibraryTokenThreshold ?? DEFAULT_PIN_TOKEN_THRESHOLD;
  const totalTokens = Number(db.prepare("SELECT COALESCE(SUM(token_count), 0) AS tot FROM library_items").get()?.tot || 0);
  const mode = totalTokens < threshold ? "pinned" : "rag";
  const activeModel = getActiveEmbeddingModelName(cfg);

  if (mode === "pinned") {
    if (forceRechunk) {
      db.exec("BEGIN");
      try {
        const staleRows = db.prepare("SELECT chunk_id FROM library_chunks WHERE embedding_model != ?").all(activeModel);
        const delFts = db.prepare("DELETE FROM library_chunks_fts WHERE chunk_id = ?");
        for (const sr of staleRows) {
          delFts.run(sr.chunk_id);
        }
        db.prepare("DELETE FROM library_chunks WHERE embedding_model != ?").run(activeModel);
        db.exec("COMMIT");
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch {}
        throw err;
      }
    }
    db.prepare("UPDATE library_items SET index_status = 'pinned' WHERE index_status != 'failed'").run();
    return { mode, totalTokens, threshold, activeModel };
  }

  // Contextual Retrieval Mode (>= threshold): ensure every item is chunked & FTS5-indexed
  const items = db.prepare("SELECT * FROM library_items").all();
  const pDir = getProjectDir(workspacePath);

  const insertChunk = db.prepare(`
    INSERT INTO library_chunks (
      chunk_id, item_id, chunk_index, start_line, end_line,
      raw_text, context_prefix, contextualized_text, header_mode, embedding_model, embedding_dim, embedding_f32
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'structural_offline', ?, 0, NULL)
  `);
  const insertFts = db.prepare(`
    INSERT INTO library_chunks_fts (chunk_id, item_id, contextualized_text)
    VALUES (?, ?, ?)
  `);

  for (const item of items) {
    const stats = db.prepare(
      "SELECT COUNT(*) AS cnt, MIN(embedding_model) AS min_model, MAX(embedding_model) AS max_model FROM library_chunks WHERE item_id = ?"
    ).get(item.item_id);
    const existingCnt = Number(stats?.cnt || 0);
    const needsRechunk =
      existingCnt === 0 ||
      forceRechunk ||
      stats?.min_model !== activeModel ||
      stats?.max_model !== activeModel;

    if (needsRechunk) {
      const absFile = path.join(pDir, item.rel_path);
      if (!fs.existsSync(absFile)) continue;
      const textContent = readLibraryItemText(workspacePath, item);
      const chunks = extractStructureAwareChunks(textContent, item.title, item.rel_path, { activeModel });
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM library_chunks_fts WHERE item_id = ?").run(item.item_id);
        db.prepare("DELETE FROM library_chunks WHERE item_id = ?").run(item.item_id);
        for (const ch of chunks) {
          const cid = `${item.item_id}#c${ch.chunkIndex}`;
          insertChunk.run(
            cid,
            item.item_id,
            ch.chunkIndex,
            ch.startLine,
            ch.endLine,
            ch.rawText,
            ch.contextPrefix,
            ch.contextualizedText,
            activeModel
          );
          insertFts.run(cid, item.item_id, ch.contextualizedText);
        }
        db.prepare("UPDATE library_items SET index_status = 'indexed', updated_at = ? WHERE item_id = ?")
          .run(nowIso(), item.item_id);
        db.exec("COMMIT");
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch {}
        throw err;
      }
    } else if (item.index_status === "pinned") {
      db.prepare("UPDATE library_items SET index_status = 'indexed', updated_at = ? WHERE item_id = ?")
        .run(nowIso(), item.item_id);
    }
  }

  triggerPythonRagEmbed(workspacePath, { asyncMode: !syncEmbeddings });
  return { mode, totalTokens, threshold, activeModel };
}

function ingestLibraryItem(workspacePath, { sourcePath, content, filename, category = "input", sourceType = "upload", title, producerThreadId, allowLargeLocal = false, syncEmbeddings = false }) {
  if (category !== "input" && category !== "output") {
    throw new Error(`Invalid category '${category}'. Must be 'input' or 'output'.`);
  }
  const pDir = getProjectDir(workspacePath);
  const subDir = category === "input" ? "inputs" : "outputs";
  const destDir = path.join(pDir, "library", subDir);
  fs.mkdirSync(destDir, { recursive: true });

  let rawBuf;
  let baseName;
  const isBufferPayload = content !== undefined && content !== null;
  if (isBufferPayload) {
    baseName = path.basename(filename || title || `doc-${Date.now()}.md`);
    rawBuf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  } else {
    if (!sourcePath) throw new Error("Provide sourcePath or content.");
    const absSrc = path.resolve(String(sourcePath));
    if (isBlockedSensitiveSourcePath(absSrc, workspacePath)) {
      const forbiddenErr = new Error("Forbidden: sourcePath points to a sensitive or non-regular file.");
      forbiddenErr.statusCode = 403;
      throw forbiddenErr;
    }
    if (!fs.existsSync(absSrc)) throw new Error(`Source file not found: ${absSrc}`);
    baseName = path.basename(filename || absSrc);
    const st = fs.statSync(absSrc);
    const preCap = allowLargeLocal
      ? MAX_LARGE_LOCAL_BYTES
      : (category === "input" ? MAX_UPLOAD_INPUT_BYTES : MAX_LARGE_LOCAL_BYTES);
    if (st.size > preCap) {
      throw new Error(
        `File '${baseName}' (${(st.size / (1024 * 1024)).toFixed(1)} MB) exceeds the ${Math.round(preCap / (1024 * 1024))} MB Project Library limit.`
      );
    }
    rawBuf = fs.readFileSync(absSrc);
  }

  if (category === "input") {
    const maxBytes = allowLargeLocal
      ? (isBufferPayload ? MAX_LARGE_UPLOAD_BYTES : MAX_LARGE_LOCAL_BYTES)
      : MAX_UPLOAD_INPUT_BYTES;
    if (rawBuf.length > maxBytes) {
      throw new Error(
        `File '${baseName}' (${(rawBuf.length / (1024 * 1024)).toFixed(1)} MB) exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB Project Library upload limit.`
      );
    }
  }

  const mimeType = guessMimeType(baseName);
  const destAbs = path.join(destDir, baseName);
  if (!sourcePath || path.resolve(sourcePath) !== destAbs) {
    fs.writeFileSync(destAbs, rawBuf);
  }

  let pageCount = null;
  let pdfMode = null;
  let extractedText = null;

  if (isStructuredBinaryMime(mimeType, destAbs)) {
    const extRes = extractDocumentSync(destAbs, mimeType);
    if (extRes && extRes.ok === false) {
      try {
        if (!sourcePath || path.resolve(sourcePath) !== destAbs) fs.unlinkSync(destAbs);
      } catch {}
      throw new Error(extRes.error || `Failed to extract '${baseName}'.`);
    }
    if (extRes && extRes.ok) {
      pageCount = extRes.pageCount ?? null;
      pdfMode = extRes.pdfMode ?? null;
      extractedText = typeof extRes.text === "string" ? extRes.text : null;
    } else if (mimeType === "application/pdf") {
      pageCount = detectPdfPagesFallback(rawBuf);
      if (pageCount > 1000) {
        throw new Error(`Uploaded file '${baseName}' is too large (${pageCount} pages; maximum supported is 1,000 pages).`);
      }
      pdfMode = pageCount <= 100 ? "visual_and_text" : "text_only";
    }
  }

  const relPath = path.posix.join("library", subDir, baseName);
  const digest = sha256Hex(rawBuf);
  const textForTokens = extractedText !== null ? extractedText : (isStructuredBinaryMime(mimeType, destAbs) ? "" : rawBuf.toString("utf8"));
  const baseTokens = estimateTokens(textForTokens);
  const tokenCount = mimeType.startsWith("image/") || mimeType === "application/pdf"
    ? Math.max(baseTokens, (pageCount || 1) * 250)
    : baseTokens;

  const db = openProjectDb(workspacePath);
  const existing = db.prepare("SELECT * FROM library_items WHERE rel_path = ?").get(relPath);
  const itemId = existing ? existing.item_id : `lib-${digest.slice(0, 10)}`;
  const ts = nowIso();

  if (extractedText !== null) {
    writeTextAtomic(getExtractedTextPath(workspacePath, itemId), extractedText);
  }

  // If updated content hash differs, clear stale chunks
  if (existing && existing.sha256 !== digest) {
    const oldChunks = db.prepare("SELECT chunk_id FROM library_chunks WHERE item_id = ?").all(itemId);
    for (const oc of oldChunks) {
      db.prepare("DELETE FROM library_chunks_fts WHERE chunk_id = ?").run(oc.chunk_id);
    }
    db.prepare("DELETE FROM library_chunks WHERE item_id = ?").run(itemId);
  }

  db.prepare(`
    INSERT INTO library_items (
      item_id, category, source_type, producer_thread_id, title, rel_path,
      mime_type, byte_size, page_count, pdf_mode, token_count, sha256, index_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(rel_path) DO UPDATE SET
      title = excluded.title,
      byte_size = excluded.byte_size,
      page_count = excluded.page_count,
      pdf_mode = excluded.pdf_mode,
      token_count = excluded.token_count,
      sha256 = excluded.sha256,
      producer_thread_id = COALESCE(excluded.producer_thread_id, library_items.producer_thread_id),
      updated_at = excluded.updated_at
  `).run(
    itemId,
    category,
    sourceType,
    producerThreadId || null,
    title || baseName,
    relPath,
    mimeType,
    rawBuf.length,
    pageCount,
    pdfMode,
    tokenCount,
    digest,
    ts,
    ts
  );

  const indexState = rebalanceLibraryIndexing(workspacePath, { syncEmbeddings });
  return {
    item: db.prepare("SELECT * FROM library_items WHERE item_id = ?").get(itemId),
    libraryState: indexState
  };
}

function buildSafeFtsQuery(rawQuery) {
  const terms = String(rawQuery || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 12);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(" OR ");
}

function cosineSimilarityBuffer(vecFloat32, blobBuf) {
  if (!vecFloat32 || !blobBuf) return -1;
  const dim = vecFloat32.length;
  if (blobBuf.byteLength !== dim * 4) return -1;
  const candidate = new Float32Array(blobBuf.buffer, blobBuf.byteOffset, dim);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < dim; i++) {
    const a = vecFloat32[i];
    const b = candidate[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 1e-8 ? dot / denom : -1;
}

function tryEmbedQuerySync(workspacePath, queryText) {
  const scriptPath = path.join(getPluginRootDir(), "server", "rag_worker.py");
  if (!fs.existsSync(scriptPath)) return null;
  const db = openProjectDb(workspacePath);
  const cfg = loadProjectConfig(workspacePath);
  const activeModel = getActiveEmbeddingModelName(cfg);
  const embeddedCnt = Number(
    db.prepare("SELECT COUNT(*) AS cnt FROM library_chunks WHERE embedding_f32 IS NOT NULL AND embedding_model = ?").get(activeModel)?.cnt || 0
  );
  if (embeddedCnt === 0) return null;

  try {
    const res = spawnSync(
      getVenvPythonOrSystem(),
      [scriptPath, "embed-query", "--workspace", path.resolve(workspacePath), "--query", String(queryText)],
      {
        env: { ...process.env, AGY_PROJECTS_DATA_DIR: getSharedDataDir() },
        encoding: "utf8",
        timeout: 8000
      }
    );
    if (res.status !== 0 || !res.stdout) return null;
    const parsed = JSON.parse(res.stdout.trim());
    if (Array.isArray(parsed.vector) && parsed.vector.length > 0) {
      return Float32Array.from(parsed.vector);
    }
  } catch {}
  return null;
}

function searchProjectLibrary(workspacePath, { query, categoryFilter, topK = 8 }) {
  const db = openProjectDb(workspacePath);
  const cfg = loadProjectConfig(workspacePath);
  const pDir = getProjectDir(workspacePath);
  const activeModel = getActiveEmbeddingModelName(cfg);

  // Ensure chunks exist for every item and match activeModel (incremental pinned-mode & provider switch)
  const syncItems = db.prepare(`
    SELECT li.* FROM library_items li
    WHERE NOT EXISTS (SELECT 1 FROM library_chunks c WHERE c.item_id = li.item_id)
       OR EXISTS (SELECT 1 FROM library_chunks c WHERE c.item_id = li.item_id AND c.embedding_model != ?)
  `).all(activeModel);
  if (syncItems.length > 0) {
    const insertChunk = db.prepare(`
      INSERT INTO library_chunks (
        chunk_id, item_id, chunk_index, start_line, end_line,
        raw_text, context_prefix, contextualized_text, header_mode, embedding_model, embedding_dim, embedding_f32
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'structural_offline', ?, 0, NULL)
    `);
    const insertFts = db.prepare(
      "INSERT INTO library_chunks_fts (chunk_id, item_id, contextualized_text) VALUES (?, ?, ?)"
    );
    db.exec("BEGIN");
    try {
      for (const item of syncItems) {
        db.prepare("DELETE FROM library_chunks_fts WHERE item_id = ?").run(item.item_id);
        db.prepare("DELETE FROM library_chunks WHERE item_id = ?").run(item.item_id);
        const textContent = readLibraryItemText(workspacePath, item);
        if (!textContent) continue;
        const chunks = extractStructureAwareChunks(textContent, item.title, item.rel_path, { activeModel });
        for (const ch of chunks) {
          const cid = `${item.item_id}#c${ch.chunkIndex}`;
          insertChunk.run(
            cid,
            item.item_id,
            ch.chunkIndex,
            ch.startLine,
            ch.endLine,
            ch.rawText,
            ch.contextPrefix,
            ch.contextualizedText,
            activeModel
          );
          insertFts.run(cid, item.item_id, ch.contextualizedText);
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch {}
      throw err;
    }
  }

  const ftsExpr = buildSafeFtsQuery(query);
  const bm25Ranks = new Map();
  if (ftsExpr) {
    const lexicalRows = db.prepare(`
      SELECT f.chunk_id, bm25(library_chunks_fts) AS score
      FROM library_chunks_fts f
      JOIN library_items li ON li.item_id = f.item_id
      WHERE library_chunks_fts MATCH ?
        AND (? IS NULL OR li.category = ?)
      ORDER BY score ASC
      LIMIT 30
    `).all(ftsExpr, categoryFilter || null, categoryFilter || null);
    lexicalRows.forEach((r, idx) => bm25Ranks.set(r.chunk_id, idx + 1));
  }

  const vecRanks = new Map();
  const queryVec = tryEmbedQuerySync(workspacePath, query);
  if (queryVec) {
    const denseCandidates = db.prepare(`
      SELECT c.chunk_id, c.embedding_f32
      FROM library_chunks c
      JOIN library_items li ON li.item_id = c.item_id
      WHERE c.embedding_f32 IS NOT NULL
        AND c.embedding_model = ?
        AND (? IS NULL OR li.category = ?)
    `).all(activeModel, categoryFilter || null, categoryFilter || null);
    const scored = denseCandidates
      .map((row) => ({ chunk_id: row.chunk_id, sim: cosineSimilarityBuffer(queryVec, row.embedding_f32) }))
      .filter((x) => x.sim > 0)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 30);
    scored.forEach((r, idx) => vecRanks.set(r.chunk_id, idx + 1));
  }

  // Reciprocal Rank Fusion (k = 60)
  const candidateIds = new Set([...bm25Ranks.keys(), ...vecRanks.keys()]);
  const fused = [];
  for (const cid of candidateIds) {
    const rBm25 = bm25Ranks.get(cid);
    const rVec = vecRanks.get(cid);
    const rrfScore = (rBm25 ? 1 / (60 + rBm25) : 0) + (rVec ? 1 / (60 + rVec) : 0);
    fused.push({ chunk_id: cid, rrfScore, bm25Rank: rBm25 || null, vectorRank: rVec || null });
  }
  fused.sort((a, b) => b.rrfScore - a.rrfScore);

  const results = [];
  for (const hit of fused.slice(0, Math.max(1, Math.min(25, Number(topK) || 8)))) {
    const row = db.prepare(`
      SELECT c.*, li.title, li.rel_path, li.category
      FROM library_chunks c
      JOIN library_items li ON li.item_id = c.item_id
      WHERE c.chunk_id = ?
    `).get(hit.chunk_id);
    if (!row) continue;
    const absPath = path.join(pDir, row.rel_path);
    const base = path.basename(absPath);
    const citation = `[${base}](file://${absPath}#L${row.start_line || 1}-L${row.end_line || 1})`;
    results.push({
      chunkId: row.chunk_id,
      title: row.title,
      category: row.category,
      relativePath: row.rel_path,
      absolutePath: absPath,
      startLine: row.start_line,
      endLine: row.end_line,
      citation,
      contextPrefix: row.context_prefix,
      snippet: row.raw_text,
      rrfScore: Number(hit.rrfScore.toFixed(6)),
      bm25Rank: hit.bm25Rank,
      vectorRank: hit.vectorRank,
      embeddingModel: queryVec ? activeModel : "fts5_bm25_only"
    });
  }

  return {
    query,
    retrievalMode: queryVec ? `hybrid_rrf (${activeModel} + fts5_bm25)` : "lexical_fts5_bm25",
    results
  };
}

// ---------- Cron Expression Evaluator (Standard 5-Field Vixie) ----------

const CRON_MONTH_NAMES = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12
};

const CRON_DOW_NAMES = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6
};

function parseCronToken(tok, min, max, { isDow = false, isMonth = false } = {}) {
  const raw = String(tok || "").trim().toUpperCase();
  if (!raw) throw new Error(`Empty token in cron field`);
  if (isMonth && Object.prototype.hasOwnProperty.call(CRON_MONTH_NAMES, raw)) {
    return CRON_MONTH_NAMES[raw];
  }
  if (isDow && Object.prototype.hasOwnProperty.call(CRON_DOW_NAMES, raw)) {
    return CRON_DOW_NAMES[raw];
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid cron token '${tok}'`);
  }
  const num = Number(raw);
  const upper = isDow ? 7 : max;
  if (!Number.isInteger(num) || num < min || num > upper) {
    throw new Error(`Cron value '${tok}' out of range [${min}..${upper}]`);
  }
  return num;
}

function validateCronField(field, min, max, { isDow = false, isMonth = false } = {}) {
  const rawField = String(field ?? "").trim();
  if (!rawField) {
    throw new Error(`Empty cron field`);
  }
  const allowed = new Set();
  const parts = rawField.split(",");
  for (const part of parts) {
    if (!part) {
      throw new Error(`Invalid empty list entry in cron field '${field}'`);
    }
    const slashParts = part.split("/");
    if (slashParts.length > 2) {
      throw new Error(`Invalid step syntax in cron field '${field}'`);
    }
    const [rangePart, stepStr] = slashParts;
    if (!rangePart) {
      throw new Error(`Missing range before '/' in cron field '${field}'`);
    }
    let step = 1;
    if (stepStr !== undefined) {
      if (!/^\d+$/.test(stepStr)) {
        throw new Error(`Invalid cron step '${stepStr}' in '${field}'`);
      }
      step = Number(stepStr);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`Cron step must be > 0 in '${field}'`);
      }
    }
    if (rangePart === "*") {
      for (let v = min; v <= max; v += step) {
        allowed.add(isDow && v === 7 ? 0 : v);
      }
      continue;
    }
    if (rangePart.includes("-")) {
      const dashParts = rangePart.split("-");
      if (dashParts.length !== 2 || !dashParts[0] || !dashParts[1]) {
        throw new Error(`Invalid cron range '${rangePart}' in '${field}'`);
      }
      const a = parseCronToken(dashParts[0], min, max, { isDow, isMonth });
      const b = parseCronToken(dashParts[1], min, max, { isDow, isMonth });
      if (a <= b) {
        for (let v = a; v <= b; v += step) {
          allowed.add(isDow && v === 7 ? 0 : v);
        }
      } else {
        if (!isDow) {
          throw new Error(`Cron range start (${a}) exceeds end (${b}) in '${field}'`);
        }
        const endWrap = b + 7;
        for (let v = a; v <= endWrap; v += step) {
          allowed.add(v % 7);
        }
      }
      continue;
    }
    const single = parseCronToken(rangePart, min, max, { isDow, isMonth });
    if (stepStr === undefined) {
      allowed.add(isDow && single === 7 ? 0 : single);
    } else {
      const loopMax = isDow ? 7 : max;
      for (let v = single; v <= loopMax; v += step) {
        allowed.add(isDow && v === 7 ? 0 : v);
      }
    }
  }
  return allowed;
}

function matchesCronField(fieldExpr, value, min, max, opts = {}) {
  const allowed = validateCronField(fieldExpr, min, max, opts);
  const checkVal = opts.isDow && value === 7 ? 0 : value;
  return allowed.has(checkVal);
}

function computeNextCronRun(cronExpr, fromDate = new Date()) {
  const fields = String(cronExpr || "").trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid 5-field cron expression: '${cronExpr}'`);
  }
  const [minF, hourF, domF, monF, dowF] = fields;
  const minSet = validateCronField(minF, 0, 59, {});
  const hourSet = validateCronField(hourF, 0, 23, {});
  const domSet = validateCronField(domF, 1, 31, {});
  const monSet = validateCronField(monF, 1, 12, { isMonth: true });
  const dowSet = validateCronField(dowF, 0, 6, { isDow: true });

  const isStar = (f) => f.startsWith("*");
  const domRestricted = !isStar(domF);
  const dowRestricted = !isStar(dowF);

  const sortedHours = Array.from(hourSet).sort((a, b) => a - b);
  const sortedMinutes = Array.from(minSet).sort((a, b) => a - b);
  if (sortedHours.length === 0 || sortedMinutes.length === 0) {
    throw new Error(`Cron expression '${cronExpr}' has no valid hour/minute slots.`);
  }

  const startCursor = new Date(fromDate.getTime());
  startCursor.setSeconds(0, 0);
  startCursor.setMinutes(startCursor.getMinutes() + 1);
  const baseYear = startCursor.getFullYear();
  const baseMonth = startCursor.getMonth();
  const baseDate = startCursor.getDate();

  // Scan day-by-day up to 3000 days (~8.2 years) so leap-day crons (0 0 29 2 *)
  // succeed across 4-year and 8-year century boundaries while skipping non-matching days in O(1).
  for (let dayOffset = 0; dayOffset < 3000; dayOffset++) {
    const dayDate = new Date(baseYear, baseMonth, baseDate + dayOffset, 12, 0, 0, 0);
    if (!monSet.has(dayDate.getMonth() + 1)) continue;
    const dom = dayDate.getDate();
    const dow = dayDate.getDay();
    const domMatch = domSet.has(dom);
    const dowMatch = dowSet.has(dow);
    const dayMatch = domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
    if (!dayMatch) continue;

    for (const h of sortedHours) {
      if (dayOffset === 0 && h < startCursor.getHours()) continue;
      for (const m of sortedMinutes) {
        const cand = new Date(dayDate.getFullYear(), dayDate.getMonth(), dom, h, m, 0, 0);
        if (
          cand.getMonth() === dayDate.getMonth() &&
          cand.getDate() === dom &&
          cand.getHours() === h &&
          cand.getMinutes() === m &&
          cand.getTime() >= startCursor.getTime()
        ) {
          return cand.toISOString();
        }
        if (dayOffset === 0 && cand.getTime() < startCursor.getTime()) {
          const candFallBack = new Date(cand.getTime() + 3600000);
          if (
            candFallBack.getMonth() === dayDate.getMonth() &&
            candFallBack.getDate() === dom &&
            candFallBack.getHours() === h &&
            candFallBack.getMinutes() === m &&
            candFallBack.getTime() >= startCursor.getTime()
          ) {
            return candFallBack.toISOString();
          }
        }
      }
    }
  }
  throw new Error(`Cron expression '${cronExpr}' has no upcoming execution window within 8 years.`);
}

function upsertSchedule(workspacePath, { routineId, name, cronExpr, prompt, targetRole = "explorer", workspaceMode = "share", enabled = true }) {
  const db = openProjectDb(workspacePath);
  const nextRunAt = computeNextCronRun(cronExpr);
  const id = routineId || `cron-${crypto.randomUUID().slice(0, 8)}`;
  const normRole = normalizeRole(targetRole);
  db.prepare(`
    INSERT INTO scheduled_routines (
      routine_id, name, cron_expr, prompt, target_role, workspace_mode, enabled, next_run_at,
      last_error, last_error_at, consecutive_failures
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)
    ON CONFLICT(routine_id) DO UPDATE SET
      name = excluded.name,
      cron_expr = excluded.cron_expr,
      prompt = excluded.prompt,
      target_role = excluded.target_role,
      workspace_mode = excluded.workspace_mode,
      enabled = excluded.enabled,
      next_run_at = excluded.next_run_at,
      last_error = NULL,
      last_error_at = NULL,
      consecutive_failures = 0
  `).run(id, name, cronExpr, prompt, normRole, workspaceMode, enabled ? 1 : 0, nextRunAt);
  return db.prepare("SELECT * FROM scheduled_routines WHERE routine_id = ?").get(id);
}

function processDueSchedules(workspacePath, { now = new Date(), onDispatch, maxConsecutiveFailures = 5 } = {}) {
  if (!hasProjectInitialized(workspacePath)) return { dispatched: [], failed: [] };
  const cfg = loadProjectConfig(workspacePath);
  if (!cfg || cfg.status !== "active") return { dispatched: [], failed: [] };

  const sql = openProjectDb(workspacePath);
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowStr = nowDate.toISOString();
  const dueRoutines = sql
    .prepare("SELECT * FROM scheduled_routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?")
    .all(nowStr);

  const dispatched = [];
  const failed = [];
  const failureCap = Math.max(1, Number(maxConsecutiveFailures) || 5);

  for (const r of dueRoutines) {
    // Compute next execution window outside the dispatch failure path so invalid crons fail cleanly without spawning threads
    let nextIso = null;
    try {
      nextIso = computeNextCronRun(r.cron_expr, nowDate);
    } catch (cronErr) {
      const errMsg = String(cronErr?.message || cronErr).slice(0, 500);
      const nextFailures = Number(r.consecutive_failures || 0) + 1;
      const badClaim = sql.prepare(`
        UPDATE scheduled_routines
        SET last_error = ?, last_error_at = ?,
            consecutive_failures = ?,
            next_run_at = NULL, enabled = 0
        WHERE routine_id = ? AND enabled = 1 AND next_run_at = ?
      `).run(errMsg, nowStr, nextFailures, r.routine_id, r.next_run_at);
      if (badClaim.changes === 1) {
        failed.push({
          routineId: r.routine_id,
          threadId: null,
          error: errMsg,
          nextRunAt: null,
          enabled: false,
          consecutiveFailures: nextFailures
        });
      }
      continue;
    }

    // Claim the routine window atomically before registering any thread or dispatching
    const claim = sql.prepare(`
      UPDATE scheduled_routines
      SET next_run_at = ?
      WHERE routine_id = ? AND enabled = 1 AND next_run_at = ?
    `).run(nextIso, r.routine_id, r.next_run_at);
    if (claim.changes !== 1) continue;

    let thread = null;
    try {
      const normRole = normalizeRole(r.target_role || "explorer");
      thread = registerThread(workspacePath, {
        title: `[Routine] ${r.name}`,
        description: r.prompt,
        role: normRole,
        workspaceMode: r.workspace_mode || "share"
      });
      sql.prepare("UPDATE scheduled_routines SET last_thread_id = ? WHERE routine_id = ?")
        .run(thread.thread_id, r.routine_id);

      let dispatchRes = null;
      if (typeof onDispatch === "function") {
        dispatchRes = onDispatch({ workspacePath, routine: r, thread, normRole });
      }
      if (dispatchRes && typeof dispatchRes === "object" && (dispatchRes.headlessAuthMissing || dispatchRes.started === false)) {
        const reasonMsg =
          dispatchRes.error ||
          (dispatchRes.headlessAuthMissing
            ? "Headless SDK authentication missing."
            : `Headless dispatch failed (${dispatchRes.reason || "not_started"}).`);
        throw new Error(reasonMsg);
      }

      sql.prepare(`
        UPDATE scheduled_routines
        SET last_run_at = ?, last_thread_id = ?,
            last_error = NULL, last_error_at = NULL, consecutive_failures = 0
        WHERE routine_id = ?
      `).run(nowStr, thread.thread_id, r.routine_id);
      dispatched.push({ routineId: r.routine_id, threadId: thread.thread_id, nextRunAt: nextIso });
    } catch (err) {
      const errMsg = String(err?.message || err).slice(0, 500);
      if (thread?.thread_id) {
        try {
          const latestThread = sql.prepare("SELECT ui_bucket, blocking_is_error FROM threads WHERE thread_id = ?").get(thread.thread_id);
          if (latestThread && !(latestThread.ui_bucket === "waiting_on_you" && Number(latestThread.blocking_is_error) === 1)) {
            updateThreadState(workspacePath, {
              threadId: thread.thread_id,
              uiBucket: "waiting_on_you",
              blockingQuestion: `Routine dispatch failed: ${errMsg}`,
              blockingIsError: true
            });
          }
        } catch {}
      }
      const nextFailures = Number(r.consecutive_failures || 0) + 1;
      const shouldDisable = nextFailures >= failureCap;
      const backoffMinutes = Math.min(60, 5 * Math.pow(2, Math.max(0, nextFailures - 1)));
      const backoffIso = shouldDisable
        ? null
        : new Date(Math.max(Date.parse(nextIso), nowDate.getTime() + backoffMinutes * 60 * 1000)).toISOString();
      const keepEnabled = shouldDisable ? 0 : 1;
      sql.prepare(`
        UPDATE scheduled_routines
        SET last_error = ?, last_error_at = ?,
            consecutive_failures = ?,
            next_run_at = ?, enabled = ?,
            last_thread_id = COALESCE(?, last_thread_id)
        WHERE routine_id = ?
      `).run(errMsg, nowStr, nextFailures, backoffIso, keepEnabled, thread?.thread_id || null, r.routine_id);
      failed.push({
        routineId: r.routine_id,
        threadId: thread?.thread_id || null,
        error: errMsg,
        nextRunAt: backoffIso,
        enabled: Boolean(keepEnabled),
        consecutiveFailures: nextFailures
      });
    }
  }
  return { dispatched, failed };
}

// ---------- Multi-Repo Pull Request Sync & Auto-Fix Engine ----------

function defaultGhRunner(args, cwd) {
  return execFileSync("gh", args, {
    cwd,
    encoding: "utf8",
    timeout: 8000,
    stdio: ["ignore", "pipe", "ignore"]
  });
}

function defaultGhRunnerAsync(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      { cwd, encoding: "utf8", timeout: 8000 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      }
    );
  });
}

const GH_PR_LIST_ARGS = ["pr", "list", "--state", "open", "--limit", "30", "--json", "number,title,url,headRefName,baseRefName"];
const GH_PR_VIEW_FIELDS =
  "state,statusCheckRollup,reviewDecision,mergeStateStatus,isInMergeQueue,title,url,headRefName,baseRefName,reviews,comments,additions,deletions,changedFiles";

function applyPrMergeOrderRanks(db, mergeOrderRanks) {
  if (!Array.isArray(mergeOrderRanks)) return;
  const rankStmt = db.prepare("UPDATE pull_requests SET merge_order_rank = ?, updated_at = ? WHERE pr_id = ?");
  for (const entry of mergeOrderRanks) {
    if (!entry) continue;
    let targetPrId = entry.prId || null;
    if (!targetPrId && entry.repoId && entry.prNumber) {
      targetPrId = `${entry.repoId}#${Number(entry.prNumber)}`;
    }
    if (targetPrId && entry.rank !== undefined) {
      rankStmt.run(Number(entry.rank), nowIso(), targetPrId);
    }
  }
}

function applyPrDiscovery(db, repo, threads, listRaw) {
  const openList = JSON.parse(listRaw || "[]");
  if (!Array.isArray(openList)) return;
  for (const item of openList) {
    if (!item || !item.number || !item.headRefName) continue;
    const matchingThread = threads.find(
      (t) =>
        t.branch_name === item.headRefName ||
        item.headRefName.startsWith(`project/${t.thread_id}`)
    );
    if (!matchingThread) continue;
    const prId = `${repo.repo_id}#${Number(item.number)}`;
    const existsPr = db.prepare("SELECT pr_id, state FROM pull_requests WHERE pr_id = ?").get(prId);
    if (!existsPr) {
      db.prepare(`
        INSERT INTO pull_requests (
          pr_id, repo_id, thread_id, pr_number, url, title, head_branch, base_branch, state, autofix_enabled, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', 1, ?)
      `).run(
        prId,
        repo.repo_id,
        matchingThread.thread_id,
        Number(item.number),
        String(item.url || ""),
        String(item.title || matchingThread.title),
        String(item.headRefName),
        String(item.baseRefName || repo.default_branch || "main"),
        nowIso()
      );
      db.prepare("UPDATE threads SET pr_number = COALESCE(pr_number, ?), pr_url = COALESCE(pr_url, ?), updated_at = ? WHERE thread_id = ?")
        .run(Number(item.number), String(item.url || ""), nowIso(), matchingThread.thread_id);
    } else if (String(existsPr.state || "OPEN").toUpperCase() === "CLOSED") {
      db.prepare("UPDATE pull_requests SET state = 'OPEN', updated_at = ? WHERE pr_id = ?")
        .run(nowIso(), prId);
    }
  }
}

function applyPrViewResult(workspacePath, db, cfg, repo, pr, raw, { triggerAutoFix }) {
  const info = JSON.parse(raw);
  const rollup = Array.isArray(info.statusCheckRollup) ? info.statusCheckRollup : [];
  const failingChecks = rollup
    .filter((c) => ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"].includes(c.conclusion || c.state))
    .map((c) => ({
      name: c.name || c.context || "check",
      conclusion: c.conclusion || c.state || "FAILURE",
      detailsUrl: c.detailsUrl || c.targetUrl || ""
    }));
  const pendingChecks = rollup.filter((c) => ["IN_PROGRESS", "QUEUED", "PENDING"].includes(c.status || c.state));

  let ciStatus = "passing";
  if (failingChecks.length > 0) {
    ciStatus = "failing";
  } else if (pendingChecks.length > 0) {
    ciStatus = "pending";
  }
  if (info.mergeStateStatus === "DIRTY") {
    ciStatus = "conflict";
  }

  const reviewDecision = info.reviewDecision || pr.review_decision || "REVIEW_REQUIRED";
  const reviews = Array.isArray(info.reviews) ? info.reviews : [];
  const comments = Array.isArray(info.comments) ? info.comments : [];
  const changeReqNotes = reviews
    .filter((r) => r && (r.state === "CHANGES_REQUESTED" || r.body))
    .slice(-4)
    .map((r) => `[Review ${r.state || "NOTE"} by ${r.author?.login || "reviewer"}]: ${String(r.body || "").slice(0, 300)}`);
  const recentCommentNotes = comments
    .slice(-4)
    .map((c) => `[Comment by ${c.author?.login || "user"}]: ${String(c.body || "").slice(0, 260)}`);

  const prevState = String(pr.state || "OPEN").toUpperCase();
  const nextState = String(info.state || prevState || "OPEN").toUpperCase();

  const eventHash = sha256Hex(
    JSON.stringify({
      state: nextState,
      ciStatus,
      reviewDecision,
      mergeStateStatus: info.mergeStateStatus || "",
      failingChecks: failingChecks.map((c) => `${c.name}:${c.conclusion}`),
      reviewCount: reviews.length,
      commentCount: comments.length
    })
  ).slice(0, 16);

  const nextAttempts =
    ciStatus === "passing" && reviewDecision !== "CHANGES_REQUESTED"
      ? 0
      : Number(pr.autofix_attempts || 0);

  const additionsVal =
    info.additions !== undefined && info.additions !== null && Number.isFinite(Number(info.additions))
      ? Math.max(0, Math.floor(Number(info.additions)))
      : null;
  const deletionsVal =
    info.deletions !== undefined && info.deletions !== null && Number.isFinite(Number(info.deletions))
      ? Math.max(0, Math.floor(Number(info.deletions)))
      : null;
  const changedFilesVal =
    info.changedFiles !== undefined && info.changedFiles !== null && Number.isFinite(Number(info.changedFiles))
      ? Math.max(0, Math.floor(Number(info.changedFiles)))
      : null;

  db.prepare(`
    UPDATE pull_requests SET
      state = ?,
      title = COALESCE(?, title),
      url = COALESCE(?, url),
      head_branch = COALESCE(?, head_branch),
      base_branch = COALESCE(?, base_branch),
      ci_status = ?,
      review_decision = ?,
      autofix_attempts = ?,
      additions = COALESCE(?, additions),
      deletions = COALESCE(?, deletions),
      changed_files = COALESCE(?, changed_files),
      updated_at = ?
    WHERE pr_id = ?
  `).run(
    nextState,
    info.title || null,
    info.url || null,
    info.headRefName || null,
    info.baseRefName || null,
    ciStatus,
    reviewDecision,
    nextAttempts,
    additionsVal,
    deletionsVal,
    changedFilesVal,
    nowIso(),
    pr.pr_id
  );

  const ownerThread = db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(pr.thread_id);

  if (nextState === "MERGED") {
    if (prevState !== "MERGED") {
      db.prepare("UPDATE pull_requests SET state = 'MERGED', autofix_attempts = 0, autofix_enabled = 0, updated_at = ? WHERE pr_id = ?")
        .run(nowIso(), pr.pr_id);
      if (ownerThread) {
        updateThreadState(workspacePath, {
          threadId: pr.thread_id,
          uiBucket: "resolved",
          summary: `PR #${pr.pr_number} merged.`
        });
      }
      if (pr.thread_id) {
        try {
          manageWorktree(workspacePath, { action: "cleanup", threadId: pr.thread_id, repoId: pr.repo_id });
        } catch {}
      }
    }
    return null;
  }

  if (nextState === "CLOSED") {
    if (prevState !== "CLOSED") {
      db.prepare("UPDATE pull_requests SET state = 'CLOSED', autofix_enabled = 0, updated_at = ? WHERE pr_id = ?")
        .run(nowIso(), pr.pr_id);
      if (ownerThread && ownerThread.ui_bucket !== "resolved") {
        updateThreadState(workspacePath, {
          threadId: pr.thread_id,
          uiBucket: "idle",
          summary: `PR #${pr.pr_number} closed without merge.`
        });
      }
    }
    return null;
  }

  if (ciStatus === "passing" && reviewDecision !== "CHANGES_REQUESTED") {
    if (ownerThread) {
      const isLanding = Boolean(
        info.isInMergeQueue ||
        info.mergeStateStatus === "QUEUED" ||
        reviewDecision === "APPROVED"
      );
      if (isLanding && ownerThread.ui_bucket !== "landing" && ownerThread.ui_bucket !== "resolved") {
        updateThreadState(workspacePath, {
          threadId: pr.thread_id,
          uiBucket: "landing",
          summary: `PR #${pr.pr_number} approved with passing checks (ready to land).`
        });
      } else if (!isLanding && ownerThread.ui_bucket === "working") {
        updateThreadState(workspacePath, {
          threadId: pr.thread_id,
          uiBucket: "ready_for_review",
          summary: `PR #${pr.pr_number} CI checks passing.`
        });
      }
    }
    return null;
  }

  if (
    triggerAutoFix &&
    cfg.status === "active" &&
    Number(pr.autofix_enabled) === 1 &&
    eventHash !== pr.last_seen_event_hash &&
    (ciStatus === "failing" || ciStatus === "conflict" || reviewDecision === "CHANGES_REQUESTED")
  ) {
    const attempts = Number(pr.autofix_attempts || 0);
    if (attempts >= 3) {
      db.prepare("UPDATE pull_requests SET autofix_enabled = 0, last_seen_event_hash = ?, updated_at = ? WHERE pr_id = ?")
        .run(eventHash, nowIso(), pr.pr_id);
      if (ownerThread) {
        updateThreadState(workspacePath, {
          threadId: pr.thread_id,
          uiBucket: "waiting_on_you",
          blockingQuestion: `Auto-Fix paused after 3 remediation attempts on PR #${pr.pr_number} (${ciStatus}). Review manually.`,
          blockingIsError: true
        });
      }
      return null;
    }

    const wtCwd = ensureThreadIsolationCwd(workspacePath, pr.thread_id);
    const detailLines = [
      `PR #${pr.pr_number} (${info.url || pr.url}) reported CI='${ciStatus}', reviewDecision='${reviewDecision}', mergeState='${info.mergeStateStatus || "UNKNOWN"}'.`,
      ...(failingChecks.length > 0
        ? [
            "Failing Checks:",
            ...failingChecks.map((c) => `- ${c.name} (${c.conclusion})${c.detailsUrl ? `: ${c.detailsUrl}` : ""}`)
          ]
        : []),
      ...changeReqNotes,
      ...recentCommentNotes,
      `Work on branch '${info.headRefName || pr.head_branch}' in worktree '${wtCwd}'. Diagnose failures, apply minimal targeted fixes, verify tests locally, commit, and push.`
    ];

    return {
      ownerThread,
      attempts,
      eventHash,
      ciStatus,
      spawnPayload: {
        threadId: pr.thread_id,
        cwd: wtCwd,
        prompt: detailLines.join("\n")
      }
    };
  }

  return null;
}

function finalizeAutoFixSpawn(workspacePath, db, pr, pending, spawnRes) {
  if (!pending) return;
  if (spawnRes && spawnRes.started === false) {
    if (spawnRes.reason === "auth_required" && pending.ownerThread) {
      updateThreadState(workspacePath, {
        threadId: pr.thread_id,
        uiBucket: "waiting_on_you",
        blockingQuestion: spawnRes.error || "Headless SDK requires GEMINI_API_KEY (or GOOGLE_GENAI_USE_VERTEXAI=1).",
        blockingIsError: true
      });
    }
    return;
  }

  db.prepare(`
    UPDATE pull_requests
    SET autofix_attempts = autofix_attempts + 1, last_seen_event_hash = ?, updated_at = ?
    WHERE pr_id = ?
  `).run(pending.eventHash, nowIso(), pr.pr_id);

  if (pending.ownerThread) {
    updateThreadState(workspacePath, {
      threadId: pr.thread_id,
      uiBucket: "working",
      summary: `Auto-Fix attempt #${pending.attempts + 1} started for PR #${pr.pr_number} (${pending.ciStatus}).`
    });
  }
}

function syncPullRequests(
  workspacePath,
  {
    repoId = null,
    triggerAutoFix = false,
    mergeOrderRanks = null,
    onSpawnAutoFix = null,
    ghRunner = defaultGhRunner
  } = {}
) {
  const db = openProjectDb(workspacePath);
  const cfg = loadProjectConfig(workspacePath);
  if (!cfg) return [];

  applyPrMergeOrderRanks(db, mergeOrderRanks);

  const repos = repoId
    ? db.prepare("SELECT * FROM repositories WHERE repo_id = ?").all(repoId)
    : db.prepare("SELECT * FROM repositories").all();
  const threads = db.prepare("SELECT * FROM threads").all();
  const updated = [];

  for (const repo of repos) {
    try {
      const listRaw = ghRunner(GH_PR_LIST_ARGS, repo.local_path);
      applyPrDiscovery(db, repo, threads, listRaw);
    } catch {}

    const prs = db.prepare("SELECT * FROM pull_requests WHERE repo_id = ?").all(repo.repo_id);
    for (const pr of prs) {
      const currState = String(pr.state || "OPEN").toUpperCase();
      if (currState === "MERGED" || currState === "CLOSED") {
        updated.push(pr);
        continue;
      }
      try {
        const raw = ghRunner(["pr", "view", String(pr.pr_number), "--json", GH_PR_VIEW_FIELDS], repo.local_path);
        const pending = applyPrViewResult(workspacePath, db, cfg, repo, pr, raw, { triggerAutoFix });
        if (pending) {
          const spawnRes = typeof onSpawnAutoFix === "function" ? onSpawnAutoFix(pending.spawnPayload) : null;
          finalizeAutoFixSpawn(workspacePath, db, pr, pending, spawnRes);
        }
        updated.push(db.prepare("SELECT * FROM pull_requests WHERE pr_id = ?").get(pr.pr_id));
      } catch {
        updated.push(pr);
      }
    }
  }
  return updated;
}

async function syncPullRequestsAsync(
  workspacePath,
  {
    repoId = null,
    triggerAutoFix = false,
    mergeOrderRanks = null,
    onSpawnAutoFix = null,
    ghRunner = defaultGhRunnerAsync
  } = {}
) {
  const db = openProjectDb(workspacePath);
  const cfg = loadProjectConfig(workspacePath);
  if (!cfg) return [];

  applyPrMergeOrderRanks(db, mergeOrderRanks);

  const repos = repoId
    ? db.prepare("SELECT * FROM repositories WHERE repo_id = ?").all(repoId)
    : db.prepare("SELECT * FROM repositories").all();
  const threads = db.prepare("SELECT * FROM threads").all();
  const updated = [];

  for (const repo of repos) {
    try {
      const listRaw = await ghRunner(GH_PR_LIST_ARGS, repo.local_path);
      applyPrDiscovery(db, repo, threads, listRaw);
    } catch {}

    const prs = db.prepare("SELECT * FROM pull_requests WHERE repo_id = ?").all(repo.repo_id);
    for (const pr of prs) {
      const currState = String(pr.state || "OPEN").toUpperCase();
      if (currState === "MERGED" || currState === "CLOSED") {
        updated.push(pr);
        continue;
      }
      try {
        const raw = await ghRunner(["pr", "view", String(pr.pr_number), "--json", GH_PR_VIEW_FIELDS], repo.local_path);
        const pending = applyPrViewResult(workspacePath, db, cfg, repo, pr, raw, { triggerAutoFix });
        if (pending) {
          const spawnRes = typeof onSpawnAutoFix === "function" ? await onSpawnAutoFix(pending.spawnPayload) : null;
          finalizeAutoFixSpawn(workspacePath, db, pr, pending, spawnRes);
        }
        updated.push(db.prepare("SELECT * FROM pull_requests WHERE pr_id = ?").get(pr.pr_id));
      } catch {
        updated.push(pr);
      }
    }
  }
  return updated;
}

// ---------- Privacy-Safe Chat Snapshots (AT-07) ----------

function escapeHtmlServer(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createChatSnapshot(workspacePath, { snapshotId: existingSnapshotId, conversationId, transcriptPath, title, maxStepIndex, publishToFeed } = {}) {
  const db = openProjectDb(workspacePath);
  let cleanSnapId = "";
  if (existingSnapshotId !== undefined && existingSnapshotId !== null && String(existingSnapshotId).trim() !== "") {
    const rawSnapId = String(existingSnapshotId).trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(rawSnapId)) {
      const err = new Error("Invalid snapshotId.");
      err.statusCode = 400;
      throw err;
    }
    cleanSnapId = rawSnapId;
    const prev = db.prepare("SELECT * FROM activity_snapshots WHERE snapshot_id = ? AND revoked = 0").get(cleanSnapId);
    if (!prev) {
      const err = new Error("Snapshot not found or revoked.");
      err.statusCode = 404;
      throw err;
    }
    if (conversationId !== undefined && conversationId !== null && String(conversationId).trim() !== "") {
      if (String(conversationId).trim() !== prev.conversation_id) {
        const err = new Error("conversationId does not match existing snapshot.");
        err.statusCode = 400;
        throw err;
      }
    }
    conversationId = prev.conversation_id;
    title = title || prev.title;
    publishToFeed = publishToFeed !== undefined ? Boolean(publishToFeed) : Boolean(prev.published_to_feed);
  } else {
    publishToFeed = Boolean(publishToFeed);
  }

  const convStr = String(conversationId || "").trim();
  if (!convStr || convStr.includes("/") || convStr.includes("\\") || convStr.includes("..") || convStr.includes("\0")) {
    const err = new Error("Invalid conversationId.");
    err.statusCode = 400;
    throw err;
  }
  conversationId = convStr;

  const brainRoot = path.join(getAppDataDir(), "brain");
  const realBrain = fs.existsSync(brainRoot) ? fs.realpathSync(brainRoot) : resolveRealPathWithAncestor(brainRoot);
  function isStrictInsideBrain(targetPathResolved) {
    let a = targetPathResolved;
    let b = realBrain;
    if (process.platform === "darwin" || process.platform === "win32") {
      a = a.toLowerCase();
      b = b.toLowerCase();
    }
    const rel = path.relative(b, a);
    return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  let resolvedTranscript = "";
  if (transcriptPath !== undefined && transcriptPath !== null && String(transcriptPath).trim() !== "") {
    const rawTp = String(transcriptPath);
    if (fs.existsSync(rawTp)) {
      const realTp = fs.realpathSync(rawTp);
      if (!isStrictInsideBrain(realTp)) {
        const err = new Error("Forbidden: transcriptPath must reside inside <appDataDir>/brain/.");
        err.statusCode = 403;
        throw err;
      }
      if (!fs.statSync(realTp).isFile()) {
        const err = new Error("transcriptPath must be a regular file.");
        err.statusCode = 400;
        throw err;
      }
      resolvedTranscript = realTp;
    } else {
      const resolvedMaybe = resolveRealPathWithAncestor(rawTp);
      if (!isStrictInsideBrain(resolvedMaybe)) {
        const err = new Error("Forbidden: transcriptPath must reside inside <appDataDir>/brain/.");
        err.statusCode = 403;
        throw err;
      }
      const err = new Error(`Transcript file not found for conversation '${conversationId}'.`);
      err.statusCode = 400;
      throw err;
    }
  } else {
    const defaultTp = path.join(brainRoot, conversationId, ".system_generated", "logs", "transcript.jsonl");
    if (!fs.existsSync(defaultTp)) {
      throw new Error(`Transcript file not found for conversation '${conversationId}'.`);
    }
    const realDefault = fs.realpathSync(defaultTp);
    if (!isStrictInsideBrain(realDefault) || !fs.statSync(realDefault).isFile()) {
      const err = new Error("Forbidden: transcriptPath must reside inside <appDataDir>/brain/.");
      err.statusCode = 403;
      throw err;
    }
    resolvedTranscript = realDefault;
  }

  const rawLines = fs.readFileSync(resolvedTranscript, "utf8").split(/\r?\n/).filter(Boolean);
  let cutoff = typeof maxStepIndex === "number" ? maxStepIndex : -1;
  const parsedSteps = [];
  for (const line of rawLines) {
    try {
      const obj = JSON.parse(line);
      const idx = typeof obj.step_index === "number" ? obj.step_index : parsedSteps.length;
      if (cutoff < 0 || idx > cutoff) {
        if (typeof maxStepIndex !== "number") cutoff = Math.max(cutoff, idx);
      }
      parsedSteps.push({ ...obj, _idx: idx });
    } catch {}
  }

  const needsFullHydration = parsedSteps.some(
    (step) => step._idx <= cutoff && Array.isArray(step.truncated_fields) && step.truncated_fields.includes("content")
  );
  if (needsFullHydration) {
    const fullCandidate = path.join(path.dirname(resolvedTranscript), "transcript_full.jsonl");
    if (fs.existsSync(fullCandidate)) {
      try {
        const realFull = fs.realpathSync(fullCandidate);
        if (isStrictInsideBrain(realFull) && fs.statSync(realFull).isFile()) {
          const fullLines = fs.readFileSync(realFull, "utf8").split(/\r?\n/).filter(Boolean);
          const fullMap = new Map();
          for (let lineIdx = 0; lineIdx < fullLines.length; lineIdx++) {
            try {
              const fullObj = JSON.parse(fullLines[lineIdx]);
              const fullIdx = typeof fullObj.step_index === "number" ? fullObj.step_index : lineIdx;
              fullMap.set(fullIdx, fullObj);
            } catch {}
          }
          for (const step of parsedSteps) {
            if (step._idx <= cutoff && Array.isArray(step.truncated_fields) && step.truncated_fields.includes("content")) {
              const fullStep = fullMap.get(step._idx);
              if (fullStep && typeof fullStep.content === "string") {
                step.content = fullStep.content;
              }
            }
          }
        }
      } catch {}
    }
  }

  const sanitizedTurns = [];
  for (const step of parsedSteps) {
    if (step._idx > cutoff) continue; // Strictly exclude post-snapshot messages
    const type = String(step.type || "");
    if (type !== "USER_INPUT" && type !== "PLANNER_RESPONSE") continue;
    const textContent = typeof step.content === "string" ? step.content.trim() : "";
    if (!textContent) continue;

    // PRIVACY INVARIANT (Claude Projects Snapshot Contract):
    // Strip step.tool_calls (raw MCP payloads/args), step.thinking, and step.media (raw uploaded source attachments).
    sanitizedTurns.push({
      stepIndex: step._idx,
      role: type === "USER_INPUT" ? "user" : "assistant",
      createdAt: step.created_at || null,
      content: textContent
    });
  }

  const snapshotId = existingSnapshotId ? cleanSnapId : `snap-${crypto.randomUUID().slice(0, 10)}`;
  const snapDir = path.join(getProjectDir(workspacePath), "state", "snapshots");
  fs.mkdirSync(snapDir, { recursive: true });
  const jsonPath = path.join(snapDir, `${snapshotId}.json`);
  const htmlPath = path.join(snapDir, `${snapshotId}.html`);
  const ts = nowIso();
  const snapTitle = title || `Conversation Snapshot (${String(conversationId).slice(0, 8)})`;

  const snapshotBundle = {
    snapshotId,
    title: snapTitle,
    conversationId,
    maxStepIndex: cutoff,
    createdAt: ts,
    privacyNotice: "Point-in-time snapshot. Subsequent turns, raw uploaded source attachments, and MCP tool payloads are excluded.",
    turns: sanitizedTurns
  };
  writeJsonAtomic(jsonPath, snapshotBundle, 0o600);

  const htmlDoc = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtmlServer(snapTitle)}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 52rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.55; }
    .turn { border: 1px solid rgba(128,128,128,0.28); border-radius: 10px; padding: 1rem; margin-block: 1rem; white-space: pre-wrap; }
    .role { font-weight: 700; font-size: 0.8rem; text-transform: uppercase; opacity: 0.72; margin-bottom: 0.4rem; }
  </style>
</head>
<body>
  <h1>${escapeHtmlServer(snapTitle)}</h1>
  <p><small>Snapshot cutoff step #${cutoff} • Created ${escapeHtmlServer(ts)} • Raw uploads &amp; MCP payloads excluded</small></p>
  ${sanitizedTurns.map((t) => `<article class="turn"><div class="role">${escapeHtmlServer(t.role)}</div><div>${escapeHtmlServer(t.content)}</div></article>`).join("\n")}
</body>
</html>`;
  writeTextAtomic(htmlPath, htmlDoc, 0o600);

  db.prepare(`
    INSERT INTO activity_snapshots (
      snapshot_id, conversation_id, created_by, title, max_step_index, snapshot_path, published_to_feed, revoked, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(snapshot_id) DO UPDATE SET
      title = excluded.title,
      max_step_index = excluded.max_step_index,
      snapshot_path = excluded.snapshot_path,
      published_to_feed = excluded.published_to_feed,
      created_at = excluded.created_at
    WHERE activity_snapshots.revoked = 0
  `).run(
    snapshotId,
    conversationId,
    os.userInfo().username || "owner",
    snapTitle,
    cutoff,
    jsonPath,
    publishToFeed ? 1 : 0,
    ts
  );

  return {
    snapshotId,
    conversationId,
    title: snapTitle,
    maxStepIndex: cutoff,
    turnCount: sanitizedTurns.length,
    publishedToFeed: Boolean(publishToFeed),
    jsonPath,
    htmlPath
  };
}

function readChatSnapshotPreview(workspacePath, snapshotId) {
  const row = openProjectDb(workspacePath)
    .prepare("SELECT * FROM activity_snapshots WHERE snapshot_id = ? AND revoked = 0")
    .get(String(snapshotId || ""));
  if (!row) {
    throw new Error("Snapshot not found or revoked.");
  }
  const jsonBundle = readJsonSafe(row.snapshot_path, null);
  const htmlPath = String(row.snapshot_path || "").replace(/\.json$/, ".html");
  const htmlContent = htmlPath && fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, "utf8") : "";
  return {
    snapshotId: row.snapshot_id,
    conversationId: row.conversation_id,
    title: row.title,
    maxStepIndex: row.max_step_index,
    createdAt: row.created_at,
    publishedToFeed: Boolean(row.published_to_feed),
    jsonBundle,
    htmlContent
  };
}

function revokeChatSnapshot(workspacePath, snapshotId) {
  const rawSnapId = String(snapshotId || "").trim();
  if (!rawSnapId || !/^[a-zA-Z0-9_-]+$/.test(rawSnapId)) {
    const err = new Error("Invalid snapshotId.");
    err.statusCode = 400;
    throw err;
  }
  const cleanSnapId = rawSnapId;
  const db = openProjectDb(workspacePath);
  const row = db.prepare("SELECT * FROM activity_snapshots WHERE snapshot_id = ?").get(cleanSnapId);
  if (!row) {
    const err = new Error("Snapshot not found.");
    err.statusCode = 404;
    throw err;
  }
  db.prepare("UPDATE activity_snapshots SET revoked = 1 WHERE snapshot_id = ?").run(cleanSnapId);
  const deletedFiles = [];
  const snapshotsRoot = path.resolve(path.join(getProjectDir(workspacePath), "state", "snapshots"));
  const realSnapRoot = fs.existsSync(snapshotsRoot) ? fs.realpathSync(snapshotsRoot) : resolveRealPathWithAncestor(snapshotsRoot);
  const candidateSet = new Set([
    path.join(snapshotsRoot, `${cleanSnapId}.json`),
    path.join(snapshotsRoot, `${cleanSnapId}.html`)
  ]);
  if (row.snapshot_path) {
    candidateSet.add(String(row.snapshot_path));
    candidateSet.add(String(row.snapshot_path).replace(/\.json$/, ".html"));
  }
  const seenRealFiles = new Set();
  for (const filePath of candidateSet) {
    if (!filePath) continue;
    const resolved = path.resolve(filePath);
    if (!isPathInsideDir(resolved, snapshotsRoot, { allowEqual: false })) continue;
    try {
      if (fs.existsSync(resolved)) {
        const realFile = fs.realpathSync(resolved);
        if (seenRealFiles.has(realFile)) continue;
        if (isPathInsideDir(realFile, realSnapRoot, { allowEqual: false }) && fs.statSync(realFile).isFile()) {
          fs.unlinkSync(realFile);
          seenRealFiles.add(realFile);
          deletedFiles.push(realFile);
        }
      }
    } catch {}
  }
  return { revoked: true, snapshotId: cleanSnapId, deletedFiles };
}

// ---------- Tier-3 Repository-Local Rules & 4-Tier Context Hydration Builder ----------

function stripWrappingQuotes(s) {
  const t = String(s || "").trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function parseRuleFrontmatter(rawText) {
  const text = String(rawText || "").replace(/^\uFEFF/, "");
  const fmMatch = text.match(/^---\r?\n([\s\S]*?\r?\n)?---(?:\r?\n|$)/);
  if (!fmMatch) {
    return { globs: [], body: text.trim() };
  }
  const yamlBlock = fmMatch[1] || "";
  const body = text.slice(fmMatch[0].length).replace(/^(?:\r?\n)+/, "").trim();
  const globs = [];
  const lines = yamlBlock.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const keyMatch = line.match(/^(?:paths|globs)\s*:\s*(.*)$/);
    if (!keyMatch) continue;
    const inlineVal = keyMatch[1].trim();
    if (inlineVal.startsWith("[")) {
      let parsedList = null;
      try {
        const arr = JSON.parse(inlineVal);
        if (Array.isArray(arr)) parsedList = arr;
      } catch {}
      if (parsedList) {
        for (const item of parsedList) {
          const clean = stripWrappingQuotes(item);
          if (clean) globs.push(clean);
        }
      } else {
        const inner = inlineVal.replace(/^\[/, "").replace(/\]$/, "");
        for (const part of inner.split(",")) {
          const clean = stripWrappingQuotes(part);
          if (clean) globs.push(clean);
        }
      }
    } else if (inlineVal && !inlineVal.startsWith("#")) {
      const clean = stripWrappingQuotes(inlineVal);
      if (clean) globs.push(clean);
    } else {
      for (let j = i + 1; j < lines.length; j++) {
        const sub = lines[j];
        if (!sub.trim() || /^\s*#/.test(sub)) continue;
        const itemMatch = sub.match(/^\s*-\s+(.+)$/);
        if (itemMatch) {
          const clean = stripWrappingQuotes(itemMatch[1]);
          if (clean) globs.push(clean);
          i = j;
        } else {
          break;
        }
      }
    }
  }
  return { globs, body };
}

function globToRegExp(globPattern) {
  let regexStr = "^";
  for (let i = 0; i < globPattern.length; i++) {
    const ch = globPattern[i];
    if (ch === "*") {
      if (globPattern[i + 1] === "*") {
        regexStr += globPattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += globPattern[i + 2] === "/" ? 2 : 1;
      } else {
        regexStr += "[^/]*";
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
  }
  return new RegExp(`${regexStr}$`);
}

function normalizeRuleGlob(g) {
  return String(g || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function matchesGlobPattern(candidate, pattern) {
  if (!candidate || !pattern) return false;
  if (candidate === pattern) return true;
  if (!pattern.includes("*") && !pattern.includes("?") && !pattern.includes("[")) {
    return candidate === pattern || candidate.startsWith(`${pattern}/`);
  }
  if (globToRegExp(pattern).test(candidate)) return true;
  if (pattern.endsWith("/**") && candidate === pattern.slice(0, -3)) return true;
  return false;
}

function staticPrefixDir(globStr) {
  const segs = globStr.split("/");
  const out = [];
  for (const s of segs) {
    if (s.includes("*") || s.includes("?") || s.includes("[")) break;
    out.push(s);
  }
  return out.join("/");
}

function ruleGlobsMatchOwned(ruleGlobs, ownedGlobs) {
  if (!Array.isArray(ruleGlobs) || ruleGlobs.length === 0) return true;
  if (!Array.isArray(ownedGlobs) || ownedGlobs.length === 0) return true;
  for (const rawRule of ruleGlobs) {
    const rg = normalizeRuleGlob(rawRule);
    if (!rg) continue;
    for (const rawOwned of ownedGlobs) {
      const og = normalizeRuleGlob(rawOwned);
      if (!og) continue;
      if (matchesGlobPattern(og, rg) || matchesGlobPattern(rg, og)) return true;
      const rgWildDir = rg.includes("**") || rg.endsWith("/*") || !path.posix.basename(rg).includes(".");
      const ogWildDir = og.includes("**") || og.endsWith("/*") || !path.posix.basename(og).includes(".");
      if ((rg.startsWith("**/") && ogWildDir) || (og.startsWith("**/") && rgWildDir)) {
        return true;
      }
      const rp = staticPrefixDir(rg);
      const op = staticPrefixDir(og);
      if (rp && op && rgWildDir && ogWildDir && (rp === op || rp.startsWith(`${op}/`) || op.startsWith(`${rp}/`))) {
        return true;
      }
    }
  }
  return false;
}

function getConfigContextHash(cfg) {
  return sha256Hex(
    JSON.stringify({
      goal: String(cfg?.goal || ""),
      instructions: String(cfg?.instructions || ""),
      useAccountMemory: Boolean(cfg?.memory?.useAccountMemory)
    })
  );
}

function collectTierThreeRepoRules(workspacePath, role, thread = null) {
  const absWs = path.resolve(workspacePath);
  const db = openProjectDb(absWs);
  const isHeadless = process.env.AGY_HEADLESS_SDK_WORKER === "1";

  let ownedGlobs = [];
  if (thread) {
    if (Array.isArray(thread.owned_globs)) {
      ownedGlobs = thread.owned_globs;
    } else if (typeof thread.owned_globs_json === "string") {
      try {
        const parsed = JSON.parse(thread.owned_globs_json);
        if (Array.isArray(parsed)) ownedGlobs = parsed;
      } catch {}
    }
  }

  let repos = [];
  if (role === "worker" && thread?.repo_id) {
    const r = db.prepare("SELECT * FROM repositories WHERE repo_id = ?").get(thread.repo_id);
    if (r) repos.push(r);
  } else {
    repos = db.prepare("SELECT * FROM repositories ORDER BY added_at ASC").all();
  }

  const seenDirs = new Set();
  const repoRoots = [];
  for (const r of repos) {
    if (!r.local_path) continue;
    const p = path.resolve(r.local_path);
    if (!seenDirs.has(p)) {
      seenDirs.add(p);
      repoRoots.push({ repoId: r.repo_id, name: r.name, dir: p });
    }
  }
  if (!seenDirs.has(absWs)) {
    repoRoots.push({ repoId: null, name: path.basename(absWs), dir: absWs });
  }

  const blocks = [];
  let totalChars = 0;
  const MAX_FILE_CHARS = 4000;
  const MAX_TOTAL_CHARS = 16000;

  for (const root of repoRoots) {
    if (!fs.existsSync(root.dir)) continue;
    const isExternalRepo = root.dir !== absWs;
    const ruleCandidates = [{ path: path.join(root.dir, "CLAUDE.md"), isSubRule: false }];
    if (isExternalRepo || isHeadless) {
      ruleCandidates.push(
        { path: path.join(root.dir, "GEMINI.md"), isSubRule: false },
        { path: path.join(root.dir, "AGENTS.md"), isSubRule: false }
      );
    }
    const claudeRulesDir = path.join(root.dir, ".claude", "rules");
    if (fs.existsSync(claudeRulesDir)) {
      try {
        const extraFiles = fs.readdirSync(claudeRulesDir).filter((f) => f.endsWith(".md")).sort();
        for (const f of extraFiles) {
          ruleCandidates.push({ path: path.join(claudeRulesDir, f), isSubRule: true });
        }
      } catch {}
    }

    for (const cand of ruleCandidates) {
      if (totalChars >= MAX_TOTAL_CHARS) break;
      const rp = cand.path;
      if (!fs.existsSync(rp) || !fs.statSync(rp).isFile()) continue;
      const rawContent = fs.readFileSync(rp, "utf8");
      let bodyText = rawContent.trim();
      let headerSuffix = "";
      if (cand.isSubRule) {
        const fm = parseRuleFrontmatter(rawContent);
        if (role === "worker" && ownedGlobs.length > 0 && !ruleGlobsMatchOwned(fm.globs, ownedGlobs)) {
          continue;
        }
        bodyText = fm.body;
        if (fm.globs.length > 0) {
          headerSuffix = ` (paths: ${fm.globs.join(", ")})`;
        }
      }
      if (!bodyText) continue;
      const relLabel = `${root.name}/${path.relative(root.dir, rp).split(path.sep).join("/")}`;
      const clipped = bodyText.slice(0, Math.min(MAX_FILE_CHARS, MAX_TOTAL_CHARS - totalChars));
      blocks.push(`### ${relLabel}${headerSuffix}\n${clipped}`);
      totalChars += clipped.length;
    }

    if (root.repoId) {
      const rulesEtag = computeRepoRulesEtag(root.dir);
      try {
        db.prepare("UPDATE repositories SET claude_md_etag = ? WHERE repo_id = ?").run(rulesEtag, root.repoId);
      } catch {}
    }
  }

  return blocks;
}

function buildFourTierContextBlock(workspacePath, role, thread = null, { currentConversationId = "", consumeCheckpoint = false } = {}) {
  const cfg = loadProjectConfig(workspacePath);
  if (!cfg) return "";
  const pDir = getProjectDir(workspacePath);
  const { indexPath } = getMemoryPaths(workspacePath);
  const memText = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8").trim() : "";

  const sections = [
    `[AGY PROJECT ACTIVE: ${cfg.name} | PROJECT_ID: ${cfg.projectId} | ROLE: ${role === "coordinator" ? "COORDINATOR" : "WORKER_THREAD"}]`
  ];
  if (thread) {
    sections.push(`<AssignedThread id="${thread.thread_id}" role="${thread.role}" bucket="${thread.ui_bucket}" branch="${thread.branch_name || ""}" worktree="${thread.worktree_path || ""}">\nTitle: ${thread.title}\nDescription: ${thread.description}\n</AssignedThread>`);
  }
  if (cfg.goal) {
    sections.push(`<ProjectGoal>\n${cfg.goal}\n</ProjectGoal>`);
  }
  if (cfg.instructions) {
    sections.push(`<ProjectInstructions>\n${cfg.instructions}\n</ProjectInstructions>`);
  }
  if (memText) {
    sections.push(`<ProjectMemory path="${indexPath}">\n${memText}\n</ProjectMemory>`);
  }
  if (cfg.memory?.useAccountMemory) {
    const acctPath = getAccountMemoryPath();
    if (fs.existsSync(acctPath)) {
      sections.push(`<AccountMemory>\n${fs.readFileSync(acctPath, "utf8").trim()}\n</AccountMemory>`);
    }
  }

  // Tier 3: Repository-local CLAUDE.md, .claude/rules/*.md & external/headless GEMINI.md/AGENTS.md
  const tier3Blocks = collectTierThreeRepoRules(workspacePath, role, thread);
  if (tier3Blocks.length > 0) {
    sections.push(`<RepositoryRules count="${tier3Blocks.length}">\n${tier3Blocks.join("\n\n")}\n</RepositoryRules>`);
  }

  // Hydrate wrapup_checkpoint.md once for newly rolled-over Coordinator sessions
  const wrapPath = path.join(pDir, "state", "wrapup_checkpoint.md");
  if (role === "coordinator" && fs.existsSync(wrapPath)) {
    const wrapText = fs.readFileSync(wrapPath, "utf8").trim();
    if (wrapText) {
      sections.push(`<WrapupCheckpoint>\n${wrapText}\n</WrapupCheckpoint>`);
      const srcMatch = wrapText.match(/^>\s*Source-Coordinator:\s*(\S+)/m);
      const sourceCoord = srcMatch ? srcMatch[1].trim() : "";
      if (consumeCheckpoint && currentConversationId && sourceCoord && currentConversationId !== sourceCoord) {
        try {
          fs.renameSync(wrapPath, path.join(pDir, "state", "wrapup_checkpoint.hydrated.md"));
        } catch {}
      }
    }
  }

  // Tier 4: Pinned Library items (< threshold) OR RAG pointer
  const db = openProjectDb(workspacePath);
  const pinnedItems = db.prepare("SELECT * FROM library_items WHERE index_status = 'pinned' ORDER BY created_at ASC").all();
  if (pinnedItems.length > 0) {
    const pinnedBlocks = [];
    for (const item of pinnedItems) {
      const bodyText = readLibraryItemText(workspacePath, item);
      pinnedBlocks.push(`### ${item.title} (${item.rel_path})\n${String(bodyText || "").slice(0, 24000)}`);
    }
    sections.push(`<PinnedProjectLibrary count="${pinnedItems.length}">\n${pinnedBlocks.join("\n\n")}\n</PinnedProjectLibrary>`);
  } else {
    const indexedCnt = Number(db.prepare("SELECT COUNT(*) AS cnt FROM library_items WHERE index_status = 'indexed'").get()?.cnt || 0);
    if (indexedCnt > 0) {
      sections.push(`<ProjectLibraryRAG mode="contextual_hybrid_rag" indexedItems="${indexedCnt}">\nProject Library exceeds inline pinning threshold. Call search_project_library(query) to retrieve line-cited context.\n</ProjectLibraryRAG>`);
    }
  }

  return sections.join("\n\n");
}

// ---------- Full Workspace Snapshot for Sidecar UI ----------

function buildFullWorkspaceSnapshot(workspacePath) {
  const reg = loadRegistry();
  const enrichedProjects = listProjects({ includeArchived: true }).projects;
  const ws = resolveActiveWorkspace(workspacePath);
  if (!ws || !hasProjectInitialized(ws)) {
    return {
      initialized: false,
      projects: enrichedProjects,
      activeProjectId: reg.activeProjectId
    };
  }
  const cfg = loadProjectConfig(ws);
  const db = openProjectDb(ws);
  const { indexPath, topicsDir } = getMemoryPaths(ws);
  const memoryIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "";
  const topicFiles = fs.existsSync(topicsDir)
    ? fs.readdirSync(topicsDir).filter((f) => f.endsWith(".md")).sort().map((f) => ({
        slug: f.replace(/\.md$/, ""),
        filename: f,
        content: fs.readFileSync(path.join(topicsDir, f), "utf8")
      }))
    : [];

  const threads = db.prepare("SELECT * FROM threads ORDER BY updated_at DESC").all().map((t) => {
    let worktrees = {};
    try {
      const parsedWt = JSON.parse(t.worktrees_json || "{}");
      if (isPlainObject(parsedWt)) worktrees = parsedWt;
    } catch {}
    return {
      ...t,
      owned_globs: JSON.parse(t.owned_globs_json || "[]"),
      live_telemetry: JSON.parse(t.live_telemetry_json || "[]"),
      worktrees
    };
  });
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const todaySpawnCount = Number(
    db.prepare("SELECT COUNT(*) AS cnt FROM threads WHERE created_at >= ? AND ui_bucket != 'suggested'").get(dayStart.toISOString())?.cnt || 0
  );
  const completedCoordinators = db
    .prepare("SELECT * FROM completed_coordinators ORDER BY archived_at DESC LIMIT 10")
    .all();
  const repositories = db.prepare("SELECT * FROM repositories ORDER BY added_at ASC").all();
  const pullRequests = db.prepare("SELECT * FROM pull_requests ORDER BY COALESCE(merge_order_rank, 999) ASC, updated_at DESC").all();
  const libraryItems = db.prepare("SELECT * FROM library_items ORDER BY updated_at DESC").all();
  const totalLibraryTokens = libraryItems.reduce((acc, i) => acc + Number(i.token_count || 0), 0);
  const embeddedChunkCount = Number(
    db.prepare("SELECT COUNT(*) AS cnt FROM library_chunks WHERE embedding_f32 IS NOT NULL AND embedding_model = ?")
      .get(getActiveEmbeddingModelName(cfg))?.cnt || 0
  );
  const totalChunkCount = Number(db.prepare("SELECT COUNT(*) AS cnt FROM library_chunks").get()?.cnt || 0);
  const routines = db.prepare("SELECT * FROM scheduled_routines ORDER BY name ASC").all();
  const snapshots = db.prepare("SELECT * FROM activity_snapshots WHERE revoked = 0 ORDER BY created_at DESC").all();
  const wrapPath = path.join(getProjectDir(ws), "state", "wrapup_checkpoint.md");

  return {
    initialized: true,
    workspacePath: ws,
    projects: enrichedProjects,
    activeProjectId: cfg.projectId,
    config: cfg,
    threads,
    todaySpawnCount,
    completedCoordinators,
    repositories,
    pullRequests,
    library: {
      items: libraryItems,
      totalTokens: totalLibraryTokens,
      threshold: cfg.memory.autoPinLibraryTokenThreshold,
      mode: totalLibraryTokens < cfg.memory.autoPinLibraryTokenThreshold ? "pinned" : "contextual_rag",
      activeEmbeddingModel: getActiveEmbeddingModelName(cfg),
      embeddedChunkCount,
      totalChunkCount
    },
    memory: {
      indexContent: memoryIndex,
      lineCount: memoryIndex ? memoryIndex.split(/\r?\n/).length : 0,
      charCount: memoryIndex.length,
      topics: topicFiles,
      accountMemoryPath: getAccountMemoryPath()
    },
    routines,
    snapshots,
    wrapupCheckpoint: fs.existsSync(wrapPath) ? fs.readFileSync(wrapPath, "utf8") : null
  };
}

module.exports = {
  MAX_INSTRUCTIONS_CHARS,
  DEFAULT_MAX_MEMORY_LINES,
  DEFAULT_MAX_MEMORY_CHARS,
  DEFAULT_PIN_TOKEN_THRESHOLD,
  MAX_UPLOAD_INPUT_BYTES,
  VALID_UI_BUCKETS,
  VALID_CONV_ID_RE,
  normalizeRole,
  isMutatingRole,
  getRoleModelOverride,
  getVenvPythonOrSystem,
  nowIso,
  sha256Hex,
  estimateTokens,
  getAppDataDir,
  getPluginRootDir,
  getSharedDataDir,
  getProjectDir,
  hasProjectInitialized,
  readJsonSafe,
  writeJsonAtomic,
  writeTextAtomic,
  loadRegistry,
  saveRegistry,
  withRegistryLock,
  updateRegistry,
  selectProject,
  hasRegistryBoundMapOnDisk,
  syncConversationBinding,
  removeConversationBinding,
  isPathInsideDir,
  isBlockedSensitiveSourcePath,
  listProjects,
  getAccountMemoryPath,
  loadProjectConfig,
  saveProjectConfig,
  updateProjectSettings,
  validateInstructions,
  openProjectDb,
  resolveSessionBinding,
  resolveActiveWorkspace,
  getMemoryPaths,
  rebuildMemoryIndex,
  upsertMemoryTopic,
  saveRawMemoryIndex,
  consolidateMemories,
  createProject,
  transitionProjectLifecycle,
  rolloverCoordinatorSession,
  ensureThreadIsolationCwd,
  computeRepoRulesEtag,
  bindRepository,
  unbindRepository,
  manageWorktree,
  proposeThreads,
  checkThreadQuota,
  registerThread,
  updateThreadState,
  extractStructureAwareChunks,
  getExtractedTextPath,
  readLibraryItemText,
  getActiveEmbeddingModelName,
  triggerPythonRagEmbed,
  rebalanceLibraryIndexing,
  ingestLibraryItem,
  searchProjectLibrary,
  validateCronField,
  computeNextCronRun,
  upsertSchedule,
  processDueSchedules,
  syncPullRequests,
  syncPullRequestsAsync,
  createChatSnapshot,
  readChatSnapshotPreview,
  revokeChatSnapshot,
  parseRuleFrontmatter,
  ruleGlobsMatchOwned,
  getConfigContextHash,
  collectTierThreeRepoRules,
  buildFourTierContextBlock,
  buildFullWorkspaceSnapshot
};
