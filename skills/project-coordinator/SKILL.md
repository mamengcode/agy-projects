---
name: project-coordinator
description: Orchestrates an AGY Project (Claude Code Projects architecture): Day-1 onboarding, decomposing broad goals into isolated parallel share/branch Worker Threads, routing tasks to new vs. existing threads, sequencing multi-repo Pull Requests, curating MEMORY.md, and executing compaction-safe rollover checkpoints.
---

# AGY Project Coordinator Runbook

## 1. Day-1 Onboarding Workflow
1. Call `create_project` (from `agy_projects_mcp`) with `name`, `workspacePath`, `goal`, and concise `instructions` (`<= 16,000` chars).
2. Scan connected Git roots via `bind_repository` to detect existing `CLAUDE.md`, `GEMINI.md`, or `AGENTS.md` files.
3. Call `propose_threads` with 2–3 read-only `Suggested` exploration cards (e.g., *Map repository architecture & seed MEMORY.md*, *Audit test/lint/CI pipelines*) so the user can start them selectively from the Overview pane.
4. Surface `[Project Hub](sidecar://agy-projects/project_hub/ui.html)` in your reply.

## 2. Thread Routing: New Thread vs. Steering an Existing Thread
- **Continue an existing thread (`send_message`):** When a follow-up belongs to an existing feature branch or warm subagent context, call `send_message(Recipient=thread.conversation_id, Message=...)` and update `update_thread_state(uiBucket="working")`.
- **Spawn a new isolated thread (`invoke_subagent`):**
  1. For single-repo tasks, pass `Workspace: "share"` (default storage-shared Git worktree isolation) or `Workspace: "branch"` (full clone).
  2. For multi-repo tasks across `2+` bound repositories, first provision isolated worktrees via `manage_worktree(action="create", threadId, repoId)` and instruct the subagent (`project-implementer` or `project-verifier`) to work inside that worktree path.
  3. Immediately bind the returned `conversationId` via `register_thread`.
  4. Stop calling tools when waiting on asynchronous subagents—Antigravity's reactive wakeup will resume you automatically as each thread reports back.

## 3. Multi-Repo PR Sequencing & Auto-Fix
- When a goal spans multiple repositories (e.g., API schema + web client), assign explicit `mergeOrderRank` (`1, 2, ...`) via `sync_pull_requests` and enable `watchingAutoFix: true` on open PR threads so the 60s Sidecar watcher automatically remediates CI or review failures.

## 4. Compaction & Rollover Protocol
- Before `/compact` or rolling over a long Coordinator session:
  1. Call `upsert_memory` with any unrecorded architectural decisions.
  2. Call `save_wrapup_checkpoint` listing current focus, completed threads, active `conversationId`s, open blockers, and immediate next steps.
  3. Inform the user they can click **Rollover Coordinator** in `[Project Hub](sidecar://agy-projects/project_hub/ui.html)` or run `/compact` safely.
