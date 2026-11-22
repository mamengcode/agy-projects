#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const readline = require("node:readline");
const db = require("./db.cjs");

const SERVER_NAME = "agy_projects_mcp";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

function getServerInfoCandidates() {
  return [
    path.join(db.getSharedDataDir(), "server_info.json"),
    path.join(db.getAppDataDir(), "sidecar_data", "agy-projects", "project_hub", "data", "server_info.json")
  ];
}

function notifySidecar(workspacePath, extra = {}) {
  for (const infoPath of getServerInfoCandidates()) {
    const info = db.readJsonSafe(infoPath, null);
    if (!info || !info.port || !info.token) continue;
    try {
      const payload = JSON.stringify({ workspacePath: workspacePath || null, at: db.nowIso(), ...extra });
      const req = http.request(
        {
          hostname: info.host || "127.0.0.1",
          port: Number(info.port),
          path: "/api/notify",
          method: "POST",
          timeout: 800,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            "X-Sidecar-Token": info.token
          }
        },
        (res) => res.resume()
      );
      req.on("error", () => {});
      req.write(payload);
      req.end();
      break;
    } catch {}
  }
}

function requireWorkspace(args = {}) {
  if (args.workspacePath && db.hasProjectInitialized(args.workspacePath)) {
    return path.resolve(args.workspacePath);
  }
  if (!args.projectId) {
    const convId = process.env.ANTIGRAVITY_CONVERSATION_ID || "";
    if (convId) {
      const binding = db.resolveSessionBinding(convId, args.workspacePath ? [args.workspacePath] : []);
      if (binding?.bound && binding.workspacePath && db.hasProjectInitialized(binding.workspacePath)) {
        return path.resolve(binding.workspacePath);
      }
    }
  }
  const ws = db.resolveActiveWorkspace(args.workspacePath, args.projectId);
  if (!ws || !db.hasProjectInitialized(ws)) {
    throw new Error(
      "No active AGY Project found. Initialize one first with create_project({ name, workspacePath }) or select an existing project with select_project."
    );
  }
  return ws;
}

const TOOLS = [
  {
    name: "create_project",
    description:
      "Initialize or bind an AGY Project in <workspacePath>/.agy-project/, set standing instructions (<=16,000 chars), bind the Coordinator conversationId, and seed Day-1 onboarding suggestions.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable project name." },
        workspacePath: { type: "string", description: "Absolute workspace path." },
        goal: { type: "string", description: "1-line North Star objective for the project." },
        instructions: { type: "string", description: "Standing instructions (max 16,000 characters)." },
        coordinatorConversationId: { type: "string", description: "Optional current conversationId to bind as the Project Coordinator." },
        createDirIfMissing: { type: "boolean", description: "Create workspacePath directory if missing (default true)." }
      },
      required: ["name", "workspacePath"]
    }
  },
  {
    name: "select_project",
    description: "Switch the active project in the global registry and optionally bind a Coordinator conversationId.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        workspacePath: { type: "string" },
        bindCoordinatorConversationId: { type: "string" },
        bindAsCoordinator: {
          type: "boolean",
          description: "Bind the active conversation (via bindCoordinatorConversationId or ANTIGRAVITY_CONVERSATION_ID) as Coordinator."
        }
      }
    }
  },
  {
    name: "list_projects",
    description: "List all registered AGY Projects across workspaces with their status, starred flag, and active indicator.",
    inputSchema: {
      type: "object",
      properties: {
        includeArchived: { type: "boolean" }
      }
    }
  },
  {
    name: "update_project_lifecycle",
    description: "Transition project status ('active', 'paused', 'archived'), toggle starred pin, or update goal/instructions/modelOverrides.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        projectId: { type: "string" },
        status: { type: "string", enum: ["active", "paused", "archived"] },
        starred: { type: "boolean" },
        goal: { type: "string" },
        instructions: { type: "string" },
        modelOverrides: { type: "object" }
      }
    }
  },
  {
    name: "update_project_settings",
    description: "Update project name, goal, standing instructions (<=16,000 chars), memory/embedding settings, contextualHeaderMode, models, orchestration, environment, or sharing settings.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        name: { type: "string" },
        goal: { type: "string" },
        instructions: { type: "string" },
        useAccountMemory: { type: "boolean" },
        maxIndexLines: { type: "number" },
        autoPinLibraryTokenThreshold: { type: "number" },
        embeddingProvider: { type: "string", enum: ["local_onnx", "gemini_cloud"] },
        cloudEmbeddingModel: { type: "string", enum: ["gemini-embedding-2", "gemini-embedding-001"] },
        contextualHeaderMode: { type: "string", enum: ["structural_offline", "gemini_flash_lite"] },
        cloudPaidTierConfirmed: { type: "boolean" },
        coordinatorModel: { type: "string" },
        defaultThreadModel: { type: "string" },
        roleOverrides: { type: "object" },
        maxConcurrentThreads: { type: "number" },
        maxNewThreadsPerDay: { type: "number" },
        idleAutoResolveDays: { type: "number" },
        requireApprovalBeforeSpawn: { type: "boolean" },
        defaultWorkspaceMode: { type: "string", enum: ["share", "branch", "inherit"] },
        environment: { type: "object" },
        sharing: { type: "object" }
      }
    }
  },
  {
    name: "save_wrapup_checkpoint",
    description: "Persist a compaction-safe Coordinator checkpoint to .agy-project/state/wrapup_checkpoint.md before /compact or session rollover.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        currentFocus: { type: "string" },
        focus: { type: "string" },
        completedWork: { type: "array", items: { type: "string" } },
        completed: { type: "array", items: { type: "string" } },
        inFlightThreads: { type: "array", items: { type: "string" } },
        openBlockers: { type: "array", items: { type: "string" } },
        nextSteps: { type: "array", items: { type: "string" } }
      }
    }
  },
  {
    name: "rollover_coordinator_session",
    description: "Archive the current Coordinator session into completed_coordinators and optionally bind a fresh Coordinator conversationId.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        newConversationId: { type: "string" },
        summary: { type: "string" }
      }
    }
  },
  {
    name: "propose_threads",
    description: "Create 'suggested' Worker Thread cards in Project Hub awaiting user approval or batch Start All, returning deterministic Swarm launch hints.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        proposals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              role: { type: "string", enum: ["explorer", "implementer", "verifier", "pr-fixer", "pr_fixer"] },
              repoId: { type: "string" },
              swarmModel: { type: "string" },
              workspaceMode: { type: "string", enum: ["inherit", "share", "branch", "worktree"] },
              ownedGlobs: { type: "array", items: { type: "string" } }
            },
            required: ["title", "description", "role"]
          }
        }
      },
      required: ["proposals"]
    }
  },
  {
    name: "register_thread",
    description: "Bind a spawned subagent or Swarm worker conversationId to a Worker Thread and transition it to 'working'.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        threadId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        role: { type: "string" },
        conversationId: { type: "string" },
        model: { type: "string" },
        swarmMemberName: { type: "string" },
        swarmModel: { type: "string" },
        executionBackend: { type: "string" },
        swarmOriginCoordinatorId: { type: "string" },
        workspaceMode: { type: "string" },
        repoId: { type: "string" },
        branchName: { type: "string" },
        worktreePath: { type: "string" },
        ownedGlobs: { type: "array", items: { type: "string" } }
      },
      required: ["role"]
    }
  },
  {
    name: "update_thread_state",
    description: "Transition a Worker Thread across the 8 canonical UI buckets ('suggested', 'working', 'waiting_on_you', 'ready_for_review', 'landing', 'idle', 'paused', 'resolved') and record summary or PR metadata.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        threadId: { type: "string" },
        conversationId: { type: "string" },
        uiBucket: {
          type: "string",
          enum: ["suggested", "working", "waiting_on_you", "ready_for_review", "landing", "idle", "paused", "resolved"]
        },
        summary: { type: "string" },
        blockingQuestion: { type: "string" },
        prNumber: { type: "number" },
        prUrl: { type: "string" },
        watchingAutoFix: { type: "boolean" }
      }
    }
  },
  {
    name: "manage_worktree",
    description: "Create, inspect, or clean up an isolated git worktree under .agy-project/worktrees/<threadId>/.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        action: { type: "string", enum: ["create", "status", "cleanup"] },
        threadId: { type: "string" },
        repoId: { type: "string" },
        baseBranch: { type: "string" }
      },
      required: ["action", "threadId"]
    }
  },
  {
    name: "upsert_memory",
    description: "Create or update a Markdown topic file in .agy-project/memory/topics/ and regenerate MEMORY.md within the <=200-line / <=16,000-char hard cap.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        topicSlug: { type: "string" },
        title: { type: "string" },
        markdownBody: { type: "string" },
        indexSummaryLine: { type: "string" },
        producerThreadId: { type: "string" }
      },
      required: ["topicSlug", "title", "markdownBody"]
    }
  },
  {
    name: "delete_memory",
    description: "Remove an obsolete topic file from .agy-project/memory/topics/ and regenerate MEMORY.md.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        topicSlug: { type: "string" }
      },
      required: ["topicSlug"]
    }
  },
  {
    name: "ingest_library_item",
    description: "Ingest a reference document ('input') or thread deliverable ('output') into the Project Library with automatic inline pinning (<15k tokens) or Contextual Hybrid RAG indexing.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        sourcePath: { type: "string", description: "Absolute path to source file." },
        content: { type: "string", description: "Inline UTF-8 content if creating directly." },
        filename: { type: "string", description: "Target filename when passing inline content." },
        category: { type: "string", enum: ["input", "output"] },
        sourceType: { type: "string", enum: ["upload", "local_file", "gdrive", "gdoc", "gsheet", "thread_artifact", "git_doc"] },
        title: { type: "string" },
        producerThreadId: { type: "string" }
      },
      required: ["category"]
    }
  },
  {
    name: "search_project_library",
    description: "Run Contextual Hybrid Retrieval (Reciprocal Rank Fusion of dense embeddings + SQLite FTS5 BM25) over the Project Library and return line-cited chunks.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        query: { type: "string" },
        categoryFilter: { type: "string", enum: ["input", "output"] },
        topK: { type: "number" }
      },
      required: ["query"]
    }
  },
  {
    name: "bind_repository",
    description: "Attach a Git repository to the project for isolated worktrees and multi-repo PR tracking.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        localPath: { type: "string" },
        name: { type: "string" },
        defaultBranch: { type: "string" }
      },
      required: ["localPath"]
    }
  },
  {
    name: "sync_pull_requests",
    description: "Discover open PRs via gh pr list, poll gh pr view CI/review/merge status, and optionally assign multi-repo mergeOrderRanks.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        repoId: { type: "string" },
        mergeOrderRanks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              prId: { type: "string" },
              repoId: { type: "string" },
              prNumber: { type: "number" },
              rank: { type: "number" }
            },
            required: ["rank"]
          }
        }
      }
    }
  },
  {
    name: "upsert_schedule",
    description: "Create or update a 5-field cron routine executed by the Project Hub background runner.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        routineId: { type: "string" },
        name: { type: "string" },
        cronExpr: { type: "string", description: "Standard 5-field cron expression, e.g. '0 9 * * 1-5'." },
        prompt: { type: "string" },
        targetRole: { type: "string", enum: ["explorer", "implementer", "verifier", "pr-fixer", "pr_fixer"] },
        workspaceMode: { type: "string", enum: ["inherit", "share", "branch"] },
        enabled: { type: "boolean" }
      },
      required: ["name", "cronExpr", "prompt"]
    }
  },
  {
    name: "create_chat_snapshot",
    description: "Generate or refresh a privacy-safe, point-in-time conversation snapshot stripping MCP payloads, internal thinking, uploaded source attachments, and turns after maxStepIndex.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        snapshotId: { type: "string", description: "Optional existing snapshotId to refresh cutoff in place." },
        conversationId: { type: "string" },
        transcriptPath: { type: "string" },
        title: { type: "string" },
        maxStepIndex: { type: "number" },
        publishToFeed: { type: "boolean" }
      },
      required: []
    }
  },
  {
    name: "get_project_overview",
    description: "Return full project configuration, thread bucket counts, library mode, memory stats, PRs, Swarm summary, and the Project Hub sidecar link.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        projectId: { type: "string" }
      }
    }
  },
  {
    name: "claim_hub_dispatch",
    description: "Atomically claim a pending Hub Swarm dispatch using its dispatchId and single-use nonce, returning the exact swarm(add)/post_message/swarm(model)/swarm(kill) payload and suggestedPlan.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        dispatchId: { type: "string" },
        nonce: { type: "string" },
        matchTtlSeconds: { type: "number" }
      },
      required: ["dispatchId", "nonce"]
    }
  },
  {
    name: "fail_hub_dispatch",
    description: "Report a non-retryable Coordinator failure to fulfill a pending or claimed Hub Swarm dispatch, releasing reserved quota slots and surfacing the error on the thread.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        dispatchId: { type: "string" },
        nonce: { type: "string" },
        reason: { type: "string" }
      },
      required: ["dispatchId", "nonce"]
    }
  },
  {
    name: "get_dispatch_context",
    description: "Retrieve untrusted external context (e.g., GitHub PR comments/checks) attached to a Hub dispatch outside the public Swarm message board.",
    inputSchema: {
      type: "object",
      properties: {
        workspacePath: { type: "string" },
        dispatchId: { type: "string" }
      },
      required: ["dispatchId"]
    }
  }
];

function executeTool(name, args = {}) {
  switch (name) {
    case "create_project": {
      const created = db.createProject({
        name: args.name,
        workspacePath: args.workspacePath,
        goal: args.goal || "",
        instructions: args.instructions || "",
        coordinatorConversationId: args.coordinatorConversationId || null,
        createDirIfMissing: args.createDirIfMissing !== false
      });
      notifySidecar(created.workspacePath);
      return {
        ...created,
        sidecarPill: "[Project Hub](sidecar://agy-projects/project_hub/ui.html)"
      };
    }

    case "select_project": {
      const bindId =
        args.bindCoordinatorConversationId ||
        (args.bindAsCoordinator ? process.env.ANTIGRAVITY_CONVERSATION_ID : null);
      const sel = db.selectProject({
        projectId: args.projectId || null,
        workspacePath: args.workspacePath || null,
        bindCoordinatorConversationId: bindId || null
      });
      notifySidecar(sel.workspacePath);
      return {
        ...sel,
        sidecarPill: "[Project Hub](sidecar://agy-projects/project_hub/ui.html)"
      };
    }

    case "list_projects": {
      return db.listProjects({ includeArchived: Boolean(args.includeArchived) });
    }

    case "update_project_lifecycle": {
      const ws = requireWorkspace(args);
      if (args.status && !["active", "paused", "archived"].includes(args.status)) {
        throw new Error(`Invalid status: ${args.status}`);
      }
      if (args.goal !== undefined || args.instructions !== undefined || args.modelOverrides !== undefined) {
        const patch = {};
        if (args.goal !== undefined) patch.goal = args.goal;
        if (args.instructions !== undefined) patch.instructions = args.instructions;
        if (args.modelOverrides !== undefined) {
          patch.models = { roleOverrides: args.modelOverrides };
        }
        db.updateProjectSettings(ws, patch);
      }
      const res = db.transitionProjectLifecycle(ws, { status: args.status, starred: args.starred });
      const cfg = res.config;
      const cancelHeadless = Boolean(args.status && args.status !== "active");
      notifySidecar(ws, cancelHeadless ? { cancelHeadless: true } : {});
      return { config: cfg, workspacePath: ws };
    }

    case "update_project_settings": {
      const ws = requireWorkspace(args);
      const res = db.updateProjectSettings(ws, args);
      notifySidecar(ws);
      return { config: res.config };
    }

    case "save_wrapup_checkpoint": {
      const ws = requireWorkspace(args);
      const cfg = db.loadProjectConfig(ws);
      const wrapPath = path.join(db.getProjectDir(ws), "state", "wrapup_checkpoint.md");
      const focus = args.currentFocus ?? args.focus ?? "";
      const completed = Array.isArray(args.completedWork) ? args.completedWork : args.completed;
      const lines = [
        `# Coordinator Wrap-Up Checkpoint`,
        `> Saved: ${db.nowIso()}`,
        ...(cfg?.coordinatorConversationId ? [`> Source-Coordinator: ${cfg.coordinatorConversationId}`] : []),
        "",
        `## Current Focus`,
        String(focus),
        "",
        `## Completed Work`,
        ...(Array.isArray(completed) && completed.length ? completed.map((x) => `- ${x}`) : ["- None recorded"]),
        "",
        `## In-Flight Threads`,
        ...(Array.isArray(args.inFlightThreads) && args.inFlightThreads.length
          ? args.inFlightThreads.map((x) => `- ${x}`)
          : ["- None"]),
        "",
        `## Open Blockers`,
        ...(Array.isArray(args.openBlockers) && args.openBlockers.length
          ? args.openBlockers.map((x) => `- ${x}`)
          : ["- None"]),
        "",
        `## Next Steps`,
        ...(Array.isArray(args.nextSteps) && args.nextSteps.length
          ? args.nextSteps.map((x) => `- ${x}`)
          : ["- Resume from Project Hub"])
      ];
      db.writeTextAtomic(wrapPath, `${lines.join("\n")}\n`);
      notifySidecar(ws);
      return { saved: true, wrapupPath: wrapPath };
    }

    case "rollover_coordinator_session": {
      const ws = requireWorkspace(args);
      const res = db.rolloverCoordinatorSession(ws, {
        newConversationId: args.newConversationId || null,
        summary: args.summary || ""
      });
      notifySidecar(ws);
      return res;
    }

    case "propose_threads": {
      const ws = requireWorkspace(args);
      const rawThreads = db.proposeThreads(ws, args.proposals || []);
      const cfg = db.loadProjectConfig(ws);
      const activeSwarm = db.readActiveSwarmState(ws);
      const existingMembers = { ...(activeSwarm?.members || {}) };
      const threads = rawThreads.map((t) => {
        const role = db.normalizeRole(t.role || "explorer");
        const rawModel =
          t.swarm_model ??
          (t.model && t.model !== "inherit" ? t.model : null) ??
          db.getRoleModelOverride(cfg, role) ??
          cfg?.models?.defaultThreadModel ??
          "inherit";
        const resolvedSwarmModel = db.resolveSwarmModel(rawModel);
        const resolvedWorkspace = db.resolveSwarmWorkspace(cfg, ws, role, t.workspace_mode);
        const swarmMemberName =
          t.swarm_member_name ||
          db.toSwarmWorkerName(ws, t.thread_id, role, t.title, existingMembers);
        existingMembers[swarmMemberName] = { name: swarmMemberName };
        return {
          ...t,
          swarmMemberName,
          resolvedSwarmModel,
          resolvedWorkspace
        };
      });
      notifySidecar(ws);
      return { createdCount: threads.length, threads };
    }

    case "register_thread": {
      const ws = requireWorkspace(args);
      const thread = db.registerThread(ws, args);
      notifySidecar(ws);
      return { thread };
    }

    case "update_thread_state": {
      const fallbackConvId = args.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || undefined;
      const mergedArgs = fallbackConvId ? { ...args, conversationId: fallbackConvId } : args;
      const ws = requireWorkspace(mergedArgs);
      const thread = db.updateThreadState(ws, mergedArgs);
      notifySidecar(ws);
      return { thread };
    }

    case "manage_worktree": {
      const ws = requireWorkspace(args);
      const res = db.manageWorktree(ws, args);
      notifySidecar(ws);
      return res;
    }

    case "upsert_memory": {
      const ws = requireWorkspace(args);
      const res = db.upsertMemoryTopic(ws, args);
      notifySidecar(ws);
      return res;
    }

    case "delete_memory": {
      const ws = requireWorkspace(args);
      const cleanSlug = String(args.topicSlug || "").replace(/[^a-zA-Z0-9_-]/g, "");
      const { topicsDir } = db.getMemoryPaths(ws);
      const filePath = path.join(topicsDir, `${cleanSlug}.md`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      const res = db.rebuildMemoryIndex(ws, db.loadProjectConfig(ws));
      notifySidecar(ws);
      return { deleted: cleanSlug, ...res };
    }

    case "ingest_library_item": {
      const ws = requireWorkspace(args);
      const res = db.ingestLibraryItem(ws, args);
      notifySidecar(ws);
      return res;
    }

    case "search_project_library": {
      const ws = requireWorkspace(args);
      return db.searchProjectLibrary(ws, args);
    }

    case "bind_repository": {
      const ws = requireWorkspace(args);
      const repo = db.bindRepository(ws, args);
      notifySidecar(ws);
      return { repository: repo };
    }

    case "sync_pull_requests": {
      const ws = requireWorkspace(args);
      const pullRequests = db.syncPullRequests(ws, {
        repoId: args.repoId || null,
        triggerAutoFix: false,
        mergeOrderRanks: args.mergeOrderRanks || null
      });
      notifySidecar(ws);
      return { syncedCount: pullRequests.length, pullRequests };
    }

    case "upsert_schedule": {
      const ws = requireWorkspace(args);
      const routine = db.upsertSchedule(ws, args);
      notifySidecar(ws);
      return { routine };
    }

    case "create_chat_snapshot": {
      const ws = requireWorkspace(args);
      if (!args.conversationId && !args.snapshotId) {
        throw new Error("Provide conversationId or snapshotId.");
      }
      const snap = db.createChatSnapshot(ws, args);
      notifySidecar(ws);
      return snap;
    }

    case "get_project_overview": {
      const ws = db.resolveActiveWorkspace(args.workspacePath, args.projectId);
      const snap = db.buildFullWorkspaceSnapshot(ws || args.workspacePath);
      return {
        ...snap,
        swarm: snap.swarm || {
          active: false,
          verifiedCapable: false,
          backend: null,
          unsupportedReason: null,
          coordinatorConversationId: null,
          title: "",
          head: 0,
          counts: { total: 0, working: 0, waiting: 0, killed: 0 },
          pendingDispatches: []
        },
        sidecarPill: "[Project Hub](sidecar://agy-projects/project_hub/ui.html)"
      };
    }

    case "claim_hub_dispatch": {
      const ws = requireWorkspace(args);
      const res = db.claimHubDispatch(ws, args.dispatchId, args.nonce, {
        matchTtlSeconds: args.matchTtlSeconds
      });
      notifySidecar(ws);
      return res;
    }

    case "fail_hub_dispatch": {
      const ws = requireWorkspace(args);
      const res = db.failHubDispatch(ws, args.dispatchId, args.nonce, args.reason);
      notifySidecar(ws);
      return res;
    }

    case "get_dispatch_context": {
      const ws = requireWorkspace(args);
      return db.getDispatchContext(ws, args.dispatchId);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function sendRpc(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Notifications have no id and expect no response
  if (msg.id === undefined || msg.id === null) return;

  const { id, method, params } = msg;

  try {
    if (method === "initialize") {
      const clientVersion = params?.protocolVersion || DEFAULT_PROTOCOL_VERSION;
      return sendRpc({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: clientVersion,
          capabilities: {
            tools: {},
            resources: {}
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION
          }
        }
      });
    }

    if (method === "ping") {
      return sendRpc({ jsonrpc: "2.0", id, result: {} });
    }

    if (method === "tools/list") {
      return sendRpc({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    }

    if (method === "resources/list") {
      return sendRpc({ jsonrpc: "2.0", id, result: { resources: [] } });
    }

    if (method === "prompts/list") {
      return sendRpc({ jsonrpc: "2.0", id, result: { prompts: [] } });
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const out = executeTool(toolName, toolArgs);
        return sendRpc({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
            isError: false
          }
        });
      } catch (toolErr) {
        return sendRpc({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ error: toolErr.message || String(toolErr) }) }],
            isError: true
          }
        });
      }
    }

    return sendRpc({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  } catch (err) {
    return sendRpc({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: err.message || "Internal MCP error" }
    });
  }
});
