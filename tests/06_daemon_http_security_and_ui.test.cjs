"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createTestEnv } = require("./helpers.cjs");

test("Sidecar Daemon HTTP/SSE APIs, CORS/CSP/Token Security (GAP-09, GAP-04), and UI script syntax", async (t) => {
  const env = createTestEnv("agy-t06-");
  env.applyProcessEnv();
  const db = require("../server/db.cjs");

  // Copy real host preload.js if present so we verify the live in-memory adaptation without touching host files
  const hostPreload = path.join(os.homedir(), ".gemini", "antigravity", "lib", "node_modules", "sidecar_sdk", "preload.js");
  if (fs.existsSync(hostPreload)) {
    const sdkDir = path.join(env.appData, "lib", "node_modules", "sidecar_sdk");
    fs.mkdirSync(sdkDir, { recursive: true });
    fs.copyFileSync(hostPreload, path.join(sdkDir, "preload.js"));
  }

  const fakeAgentApi = env.createFakeAgentApi(
    "#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true, conversationId: 'conv-stub', cwd: process.cwd(), envPid: process.env.ANTIGRAVITY_PROJECT_ID || null }));\n"
  );

  const daemon = await env.startDaemon({
    ANTIGRAVITY_AGENTAPI_EXE: fakeAgentApi,
    ANTIGRAVITY_SIDECAR_UI_TOKEN: "gap09-suite-secret-token"
  });

  t.after(async () => {
    await daemon.stop();
    await env.cleanup();
  });

  await t.test("ui.html inline <script> blocks have valid JavaScript syntax", () => {
    const uiHtml = fs.readFileSync(path.join(env.REPO_ROOT, "sidecars", "project_hub", "ui.html"), "utf8");
    const blocks = [...uiHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(blocks.length >= 2);
    for (const m of blocks) {
      if (m[1].trim()) new Function(m[1]);
    }
  });

  await t.test("HTML CSP rotating nonces, security headers, no ?token= exposure, and /preload.js VM auth (GAP-09)", async () => {
    const health = await daemon.request("GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);

    const h1 = await daemon.request("GET", "/?conversationId=%3C/script%3E%3Cscript%3Ealert(1)%3C/script%3E");
    assert.equal(h1.status, 200);
    const csp1 = h1.headers["content-security-policy"] || "";
    const nonceMatch = csp1.match(/script-src 'self' 'nonce-([A-Za-z0-9+/=]+)'/);
    assert.ok(nonceMatch, `Missing script-src nonce in CSP: ${csp1}`);
    const nonce1 = nonceMatch[1];
    assert.equal(/script-src[^;]*unsafe-inline/.test(csp1), false);
    assert.equal(/script-src[^;]*unsafe-eval/.test(csp1), false);
    assert.equal(h1.headers["x-content-type-options"], "nosniff");
    assert.equal(h1.headers["referrer-policy"], "no-referrer");
    assert.equal(h1.body.includes('searchParams.set("token"'), false);
    assert.equal(h1.body.includes("/preload.js?token="), false);
    assert.equal(h1.body.includes('searchParams.delete("token")'), true);
    assert.equal(h1.body.includes("alert(1)"), false);

    for (const m of h1.body.matchAll(/<script\b([^>]*)>/gi)) {
      if (!/\bsrc=/i.test(m[1])) assert.ok(m[1].includes(`nonce="${nonce1}"`));
    }
    for (const m of h1.body.matchAll(/<style\b([^>]*)>/gi)) {
      assert.ok(m[1].includes(`nonce="${nonce1}"`));
    }

    const h2 = await daemon.request("GET", "/ui.html");
    const nonce2 = (h2.headers["content-security-policy"] || "").match(/nonce-([A-Za-z0-9+/=]+)/)[1];
    assert.notEqual(nonce1, nonce2);

    const preload = await daemon.request("GET", "/preload.js");
    assert.equal(preload.status, 200);
    assert.equal(preload.body.includes(daemon.token), false);
    new Function(preload.body);

    if (fs.existsSync(hostPreload)) {
      const captured = [];
      const sandbox = {
        URLSearchParams,
        Headers,
        Promise,
        Set,
        Object,
        Array,
        console,
        queueMicrotask,
        fetch: async (url, opts) => {
          const hdrs = opts?.headers instanceof Headers ? Object.fromEntries(opts.headers.entries()) : (opts?.headers || {});
          captured.push({ url, headers: hdrs });
          return { ok: true, json: async () => ({ ok: true, response: {} }), text: async () => "{}" };
        },
        document: {
          readyState: "complete",
          body: { style: {} },
          documentElement: { style: { setProperty: () => {} } },
          addEventListener: () => {}
        }
      };
      sandbox.window = sandbox;
      sandbox.parent = sandbox;
      sandbox.location = { search: "" };
      sandbox.addEventListener = () => {};
      sandbox.__SIDECAR_TOKEN__ = daemon.token;
      sandbox.__SIDECAR_CONVERSATION_ID__ = "conv-vm-1";
      vm.runInNewContext(preload.body, sandbox);

      await sandbox.sidecar.fetch("/api/state");
      await sandbox.sidecar.agent.sendMessage("ping", "conv-vm-1");
      assert.ok(captured.length >= 2);
      for (const req of captured) {
        assert.equal(req.headers["x-sidecar-token"], daemon.token);
      }
    }
  });

  await t.test("CORS allow/deny and API token authentication enforcement (GAP-09)", async () => {
    const evilOpt = await daemon.request("OPTIONS", "/api/state", { Origin: "https://evil.example" });
    assert.equal(evilOpt.status, 403);
    assert.equal(evilOpt.headers["access-control-allow-origin"], undefined);

    const evilGet = await daemon.request("GET", "/api/state", {
      Origin: "https://evil.example",
      "X-Sidecar-Token": daemon.token
    });
    assert.equal(evilGet.status, 403);

    const nullOrigin = await daemon.request("GET", "/api/state", {
      Origin: "null",
      "X-Sidecar-Token": daemon.token
    });
    assert.equal(nullOrigin.status, 403);

    const wrongPort = await daemon.request("GET", "/api/state", {
      Origin: "http://127.0.0.1:9999",
      "X-Sidecar-Token": daemon.token
    });
    assert.equal(wrongPort.status, 403);

    const okOpt = await daemon.request("OPTIONS", "/api/state", { Origin: `http://127.0.0.1:${daemon.port}` });
    assert.equal(okOpt.status, 204);
    assert.equal(okOpt.headers["access-control-allow-origin"], `http://127.0.0.1:${daemon.port}`);
    assert.equal(okOpt.headers["vary"], "Origin");

    const okWebview = await daemon.request("GET", "/api/state", {
      Origin: "vscode-webview://pane-1",
      "X-Sidecar-Token": daemon.token
    });
    assert.equal(okWebview.status, 200);
    assert.equal(okWebview.headers["access-control-allow-origin"], "vscode-webview://pane-1");

    // Token auth checks
    assert.equal((await daemon.request("GET", "/api/state")).status, 401);
    assert.equal((await daemon.request("GET", "/api/state", { "X-Sidecar-Token": "wrong" })).status, 401);
    assert.equal((await daemon.request("GET", `/api/state?token=${encodeURIComponent(daemon.token)}`)).status, 401);
  });

  await t.test("Daemon CRUD, GAP-04 400 rejection, SSE validation, and /_sidecar/new-conversation", async () => {
    const wsA = env.makeWorkspace("http-a");
    const wsB = env.makeWorkspace("http-b");
    const wsUninit = env.makeWorkspace("http-uninit");
    const auth = { "X-Sidecar-Token": daemon.token };

    const cA = await daemon.request("POST", "/api/projects/create", auth, { name: "HTTP A", workspacePath: wsA, goal: "gA" });
    assert.equal(cA.status, 200);
    const pidA = cA.json.config.projectId;

    const cB = await daemon.request("POST", "/api/projects/create", auth, { name: "HTTP B", workspacePath: wsB, goal: "gB" });
    assert.equal(cB.status, 200);
    const pidB = cB.json.config.projectId;

    await daemon.request("POST", "/api/projects/select", auth, { projectId: pidA });

    // Uninitialized workspacePath -> 400 on POST, GET /api/state, GET /api/events, /_sidecar/new-conversation
    const badUpd = await daemon.request("POST", "/api/settings/update", auth, { workspacePath: wsUninit, goal: "hacked" });
    assert.equal(badUpd.status, 400);
    assert.equal(db.loadProjectConfig(wsA).goal, "gA");

    const badConflict = await daemon.request("POST", "/api/settings/update", auth, { workspacePath: wsA, projectId: pidB, goal: "hacked" });
    assert.equal(badConflict.status, 400);

    const badState = await daemon.request("GET", `/api/state?workspacePath=${encodeURIComponent(wsUninit)}`, auth);
    assert.equal(badState.status, 400);

    const badEvents = await daemon.request("GET", `/api/events?workspacePath=${encodeURIComponent(wsUninit)}`, auth);
    assert.equal(badEvents.status, 400);

    const badNewConv = await daemon.request("POST", "/_sidecar/new-conversation", auth, {
      message: "bad",
      workspacePath: wsUninit
    });
    assert.equal(badNewConv.status, 400);

    // /_sidecar/new-conversation with host agentapi projectId succeeds and uses active workspace cwd
    const hostNewConv = await daemon.request("POST", "/_sidecar/new-conversation", auth, {
      message: "hello host",
      projectId: "host-agentapi-pid-999"
    });
    assert.equal(hostNewConv.status, 200);
    assert.equal(fs.realpathSync(hostNewConv.json.cwd), fs.realpathSync(wsA));
    assert.equal(hostNewConv.json.envPid, "host-agentapi-pid-999");

    // Valid API mutations
    const updOk = await daemon.request("POST", "/api/settings/update", auth, { workspacePath: wsA, goal: "updated-A" });
    assert.equal(updOk.status, 200);
    assert.equal(updOk.json.config.goal, "updated-A");

    const propOk = await daemon.request("POST", "/api/threads/propose", auth, {
      workspacePath: wsA,
      proposals: [{ title: "UI Task", description: "Do work", role: "explorer" }]
    });
    assert.equal(propOk.status, 200);
    assert.equal(propOk.json.threads.length, 1);
  });
});
