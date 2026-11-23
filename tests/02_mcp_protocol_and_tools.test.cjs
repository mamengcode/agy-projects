"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createTestEnv } = require("./helpers.cjs");

test("MCP JSON-RPC protocol, tool schemas (GAP-01, GAP-05), and tool round-trips (GAP-04)", async (t) => {
  const env = createTestEnv("agy-t02-");
  t.after(async () => {
    await env.cleanup();
  });

  const wsA = env.makeWorkspace("mcp-a");
  const wsUninit = env.makeWorkspace("mcp-uninit");

  await t.test("initialize, ping, resources/list, prompts/list, unknown method, and tools/list schema completeness", () => {
    const replies = env.callMcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 4, method: "resources/list" },
      { jsonrpc: "2.0", id: 5, method: "prompts/list" },
      { jsonrpc: "2.0", id: 6, method: "nonexistent/method" }
    ]);

    assert.equal(replies.find((r) => r.id === 1).result.serverInfo.name, "agy_projects_mcp");
    assert.deepEqual(replies.find((r) => r.id === 2).result, {});
    assert.deepEqual(replies.find((r) => r.id === 4).result, { resources: [] });
    assert.deepEqual(replies.find((r) => r.id === 5).result, { prompts: [] });
    assert.equal(replies.find((r) => r.id === 6).error.code, -32601);

    const tools = replies.find((r) => r.id === 3).result.tools;
    assert.equal(tools.length, 23);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    // GAP-01 tools present
    for (const reqTool of ["claim_hub_dispatch", "fail_hub_dispatch", "get_dispatch_context", "propose_threads", "register_thread"]) {
      assert.ok(byName.has(reqTool), `missing tool ${reqTool}`);
    }

    // GAP-05 & GAP-14 fields in update_project_settings & upsert_schedule
    const upsProps = byName.get("update_project_settings").inputSchema.properties;
    assert.equal(upsProps.maxIndexChars.type, "number");
    assert.deepEqual(upsProps.executionEngine.enum, ["swarm", "headless", "subagent"]);
    assert.equal(upsProps.autoSpawnSwarmMonitor.type, "boolean");
    assert.equal(upsProps.dispatchClaimTtlSeconds.type, "number");
    assert.equal(upsProps.dispatchMatchTtlSeconds.type, "number");
    assert.ok(upsProps.defaultWorkspaceMode.enum.includes("worktree"));

    const usProps = byName.get("upsert_schedule").inputSchema.properties;
    assert.ok(usProps.workspaceMode.enum.includes("worktree"));

    // GAP-05 fields in ingest_library_item
    const iliProps = byName.get("ingest_library_item").inputSchema.properties;
    assert.equal(iliProps.allowLargeLocal.type, "boolean");
    assert.equal(iliProps.syncEmbeddings.type, "boolean");
    assert.ok(iliProps.sourceType.enum.includes("coordinator_artifact"));
  });

  await t.test("end-to-end MCP tool calls and GAP-04 explicit uninitialized workspacePath rejection", () => {
    const replies = env.callMcp(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "create_project",
            arguments: { name: "MCP Proj", workspacePath: wsA, coordinatorConversationId: "coord-mcp" }
          }
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "update_project_settings",
            arguments: {
              workspacePath: wsA,
              maxIndexChars: 9000,
              executionEngine: "swarm",
              autoSpawnSwarmMonitor: true,
              dispatchClaimTtlSeconds: 420,
              dispatchMatchTtlSeconds: 210
            }
          }
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "save_wrapup_checkpoint",
            arguments: {
              workspacePath: wsA,
              currentFocus: "Testing MCP",
              completedWork: ["Init"],
              nextSteps: ["Verify"]
            }
          }
        },
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "upsert_memory",
            arguments: {
              workspacePath: wsA,
              topicSlug: "arch-notes",
              title: "Architecture",
              markdownBody: "SQLite WAL is used for state.",
              indexSummaryLine: "SQLite WAL state"
            }
          }
        },
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "ingest_library_item",
            arguments: {
              workspacePath: wsA,
              category: "output",
              sourceType: "coordinator_artifact",
              filename: "design.md",
              content: "# Design\nHybrid retrieval fuses dense and BM25 rankings.\n",
              allowLargeLocal: true,
              syncEmbeddings: false
            }
          }
        },
        {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: {
            name: "upsert_schedule",
            arguments: {
              workspacePath: wsA,
              name: "Nightly",
              cronExpr: "0 2 * * *",
              prompt: "Run checks",
              targetRole: "verifier"
            }
          }
        },
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "get_project_overview", arguments: { workspacePath: wsA } }
        },
        // Explicit uninitialized workspacePath must fail even with ANTIGRAVITY_CONVERSATION_ID bound to wsA
        {
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: {
            name: "upsert_memory",
            arguments: {
              workspacePath: wsUninit,
              topicSlug: "should-not-leak",
              title: "Leak",
              markdownBody: "bad",
              indexSummaryLine: "bad"
            }
          }
        },
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "get_project_overview", arguments: { workspacePath: wsUninit } }
        },
        {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: { name: "delete_memory", arguments: { workspacePath: wsA, topicSlug: "arch-notes" } }
        },
        {
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: {
            name: "rollover_coordinator_session",
            arguments: { workspacePath: wsA, newConversationId: "coord-mcp-2", summary: "Rolled over" }
          }
        }
      ],
      { ANTIGRAVITY_CONVERSATION_ID: "coord-mcp" }
    );

    const parseResult = (id) => {
      const r = replies.find((m) => m.id === id).result;
      return { isError: r.isError, data: JSON.parse(r.content[0].text) };
    };

    const r2 = parseResult(2);
    assert.equal(r2.isError, false);
    assert.equal(r2.data.config.memory.maxIndexChars, 9000);
    assert.equal(r2.data.config.orchestration.autoSpawnSwarmMonitor, true);
    assert.equal(r2.data.config.orchestration.dispatchClaimTtlSeconds, 420);

    const r3 = parseResult(3);
    assert.equal(r3.isError, false);
    assert.equal(r3.data.saved, true);
    assert.equal(fs.existsSync(r3.data.wrapupPath), true);

    const r5 = parseResult(5);
    assert.equal(r5.isError, false);
    assert.equal(r5.data.item.source_type, "coordinator_artifact");

    const r7 = parseResult(7);
    assert.equal(r7.isError, false);
    assert.equal(r7.data.initialized, true);
    assert.ok(r7.data.sidecarPill.includes("sidecar://agy-projects/project_hub/ui.html"));

    const r8 = parseResult(8);
    assert.equal(r8.isError, true);
    assert.match(r8.data.error, /not an initialized AGY Project/i);
    assert.equal(fs.existsSync(path.join(wsA, ".agy-project", "memory", "topics", "should-not-leak.md")), false);

    const r9 = parseResult(9);
    assert.equal(r9.isError, true);
    assert.match(r9.data.error, /not an initialized AGY Project/i);

    const r10 = parseResult(10);
    assert.equal(r10.isError, false);
    assert.equal(fs.existsSync(path.join(wsA, ".agy-project", "memory", "topics", "arch-notes.md")), false);

    const r11 = parseResult(11);
    assert.equal(r11.isError, false);
    assert.equal(r11.data.rolledOver, true);
    assert.equal(r11.data.coordinatorConversationId, "coord-mcp-2");
  });
});
