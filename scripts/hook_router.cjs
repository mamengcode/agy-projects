#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let db = null;
let currentEvent = "";

const STRICT_UUID_CONV_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-zA-Z0-9_-]{8,64})$/i;
const SYSTEM_ROLE_NAME_RE = /^(?:coordinator|narrator|monitor)(?:-\d+)?$/i;

function getAppDataDirFast() {
  if (process.env.ANTIGRAVITY_APP_DATA_DIR?.trim()) {
    return path.resolve(process.env.ANTIGRAVITY_APP_DATA_DIR.trim());
  }
  return path.join(os.homedir(), ".gemini", "antigravity");
}

function getSharedDataDirFast() {
  const custom = process.env.AGY_PROJECTS_DATA_DIR?.trim();
  if (custom) return path.resolve(custom);
  return path.join(getAppDataDirFast(), "plugin_data", "agy-projects");
}

function readJsonFastSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isSwarmWorkerInMembersFast(appDataDir, coordId, cid) {
  if (!coordId || typeof coordId !== "string" || !STRICT_UUID_CONV_RE.test(coordId)) return false;
  const brainRoot = path.resolve(appDataDir, "brain");
  const swarmDir = path.join(brainRoot, coordId, ".system_generated", "swarm");
  const rel = path.relative(brainRoot, swarmDir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const swarmJson = readJsonFastSafe(path.join(swarmDir, "swarm.json"));
  if (swarmJson && typeof swarmJson.backend === "string" && swarmJson.backend !== "local") return false;
  const roster = readJsonFastSafe(path.join(swarmDir, "members.json"));
  const members =
    roster?.members && typeof roster.members === "object" && !Array.isArray(roster.members) ? roster.members : null;
  if (!members) return false;
  for (const [name, m] of Object.entries(members)) {
    if (!m || typeof m !== "object") continue;
    if (m.role !== "worker") continue;
    if (SYSTEM_ROLE_NAME_RE.test(String(name || ""))) continue;
    if (m.conversation_id === cid) return true;
  }
  return false;
}

function isFastUnbound(conversationId) {
  const regPath = path.join(getSharedDataDirFast(), "projects_registry.json");
  let reg;
  try {
    if (!fs.existsSync(regPath)) return true;
    reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
  } catch {
    return true;
  }
  if (!reg || !Array.isArray(reg.projects) || reg.projects.length === 0) return true;
  const cid = String(conversationId || "").trim();
  if (!cid) return true;
  if (reg.projects.some((p) => p && p.coordinatorConversationId === cid)) return false;
  if (reg.boundConversations && typeof reg.boundConversations === "object" && !Array.isArray(reg.boundConversations)) {
    if (Object.prototype.hasOwnProperty.call(reg.boundConversations, cid)) return false;
    const appDataDir = getAppDataDirFast();
    for (const p of reg.projects) {
      if (p && p.status !== "archived" && p.coordinatorConversationId && isSwarmWorkerInMembersFast(appDataDir, p.coordinatorConversationId, cid)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function sendJson(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
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

function matchesOwnedGlobs(absTargetPath, workspacePath, ownedGlobs = []) {
  if (!Array.isArray(ownedGlobs) || ownedGlobs.length === 0) return true;
  const resolvedTarget = path.isAbsolute(absTargetPath)
    ? path.resolve(absTargetPath)
    : path.resolve(workspacePath, absTargetPath);
  const rel = path.relative(path.resolve(workspacePath), resolvedTarget).split(path.sep).join("/");
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;

  for (const glob of ownedGlobs) {
    const cleanGlob = String(glob || "").trim().replace(/^\.\/+/, "");
    if (!cleanGlob) continue;

    // Exact file path or directory entry (without wildcards)
    if (!cleanGlob.includes("*") && !cleanGlob.includes("?") && !cleanGlob.includes("[")) {
      const cleanDir = cleanGlob.replace(/\/+$/, "");
      if (rel === cleanGlob || rel === cleanDir || rel.startsWith(`${cleanDir}/`)) return true;
      continue;
    }

    if (typeof path.matchesGlob === "function") {
      if (path.matchesGlob(rel, cleanGlob)) return true;
      if (cleanGlob.endsWith("/**") && rel === cleanGlob.slice(0, -3)) return true;
      continue;
    }

    if (globToRegExp(cleanGlob).test(rel)) return true;
  }
  return false;
}

function isInsideDir(targetPath, parentDir) {
  if (!targetPath || !parentDir) return false;
  const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function findMatchingBacktickEnd(str, startIdx) {
  for (let i = startIdx; i < str.length; i++) {
    if (str[i] === "\\") {
      i++;
      continue;
    }
    if (str[i] === "`") return i;
  }
  return str.length;
}

function findMatchingBraceEnd(str, startIdx) {
  let depth = 1;
  let quote = null;
  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return str.length;
}

function findMatchingParenEnd(str, startIdx) {
  let depth = 1;
  let quote = null;
  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      else if (ch === "$" && str[i + 1] === "(") {
        const innerEnd = findMatchingParenEnd(str, i + 2);
        i = innerEnd;
      }
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return str.length;
}

function extractCommandInvocations(cmdStr, depth = 0) {
  const str = String(cmdStr || "");
  if (!str.trim() || depth > 5) return [];
  const rawSegments = [];
  const nestedInvocations = [];
  let currSeg = [];
  let currTok = "";
  let hasTok = false;
  let quote = null;

  const flushTok = () => {
    if (hasTok) {
      currSeg.push(currTok);
      currTok = "";
      hasTok = false;
    }
  };
  const flushSeg = () => {
    flushTok();
    if (currSeg.length > 0) {
      rawSegments.push(currSeg);
      currSeg = [];
    }
  };

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else currTok += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        if (i + 1 < str.length) {
          currTok += str[i + 1];
          i++;
        }
        continue;
      }
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "$" && str[i + 1] === "(") {
        const end = findMatchingParenEnd(str, i + 2);
        const inner = str.slice(i + 2, end);
        nestedInvocations.push(...extractCommandInvocations(inner, depth + 1));
        currTok += str.slice(i, end + 1);
        i = end;
        continue;
      }
      if (ch === "`") {
        const end = findMatchingBacktickEnd(str, i + 1);
        const inner = str.slice(i + 1, end);
        nestedInvocations.push(...extractCommandInvocations(inner, depth + 1));
        currTok += str.slice(i, end + 1);
        i = end;
        continue;
      }
      currTok += ch;
      continue;
    }

    if (ch === "\\") {
      if (i + 1 < str.length) {
        currTok += str[i + 1];
        hasTok = true;
        i++;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasTok = true;
      continue;
    }
    if (ch === "$" && str[i + 1] === "{") {
      const end = findMatchingBraceEnd(str, i + 2);
      const inner = str.slice(i + 2, end);
      if (inner.includes("$(") || inner.includes("`")) {
        nestedInvocations.push(...extractCommandInvocations(inner, depth + 1));
      }
      currTok += str.slice(i, end + 1);
      hasTok = true;
      i = end;
      continue;
    }
    if (ch === "$" && str[i + 1] === "(") {
      const end = findMatchingParenEnd(str, i + 2);
      const inner = str.slice(i + 2, end);
      nestedInvocations.push(...extractCommandInvocations(inner, depth + 1));
      currTok += str.slice(i, end + 1);
      hasTok = true;
      i = end;
      continue;
    }
    if (ch === "`") {
      const end = findMatchingBacktickEnd(str, i + 1);
      const inner = str.slice(i + 1, end);
      nestedInvocations.push(...extractCommandInvocations(inner, depth + 1));
      currTok += str.slice(i, end + 1);
      hasTok = true;
      i = end;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "\r" || ch === "(" || ch === ")") {
      flushSeg();
      continue;
    }
    if (ch === "|") {
      flushSeg();
      if (str[i + 1] === "|") i++;
      continue;
    }
    if (ch === "&") {
      const prev = i > 0 ? str[i - 1] : "";
      if (prev === ">" || prev === "<") {
        currTok += ch;
        hasTok = true;
        continue;
      }
      flushSeg();
      if (str[i + 1] === "&") i++;
      continue;
    }
    if (ch === " " || ch === "\t") {
      flushTok();
      continue;
    }
    currTok += ch;
    hasTok = true;
  }
  flushSeg();

  const splitBraceGroups = [];
  for (const seg of rawSegments) {
    let chunk = [];
    for (const tok of seg) {
      if (tok === "{" || tok === "}") {
        if (chunk.length > 0) {
          splitBraceGroups.push(chunk);
          chunk = [];
        }
      } else {
        chunk.push(tok);
      }
    }
    if (chunk.length > 0) splitBraceGroups.push(chunk);
  }

  const invocations = [];
  for (const seg of splitBraceGroups) {
    const inv = unwrapCommandTokens(seg);
    if (!inv) continue;
    invocations.push(inv);
    if (["sh", "bash", "zsh", "dash", "ksh"].includes(inv.bin)) {
      const cIdx = inv.args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
      if (cIdx >= 0 && inv.args[cIdx + 1]) {
        invocations.push(...extractCommandInvocations(inv.args[cIdx + 1], depth + 1));
      }
    } else if (inv.bin === "eval" && inv.args.length > 0) {
      invocations.push(...extractCommandInvocations(inv.args.join(" "), depth + 1));
    }
  }
  invocations.push(...nestedInvocations);
  return invocations;
}

function unwrapCommandTokens(tokens) {
  let idx = 0;
  while (idx < tokens.length) {
    const t = tokens[idx];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      idx++;
      continue;
    }
    const base = path.posix.basename(t).toLowerCase();
    if (["command", "builtin", "exec", "time", "nohup"].includes(base)) {
      idx++;
      while (idx < tokens.length && tokens[idx].startsWith("-")) idx++;
      continue;
    }
    if (base === "env") {
      idx++;
      while (idx < tokens.length && (tokens[idx].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]))) {
        if (["-u", "--unset", "-C", "--chdir"].includes(tokens[idx])) idx += 2;
        else idx++;
      }
      continue;
    }
    if (base === "sudo" || base === "doas") {
      idx++;
      while (idx < tokens.length && tokens[idx].startsWith("-")) {
        if (["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U"].includes(tokens[idx])) idx += 2;
        else idx++;
      }
      continue;
    }
    if (base === "nice") {
      idx++;
      while (idx < tokens.length && tokens[idx].startsWith("-")) {
        if (tokens[idx] === "-n") idx += 2;
        else idx++;
      }
      continue;
    }
    break;
  }
  if (idx >= tokens.length) return null;
  return {
    bin: path.posix.basename(tokens[idx]).toLowerCase(),
    args: tokens.slice(idx + 1)
  };
}

function getNonFlagArgs(args) {
  return args.filter((a) => !a.startsWith("-"));
}

function extractGitSubcommand(args) {
  const optsWithValue = new Set([
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--super-prefix",
    "--config-env",
    "--exec-path",
    "--list-cmds"
  ]);
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "--") {
      i++;
      break;
    }
    if (optsWithValue.has(a)) {
      i += 2;
      continue;
    }
    if (
      a.startsWith("-C") ||
      a.startsWith("-c") ||
      a.startsWith("--git-dir=") ||
      a.startsWith("--work-tree=") ||
      a.startsWith("--namespace=") ||
      a.startsWith("--super-prefix=") ||
      a.startsWith("--config-env=") ||
      a.startsWith("--exec-path=") ||
      a.startsWith("-")
    ) {
      i++;
      continue;
    }
    return { subcmd: a.toLowerCase(), subArgs: args.slice(i + 1) };
  }
  return { subcmd: "", subArgs: [] };
}

function isNetworkCommand(inv) {
  const { bin, args } = inv;
  if (["curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "ftp", "sftp", "ssh", "scp", "rsync", "aria2c", "http", "https"].includes(bin)) {
    return true;
  }
  const nonFlags = getNonFlagArgs(args);
  const sub = (nonFlags[0] || "").toLowerCase();
  const sub2 = (nonFlags[1] || "").toLowerCase();

  if (bin === "git") {
    const { subcmd } = extractGitSubcommand(args);
    return ["clone", "fetch", "pull", "push", "ls-remote", "submodule"].includes(subcmd);
  }
  if (bin === "npm") {
    return ["i", "install", "ci", "add", "update", "up", "upgrade", "audit", "publish", "login", "ping", "unpublish"].includes(sub);
  }
  if (bin === "pnpm") {
    return ["i", "install", "add", "update", "up", "dlx", "publish", "audit"].includes(sub);
  }
  if (bin === "yarn") {
    return !sub || ["install", "add", "up", "upgrade", "dlx", "publish", "audit"].includes(sub);
  }
  if (bin === "bun") {
    return ["i", "install", "add", "update", "x", "publish"].includes(sub);
  }
  if (bin === "npx" || bin === "pnpx" || bin === "bunx") {
    return !args.includes("--no-install");
  }
  if (bin === "pip" || bin === "pip3" || bin === "pipx") {
    return ["install", "download", "wheel"].includes(sub);
  }
  if (bin === "python" || bin === "python3") {
    const mIdx = args.indexOf("-m");
    if (mIdx >= 0 && ["pip", "pip3"].includes((args[mIdx + 1] || "").toLowerCase())) {
      const pipSub = getNonFlagArgs(args.slice(mIdx + 2))[0]?.toLowerCase() || "";
      return ["install", "download", "wheel"].includes(pipSub);
    }
    return false;
  }
  if (bin === "uv") {
    return ["pip", "sync", "add", "tool", "lock"].includes(sub);
  }
  if (bin === "poetry") {
    return ["install", "add", "update", "lock"].includes(sub);
  }
  if (bin === "cargo") {
    return ["install", "fetch", "update", "publish"].includes(sub);
  }
  if (bin === "go") {
    return ["get", "install"].includes(sub) || (sub === "mod" && sub2 === "download");
  }
  if (bin === "brew") {
    return ["install", "upgrade", "fetch", "update", "reinstall"].includes(sub);
  }
  return false;
}

function isTestRunnerCommand(inv) {
  const { bin, args } = inv;
  if (["pytest", "py.test", "vitest", "jest", "mocha", "ava", "playwright", "cypress", "phpunit", "rspec"].includes(bin)) {
    return true;
  }
  const nonFlags = getNonFlagArgs(args);
  const sub = (nonFlags[0] || "").toLowerCase();
  const sub2 = (nonFlags[1] || "").toLowerCase();

  if (["npm", "pnpm", "yarn", "bun"].includes(bin)) {
    if (["test", "t", "tst"].includes(sub)) return true;
    if (["run", "run-script"].includes(sub) && /^(test(:.*)?|e2e|integration)$/i.test(sub2)) {
      return true;
    }
    if ((bin === "pnpm" || bin === "yarn") && ["jest", "vitest", "pytest", "mocha", "playwright", "cypress"].includes(sub)) {
      return true;
    }
    if ((bin === "pnpm" && sub === "exec") && ["jest", "vitest", "pytest", "mocha", "playwright", "cypress"].includes(sub2)) {
      return true;
    }
    return false;
  }
  if (["npx", "pnpx", "bunx"].includes(bin)) {
    return ["jest", "vitest", "pytest", "py.test", "mocha", "ava", "playwright", "cypress"].includes(sub);
  }
  if (bin === "python" || bin === "python3") {
    const mIdx = args.indexOf("-m");
    if (mIdx >= 0 && ["pytest", "unittest"].includes((args[mIdx + 1] || "").toLowerCase())) {
      return true;
    }
    return false;
  }
  if (bin === "uv" || bin === "poetry") {
    return sub === "run" && ["pytest", "py.test", "vitest", "jest", "mocha"].includes(sub2);
  }
  if (["cargo", "go", "mix", "dotnet"].includes(bin)) {
    return sub === "test";
  }
  if (bin === "mvn" || bin === "mvnw") {
    return nonFlags.some((a) => ["test", "verify"].includes(a.toLowerCase()));
  }
  if (bin === "gradle" || bin === "gradlew") {
    return nonFlags.some((a) => ["test", "check"].includes(a.toLowerCase()));
  }
  return false;
}

function isReadOnlyGitMutationCommand(inv) {
  if (inv.bin !== "git") return false;
  const { subcmd, subArgs } = extractGitSubcommand(inv.args);
  if (!subcmd) return false;
  if (
    [
      "commit",
      "push",
      "rebase",
      "merge",
      "reset",
      "switch",
      "checkout",
      "cherry-pick",
      "revert",
      "am",
      "apply",
      "rm",
      "mv",
      "restore",
      "gc",
      "prune",
      "pull",
      "bisect"
    ].includes(subcmd)
  ) {
    return true;
  }
  if (subcmd === "clean") {
    const dryOnly =
      subArgs.some((a) => a === "-n" || a === "--dry-run") &&
      !subArgs.some((a) => a === "-f" || a === "--force");
    return !dryOnly;
  }
  if (subcmd === "branch") {
    if (
      subArgs.some(
        (a) =>
          [
            "-d",
            "-D",
            "-m",
            "-M",
            "-c",
            "-C",
            "--delete",
            "--move",
            "--copy",
            "--edit-description",
            "--set-upstream-to",
            "--unset-upstream"
          ].includes(a) || /^-[a-zA-Z]*[dDmMcC]/.test(a)
      )
    ) {
      return true;
    }
    const queryFlags = new Set([
      "-l",
      "--list",
      "--show-current",
      "--contains",
      "--no-contains",
      "--merged",
      "--no-merged",
      "-a",
      "--all",
      "-r",
      "--remotes",
      "-v",
      "-vv",
      "--verbose"
    ]);
    const hasQueryFlag = subArgs.some((a) => queryFlags.has(a));
    if (!hasQueryFlag && subArgs.some((a) => !a.startsWith("-"))) {
      return true;
    }
    return false;
  }
  if (subcmd === "tag") {
    if (subArgs.some((a) => ["-d", "--delete", "-a", "--annotate", "-s", "--sign", "-f", "--force"].includes(a))) {
      return true;
    }
    const isList = subArgs.some((a) => a === "-l" || a === "--list");
    return !isList && subArgs.some((a) => !a.startsWith("-"));
  }
  if (subcmd === "stash") {
    const act = (getNonFlagArgs(subArgs)[0] || "").toLowerCase();
    return !["list", "show"].includes(act);
  }
  if (subcmd === "worktree") {
    const act = (getNonFlagArgs(subArgs)[0] || "").toLowerCase();
    return Boolean(act && act !== "list");
  }
  return false;
}

function getMemoryHash(workspacePath) {
  const { indexPath } = db.getMemoryPaths(workspacePath);
  if (!fs.existsSync(indexPath)) return "";
  return db.sha256Hex(fs.readFileSync(indexPath));
}

function normalizeSwarmToolName(name) {
  const raw = String(name || "").trim();
  if (raw === "manage_swarm" || raw === "swarm") return "swarm";
  return raw;
}

function escapeRegExp(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferRoleFromSwarmArgs(name, brief) {
  const n = String(name || "").toLowerCase();
  if (/^(?:expl-|explorer\b|research|investigat)/.test(n)) return "explorer";
  if (/^(?:ver-|verifier\b|review|test|audit|qa\b)/.test(n)) return "verifier";
  if (/^(?:pr-|pr-fixer\b|pr_fixer\b)/.test(n)) return "pr-fixer";
  if (/^(?:impl-|implementer\b|builder|author)/.test(n)) return "implementer";
  const b = String(brief || "").toLowerCase();
  if (/\brole:\s*(?:project-)?explorer\b/.test(b)) return "explorer";
  if (/\brole:\s*(?:project-)?verifier\b/.test(b)) return "verifier";
  if (/\brole:\s*(?:project-)?pr[-_]?fixer\b/.test(b)) return "pr-fixer";
  if (/\brole:\s*(?:project-)?implementer\b/.test(b)) return "implementer";
  return "implementer";
}

function readSwarmMembersMap(appDataDir, coordId) {
  const swarmDir = coordId ? db.getSwarmDir(appDataDir, coordId) : null;
  if (!swarmDir) return { swarmDir: null, members: {} };
  const roster = readJsonFastSafe(path.join(swarmDir, "members.json"));
  const members =
    roster?.members && typeof roster.members === "object" && !Array.isArray(roster.members) ? roster.members : {};
  return { swarmDir, members };
}

function tryAutoBindSwarmWorker(conversationId, workspacePaths) {
  const reg = db.loadRegistry();
  if (!reg || !Array.isArray(reg.projects)) return null;
  const appDataDir = db.getAppDataDir();
  for (const p of reg.projects) {
    if (!p || p.status === "archived" || !p.coordinatorConversationId || !p.workspacePath) continue;
    const absWs = path.resolve(p.workspacePath);
    if (!db.hasProjectInitialized(absWs)) continue;
    const cfg = db.loadProjectConfig(absWs);
    const coordId = cfg?.coordinatorConversationId || p.coordinatorConversationId;
    if (!coordId || !isSwarmWorkerInMembersFast(appDataDir, coordId, conversationId)) continue;
    db.syncSwarmIntoProjectDb(absWs, { appDataDir });
    const bound = db.resolveSessionBinding(conversationId, workspacePaths);
    if (bound && bound.bound) return bound;
  }
  return null;
}

function main() {
  const input = readStdinJson();
  const event = input.hookEventName || "";
  currentEvent = event;
  const conversationId = input.conversationId || "";
  const workspacePaths = Array.isArray(input.workspacePaths) ? input.workspacePaths : (input.cwd ? [input.cwd] : []);

  // Headless SDK background workers hydrate context via system_instructions directly
  if (process.env.AGY_HEADLESS_SDK_WORKER === "1") {
    if (event === "PreToolUse" || event === "Stop") return sendJson({ decision: "allow" });
    return sendJson({});
  }

  // Zero-SQLite fast path (<10ms) for any conversation not bound to an AGY Project (AT-01 / P1-2)
  if (isFastUnbound(conversationId)) {
    if (event === "PreToolUse" || event === "Stop") return sendJson({ decision: "allow" });
    return sendJson({});
  }

  db = require("../server/db.cjs");
  let binding = db.resolveSessionBinding(conversationId, workspacePaths);
  if (!binding.bound) {
    const autoBound = tryAutoBindSwarmWorker(conversationId, workspacePaths);
    if (autoBound) binding = autoBound;
  }

  if (!binding.bound) {
    if (event === "PreToolUse" || event === "Stop") return sendJson({ decision: "allow" });
    return sendJson({});
  }

  const { workspacePath, role, thread } = binding;
  const cfg = db.loadProjectConfig(workspacePath);
  const sql = db.openProjectDb(workspacePath);

  if (event === "SessionStart") {
    const memHash = getMemoryHash(workspacePath);
    const cfgHash = db.getConfigContextHash(cfg);
    sql.prepare(`
      INSERT INTO session_hook_state (conversation_id, last_memory_hash, last_config_hash, compaction_warned, updated_at)
      VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        last_memory_hash = excluded.last_memory_hash,
        last_config_hash = excluded.last_config_hash,
        updated_at = excluded.updated_at
    `).run(conversationId, memHash, cfgHash, db.nowIso());

    const contextBlock = db.buildFourTierContextBlock(workspacePath, role, thread, {
      currentConversationId: conversationId,
      consumeCheckpoint: true
    });
    if (!contextBlock) return sendJson({});
    return sendJson({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: contextBlock
          }
        }
      ]
    });
  }

  if (event === "PreInvocation") {
    // Hard-stop Paused or Archived projects (AT-05)
    if (cfg && (cfg.status === "paused" || cfg.status === "archived")) {
      return sendJson({
        injectSteps: [
          {
            errorMessage: {
              userMessage: `Project "${cfg.name}" is currently ${cfg.status.toUpperCase()}. Resume it in Project Hub (sidecar://agy-projects/project_hub/ui.html) or via update_project_lifecycle before continuing.`
            }
          }
        ],
        terminationBehavior: "terminate"
      });
    }

    const injectSteps = [];
    const hookState = sql.prepare("SELECT * FROM session_hook_state WHERE conversation_id = ?").get(conversationId);
    const currentHash = getMemoryHash(workspacePath);
    const currentCfgHash = db.getConfigContextHash(cfg);

    if (!hookState) {
      // Session bound mid-flight (e.g., via create_project / select_project): hydrate full 4-tier context once
      sql.prepare(`
        INSERT INTO session_hook_state (conversation_id, last_memory_hash, last_config_hash, compaction_warned, updated_at)
        VALUES (?, ?, ?, 0, ?)
      `).run(conversationId, currentHash, currentCfgHash, db.nowIso());
      const contextBlock = db.buildFourTierContextBlock(workspacePath, role, thread, {
        currentConversationId: conversationId,
        consumeCheckpoint: true
      });
      if (contextBlock) {
        injectSteps.push({
          systemMessage: { systemMessage: contextBlock }
        });
      }
    } else {
      if (currentHash && currentHash !== hookState.last_memory_hash) {
        const { indexPath } = db.getMemoryPaths(workspacePath);
        const memContent = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8").trim() : "";
        sql.prepare("UPDATE session_hook_state SET last_memory_hash = ?, updated_at = ? WHERE conversation_id = ?")
          .run(currentHash, db.nowIso(), conversationId);
        if (memContent) {
          injectSteps.push({
            systemMessage: {
              systemMessage: `[PROJECT MEMORY UPDATED]\n<ProjectMemory path="${indexPath}">\n${memContent}\n</ProjectMemory>`
            }
          });
        }
      }
      if (hookState.last_config_hash === null || hookState.last_config_hash === undefined) {
        sql.prepare("UPDATE session_hook_state SET last_config_hash = ?, updated_at = ? WHERE conversation_id = ?")
          .run(currentCfgHash, db.nowIso(), conversationId);
      } else if (currentCfgHash !== hookState.last_config_hash) {
        sql.prepare("UPDATE session_hook_state SET last_config_hash = ?, updated_at = ? WHERE conversation_id = ?")
          .run(currentCfgHash, db.nowIso(), conversationId);
        let acctSection = "";
        if (cfg?.memory?.useAccountMemory) {
          const acctPath = db.getAccountMemoryPath();
          if (fs.existsSync(acctPath)) {
            const acctText = fs.readFileSync(acctPath, "utf8").trim();
            if (acctText) acctSection = `\n<AccountMemory>\n${acctText}\n</AccountMemory>`;
          }
        } else {
          acctSection = "\n<AccountMemoryStatus>Isolated (Off) — ignore any earlier AccountMemory from prior turns.</AccountMemoryStatus>";
        }
        injectSteps.push({
          systemMessage: {
            systemMessage: `[PROJECT INSTRUCTIONS UPDATED]\n<ProjectGoal>\n${cfg?.goal || ""}\n</ProjectGoal>\n<ProjectInstructions>\n${cfg?.instructions || ""}\n</ProjectInstructions>${acctSection}`
          }
        });
      }
    }

    // Proactive compaction / wrap-up warning for Coordinator (>450 KB transcript OR >=60 invocations)
    if (role === "coordinator") {
      const warned = hookState ? Number(hookState.compaction_warned || 0) : 0;
      const oversizedTranscript = Boolean(
        input.transcriptPath && fs.existsSync(input.transcriptPath) && fs.statSync(input.transcriptPath).size > 450 * 1024
      );
      const highInvocationCount = Number(input.invocationNum || 0) >= 60;
      if (!warned && (oversizedTranscript || highInvocationCount)) {
        sql.prepare("UPDATE session_hook_state SET compaction_warned = 1, updated_at = ? WHERE conversation_id = ?")
          .run(db.nowIso(), conversationId);
        injectSteps.push({
          systemMessage: {
            systemMessage:
              "[WRAP-UP RECOMMENDED] Coordinator session is approaching compaction or invocation limits. Persist active state with save_wrapup_checkpoint before running /compact or rolling over via rollover_coordinator_session."
          }
        });
      }
    }

    if (injectSteps.length === 0) return sendJson({});
    return sendJson({ injectSteps, terminationBehavior: "" });
  }

  if (event === "PreToolUse") {
    const toolCall = input.toolCall || {};
    const toolName = String(toolCall.name || "");
    const normTool = normalizeSwarmToolName(toolName);
    const args = toolCall.args || {};

    if (normTool === "swarm") {
      const action = String(args.action || "").trim().toLowerCase();
      if (action !== "add") {
        return sendJson({ decision: "allow" });
      }
      const argSwarmRole =
        args.role !== undefined && args.role !== null && String(args.role).trim() !== ""
          ? String(args.role).trim().toLowerCase()
          : "worker";
      if (argSwarmRole !== "worker") {
        return sendJson({ decision: "allow" });
      }
      const targetName = String(args.name || "").trim();
      if (targetName && SYSTEM_ROLE_NAME_RE.test(targetName)) {
        return sendJson({ decision: "allow" });
      }

      const k =
        Array.isArray(args.tasks) && args.tasks.length > 0
          ? args.tasks.length
          : (Number.isFinite(Number(args.n)) && Number(args.n) >= 1 ? Math.floor(Number(args.n)) : 1);
      const parsedMarker = db.parseDispatchMarker(args.brief || "");
      const credit = parsedMarker
        ? db.getDispatchReservationCredit(workspacePath, parsedMarker.dispatchId, parsedMarker.threadId)
        : 0;
      const additionalNeeded = Math.max(0, k - credit);

      try {
        db.checkThreadQuota(workspacePath, {
          additionalCount: additionalNeeded,
          skipCounts: additionalNeeded === 0
        });
      } catch (err) {
        return sendJson({ decision: "deny", reason: err.message });
      }

      if (credit > 0 && parsedMarker) {
        db.consumeDispatchPreTool(workspacePath, parsedMarker.dispatchId, parsedMarker.threadId);
      }

      const targetThread = parsedMarker
        ? sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(parsedMarker.threadId)
        : null;
      const roleKey = targetThread?.role
        ? db.normalizeRole(targetThread.role)
        : inferRoleFromSwarmArgs(targetName, args.brief);

      const overwrite = {};
      const isWorkerAdHocHelper = role === "worker" && !parsedMarker;
      if (isWorkerAdHocHelper) {
        if (args.model === "inherit") {
          overwrite.model = "";
        } else if (args.model) {
          const resolvedHelperModel = db.resolveSwarmModel(args.model);
          if (resolvedHelperModel && resolvedHelperModel !== args.model) {
            overwrite.model = resolvedHelperModel;
          }
        }
      } else {
        const rawModelSetting =
          args.model && args.model !== "inherit"
            ? args.model
            : (targetThread?.swarm_model ??
              (targetThread?.model && targetThread.model !== "inherit" ? targetThread.model : null) ??
              db.getRoleModelOverride(cfg, roleKey) ??
              cfg?.models?.defaultThreadModel ??
              "inherit");
        const resolvedSwarmModel = db.resolveSwarmModel(rawModelSetting);
        if ((!args.model || args.model === "inherit") && resolvedSwarmModel) {
          overwrite.model = resolvedSwarmModel;
        } else if (args.model === "inherit" && !resolvedSwarmModel) {
          overwrite.model = "";
        } else if (args.model && args.model !== "inherit" && resolvedSwarmModel && resolvedSwarmModel !== args.model) {
          overwrite.model = resolvedSwarmModel;
        }
      }

      const threadWsHint =
        targetThread?.workspace_mode && (db.isMutatingRole(roleKey) || targetThread.workspace_mode === "branch")
          ? targetThread.workspace_mode
          : "";
      const effectiveExplicitWs = args.workspace || threadWsHint;
      const resolvedWorkspace = db.resolveSwarmWorkspace(cfg, workspacePath, roleKey, effectiveExplicitWs);
      if (!args.workspace || args.workspace !== resolvedWorkspace) {
        overwrite.workspace = resolvedWorkspace;
      }

      return Object.keys(overwrite).length > 0
        ? sendJson({ decision: "allow", overwrite })
        : sendJson({ decision: "allow" });
    }

    if (toolName === "invoke_subagent") {
      try {
        db.checkThreadQuota(workspacePath);
      } catch (err) {
        return sendJson({ decision: "deny", reason: err.message });
      }

      const overwrite = {};
      const typeName = String(args.TypeName || "");
      const roleKey = db.normalizeRole(typeName.replace(/^project-/, ""));
      const resolvedSubModel = db.resolveSubagentModel(
        { role: roleKey, model: args.Model },
        cfg
      );
      const validSubagentTiers = new Set(["inherit", "flash", "flash_lite", "pro"]);

      if ((!args.Model || args.Model === "inherit") && resolvedSubModel && resolvedSubModel !== "inherit") {
        overwrite.Model = resolvedSubModel;
      } else if (args.Model && !validSubagentTiers.has(String(args.Model))) {
        overwrite.Model = resolvedSubModel;
      }

      if (!args.Workspace && db.isMutatingRole(roleKey)) {
        overwrite.Workspace = cfg?.orchestration?.defaultWorkspaceMode || "share";
      }

      return Object.keys(overwrite).length > 0
        ? sendJson({ decision: "allow", overwrite })
        : sendJson({ decision: "allow" });
    }

    if (toolName === "run_command") {
      const cmd = String(args.CommandLine || args.command || "");
      const invocations = extractCommandInvocations(cmd);
      if (cfg?.environment?.networkPolicy === "deny" && invocations.some(isNetworkCommand)) {
        return sendJson({
          decision: "deny",
          reason: "Project Network Policy Guard: Outbound network commands are denied by project environment.networkPolicy='deny'."
        });
      }
      if (role === "coordinator" && invocations.some(isTestRunnerCommand)) {
        return sendJson({
          decision: "deny",
          reason:
            'Coordinator Separation Guard: Delegate lengthy test suite execution to a project-verifier Worker Thread via swarm{action:"add", ...}.'
        });
      }
      if (role === "worker" && thread && !db.isMutatingRole(thread.role) && invocations.some(isReadOnlyGitMutationCommand)) {
        return sendJson({
          decision: "deny",
          reason: "Read-Only Role Guard: explorer/verifier threads cannot mutate git branches or history."
        });
      }
    }

    if (toolName === "edit_file" || toolName === "write_file") {
      const targetPath = args.Path || args.TargetFile || "";
      if (targetPath) {
        const projectDir = db.getProjectDir(workspacePath);
        const inProjectMeta = isInsideDir(targetPath, projectDir);
        const inArtifacts = input.artifactDirectoryPath && isInsideDir(targetPath, input.artifactDirectoryPath);
        const convBrainDir =
          db.STRICT_UUID_CONV_RE && db.STRICT_UUID_CONV_RE.test(conversationId)
            ? path.join(db.getAppDataDir(), "brain", conversationId)
            : "";
        const inCoordBrain = Boolean(convBrainDir && isInsideDir(targetPath, convBrainDir));

        // Coordinator separation of concerns: delegate application source code mutations to isolated Worker Threads
        if (role === "coordinator" && !inProjectMeta && !inArtifacts && !inCoordBrain) {
          return sendJson({
            decision: "deny",
            reason:
              'Coordinator Separation Guard: Coordinator sessions manage specs, memory, and orchestration, and must delegate application source edits to an isolated Worker Thread via swarm{action:"add", ...}.'
          });
        }

        // Shared-workspace Worker Thread glob ownership check
        if (role === "worker" && thread && thread.workspace_mode === "inherit" && !inProjectMeta && !inArtifacts) {
          let globs = [];
          try { globs = JSON.parse(thread.owned_globs_json || "[]"); } catch {}
          if (globs.length > 0 && !matchesOwnedGlobs(targetPath, workspacePath, globs)) {
            return sendJson({
              decision: "deny",
              reason: `File Ownership Guard: '${targetPath}' is outside this thread's assigned globs (${globs.join(", ")}).`
            });
          }
        }
      }
    }

    return sendJson({ decision: "allow" });
  }

  if (event === "PostToolUse") {
    const toolCall = input.toolCall || {};
    const toolName = String(toolCall.name || "");
    const normTool = normalizeSwarmToolName(toolName);
    const args = toolCall.args || {};

    if (role === "worker" && thread) {
      // Record lightweight tool telemetry & token usage delta on the worker thread
      if (!input.error && toolName) {
        try {
          const respText = typeof input.toolResponse === "string"
            ? input.toolResponse
            : JSON.stringify(input.toolResponse || "");
          const tokenUsageDelta = Math.max(
            50,
            db.estimateTokens(JSON.stringify(args)) + db.estimateTokens(respText)
          );
          db.updateThreadState(workspacePath, {
            threadId: thread.thread_id,
            telemetryEvent: { type: "tool_call", tool: toolName },
            tokenUsageDelta
          });
        } catch {}
      }
    }

    // Coordinator Swarm PostToolUse handlers (bind workers, sync dispatches, model/kill/steer matching)
    if (role === "coordinator") {
      const appDataDir = db.getAppDataDir();
      const coordId = cfg?.coordinatorConversationId || conversationId;

      if (normTool === "swarm") {
        const action = String(args.action || "").trim().toLowerCase();
        if (action === "add") {
          const parsedBrief = db.parseDispatchMarker(args.brief || "");
          if (input.error) {
            if (parsedBrief) {
              try { db.resetDispatchPreTool(workspacePath, parsedBrief.dispatchId); } catch {}
            }
          } else {
            const argSwarmRole =
              args.role !== undefined && args.role !== null && String(args.role).trim() !== ""
                ? String(args.role).trim().toLowerCase()
                : "worker";
            const baseName = String(args.name || "").trim();
            if (argSwarmRole === "worker" && !(baseName && SYSTEM_ROLE_NAME_RE.test(baseName))) {
              const { swarmDir, members } = readSwarmMembersMap(appDataDir, coordId);
              const boardTail = swarmDir
                ? db.readBoardTailSync(path.join(swarmDir, "board.jsonl"))
                : { msgs: [], head: 0 };
              const nameRe = baseName ? new RegExp(`^${escapeRegExp(baseName)}(?:-\\d+)?$`, "i") : null;
              const matchedMembers = nameRe
                ? Object.entries(members)
                    .filter(([mName, mObj]) => (
                      mObj &&
                      typeof mObj === "object" &&
                      mObj.role === "worker" &&
                      !SYSTEM_ROLE_NAME_RE.test(mName) &&
                      nameRe.test(mName)
                    ))
                    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
                : [];

              let primaryBriefMarkerConsumed = false;
              const ts = db.nowIso();

              if (matchedMembers.length > 0) {
                for (const [mName, mObj] of matchedMembers) {
                  let marker = null;
                  let briefSeq = 0;
                  const startMentionRe = new RegExp(`^\\s*@${escapeRegExp(mName)}(?=\\s|$)`, "i");
                  for (let i = boardTail.msgs.length - 1; i >= 0; i--) {
                    const bm = boardTail.msgs[i];
                    if (
                      bm &&
                      bm.agent === "coordinator" &&
                      bm.kind === "brief" &&
                      startMentionRe.test(String(bm.text || ""))
                    ) {
                      briefSeq = Number(bm.seq) || 0;
                      const mParsed = db.parseDispatchMarker(bm.text);
                      if (mParsed) {
                        marker = mParsed;
                      }
                      break;
                    }
                  }
                  if (!marker && parsedBrief && !primaryBriefMarkerConsumed) {
                    marker = parsedBrief;
                    primaryBriefMarkerConsumed = true;
                  }

                  const boundThreadId = db.runImmediateTx(sql, () => {
                    let targetRow = null;
                    if (marker?.threadId) {
                      const byMarker = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(marker.threadId);
                      if (
                        byMarker &&
                        (!byMarker.conversation_id || !mObj.conversation_id || byMarker.conversation_id === mObj.conversation_id)
                      ) {
                        targetRow = byMarker;
                      }
                    }
                    if (!targetRow && coordId) {
                      const bySwarm = sql
                        .prepare("SELECT * FROM threads WHERE swarm_origin_coordinator_id = ? AND swarm_member_name = ?")
                        .get(coordId, mName);
                      if (
                        bySwarm &&
                        (!bySwarm.conversation_id || !mObj.conversation_id || bySwarm.conversation_id === mObj.conversation_id)
                      ) {
                        targetRow = bySwarm;
                      }
                    }
                    if (!targetRow && mObj.conversation_id) {
                      targetRow = sql.prepare("SELECT * FROM threads WHERE conversation_id = ?").get(mObj.conversation_id) || null;
                    }
                    if (!targetRow) {
                      const adHocId = `swarm-${db.sha256Hex(`${coordId}:${mName}`).slice(0, 8)}`;
                      const inferredRole = inferRoleFromSwarmArgs(mName, args.brief);
                      sql.prepare(`
                        INSERT INTO threads (
                          thread_id, title, description, role, ui_bucket, server_status,
                          model, swarm_model, workspace_mode, swarm_member_name, swarm_state,
                          swarm_origin_coordinator_id, execution_backend, working_since, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, 'working', 'working', 'inherit', ?, ?, ?, 'working', ?, 'swarm', ?, ?, ?)
                        ON CONFLICT(thread_id) DO NOTHING
                      `).run(
                        adHocId,
                        `Swarm: ${mName}`,
                        String(args.brief || "").slice(0, 500),
                        inferredRole,
                        mObj.model || (args.model && args.model !== "inherit" ? args.model : null),
                        args.workspace || "inherit",
                        mName,
                        coordId || null,
                        ts,
                        ts,
                        ts
                      );
                      targetRow = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(adHocId);
                    }
                    if (!targetRow) return null;

                    let safeConvId = targetRow.conversation_id || null;
                    if (!safeConvId && mObj.conversation_id) {
                      const convOwner = sql
                        .prepare("SELECT thread_id FROM threads WHERE conversation_id = ?")
                        .get(mObj.conversation_id);
                      if (!convOwner || convOwner.thread_id === targetRow.thread_id) {
                        safeConvId = mObj.conversation_id;
                      } else if (/^swarm-[a-f0-9]{8}$/i.test(String(convOwner.thread_id || ""))) {
                        // Transient ad-hoc swarm-* row was auto-bound ahead of Hub dispatch matching; re-home cleanly
                        sql.prepare("DELETE FROM threads WHERE thread_id = ?").run(convOwner.thread_id);
                        safeConvId = mObj.conversation_id;
                      }
                    }

                    const handledFloor = briefSeq > 0 ? briefSeq : Number(boardTail.head || 0);
                    sql.prepare(`
                      UPDATE threads SET
                        conversation_id = ?,
                        swarm_member_name = ?,
                        swarm_model = COALESCE(?, swarm_model),
                        swarm_state = 'working',
                        swarm_origin_coordinator_id = ?,
                        execution_backend = 'swarm',
                        ui_bucket = CASE WHEN ui_bucket IN ('resolved', 'paused', 'landing') THEN ui_bucket ELSE 'working' END,
                        server_status = CASE WHEN ui_bucket IN ('resolved', 'paused', 'landing') THEN server_status ELSE 'working' END,
                        blocking_question = CASE WHEN ui_bucket IN ('resolved', 'paused', 'landing') THEN blocking_question ELSE NULL END,
                        blocking_is_error = CASE WHEN ui_bucket IN ('resolved', 'paused', 'landing') THEN blocking_is_error ELSE 0 END,
                        working_since = CASE WHEN ui_bucket IN ('resolved', 'paused', 'landing') THEN working_since ELSE COALESCE(working_since, ?) END,
                        swarm_handled_seq = MAX(COALESCE(swarm_handled_seq, 0), ?),
                        updated_at = ?
                      WHERE thread_id = ?
                    `).run(
                      safeConvId,
                      mName,
                      mObj.model || (args.model && args.model !== "inherit" ? args.model : null),
                      coordId || null,
                      ts,
                      handledFloor,
                      ts,
                      targetRow.thread_id
                    );
                    return targetRow.thread_id;
                  });

                  if (boundThreadId && mObj.conversation_id) {
                    const finalOwner = sql.prepare("SELECT thread_id FROM threads WHERE conversation_id = ?").get(mObj.conversation_id);
                    if (!finalOwner || finalOwner.thread_id === boundThreadId) {
                      try {
                        db.syncConversationBinding(mObj.conversation_id, {
                          workspacePath,
                          role: "worker",
                          threadId: boundThreadId,
                          projectId: cfg?.projectId || null
                        });
                      } catch {}
                    }
                  }

                  if (marker?.dispatchId) {
                    try { db.matchHubDispatch(workspacePath, marker.dispatchId, { targetMemberName: mName }); } catch {}
                  } else {
                    const fallbackDisp = sql
                      .prepare(`
                        SELECT dispatch_id FROM hub_dispatches
                        WHERE status IN ('pending', 'claimed')
                          AND action IN ('start', 'cron', 'pr_autofix')
                          AND (
                            thread_id = ?
                            OR target_member_name = ?
                            OR (? != '' AND target_member_name = ?)
                          )
                        ORDER BY
                          CASE WHEN thread_id = ? THEN 0 WHEN target_member_name = ? THEN 1 ELSE 2 END,
                          created_at DESC
                        LIMIT 1
                      `)
                      .get(boundThreadId || "", mName, baseName, baseName, boundThreadId || "", mName);
                    if (fallbackDisp) {
                      try { db.matchHubDispatch(workspacePath, fallbackDisp.dispatch_id, { targetMemberName: mName }); } catch {}
                    }
                  }
                }
              } else if (parsedBrief?.dispatchId) {
                if (parsedBrief.threadId) {
                  sql.prepare(`
                    UPDATE threads SET
                      swarm_member_name = COALESCE(NULLIF(?, ''), swarm_member_name),
                      swarm_state = 'working',
                      swarm_origin_coordinator_id = COALESCE(?, swarm_origin_coordinator_id),
                      execution_backend = 'swarm',
                      ui_bucket = CASE WHEN ui_bucket IN ('resolved', 'paused', 'landing') THEN ui_bucket ELSE 'working' END,
                      server_status = CASE WHEN ui_bucket IN ('resolved', 'paused', 'landing') THEN server_status ELSE 'working' END,
                      working_since = CASE WHEN ui_bucket IN ('resolved', 'paused', 'landing') THEN working_since ELSE COALESCE(working_since, ?) END,
                      updated_at = ?
                    WHERE thread_id = ?
                  `).run(baseName || "", coordId || null, ts, ts, parsedBrief.threadId);
                }
                try {
                  db.matchHubDispatch(workspacePath, parsedBrief.dispatchId, {
                    targetMemberName: baseName || null
                  });
                } catch {}
              }
            }
          }
        } else if (action === "model" && !input.error) {
          const baseName = String(args.name || "").trim();
          if (baseName && !SYSTEM_ROLE_NAME_RE.test(baseName)) {
            const nameRe = new RegExp(`^${escapeRegExp(baseName)}(?:-\\d+)?$`, "i");
            const { members } = readSwarmMembersMap(appDataDir, coordId);
            const rawArgModel = args.model !== undefined && args.model !== null ? String(args.model).trim() : "";
            const isInheritModel = !rawArgModel || rawArgModel === "inherit";
            const resolvedExplicitModel = !isInheritModel ? (db.resolveSwarmModel(rawArgModel) || rawArgModel) : null;
            const ts = db.nowIso();
            const candidateThreads = sql
              .prepare(`
                SELECT thread_id, swarm_member_name FROM threads
                WHERE swarm_member_name IS NOT NULL
                  AND (swarm_origin_coordinator_id = ? OR swarm_origin_coordinator_id IS NULL)
              `)
              .all(coordId || "");
            for (const row of candidateThreads) {
              if (!nameRe.test(String(row.swarm_member_name || ""))) continue;
              const nextModel = isInheritModel
                ? (members[row.swarm_member_name]?.model || members.coordinator?.model || null)
                : resolvedExplicitModel;
              sql.prepare("UPDATE threads SET swarm_model = ?, updated_at = ? WHERE thread_id = ?")
                .run(nextModel, ts, row.thread_id);
            }
            const modelDispatches = sql
              .prepare("SELECT dispatch_id, target_member_name FROM hub_dispatches WHERE action = 'switch_model' AND status IN ('pending', 'claimed')")
              .all();
            for (const d of modelDispatches) {
              if (d.target_member_name && nameRe.test(d.target_member_name)) {
                try { db.matchHubDispatch(workspacePath, d.dispatch_id, { targetMemberName: d.target_member_name }); } catch {}
              }
            }
          }
        } else if (action === "kill" && !input.error) {
          const baseName = String(args.name || "").trim();
          if (baseName && !SYSTEM_ROLE_NAME_RE.test(baseName)) {
            const nameRe = new RegExp(`^${escapeRegExp(baseName)}(?:-\\d+)?$`, "i");
            const ts = db.nowIso();
            const candidateThreads = sql
              .prepare(`
                SELECT thread_id, swarm_member_name FROM threads
                WHERE swarm_member_name IS NOT NULL
                  AND (swarm_origin_coordinator_id = ? OR swarm_origin_coordinator_id IS NULL)
              `)
              .all(coordId || "");
            for (const row of candidateThreads) {
              if (!nameRe.test(String(row.swarm_member_name || ""))) continue;
              sql.prepare(`
                UPDATE threads SET
                  swarm_state = 'killed',
                  ui_bucket = 'resolved',
                  server_status = 'resolved',
                  pre_pause_bucket = NULL,
                  working_since = NULL,
                  resolved_at = COALESCE(resolved_at, ?),
                  blocking_question = NULL,
                  blocking_is_error = 0,
                  active_dispatch_id = CASE WHEN active_dispatch_id IS NOT NULL THEN NULL ELSE active_dispatch_id END,
                  updated_at = ?
                WHERE thread_id = ?
              `).run(ts, ts, row.thread_id);
            }
            const killDispatches = sql
              .prepare("SELECT dispatch_id, target_member_name FROM hub_dispatches WHERE action = 'kill' AND status IN ('pending', 'claimed')")
              .all();
            for (const d of killDispatches) {
              if (d.target_member_name && nameRe.test(d.target_member_name)) {
                try { db.matchHubDispatch(workspacePath, d.dispatch_id, { targetMemberName: d.target_member_name }); } catch {}
              }
            }
          }
        }
      } else if (normTool === "post_message" && !input.error) {
        const text = String(args.text || "");
        const steerDispatches = sql
          .prepare("SELECT dispatch_id, thread_id, target_member_name FROM hub_dispatches WHERE action = 'steer' AND status = 'claimed'")
          .all();
        const ts = db.nowIso();
        for (const d of steerDispatches) {
          if (d.target_member_name && db.hasExactMention(text, d.target_member_name)) {
            try { db.matchHubDispatch(workspacePath, d.dispatch_id, { targetMemberName: d.target_member_name }); } catch {}
            // Leave swarm_state untouched so syncSwarmIntoProjectDb waits for Turn 2 transcript without premature working->idle park
            sql.prepare(`
              UPDATE threads SET
                ui_bucket = CASE WHEN ui_bucket IN ('resolved', 'paused', 'landing') THEN ui_bucket ELSE 'working' END,
                server_status = CASE WHEN ui_bucket IN ('resolved', 'paused', 'landing') THEN server_status ELSE 'working' END,
                blocking_question = CASE WHEN ui_bucket IN ('resolved', 'paused', 'landing') THEN blocking_question ELSE NULL END,
                blocking_is_error = CASE WHEN ui_bucket IN ('resolved', 'paused', 'landing') THEN blocking_is_error ELSE 0 END,
                working_since = CASE WHEN ui_bucket IN ('resolved', 'paused', 'landing') THEN working_since ELSE COALESCE(working_since, ?) END,
                updated_at = ?
              WHERE thread_id = ?
            `).run(ts, ts, d.thread_id);
          }
        }
      }
    }

    // Worker Swarm PostToolUse handlers (acting-member bounded derivation + board tail)
    if (role === "worker" && thread && !input.error && (normTool === "post_message" || normTool === "swarm_wait")) {
      try {
        const appDataDir = db.getAppDataDir();
        const coordId = thread.swarm_origin_coordinator_id || cfg?.coordinatorConversationId || null;
        const { swarmDir, members } = readSwarmMembersMap(appDataDir, coordId);
        const memberName = thread.swarm_member_name || "worker";
        const memberObj = (thread.swarm_member_name && members[thread.swarm_member_name]) || {
          name: memberName,
          conversation_id: thread.conversation_id || conversationId,
          role: "worker",
          state: thread.swarm_state || "working"
        };
        const singleState = db.deriveSingleMemberState(appDataDir, memberObj);
        const boardTail = swarmDir
          ? db.readBoardTailSync(path.join(swarmDir, "board.jsonl"))
          : { msgs: [], head: 0 };
        const headSeq = Number(boardTail.head || 0);
        const freshThread = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(thread.thread_id);
        const protectedBucket =
          freshThread && (freshThread.ui_bucket === "resolved" || freshThread.ui_bucket === "paused" || freshThread.ui_bucket === "landing");

        if (freshThread && !protectedBucket) {
          if (normTool === "post_message") {
            const text = String(args.text || "").trim();
            let latestMemberMsg = null;
            for (let i = boardTail.msgs.length - 1; i >= 0; i--) {
              const bm = boardTail.msgs[i];
              if (bm && !bm.control && bm.agent === memberName) {
                latestMemberMsg = bm;
                break;
              }
            }
            const memberPostSeq = latestMemberMsg ? (Number(latestMemberMsg.seq) || 0) : 0;
            const handledSeq = memberPostSeq > 0 ? memberPostSeq : headSeq;
            const formattedLastMsg = db.formatSwarmLastMessage(
              latestMemberMsg || { seq: memberPostSeq, agent: memberName, text }
            );

            if (db.DONE_LINE_RE.test(text)) {
              const summary =
                db.oneLine(text.replace(/^\s*(?:@[a-z0-9_-]+\s+)+\[done\]\s*/i, ""), 240) || "Swarm worker finished";
              const ts = db.nowIso();
              sql.prepare(`
                UPDATE threads SET
                  ui_bucket = 'ready_for_review',
                  server_status = ?,
                  pre_pause_bucket = NULL,
                  last_summary = ?,
                  blocking_question = NULL,
                  blocking_is_error = 0,
                  working_since = NULL,
                  swarm_state = ?,
                  swarm_last_message = ?,
                  swarm_last_seq = MAX(COALESCE(swarm_last_seq, 0), ?),
                  swarm_handled_seq = MAX(COALESCE(swarm_handled_seq, 0), ?),
                  updated_at = ?
                WHERE thread_id = ?
              `).run(
                db.uiBucketToServerStatus("ready_for_review"),
                summary,
                singleState.status || freshThread.swarm_state,
                formattedLastMsg,
                memberPostSeq,
                handledSeq,
                ts,
                thread.thread_id
              );
            } else {
              const mentionsCoord = db.hasExactMention(text, "coordinator");
              const isBlockedTag = mentionsCoord && db.BLOCKED_LINE_RE.test(text);
              const rq = mentionsCoord && !isBlockedTag ? db.replyQuestion(text) : "";
              if (isBlockedTag || rq) {
                const question = isBlockedTag
                  ? (db.oneLine(text.replace(/^\s*(?:@[a-z0-9_-]+\s+)+\[(?:blocked|question)\]\s*/i, ""), 240) ||
                      db.replyQuestion(text) ||
                      db.oneLine(text, 240) ||
                      "Worker requested input.")
                  : rq;
                const ts = db.nowIso();
                sql.prepare(`
                  UPDATE threads SET
                    ui_bucket = 'waiting_on_you',
                    server_status = ?,
                    pre_pause_bucket = NULL,
                    blocking_question = ?,
                    blocking_is_error = 0,
                    working_since = NULL,
                    swarm_state = ?,
                    swarm_last_message = ?,
                    swarm_last_seq = MAX(COALESCE(swarm_last_seq, 0), ?),
                    swarm_handled_seq = MAX(COALESCE(swarm_handled_seq, 0), ?),
                    updated_at = ?
                  WHERE thread_id = ?
                `).run(
                  db.uiBucketToServerStatus("waiting_on_you"),
                  question,
                  singleState.status || freshThread.swarm_state,
                  formattedLastMsg,
                  memberPostSeq,
                  handledSeq,
                  ts,
                  thread.thread_id
                );
              }
            }
          } else if (normTool === "swarm_wait") {
            let hasActiveDispatch = false;
            if (freshThread.active_dispatch_id) {
              const nowStr = db.nowIso();
              const activeDisp = sql
                .prepare(`
                  SELECT dispatch_id FROM hub_dispatches
                  WHERE dispatch_id = ?
                    AND ((status = 'pending' AND claim_expires_at > ?)
                      OR (status = 'claimed' AND match_expires_at > ?))
                `)
                .get(freshThread.active_dispatch_id, nowStr, nowStr);
              hasActiveDispatch = Boolean(activeDisp);
            }
            const rawSince = Number(args.since);
            const parsedSince = Number.isFinite(rawSince) && rawSince >= 0 ? Math.floor(rawSince) : 0;
            const waitHandledSeq = headSeq > 0 ? Math.min(headSeq, parsedSince) : parsedSince;

            if (singleState.status === "killed") {
              sql.prepare("UPDATE threads SET swarm_state = 'killed' WHERE thread_id = ?").run(thread.thread_id);
            } else if (freshThread.ui_bucket === "working" && !hasActiveDispatch) {
              const ts = db.nowIso();
              sql.prepare(`
                UPDATE threads SET
                  ui_bucket = 'idle',
                  server_status = 'idle',
                  pre_pause_bucket = NULL,
                  blocking_question = NULL,
                  blocking_is_error = 0,
                  working_since = NULL,
                  swarm_state = 'waiting',
                  swarm_handled_seq = MAX(COALESCE(swarm_handled_seq, 0), ?),
                  updated_at = ?
                WHERE thread_id = ?
              `).run(waitHandledSeq, ts, thread.thread_id);
            } else {
              sql.prepare("UPDATE threads SET swarm_state = ? WHERE thread_id = ?")
                .run(hasActiveDispatch ? (freshThread.swarm_state || "working") : "waiting", thread.thread_id);
            }
          }
        }
      } catch {}
    }

    // Auto-ingest deliverables written by either Coordinator or Worker Threads (excluding scratch scripts and .system_generated)
    if (!input.error && toolName === "write_file") {
      const writtenPath = args.Path || "";
      const normalizedWrittenPath = String(writtenPath).split(path.sep).join("/");
      const inSystemGenerated = normalizedWrittenPath.includes("/.system_generated/");
      const outputsDir = path.join(db.getProjectDir(workspacePath), "library", "outputs");
      const scratchDir = input.artifactDirectoryPath ? path.join(input.artifactDirectoryPath, "scratch") : "";
      const inOutputs = writtenPath && isInsideDir(writtenPath, outputsDir);
      const inArtifacts = writtenPath && input.artifactDirectoryPath && isInsideDir(writtenPath, input.artifactDirectoryPath);
      const inScratch = writtenPath && scratchDir && isInsideDir(writtenPath, scratchDir);
      const ext = path.extname(writtenPath).toLowerCase();
      const allowedAutoExts = new Set([".md", ".txt", ".json", ".html", ".csv", ".pdf"]);
      if (!inSystemGenerated && (inOutputs || (inArtifacts && !inScratch)) && allowedAutoExts.has(ext) && fs.existsSync(writtenPath)) {
        try {
          db.ingestLibraryItem(workspacePath, {
            sourcePath: writtenPath,
            category: "output",
            sourceType: role === "coordinator" ? "coordinator_artifact" : "thread_artifact",
            producerThreadId: thread ? thread.thread_id : null
          });
        } catch {}
      }
    }
    return sendJson({});
  }

  if (event === "Stop") {
    if (
      role === "worker" &&
      thread &&
      !input.continuationActive &&
      input.terminationReason === "NO_TOOL_CALL"
    ) {
      const freshThread = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(thread.thread_id);
      if (freshThread && freshThread.ui_bucket === "working") {
        const isSwarmWorker = freshThread.execution_backend === "swarm" || Boolean(freshThread.swarm_member_name);
        if (isSwarmWorker) {
          const appDataDir = db.getAppDataDir();
          const coordId = freshThread.swarm_origin_coordinator_id || cfg?.coordinatorConversationId || null;
          const { members } = readSwarmMembersMap(appDataDir, coordId);
          const memberObj = (freshThread.swarm_member_name && members[freshThread.swarm_member_name]) || {
            name: freshThread.swarm_member_name || "worker",
            conversation_id: freshThread.conversation_id || conversationId,
            role: "worker",
            state: freshThread.swarm_state || "working"
          };
          const derived = db.deriveSingleMemberState(appDataDir, memberObj);
          if (derived && (derived.status === "waiting" || derived.status === "killed")) {
            return sendJson({ decision: "allow" });
          }
          return sendJson({
            decision: "continue",
            reason:
              "Your Swarm Worker Thread is still marked 'working'. Before stopping, post your result with post_message (starting with '@coordinator [done] <summary>' or '@coordinator [blocked] <question>') and call swarm_wait."
          });
        }
        return sendJson({
          decision: "continue",
          reason:
            "Your Worker Thread is still marked 'working'. Before finishing your turn, call update_thread_state with uiBucket set to 'ready_for_review', 'waiting_on_you', 'idle', or 'resolved' and include a concise summary."
        });
      }
    }
    return sendJson({ decision: "allow" });
  }

  return sendJson({});
}

try {
  main();
} catch {
  // Fail-open safely on unexpected hook error so normal sessions are never bricked
  if (currentEvent === "PreToolUse" || currentEvent === "Stop") sendJson({ decision: "allow" });
  else sendJson({});
}
