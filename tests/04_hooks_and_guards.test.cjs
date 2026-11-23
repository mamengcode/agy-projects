"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createTestEnv } = require("./helpers.cjs");

test("Hook router guards (AT-01..AT-05, SessionStart, PreInvocation, PreToolUse, PostToolUse, Stop)", async (t) => {
  const env = createTestEnv("agy-t04-");
  env.applyProcessEnv();
  const db = require("../server/db.cjs");

  t.after(async () => {
    await env.cleanup();
  });

  const ws = env.makeWorkspace("hooks-ws");
  const coordId = "coord-hooks-1";
  db.createProject({
    name: "Hooks Project",
    workspacePath: ws,
    goal: "Verify hooks",
    instructions: "Always run tests.",
    coordinatorConversationId: coordId
  });
  db.updateProjectSettings(ws, {
    maxConcurrentThreads: 10,
    models: { defaultThreadModel: "claude-opus-5-5-medium", roleOverrides: { implementer: "gemini-4-hydrogen-high" } },
    environment: { networkPolicy: "deny" }
  });

  await t.test("AT-01: unbound conversation takes zero-SQLite fast path", () => {
    const pre = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: "unbound-conv-999",
      workspacePaths: [ws],
      toolCall: { name: "write_file", args: { Path: path.join(ws, "a.txt") } }
    });
    assert.equal(pre.decision, "allow");

    const preInv = env.callHook({
      hookEventName: "PreInvocation",
      conversationId: "unbound-conv-999",
      workspacePaths: [ws]
    });
    assert.deepEqual(preInv, {});
  });

  await t.test("SessionStart & PreInvocation inject active project context and delta updates", () => {
    const start = env.callHook({
      hookEventName: "SessionStart",
      conversationId: coordId,
      workspacePaths: [ws]
    });
    assert.ok(Array.isArray(start.injectSteps) && start.injectSteps.length > 0);
    const msg = start.injectSteps[0].systemMessage.systemMessage;
    assert.ok(msg.includes("AGY PROJECT ACTIVE"));
    assert.ok(msg.includes("Always run tests."));

    // Second PreInvocation with no changes injects nothing
    const idleInv = env.callHook({
      hookEventName: "PreInvocation",
      conversationId: coordId,
      workspacePaths: [ws]
    });
    assert.deepEqual(idleInv, {});

    // Updating instructions triggers delta injection
    db.updateProjectSettings(ws, { instructions: "Updated standing instruction." });
    const deltaInv = env.callHook({
      hookEventName: "PreInvocation",
      conversationId: coordId,
      workspacePaths: [ws]
    });
    assert.ok(Array.isArray(deltaInv.injectSteps) && deltaInv.injectSteps.length > 0);
    assert.ok(deltaInv.injectSteps[0].systemMessage.systemMessage.includes("Updated standing instruction."));
  });

  await t.test("PreToolUse enforces networkPolicy=deny, explorer read-only, ownedGlobs, and Swarm model precedence", () => {
    // Network deny on outbound shell network commands (curl / wget)
    const curlDeny = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: coordId,
      workspacePaths: [ws],
      toolCall: { name: "run_command", args: { CommandLine: "curl https://example.com" } }
    });
    assert.equal(curlDeny.decision, "deny");
    assert.match(curlDeny.reason, /networkPolicy='deny'/);

    const wgetDeny = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: coordId,
      workspacePaths: [ws],
      toolCall: { name: "run_command", args: { CommandLine: "wget https://example.com/file" } }
    });
    assert.equal(wgetDeny.decision, "deny");

    // Swarm add model precedence (explorer -> defaultThreadModel, implementer -> roleOverride)
    const expAdd = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: coordId,
      workspacePaths: [ws],
      toolCall: { name: "swarm", args: { action: "add", name: "expl-scan", brief: "Explore files." } }
    });
    assert.equal(expAdd.decision, "allow");
    assert.equal(expAdd.overwrite.model, "claude-opus-5-5-medium");

    const implAdd = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: coordId,
      workspacePaths: [ws],
      toolCall: { name: "swarm", args: { action: "add", name: "impl-core", brief: "Implement feature." } }
    });
    assert.equal(implAdd.decision, "allow");
    assert.equal(implAdd.overwrite.model, "gemini-4-hydrogen-high");

    // Coordinator Separation Guard blocks direct source file edits by coordinator
    const coordWrite = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: coordId,
      workspacePaths: [ws],
      toolCall: { name: "write_file", args: { Path: path.join(ws, "src", "app.js"), Content: "x" } }
    });
    assert.equal(coordWrite.decision, "deny");
    assert.match(coordWrite.reason, /Coordinator Separation Guard/);

    // Explorer worker blocked from mutating git commands
    db.registerThread(ws, {
      role: "explorer",
      title: "Readonly Explorer",
      conversationId: "worker-expl-1"
    });
    const explGitMutate = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: "worker-expl-1",
      workspacePaths: [ws],
      toolCall: { name: "run_command", args: { CommandLine: "git commit -m nope" } }
    });
    assert.equal(explGitMutate.decision, "deny");
    assert.match(explGitMutate.reason, /Read-Only Role Guard/);

    // Shared-workspace implementer worker with ownedGlobs blocked outside globs, allowed inside globs
    db.registerThread(ws, {
      role: "implementer",
      title: "Scoped Impl",
      conversationId: "worker-impl-1",
      workspaceMode: "inherit",
      ownedGlobs: ["src/auth/**"]
    });
    const outOfBounds = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: "worker-impl-1",
      workspacePaths: [ws],
      toolCall: { name: "write_file", args: { Path: path.join(ws, "src", "billing", "charge.js"), Content: "x" } }
    });
    assert.equal(outOfBounds.decision, "deny");

    const inBounds = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: "worker-impl-1",
      workspacePaths: [ws],
      toolCall: { name: "write_file", args: { Path: path.join(ws, "src", "auth", "login.js"), Content: "x" } }
    });
    assert.equal(inBounds.decision, "allow");
  });

  await t.test("PostToolUse swarm add matches dispatch and Stop hook runs cleanly", () => {
    const [prop] = db.proposeThreads(ws, [{ title: "Dispatch Match", description: "work", role: "implementer" }]);
    const disp = db.createHubDispatch(ws, {
      threadId: prop.thread_id,
      action: "start",
      targetMemberName: "impl-match",
      payload: { role: "implementer", title: prop.title, prompt: "work" }
    });
    const claimed = db.claimHubDispatch(ws, disp.dispatchId, disp.nonce);

    const post = env.callHook({
      hookEventName: "PostToolUse",
      conversationId: coordId,
      workspacePaths: [ws],
      toolCall: { name: "swarm", args: claimed.addArgs },
      toolResult: { ok: true }
    });
    assert.ok(typeof post === "object");
    const row = db.openProjectDb(ws).prepare("SELECT * FROM hub_dispatches WHERE dispatch_id = ?").get(disp.dispatchId);
    assert.equal(row.status, "matched");

    const stopOut = env.callHook({
      hookEventName: "Stop",
      conversationId: "worker-impl-1",
      workspacePaths: [ws]
    });
    assert.equal(stopOut.decision, "allow");
  });

  await t.test("AT-05: paused project hard-stops PreInvocation/PreToolUse mutations", () => {
    db.transitionProjectLifecycle(ws, { status: "paused" });
    const pausedPre = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: coordId,
      workspacePaths: [ws],
      toolCall: { name: "swarm", args: { action: "add", name: "impl-paused", brief: "Should fail" } }
    });
    assert.equal(pausedPre.decision, "deny");
    assert.match(pausedPre.reason, /paused/i);
  });
});
