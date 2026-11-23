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

  await t.test("GAP-10: PostToolUse swarm add does not hijack sibling worker rows", () => {
    const sql = db.openProjectDb(ws);
    const swarmDir = path.join(env.appData, "brain", coordId, ".system_generated", "swarm");
    fs.mkdirSync(swarmDir, { recursive: true });

    // Existing sibling impl-auth already finished (ready_for_review)
    const oldThread = db.registerThread(ws, {
      role: "implementer",
      title: "Old Auth",
      conversationId: "conv-auth-old",
      swarmMemberName: "impl-auth",
      executionBackend: "swarm",
      swarmOriginCoordinatorId: coordId
    });
    db.updateThreadState(ws, { threadId: oldThread.thread_id, uiBucket: "ready_for_review", summary: "Old done" });

    // New sibling impl-auth-2 proposed + claimed
    const [newProp] = db.proposeThreads(ws, [{ title: "New Auth 2", description: "v2", role: "implementer" }]);
    const newDisp = db.createHubDispatch(ws, {
      threadId: newProp.thread_id,
      action: "start",
      targetMemberName: "impl-auth-2",
      payload: { role: "implementer", title: "New Auth 2", prompt: "v2" }
    });
    const claimedNew = db.claimHubDispatch(ws, newDisp.dispatchId, newDisp.nonce);

    fs.writeFileSync(
      path.join(swarmDir, "members.json"),
      JSON.stringify({
        members: {
          "impl-auth": { role: "worker", conversation_id: "conv-auth-old", phase: "WAITING" },
          "impl-auth-2": { role: "worker", conversation_id: "conv-auth-new", phase: "WORKING" }
        }
      })
    );
    fs.writeFileSync(
      path.join(swarmDir, "board.jsonl"),
      JSON.stringify({ seq: 1, agent: "coordinator", kind: "brief", text: "@impl-auth legacy brief" }) + "\n"
    );

    env.callHook({
      hookEventName: "PostToolUse",
      conversationId: coordId,
      workspacePaths: [ws],
      toolCall: { name: "swarm", args: { action: "add", name: "impl-auth-2", brief: claimedNew.addArgs.brief } }
    });

    const oldRow = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(oldThread.thread_id);
    const newRow = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(newProp.thread_id);
    const dispRow = sql.prepare("SELECT * FROM hub_dispatches WHERE dispatch_id = ?").get(newDisp.dispatchId);

    assert.equal(oldRow.ui_bucket, "ready_for_review");
    assert.equal(oldRow.conversation_id, "conv-auth-old");
    assert.equal(oldRow.swarm_member_name, "impl-auth");
    assert.equal(newRow.swarm_member_name, "impl-auth-2");
    assert.equal(newRow.conversation_id, "conv-auth-new");
    assert.equal(newRow.ui_bucket, "working");
    assert.equal(dispRow.status, "matched");
    assert.equal(dispRow.target_member_name, "impl-auth-2");

    // Reverse: adding exact "impl-auth" must not touch "impl-auth-2"
    db.updateThreadState(ws, { threadId: newProp.thread_id, uiBucket: "ready_for_review", summary: "New done" });
    env.callHook({
      hookEventName: "PostToolUse",
      conversationId: coordId,
      workspacePaths: [ws],
      toolCall: { name: "swarm", args: { action: "add", name: "impl-auth", brief: "re-add exact base" } }
    });
    const newRowAfter = sql.prepare("SELECT * FROM threads WHERE thread_id = ?").get(newProp.thread_id);
    assert.equal(newRowAfter.ui_bucket, "ready_for_review");
    assert.equal(newRowAfter.conversation_id, "conv-auth-new");
  });

  await t.test("GAP-11: Stop hook enforces post_message/swarm_wait even after plain-text transcript flush", () => {
    const sql = db.openProjectDb(ws);
    const swarmDir = path.join(env.appData, "brain", coordId, ".system_generated", "swarm");
    fs.mkdirSync(swarmDir, { recursive: true });

    const stopConv = "conv-swarm-stop-1";
    const stopThread = db.registerThread(ws, {
      role: "implementer",
      title: "Stop Guard Worker",
      conversationId: stopConv,
      swarmMemberName: "impl-stop",
      executionBackend: "swarm",
      swarmOriginCoordinatorId: coordId
    });
    sql.prepare("UPDATE threads SET swarm_handled_seq = 1 WHERE thread_id = ?").run(stopThread.thread_id);

    // Flush a plain-text PLANNER_RESPONSE (no tool_calls) into transcript.jsonl so deriveSingleMemberState returns "waiting"
    const trDir = path.join(env.appData, "brain", stopConv, ".system_generated", "logs");
    fs.mkdirSync(trDir, { recursive: true });
    fs.writeFileSync(
      path.join(trDir, "transcript.jsonl"),
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [], content: "Finished without calling post_message!" }) + "\n"
    );

    const membersPath = path.join(swarmDir, "members.json");
    const boardPath = path.join(swarmDir, "board.jsonl");
    fs.writeFileSync(
      membersPath,
      JSON.stringify({ members: { "impl-stop": { role: "worker", conversation_id: stopConv, phase: "WAITING" } } })
    );
    fs.writeFileSync(
      boardPath,
      JSON.stringify({ seq: 1, agent: "coordinator", kind: "brief", text: "@impl-stop do work" }) + "\n"
    );

    // 1. No completion post on board.jsonl -> Stop MUST return continue (not bypassed by plain-text waiting state)
    const stopDeny = env.callHook({
      hookEventName: "Stop",
      conversationId: stopConv,
      workspacePaths: [ws],
      terminationReason: "NO_TOOL_CALL",
      continuationActive: false
    });
    assert.equal(stopDeny.decision, "continue");
    assert.match(stopDeny.reason, /post_message.*swarm_wait/i);

    // 2. Worker posts @coordinator [done] on board.jsonl -> Stop allows
    fs.appendFileSync(
      boardPath,
      JSON.stringify({ seq: 2, agent: "impl-stop", text: "@coordinator [done] completed task" }) + "\n"
    );
    const stopAllow = env.callHook({
      hookEventName: "Stop",
      conversationId: stopConv,
      workspacePaths: [ws],
      terminationReason: "NO_TOOL_CALL",
      continuationActive: false
    });
    assert.equal(stopAllow.decision, "allow");

    // 3. Coordinator steers on Turn 2 (seq 3) and worker exits plain-text without new post -> Stop returns continue again
    fs.appendFileSync(
      boardPath,
      JSON.stringify({ seq: 3, agent: "coordinator", text: "@impl-stop fix follow-up issue" }) + "\n"
    );
    const stopTurn2 = env.callHook({
      hookEventName: "Stop",
      conversationId: stopConv,
      workspacePaths: [ws],
      terminationReason: "NO_TOOL_CALL",
      continuationActive: false
    });
    assert.equal(stopTurn2.decision, "continue");

    // 4. Killed worker -> Stop allows
    fs.writeFileSync(
      membersPath,
      JSON.stringify({ members: { "impl-stop": { role: "worker", conversation_id: stopConv, killed: true, phase: "KILLED" } } })
    );
    const stopKilled = env.callHook({
      hookEventName: "Stop",
      conversationId: stopConv,
      workspacePaths: [ws],
      terminationReason: "NO_TOOL_CALL",
      continuationActive: false
    });
    assert.equal(stopKilled.decision, "allow");
  });

  await t.test("GAP-19: hooks.json matches edit_file and PostToolUse auto-ingests via TargetFile with telemetry", () => {
    const hooksCfg = JSON.parse(fs.readFileSync(path.join(env.REPO_ROOT, "hooks.json"), "utf8"));
    const postMatcher = hooksCfg["agy-projects-lifecycle"].PostToolUse[0].matcher;
    assert.ok(postMatcher.split("|").includes("edit_file"), `edit_file missing from PostToolUse matcher: ${postMatcher}`);

    const outputsDir = path.join(ws, ".agy-project", "library", "outputs");
    fs.mkdirSync(outputsDir, { recursive: true });
    const reportPath = path.join(outputsDir, "edited-deliverable.md");
    fs.writeFileSync(reportPath, "# Edited Report\nDeliverable updated via edit_file.\n");

    env.callHook({
      hookEventName: "PostToolUse",
      conversationId: "worker-impl-1",
      workspacePaths: [ws],
      toolCall: { name: "edit_file", args: { TargetFile: reportPath } },
      toolResponse: { ok: true }
    });

    const sql = db.openProjectDb(ws);
    const libItem = sql.prepare("SELECT * FROM library_items WHERE rel_path = ?").get("library/outputs/edited-deliverable.md");
    assert.ok(libItem, "edit_file deliverable was not auto-ingested into library_items");
    assert.equal(libItem.source_type, "thread_artifact");

    const workerRow = sql.prepare("SELECT live_telemetry_json FROM threads WHERE conversation_id = ?").get("worker-impl-1");
    const telemetry = JSON.parse(workerRow.live_telemetry_json || "[]");
    assert.ok(telemetry.some((e) => e.tool === "edit_file"), "edit_file telemetry not recorded");
  });

  await t.test("GAP-06: PreToolUse enforces networkPolicy (deny/ask/allow) and sandboxMode (enabled/disabled)", () => {
    const hooksCfg = JSON.parse(fs.readFileSync(path.join(env.REPO_ROOT, "hooks.json"), "utf8"));
    const preMatcher = hooksCfg["agy-projects-lifecycle"].PreToolUse[0].matcher.split("|");
    assert.ok(preMatcher.includes("search_web"), "search_web missing from PreToolUse matcher");
    assert.ok(preMatcher.includes("read_url_content"), "read_url_content missing from PreToolUse matcher");

    // Create a share-mode worker (no ownedGlobs) for sandbox testing
    const sbConv = "worker-sandbox-1";
    db.registerThread(ws, {
      role: "implementer",
      title: "Sandbox Worker",
      conversationId: sbConv,
      workspaceMode: "share"
    });

    // 1. networkPolicy = "deny" blocks search_web, read_url_content, and curl
    db.updateProjectSettings(ws, { environment: { networkPolicy: "deny", sandboxMode: "inherit" } });
    assert.equal(
      env.callHook({
        hookEventName: "PreToolUse",
        conversationId: sbConv,
        workspacePaths: [ws],
        toolCall: { name: "search_web", args: { query: "docs" } }
      }).decision,
      "deny"
    );
    assert.equal(
      env.callHook({
        hookEventName: "PreToolUse",
        conversationId: sbConv,
        workspacePaths: [ws],
        toolCall: { name: "read_url_content", args: { Url: "https://example.com" } }
      }).decision,
      "deny"
    );

    // 2. networkPolicy = "ask" prompts on web tools & curl, allows local commands, never downgrades hard denies
    db.updateProjectSettings(ws, { environment: { networkPolicy: "ask" } });
    const askWeb = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: sbConv,
      workspacePaths: [ws],
      toolCall: { name: "search_web", args: { query: "docs" } }
    });
    assert.equal(askWeb.decision, "ask");
    assert.match(askWeb.reason, /networkPolicy='ask'/);

    const askCurl = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: sbConv,
      workspacePaths: [ws],
      toolCall: { name: "run_command", args: { CommandLine: "curl https://example.com" } }
    });
    assert.equal(askCurl.decision, "ask");

    const allowLs = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: sbConv,
      workspacePaths: [ws],
      toolCall: { name: "run_command", args: { CommandLine: "ls -la" } }
    });
    assert.equal(allowLs.decision, "allow");

    // 3. networkPolicy = "allow" permits web tools & curl
    db.updateProjectSettings(ws, { environment: { networkPolicy: "allow" } });
    assert.equal(
      env.callHook({
        hookEventName: "PreToolUse",
        conversationId: sbConv,
        workspacePaths: [ws],
        toolCall: { name: "search_web", args: { query: "docs" } }
      }).decision,
      "allow"
    );
    assert.equal(
      env.callHook({
        hookEventName: "PreToolUse",
        conversationId: sbConv,
        workspacePaths: [ws],
        toolCall: { name: "run_command", args: { CommandLine: "curl https://example.com" } }
      }).decision,
      "allow"
    );

    // 4. sandboxMode = "enabled" blocks writes and command Cwd outside workspace, permits inside workspace & share clone root
    db.updateProjectSettings(ws, { environment: { sandboxMode: "enabled" } });
    const shareCloneRoot = env.makeWorkspace("share-clone-worker");
    const outsidePath = path.join(env.tmpRoot, "outside-sandbox.txt");
    const sbDenyWrite = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: sbConv,
      workspacePaths: [shareCloneRoot],
      toolCall: { name: "write_file", args: { Path: outsidePath, Content: "x" } }
    });
    assert.equal(sbDenyWrite.decision, "deny");
    assert.match(sbDenyWrite.reason, /Project Sandbox Guard/);

    const sbAllowShareClone = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: sbConv,
      workspacePaths: [shareCloneRoot],
      toolCall: { name: "write_file", args: { Path: path.join(shareCloneRoot, "src", "feature.js"), Content: "ok" } }
    });
    assert.equal(sbAllowShareClone.decision, "allow");

    const sbDenyInputCwd = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: sbConv,
      workspacePaths: [shareCloneRoot],
      cwd: env.tmpRoot,
      toolCall: { name: "run_command", args: { CommandLine: "ls" } }
    });
    assert.equal(sbDenyInputCwd.decision, "deny");
    assert.match(sbDenyInputCwd.reason, /Project Sandbox Guard/);

    const sbAllowInside = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: sbConv,
      workspacePaths: [shareCloneRoot],
      cwd: shareCloneRoot,
      toolCall: { name: "write_file", args: { Path: path.join(ws, "inside.txt"), Content: "ok" } }
    });
    assert.equal(sbAllowInside.decision, "allow");

    // 5. sandboxMode = "disabled" relaxes external path boundary
    db.updateProjectSettings(ws, { environment: { sandboxMode: "disabled" } });
    const sbDisabledAllow = env.callHook({
      hookEventName: "PreToolUse",
      conversationId: sbConv,
      workspacePaths: [ws],
      toolCall: { name: "write_file", args: { Path: outsidePath, Content: "x" } }
    });
    assert.equal(sbDisabledAllow.decision, "allow");
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
