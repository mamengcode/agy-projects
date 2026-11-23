"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");

function createTestEnv(prefix = "agy-test-") {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const appData = path.join(tmpRoot, "appdata");
  const sharedData = path.join(tmpRoot, "shared");
  const binDir = path.join(tmpRoot, "bin");
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(sharedData, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const childProcs = new Set();

  function makeWorkspace(name = "ws") {
    const ws = path.join(tmpRoot, name);
    fs.mkdirSync(ws, { recursive: true });
    return ws;
  }

  function childEnv(extra = {}) {
    return {
      ...process.env,
      ANTIGRAVITY_APP_DATA_DIR: appData,
      AGY_PROJECTS_DATA_DIR: sharedData,
      AGY_DISABLE_ASYNC_RAG_EMBED: "1",
      ...extra
    };
  }

  function applyProcessEnv() {
    process.env.ANTIGRAVITY_APP_DATA_DIR = appData;
    process.env.AGY_PROJECTS_DATA_DIR = sharedData;
    process.env.AGY_DISABLE_ASYNC_RAG_EMBED = "1";
  }

  function createFakeAgentApi(scriptBody) {
    const exePath = path.join(binDir, "agentapi");
    fs.writeFileSync(exePath, scriptBody, { mode: 0o755 });
    return exePath;
  }

  function callMcp(messages, extraEnv = {}) {
    const lines = (Array.isArray(messages) ? messages : [messages]).map((m) => JSON.stringify(m)).join("\n") + "\n";
    const res = spawnSync(process.execPath, [path.join(REPO_ROOT, "server", "mcp_server.cjs")], {
      input: lines,
      encoding: "utf8",
      env: childEnv(extraEnv),
      timeout: 15000
    });
    if (res.status !== 0) {
      throw new Error(`mcp_server exited ${res.status}: ${res.stderr}`);
    }
    const parsed = res.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return parsed;
  }

  function callHook(payload, extraEnv = {}) {
    const res = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "hook_router.cjs")], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: childEnv(extraEnv),
      timeout: 15000
    });
    if (res.status !== 0) {
      throw new Error(`hook_router exited ${res.status}: ${res.stderr}`);
    }
    const raw = res.stdout.trim();
    return raw ? JSON.parse(raw) : {};
  }

  async function startDaemon(extraEnv = {}) {
    const token = extraEnv.ANTIGRAVITY_SIDECAR_UI_TOKEN || "test-sidecar-token-abcdef";
    const proc = spawn(process.execPath, [path.join(REPO_ROOT, "sidecars", "project_hub", "daemon.cjs")], {
      env: childEnv({
        ANTIGRAVITY_SIDECAR_WEB_PORT: "0",
        ANTIGRAVITY_SIDECAR_UI_TOKEN: token,
        ...extraEnv
      }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    childProcs.add(proc);

    const infoPath = path.join(sharedData, "server_info.json");
    let info = null;
    for (let i = 0; i < 60; i++) {
      if (proc.exitCode !== null) {
        throw new Error(`daemon exited prematurely with code ${proc.exitCode}`);
      }
      if (fs.existsSync(infoPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(infoPath, "utf8"));
          if (parsed && parsed.port) {
            info = parsed;
            break;
          }
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    if (!info) {
      proc.kill("SIGKILL");
      throw new Error("Timed out waiting for daemon server_info.json");
    }

    function request(method, reqPath, headers = {}, body = null) {
      return new Promise((resolve, reject) => {
        const isObj = body !== null && typeof body === "object" && !Buffer.isBuffer(body);
        const bodyStr = isObj ? JSON.stringify(body) : body;
        const reqHeaders = {
          ...(isObj ? { "Content-Type": "application/json" } : {}),
          ...headers,
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {})
        };
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: info.port,
            path: reqPath,
            method,
            headers: reqHeaders
          },
          (res) => {
            let raw = "";
            res.on("data", (chunk) => {
              raw += chunk;
            });
            res.on("end", () => {
              let json = null;
              try {
                json = JSON.parse(raw);
              } catch {}
              resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
            });
          }
        );
        req.on("error", reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
      });
    }

    async function stop() {
      childProcs.delete(proc);
      if (proc.exitCode === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {}
            resolve();
          }, 1500);
          proc.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          try {
            proc.kill("SIGTERM");
          } catch {
            clearTimeout(timer);
            resolve();
          }
        });
      }
    }

    return { port: info.port, token: info.token, proc, request, stop };
  }

  async function cleanup() {
    for (const proc of Array.from(childProcs)) {
      childProcs.delete(proc);
      if (proc.exitCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  return {
    REPO_ROOT,
    tmpRoot,
    appData,
    sharedData,
    binDir,
    makeWorkspace,
    childEnv,
    applyProcessEnv,
    createFakeAgentApi,
    callMcp,
    callHook,
    startDaemon,
    cleanup
  };
}

module.exports = {
  REPO_ROOT,
  createTestEnv
};
