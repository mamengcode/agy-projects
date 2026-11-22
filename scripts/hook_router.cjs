#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let db = null;
let currentEvent = "";

function getSharedDataDirFast() {
  const custom = process.env.AGY_PROJECTS_DATA_DIR?.trim();
  if (custom) return path.resolve(custom);
  const appDir = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim()
    ? path.resolve(process.env.ANTIGRAVITY_APP_DATA_DIR.trim())
    : path.join(os.homedir(), ".gemini", "antigravity");
  return path.join(appDir, "plugin_data", "agy-projects");
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
    return !Object.prototype.hasOwnProperty.call(reg.boundConversations, cid);
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
  const binding = db.resolveSessionBinding(conversationId, workspacePaths);

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
    const args = toolCall.args || {};

    if (toolName === "invoke_subagent") {
      try {
        db.checkThreadQuota(workspacePath);
      } catch (err) {
        return sendJson({ decision: "deny", reason: err.message });
      }

      const overwrite = {};
      const typeName = String(args.TypeName || "");
      const roleKey = db.normalizeRole(typeName.replace(/^project-/, ""));
      const roleModel = db.getRoleModelOverride(cfg, roleKey) || db.getRoleModelOverride(cfg, typeName);
      const fallbackModel = cfg?.models?.defaultThreadModel;

      if ((!args.Model || args.Model === "inherit") && roleModel && roleModel !== "inherit") {
        overwrite.Model = roleModel;
      } else if (!args.Model && fallbackModel && fallbackModel !== "inherit") {
        overwrite.Model = fallbackModel;
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
          reason: "Coordinator Separation Guard: Delegate lengthy test suite execution to a project-verifier Worker Thread via invoke_subagent."
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

        // Coordinator separation of concerns: delegate application source code mutations to isolated Worker Threads
        if (role === "coordinator" && !inProjectMeta && !inArtifacts) {
          return sendJson({
            decision: "deny",
            reason:
              "Coordinator Separation Guard: Coordinator sessions manage specs, memory, and orchestration, and must delegate application source edits to an isolated Worker Thread via invoke_subagent."
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

    // Auto-ingest deliverables written by either Coordinator or Worker Threads (excluding scratch scripts)
    if (!input.error && toolName === "write_file") {
      const writtenPath = args.Path || "";
      const outputsDir = path.join(db.getProjectDir(workspacePath), "library", "outputs");
      const scratchDir = input.artifactDirectoryPath ? path.join(input.artifactDirectoryPath, "scratch") : "";
      const inOutputs = writtenPath && isInsideDir(writtenPath, outputsDir);
      const inArtifacts = writtenPath && input.artifactDirectoryPath && isInsideDir(writtenPath, input.artifactDirectoryPath);
      const inScratch = writtenPath && scratchDir && isInsideDir(writtenPath, scratchDir);
      const ext = path.extname(writtenPath).toLowerCase();
      const allowedAutoExts = new Set([".md", ".txt", ".json", ".html", ".csv", ".pdf"]);
      if ((inOutputs || (inArtifacts && !inScratch)) && allowedAutoExts.has(ext) && fs.existsSync(writtenPath)) {
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
      const freshThread = sql.prepare("SELECT ui_bucket FROM threads WHERE thread_id = ?").get(thread.thread_id);
      if (freshThread && freshThread.ui_bucket === "working") {
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
