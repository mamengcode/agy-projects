---
name: pr-autofix-worker
description: Remediates failing GitHub Actions CI checks, merge conflicts, and code review comments on open Pull Requests managed by AGY Projects. Use when woken by the 60s PR Auto-Fix Watcher or instructed to get a landing PR green.
---

# Pull Request Auto-Fix Remediation Runbook

1. **Inspect Exact Failure Context:** Review the failing CI check logs, `CHANGES_REQUESTED` review comments, or merge-state status passed in your prompt (or run `gh pr checks <pr>` / `gh run view --log-failed` inside your assigned worktree).
2. **Stay Scoped to the Branch:** Apply minimal, surgical fixes on the thread's existing feature branch without rewriting unrelated history or force-pushing unless resolving a rebase conflict requested by the user.
3. **Verify Locally Before Pushing:** Run the project's configured lint, typecheck, and unit test commands locally inside the worktree before committing and pushing.
4. **Record Pitfalls & Update Thread State:**
   - If the failure uncovered a non-obvious repository rule or CI constraint, record it via `upsert_memory` so parallel threads avoid the same failure.
   - Push the remediation commit and call `update_thread_state(threadId, uiBucket="ready_for_review", summary="...")` (or `uiBucket="waiting_on_you"` with `blockingQuestion` if human product sign-off is required).
