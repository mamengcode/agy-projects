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

  await t.test("GAP-14 & GAP-15: worktree API, batch start HTTP errors, executionBackend, routines edit, and UI controls", async () => {
    const wsWt = env.makeGitRepo("daemon-wt");
    db.createProject({ name: "Daemon WT", workspacePath: wsWt });
    const bound = db.bindRepository(wsWt, { localPath: wsWt, name: "daemon-wt" });
    db.updateProjectSettings(wsWt, {
      executionEngine: "subagent",
      defaultWorkspaceMode: "worktree",
      maxConcurrentThreads: 1
    });
    const auth = { "X-Sidecar-Token": daemon.token };

    // 1. /api/worktrees/action create -> status -> cleanup
    const wtCreate = await daemon.request("POST", "/api/worktrees/action", auth, {
      workspacePath: wsWt,
      action: "create",
      threadId: "t-api-wt",
      repoId: bound.repo_id
    });
    assert.equal(wtCreate.status, 200);
    assert.equal(wtCreate.json.created, true);
    assert.equal(fs.existsSync(wtCreate.json.worktreePath), true);

    const wtStatus = await daemon.request("POST", "/api/worktrees/action", auth, {
      workspacePath: wsWt,
      action: "status",
      threadId: "t-api-wt",
      repoId: bound.repo_id
    });
    assert.equal(wtStatus.status, 200);
    assert.equal(wtStatus.json.exists, true);

    const wtCleanup = await daemon.request("POST", "/api/worktrees/action", auth, {
      workspacePath: wsWt,
      action: "cleanup",
      threadId: "t-api-wt"
    });
    assert.equal(wtCleanup.status, 200);
    assert.equal(wtCleanup.json.cleanedUp, true);
    assert.equal(fs.existsSync(wtCreate.json.worktreePath), false);

    // 2. Single start sets execution_backend correctly ("headless" vs "subagent")
    const props = db.proposeThreads(wsWt, [
      { threadId: "t-be-head", title: "Headless Task", description: "Run", role: "explorer" },
      { threadId: "t-be-sub", title: "Subagent Task", description: "Run", role: "explorer" },
      { threadId: "t-be-q1", title: "Quota Task 1", description: "Run", role: "explorer" }
    ]);
    assert.equal(props.length, 3);

    const startHeadless = await daemon.request("POST", "/api/threads/action", auth, {
      workspacePath: wsWt,
      action: "start",
      threadId: "t-be-head",
      launchHeadless: true
    });
    assert.equal(startHeadless.status, 200);
    assert.equal(startHeadless.json.thread.execution_backend, "headless");

    // Resolve t-be-head so slot frees up; test start_selected partialFailure & 409 quota error
    db.updateThreadState(wsWt, { threadId: "t-be-head", uiBucket: "resolved" });

    const partialBatch = await daemon.request("POST", "/api/threads/action", auth, {
      workspacePath: wsWt,
      action: "start_selected",
      threadIds: ["t-be-sub", "t-be-q1"],
      executionBackend: "subagent",
      launchHeadless: false
    });
    assert.equal(partialBatch.status, 200);
    assert.equal(partialBatch.json.startedCount, 1);
    assert.equal(partialBatch.json.threads[0].execution_backend, "subagent");
    assert.equal(partialBatch.json.partialFailure, true);
    assert.equal(partialBatch.json.failures.length, 1);
    assert.equal(partialBatch.json.failures[0].code, "quota_exceeded");

    // Now slot is full (1/1): start_all must fail with HTTP 409, NOT 200 { startedCount: 0 }
    const fullQuotaBatch = await daemon.request("POST", "/api/threads/action", auth, {
      workspacePath: wsWt,
      action: "start_all",
      executionBackend: "subagent",
      launchHeadless: false
    });
    assert.equal(fullQuotaBatch.status, 409);
    assert.equal(fullQuotaBatch.json.startedCount, 0);
    assert.equal(fullQuotaBatch.json.failures[0].code, "quota_exceeded");

    // 3. Routine create, edit (routineId), disable (enabled: false), and workspaceMode: "worktree"
    const rtCreate = await daemon.request("POST", "/api/routines/upsert", auth, {
      workspacePath: wsWt,
      name: "Nightly WT",
      cronExpr: "0 3 * * *",
      prompt: "Check repo",
      targetRole: "implementer",
      workspaceMode: "worktree",
      enabled: true
    });
    assert.equal(rtCreate.status, 200);
    const rid = rtCreate.json.routine.routine_id;
    assert.equal(rtCreate.json.routine.workspace_mode, "worktree");
    assert.equal(rtCreate.json.routine.enabled, 1);

    const rtEdit = await daemon.request("POST", "/api/routines/upsert", auth, {
      workspacePath: wsWt,
      routineId: rid,
      name: "Nightly WT Edited",
      cronExpr: "30 4 * * *",
      prompt: "Check repo v2",
      targetRole: "verifier",
      workspaceMode: "worktree",
      enabled: false
    });
    assert.equal(rtEdit.status, 200);
    assert.equal(rtEdit.json.routine.routine_id, rid);
    assert.equal(rtEdit.json.routine.name, "Nightly WT Edited");
    assert.equal(rtEdit.json.routine.enabled, 0);

    // 3b. POST /api/routines/run-now (headless path) sets execution_backend='headless' and auto-provisions worktree
    db.updateProjectSettings(wsWt, { maxConcurrentThreads: 5, executionEngine: "headless" });
    const rtRunNow = await daemon.request("POST", "/api/routines/run-now", auth, {
      workspacePath: wsWt,
      routineId: rid
    });
    assert.equal(rtRunNow.status, 200);
    assert.equal(rtRunNow.json.thread.execution_backend, "headless");
    assert.ok(rtRunNow.json.thread.worktree_path, "run-now should auto-provision worktree for workspaceMode='worktree'");
    assert.equal(fs.existsSync(rtRunNow.json.thread.worktree_path), true);
    db.manageWorktree(wsWt, { action: "cleanup", threadId: rtRunNow.json.thread.thread_id });

    // 3c. Single start on workspaceMode='worktree' thread auto-provisions worktree
    const [wtTask] = db.proposeThreads(wsWt, [
      { threadId: "t-auto-wt-start", title: "Auto WT Start", description: "Work", role: "implementer", workspaceMode: "worktree", repoId: bound.repo_id }
    ]);
    const autoWtStart = await daemon.request("POST", "/api/threads/action", auth, {
      workspacePath: wsWt,
      action: "start",
      threadId: wtTask.thread_id,
      executionBackend: "subagent",
      launchHeadless: false
    });
    assert.equal(autoWtStart.status, 200);
    assert.ok(autoWtStart.json.thread.worktree_path);
    assert.equal(fs.existsSync(autoWtStart.json.thread.worktree_path), true);
    db.manageWorktree(wsWt, { action: "cleanup", threadId: wtTask.thread_id });

    // 4. UI markup parity checks for GAP-14 & GAP-15
    const uiHtml = fs.readFileSync(path.join(env.REPO_ROOT, "sidecars", "project_hub", "ui.html"), "utf8");
    for (const id of [
      'id="set-exec-engine"',
      'id="set-max-mem-chars"',
      'id="set-claim-ttl"',
      'id="set-match-ttl"',
      'id="pt-ws-mode"',
      'id="pt-repo"',
      'id="pt-owned-globs"',
      'id="rt-id"',
      'id="rt-ws-mode"',
      'id="rt-enabled"',
      'id="td-worktree-section"',
      'id="btn-td-wt-status"',
      'id="btn-td-wt-cleanup"'
    ]) {
      assert.ok(uiHtml.includes(id), `ui.html missing ${id}`);
    }
    assert.ok(uiHtml.includes('<option value="worktree">worktree</option>'));
    assert.ok(uiHtml.includes("Unarchive"));
    assert.ok(uiHtml.includes("webkitRelativePath"));
    assert.ok(uiHtml.includes("relativePath:"));

    // 5. GAP-16: /api/library/upload preserves relative subpaths, disambiguates collisions, and rejects traversal
    const upA = await daemon.request("POST", "/api/library/upload", auth, {
      workspacePath: wsWt,
      filename: "a/notes.md",
      relativePath: "a/notes.md",
      textContent: "Notes A"
    });
    assert.equal(upA.status, 200);
    assert.equal(upA.json.item.rel_path, "library/inputs/a/notes.md");

    const upB = await daemon.request("POST", "/api/library/upload", auth, {
      workspacePath: wsWt,
      filename: "b/notes.md",
      relativePath: "b/notes.md",
      textContent: "Notes B"
    });
    assert.equal(upB.status, 200);
    assert.equal(upB.json.item.rel_path, "library/inputs/b/notes.md");

    const upB2 = await daemon.request("POST", "/api/library/upload", auth, {
      workspacePath: wsWt,
      filename: "b/notes.md",
      relativePath: "b/notes.md",
      textContent: "Notes B v2"
    });
    assert.equal(upB2.status, 200);
    assert.notEqual(upB2.json.item.rel_path, upB.json.item.rel_path);

    const upTrav = await daemon.request("POST", "/api/library/upload", auth, {
      workspacePath: wsWt,
      filename: "../outside.md",
      relativePath: "../outside.md",
      textContent: "escape"
    });
    assert.equal(upTrav.status, 400);
  });

  await t.test("GAP-17: live SSE /api/events emits accountMemoryContent & diagnostics on init and broadcast, and ui.html wires EventSource", async () => {
    const http = require("node:http");
    const wsSse = env.makeWorkspace("daemon-sse");
    db.createProject({ name: "SSE Proj", workspacePath: wsSse });
    const auth = { "X-Sidecar-Token": daemon.token };

    // Set account memory first so initial SSE frame carries it
    const acctRes = await daemon.request("POST", "/api/memory/save-account", auth, {
      workspacePath: wsSse,
      content: "# Account Memory\nGAP-17 initial marker\n"
    });
    assert.equal(acctRes.status, 200);

    const frames = [];
    let waitForFrame = null;
    const nextFrame = () =>
      new Promise((resolve, reject) => {
        if (frames.length > 0) return resolve(frames.shift());
        const timer = setTimeout(() => reject(new Error("Timed out waiting for SSE snapshot frame")), 5000);
        waitForFrame = (val) => {
          clearTimeout(timer);
          waitForFrame = null;
          resolve(val);
        };
      });

    const sseReq = http.request({
      hostname: "127.0.0.1",
      port: daemon.port,
      path: `/api/events?token=${encodeURIComponent(daemon.token)}&workspacePath=${encodeURIComponent(wsSse)}`,
      method: "GET"
    });

    let sseResRef = null;
    let buf = "";
    const connected = new Promise((resolve, reject) => {
      sseReq.on("error", reject);
      sseReq.on("response", (res) => {
        sseResRef = res;
        assert.equal(res.statusCode, 200);
        assert.match(String(res.headers["content-type"] || ""), /text\/event-stream/);
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const rawBlock = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = rawBlock
              .split("\n")
              .find((l) => l.startsWith("data: "));
            if (dataLine) {
              const parsed = JSON.parse(dataLine.slice(6));
              if (waitForFrame) waitForFrame(parsed);
              else frames.push(parsed);
            }
          }
        });
        resolve();
      });
    });
    sseReq.end();

    try {
      await connected;
      // 1. Initial SSE snapshot includes accountMemoryContent and diagnostics
      const initSnap = await nextFrame();
      assert.equal(initSnap.initialized, true);
      assert.ok(String(initSnap.accountMemoryContent || "").includes("GAP-17 initial marker"));
      assert.ok(initSnap.diagnostics && typeof initSnap.diagnostics === "object");
      assert.ok(initSnap.diagnostics.connectors && initSnap.diagnostics.plugins);

      // 2. Mutation triggers broadcastSnapshot() which ALSO includes accountMemoryContent & diagnostics
      const updGoal = await daemon.request("POST", "/api/settings/update", auth, {
        workspacePath: wsSse,
        goal: "SSE-broadcast-verified"
      });
      assert.equal(updGoal.status, 200);

      const broadcastSnap = await nextFrame();
      assert.equal(broadcastSnap.config.goal, "SSE-broadcast-verified");
      assert.ok(String(broadcastSnap.accountMemoryContent || "").includes("GAP-17 initial marker"));
      assert.ok(broadcastSnap.diagnostics && typeof broadcastSnap.diagnostics === "object");
      assert.ok(broadcastSnap.diagnostics.connectors && broadcastSnap.diagnostics.plugins);
    } finally {
      try { sseReq.destroy(); } catch {}
      try { sseResRef?.destroy(); } catch {}
    }

    // 2b. Unpinned /api/events follows active project switches immediately (POST /api/projects/select)
    const wsSseB = env.makeWorkspace("daemon-sse-b");
    const createdB = db.createProject({ name: "SSE Proj B", workspacePath: wsSseB });
    const regSse = db.loadRegistry();
    const projA = regSse.projects.find((p) => path.resolve(p.workspacePath) === path.resolve(wsSse));
    db.selectProject({ projectId: projA.projectId });

    const uFrames = [];
    let uWait = null;
    const nextUnpinned = () =>
      new Promise((resolve, reject) => {
        if (uFrames.length > 0) return resolve(uFrames.shift());
        const timer = setTimeout(() => reject(new Error("Timed out waiting for unpinned SSE frame")), 5000);
        uWait = (val) => {
          clearTimeout(timer);
          uWait = null;
          resolve(val);
        };
      });

    const uReq = http.request({
      hostname: "127.0.0.1",
      port: daemon.port,
      path: `/api/events?token=${encodeURIComponent(daemon.token)}`,
      method: "GET"
    });
    let uResRef = null;
    let uBuf = "";
    const uConn = new Promise((resolve, reject) => {
      uReq.on("error", reject);
      uReq.on("response", (res) => {
        uResRef = res;
        assert.equal(res.statusCode, 200);
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          uBuf += chunk;
          let idx;
          while ((idx = uBuf.indexOf("\n\n")) !== -1) {
            const rawBlock = uBuf.slice(0, idx);
            uBuf = uBuf.slice(idx + 2);
            const dataLine = rawBlock.split("\n").find((l) => l.startsWith("data: "));
            if (dataLine) {
              const parsed = JSON.parse(dataLine.slice(6));
              if (uWait) uWait(parsed);
              else uFrames.push(parsed);
            }
          }
        });
        resolve();
      });
    });
    uReq.end();

    try {
      await uConn;
      const uInit = await nextUnpinned();
      assert.equal(uInit.config.projectId, projA.projectId);

      const projBId = createdB.config.projectId;
      const selB = await daemon.request("POST", "/api/projects/select", auth, {
        projectId: projBId
      });
      assert.equal(selB.status, 200);

      const uSwitched = await nextUnpinned();
      assert.equal(uSwitched.config.projectId, projBId);
      assert.equal(uSwitched.config.name, "SSE Proj B");
      assert.ok(uSwitched.diagnostics && uSwitched.diagnostics.connectors);
    } finally {
      try { uReq.destroy(); } catch {}
      try { uResRef?.destroy(); } catch {}
    }

    // 3. ui.html EventSource wiring & cleanup assertions
    const uiHtml = fs.readFileSync(path.join(env.REPO_ROOT, "sidecars", "project_hub", "ui.html"), "utf8");
    assert.ok(uiHtml.includes("new EventSource("));
    assert.ok(uiHtml.includes("/api/events"));
    assert.ok(uiHtml.includes('addEventListener("snapshot"'));
    assert.ok(uiHtml.includes("closeStateSse"));
    assert.ok(uiHtml.includes('window.addEventListener("beforeunload", closeStateSse)'));
  });

  await t.test("GAP-21: static ARIA tablist/tab roles, no openUri, renderSafeSnippet XSS/mark handling, and killed-worker steer guard", () => {
    const uiHtml = fs.readFileSync(path.join(env.REPO_ROOT, "sidecars", "project_hub", "ui.html"), "utf8");

    // 1. Static ARIA roles on tablist & all 6 tabs
    assert.ok(uiHtml.includes('id="main-tablist" role="tablist"'));
    for (const tabId of ["tab-overview", "tab-threads", "tab-library", "tab-memory", "tab-prs", "tab-settings"]) {
      assert.ok(
        uiHtml.includes(`role="tab" id="${tabId}"`),
        `Missing static role="tab" on ${tabId}`
      );
    }

    // 2. Non-existent window.sidecar.ui.openUri removed
    assert.equal(uiHtml.includes("openUri"), false, "ui.html must not reference non-existent sidecar.ui.openUri");

    // 3. Killed-worker steer guard throws (preserving input/modal) and disables form controls
    assert.ok(uiHtml.includes('throw new Error(`Cannot steer killed Swarm worker @${thread.swarm_member_name}.`)'));
    assert.ok(uiHtml.includes("if (steerInput) steerInput.disabled = isKilledSwarm;"));
    assert.ok(uiHtml.includes("if (steerBtn) steerBtn.disabled = isKilledSwarm;"));
    assert.ok(uiHtml.includes('id="steer-form-hint"'));

    // 4. Execute extracted renderSafeSnippet in VM on both setHTML and DOM fallback paths
    const fnStart = uiHtml.indexOf("function renderSafeSnippet(");
    const fnEnd = uiHtml.indexOf("function formatElapsedSeconds(");
    assert.ok(fnStart > 0 && fnEnd > fnStart);
    const fnSrc = uiHtml.slice(fnStart, fnEnd);

    // 4a. Native setHTML path preserves <mark> without pre-escaping
    let capturedHtml = null;
    let capturedOpts = null;
    const setHtmlSandbox = {
      Element: { prototype: { setHTML: () => {} } }
    };
    vm.runInNewContext(`${fnSrc}\nthis.renderSafeSnippet = renderSafeSnippet;`, setHtmlSandbox);
    setHtmlSandbox.renderSafeSnippet(
      {
        setHTML(html, opts) {
          capturedHtml = html;
          capturedOpts = opts;
        }
      },
      'Hello <mark>world</mark> &amp; <script>alert(1)</script>'
    );
    assert.ok(capturedHtml.includes("<mark>world</mark>"), "setHTML path must not pre-escape <mark>");
    assert.equal(capturedHtml.includes("&amp;amp;"), false, "setHTML path must not double-escape entities");
    assert.deepEqual(Array.from(capturedOpts.sanitizer.elements), ["code", "mark", "strong", "em"]);
    assert.deepEqual(Array.from(capturedOpts.sanitizer.attributes), []);

    // 4b. Fallback DOM tokenizer path preserves <mark>, strips <script> and <img onerror>, and drops attributes
    class MockNode {
      constructor(type, tagOrText) {
        this.type = type;
        this.tagName = type === "el" ? tagOrText.toUpperCase() : "";
        this.text = type === "text" ? tagOrText : "";
        this.children = [];
      }
      appendChild(c) {
        this.children.push(c);
        return c;
      }
      replaceChildren(...nodes) {
        this.children = nodes;
      }
    }
    const fallbackSandbox = {
      Element: { prototype: {} },
      document: {
        createElement: (tag) => new MockNode("el", tag),
        createTextNode: (txt) => new MockNode("text", txt)
      }
    };
    vm.runInNewContext(`${fnSrc}\nthis.renderSafeSnippet = renderSafeSnippet;`, fallbackSandbox);
    const container = new MockNode("el", "div");
    fallbackSandbox.renderSafeSnippet(
      container,
      'Match: <mark onclick="alert(1)">token</mark> &amp; &lt;script&gt; <script>alert(2)</script><img src=x onerror=alert(3)> <strong>ok</strong>'
    );
    const serialize = (n) =>
      n.type === "text" ? n.text : `<${n.tagName.toLowerCase()}>${n.children.map(serialize).join("")}</${n.tagName.toLowerCase()}>`;
    const rendered = container.children.map(serialize).join("");
    assert.equal(rendered, "<code>Match: <mark>token</mark> & <script>  <strong>ok</strong></code>");
    // Verify "& <script> " is a plain text node (not an element)
    const codeChildren = container.children[0].children;
    assert.equal(codeChildren[2].type, "text");
    assert.equal(codeChildren[2].text, " & <script> ");

    // 4c. Throwing setHTML (older Chromium Sanitizer signature) falls back cleanly to DOM tokenizer
    const throwingSandbox = {
      Element: { prototype: { setHTML: () => { throw new TypeError("Invalid Sanitizer"); } } },
      document: {
        createElement: (tag) => new MockNode("el", tag),
        createTextNode: (txt) => new MockNode("text", txt)
      }
    };
    vm.runInNewContext(`${fnSrc}\nthis.renderSafeSnippet = renderSafeSnippet;`, throwingSandbox);
    const fallbackContainer = new MockNode("el", "div");
    fallbackContainer.setHTML = () => { throw new TypeError("Invalid Sanitizer"); };
    throwingSandbox.renderSafeSnippet(fallbackContainer, "Safe <mark>hit</mark> &quot;q&quot;");
    assert.equal(fallbackContainer.children.map(serialize).join(""), '<code>Safe <mark>hit</mark> "q"</code>');
  });
});
