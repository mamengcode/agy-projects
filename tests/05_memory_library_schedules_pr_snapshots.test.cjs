"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createTestEnv } = require("./helpers.cjs");

test("Memory curation, Library ingestion & search, Schedules, PRs, and Privacy-Safe Snapshots (AT-07)", async (t) => {
  const env = createTestEnv("agy-t05-");
  env.applyProcessEnv();
  const db = require("../server/db.cjs");

  t.after(async () => {
    await env.cleanup();
  });

  const ws = env.makeWorkspace("data-ws");
  db.createProject({ name: "Data Proj", workspacePath: ws, coordinatorConversationId: "coord-data" });

  await t.test("Memory curation writes topics, rebuilds MEMORY.md, and enforces index bounds", () => {
    const res = db.upsertMemoryTopic(ws, {
      topicSlug: "sqlite-wal",
      title: "SQLite WAL Mode",
      markdownBody: "Always use WAL mode for concurrent reads and writes.",
      indexSummaryLine: "Use WAL mode for concurrency"
    });
    assert.ok(res.lines > 0 && res.chars > 0 && res.topicCount === 1);
    const { indexPath, topicsDir } = db.getMemoryPaths(ws);
    assert.equal(fs.existsSync(path.join(topicsDir, "sqlite-wal.md")), true);
    const indexText = fs.readFileSync(indexPath, "utf8");
    assert.ok(indexText.includes("sqlite-wal"));
    assert.ok(indexText.includes("Use WAL mode for concurrency"));

    assert.throws(
      () => db.saveRawMemoryIndex(ws, "a\n".repeat(250)),
      /line index limit/i
    );
  });

  await t.test("Library ingestion (pinning vs RAG indexing, size/path guards) and FTS5 hybrid search", () => {
    // Reject sensitive path
    assert.throws(
      () => db.ingestLibraryItem(ws, { sourcePath: "/etc/passwd", category: "input" }),
      /Forbidden/i
    );

    // Ingest small input -> pinned inline
    const small = db.ingestLibraryItem(ws, {
      category: "input",
      sourceType: "upload",
      filename: "spec.md",
      content: "# Architecture Spec\nReciprocal Rank Fusion combines dense vectors and BM25 lexical matches.\n",
      syncEmbeddings: false
    });
    assert.equal(small.item.category, "input");
    assert.equal(small.libraryState.mode, "pinned");

    // Lower auto-pin threshold to force Contextual Hybrid RAG chunking & FTS5 indexing
    db.updateProjectSettings(ws, { autoPinLibraryTokenThreshold: 500 });
    const bigContent = Array.from({ length: 120 }, (_, i) =>
      `Line ${i + 1}: Quantum telemetry pipeline checkpoint token_${i} handles distributed reconciliation.`
    ).join("\n");
    const large = db.ingestLibraryItem(ws, {
      category: "output",
      sourceType: "coordinator_artifact",
      filename: "report.md",
      content: bigContent,
      syncEmbeddings: false
    });
    assert.equal(large.item.source_type, "coordinator_artifact");
    assert.equal(large.libraryState.mode, "rag");

    const searchRes = db.searchProjectLibrary(ws, { query: "Quantum telemetry reconciliation", topK: 5 });
    assert.ok(Array.isArray(searchRes.results) && searchRes.results.length > 0);
    assert.ok(JSON.stringify(searchRes.results[0]).includes("Quantum telemetry"));
  });

  await t.test("Schedules & routines validation and due execution", async () => {
    assert.throws(
      () => db.upsertSchedule(ws, { name: "Bad Cron", cronExpr: "not a cron", prompt: "x" }),
      /cron/i
    );

    const routine = db.upsertSchedule(ws, {
      name: "Hourly Audit",
      cronExpr: "0 * * * *",
      prompt: "Audit state",
      targetRole: "explorer",
      enabled: true
    });
    assert.equal(routine.name, "Hourly Audit");

    const sql = db.openProjectDb(ws);
    sql.prepare("UPDATE scheduled_routines SET next_run_at = ? WHERE routine_id = ?").run(
      "2000-01-01T00:00:00.000Z",
      routine.routine_id
    );
    const dispatched = [];
    const runRes = await db.processDueSchedules(ws, {
      now: new Date(),
      onDispatch: async (ctx) => {
        dispatched.push(ctx);
        return { ok: true };
      }
    });
    assert.equal(runRes.dispatched.length, 1);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].routine.routine_id, routine.routine_id);
  });

  await t.test("Repository binding, manageWorktree (create -> status -> cleanup), and syncPullRequests with stub gh", () => {
    const repoDir = env.makeWorkspace("temp-git-repo");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Demo\n");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: repoDir });

    const bound = db.bindRepository(ws, { localPath: repoDir, name: "demo-repo", defaultBranch: "main" });
    assert.equal(bound.name, "demo-repo");

    const ownerThread = db.registerThread(ws, { role: "implementer", title: "PR Owner" });

    // manageWorktree: create -> status -> cleanup
    const wtCreate = db.manageWorktree(ws, {
      action: "create",
      threadId: ownerThread.thread_id,
      repoId: bound.repo_id,
      baseBranch: "main",
      runSetup: false
    });
    assert.equal(wtCreate.created, true);
    assert.equal(fs.existsSync(wtCreate.worktreePath), true);

    const wtStatus = db.manageWorktree(ws, {
      action: "status",
      threadId: ownerThread.thread_id,
      repoId: bound.repo_id
    });
    assert.equal(wtStatus.exists, true);
    assert.equal(wtStatus.worktreePath, wtCreate.worktreePath);

    const wtClean = db.manageWorktree(ws, {
      action: "cleanup",
      threadId: ownerThread.thread_id,
      repoId: bound.repo_id
    });
    assert.equal(wtClean.cleanedUp, true);
    assert.equal(fs.existsSync(wtCreate.worktreePath), false);

    // syncPullRequests using stub gh executable in env.binDir on PATH
    const ghStateFile = path.join(env.tmpRoot, "gh-state.json");
    const ghBin = path.join(env.binDir, "gh");
    fs.writeFileSync(
      ghBin,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `const st = JSON.parse(fs.readFileSync(${JSON.stringify(ghStateFile)}, 'utf8'));`,
        "const args = process.argv.slice(2);",
        "if (args[0] === 'pr' && args[1] === 'list') { console.log(JSON.stringify(st.list)); process.exit(0); }",
        "if (args[0] === 'pr' && args[1] === 'view') { console.log(JSON.stringify(st.view)); process.exit(0); }",
        "process.exit(1);"
      ].join("\n") + "\n",
      { mode: 0o755 }
    );

    const headBranch = wtCreate.branchName;
    fs.writeFileSync(
      ghStateFile,
      JSON.stringify({
        list: [
          {
            number: 42,
            title: "Fix bug",
            headRefName: headBranch,
            baseRefName: "main",
            url: "https://github.com/org/demo/pull/42"
          }
        ],
        view: {
          state: "OPEN",
          reviewDecision: "CHANGES_REQUESTED",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [{ name: "ci-test", conclusion: "FAILURE" }],
          reviews: [{ state: "CHANGES_REQUESTED", body: "Please fix lint", author: { login: "rev" } }],
          comments: [],
          additions: 10,
          deletions: 2,
          changedFiles: 1
        }
      })
    );

    const prevPath = process.env.PATH;
    process.env.PATH = `${env.binDir}:${prevPath}`;
    try {
      const spawns = [];
      const synced1 = db.syncPullRequests(ws, {
        repoId: bound.repo_id,
        triggerAutoFix: true,
        onSpawnAutoFix: (payload) => {
          spawns.push(payload);
          return { started: true };
        }
      });
      assert.equal(synced1.length, 1);
      assert.equal(synced1[0].pr_number, 42);
      assert.equal(synced1[0].ci_status, "failing");
      assert.equal(synced1[0].autofix_attempts, 1);
      assert.equal(spawns.length, 1);

      // Apply mergeOrderRanks
      const syncedRank = db.syncPullRequests(ws, {
        repoId: bound.repo_id,
        triggerAutoFix: false,
        mergeOrderRanks: [{ prId: synced1[0].pr_id, rank: 1 }]
      });
      assert.equal(syncedRank[0].merge_order_rank, 1);

      // 3-strike auto-fix disable: simulate attempts=3 and a new failing event
      const sql = db.openProjectDb(ws);
      sql.prepare("UPDATE pull_requests SET autofix_attempts = 3, last_seen_event_hash = 'oldhash' WHERE pr_id = ?").run(
        synced1[0].pr_id
      );
      const syncedStrike = db.syncPullRequests(ws, {
        repoId: bound.repo_id,
        triggerAutoFix: true,
        onSpawnAutoFix: (payload) => {
          spawns.push(payload);
          return { started: true };
        }
      });
      assert.equal(spawns.length, 1, "3-strike PR must not trigger additional auto-fix");
      assert.equal(syncedStrike[0].autofix_enabled, 0);

      // Merged PR transitions cleanly to MERGED
      const curSt = JSON.parse(fs.readFileSync(ghStateFile, "utf8"));
      curSt.view.state = "MERGED";
      curSt.view.statusCheckRollup = [{ name: "ci-test", conclusion: "SUCCESS" }];
      curSt.view.reviewDecision = "APPROVED";
      fs.writeFileSync(ghStateFile, JSON.stringify(curSt));

      const syncedMerged = db.syncPullRequests(ws, { repoId: bound.repo_id, triggerAutoFix: false });
      assert.equal(syncedMerged[0].state, "MERGED");

      // GAP-13: Non-timeout relay failure must record eventHash & attempts and not loop every 60s
      const prOwner2 = db.registerThread(ws, { role: "implementer", title: "PR Owner 2" });
      const pr2Branch = `project/${prOwner2.thread_id}`;
      const sql2 = db.openProjectDb(ws);
      sql2.prepare("UPDATE threads SET branch_name = ? WHERE thread_id = ?").run(pr2Branch, prOwner2.thread_id);
      fs.writeFileSync(
        ghStateFile,
        JSON.stringify({
          list: [
            {
              number: 43,
              title: "Relay failure PR",
              headRefName: pr2Branch,
              baseRefName: "main",
              url: "https://github.com/org/demo/pull/43"
            }
          ],
          view: {
            state: "OPEN",
            reviewDecision: "CHANGES_REQUESTED",
            mergeStateStatus: "CLEAN",
            statusCheckRollup: [{ name: "lint", conclusion: "FAILURE" }],
            reviews: [],
            comments: [],
            additions: 5,
            deletions: 1,
            changedFiles: 1
          }
        })
      );

      let relayCalls = 0;
      const failRelay = () => {
        relayCalls++;
        return {
          dispatchedVia: "swarm",
          ok: false,
          started: false,
          spawnFailed: false,
          timedOut: false,
          reason: "relay_failed",
          error: "agentapi send-message failed"
        };
      };

      // Poll 1: fails -> records eventHash + attempt=1 + waiting_on_you
      db.syncPullRequests(ws, { repoId: bound.repo_id, triggerAutoFix: true, onSpawnAutoFix: failRelay });
      assert.equal(relayCalls, 1);
      const pr43After1 = sql2.prepare("SELECT * FROM pull_requests WHERE pr_number = 43").get();
      assert.equal(pr43After1.autofix_attempts, 1);
      assert.ok(pr43After1.last_seen_event_hash);
      const owner2After1 = sql2.prepare("SELECT ui_bucket, blocking_is_error FROM threads WHERE thread_id = ?").get(prOwner2.thread_id);
      assert.equal(owner2After1.ui_bucket, "waiting_on_you");
      assert.equal(owner2After1.blocking_is_error, 1);

      // Poll 2 (same unchanged event): must NOT re-fire relay
      db.syncPullRequests(ws, { repoId: bound.repo_id, triggerAutoFix: true, onSpawnAutoFix: failRelay });
      assert.equal(relayCalls, 1);

      // Poll 3 & 4 (new distinct failure events): attempts reach 3 and auto-fix disables
      const stNew1 = JSON.parse(fs.readFileSync(ghStateFile, "utf8"));
      stNew1.view.statusCheckRollup.push({ name: "unit", conclusion: "FAILURE" });
      fs.writeFileSync(ghStateFile, JSON.stringify(stNew1));
      db.syncPullRequests(ws, { repoId: bound.repo_id, triggerAutoFix: true, onSpawnAutoFix: failRelay });
      assert.equal(relayCalls, 2);

      stNew1.view.statusCheckRollup.push({ name: "e2e", conclusion: "FAILURE" });
      fs.writeFileSync(ghStateFile, JSON.stringify(stNew1));
      db.syncPullRequests(ws, { repoId: bound.repo_id, triggerAutoFix: true, onSpawnAutoFix: failRelay });
      assert.equal(relayCalls, 3);
      const pr43After3 = sql2.prepare("SELECT autofix_attempts, autofix_enabled FROM pull_requests WHERE pr_number = 43").get();
      assert.equal(pr43After3.autofix_attempts, 3);
      assert.equal(pr43After3.autofix_enabled, 0);
    } finally {
      process.env.PATH = prevPath;
    }
  });

  await t.test("AT-07: Privacy-safe chat snapshots strip thinking, MCP payloads, uploads, and post-cutoff turns", () => {
    const transcriptDir = path.join(env.appData, "brain", "coord-data", ".system_generated", "logs");
    fs.mkdirSync(transcriptDir, { recursive: true });
    const transcriptFile = path.join(transcriptDir, "transcript.jsonl");
    const entries = [
      {
        step_index: 1,
        type: "USER_INPUT",
        content: "Summarize the project architecture.",
        media: [{ mime_type: "application/pdf", uri: "/secret/upload.pdf" }]
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        thinking: "INTERNAL SECRET THOUGHT THAT MUST BE STRIPPED",
        content: "The architecture uses SQLite WAL and local ONNX embeddings.",
        tool_calls: [{ name: "mcp_agy_projects_get_project_overview", args: { secret: "xyz" } }]
      },
      {
        step_index: 3,
        type: "USER_INPUT",
        content: "PRIVATE POST-CUTOFF MESSAGE THAT MUST NOT APPEAR"
      }
    ];
    fs.writeFileSync(transcriptFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const snap = db.createChatSnapshot(ws, {
      conversationId: "coord-data",
      transcriptPath: transcriptFile,
      title: "Arch Snapshot",
      maxStepIndex: 2
    });
    assert.ok(snap.snapshotId);
    const preview = db.readChatSnapshotPreview(ws, snap.snapshotId);
    const previewText = JSON.stringify(preview);
    assert.ok(previewText.includes("Summarize the project architecture."));
    assert.ok(previewText.includes("SQLite WAL"));
    assert.equal(previewText.includes("INTERNAL SECRET THOUGHT"), false);
    assert.equal(previewText.includes("PRIVATE POST-CUTOFF MESSAGE"), false);
    assert.equal(previewText.includes("/secret/upload.pdf"), false);

    // Refresh cutoff in place and then revoke
    const refreshed = db.createChatSnapshot(ws, {
      snapshotId: snap.snapshotId,
      conversationId: "coord-data",
      transcriptPath: transcriptFile,
      maxStepIndex: 3
    });
    assert.equal(refreshed.snapshotId, snap.snapshotId);
    const preview2Text = JSON.stringify(db.readChatSnapshotPreview(ws, snap.snapshotId));
    assert.ok(preview2Text.includes("PRIVATE POST-CUTOFF MESSAGE"));

    const revoked = db.revokeChatSnapshot(ws, snap.snapshotId);
    assert.equal(revoked.revoked, true);
  });
});
