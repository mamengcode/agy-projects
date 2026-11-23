"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createTestEnv } = require("./helpers.cjs");

test("Project lifecycle, registry, workspace resolution (GAP-04), and settings/model precedence (GAP-02)", async (t) => {
  const env = createTestEnv("agy-t01-");
  env.applyProcessEnv();
  const db = require("../server/db.cjs");

  t.after(async () => {
    await env.cleanup();
  });

  const wsA = env.makeWorkspace("proj-a");
  const wsB = env.makeWorkspace("proj-b");
  const wsUninit = env.makeWorkspace("uninit");

  await t.test("empty registry resolves omitted workspace to null and rejects explicit uninitialized workspace", () => {
    assert.equal(db.resolveActiveWorkspace(), null);
    assert.equal(db.buildFullWorkspaceSnapshot().initialized, false);
    assert.throws(
      () => db.resolveActiveWorkspace(wsUninit),
      (err) => err.statusCode === 400 && err.code === "UNINITIALIZED_WORKSPACE"
    );
  });

  const createdA = db.createProject({
    name: "Alpha Project",
    workspacePath: wsA,
    goal: "Build alpha",
    instructions: "Keep changes minimal.",
    coordinatorConversationId: "coord-alpha"
  });
  const pidA = createdA.config.projectId;

  const createdB = db.createProject({
    name: "Beta Project",
    workspacePath: wsB,
    goal: "Build beta"
  });
  const pidB = createdB.config.projectId;

  await t.test("project creation, selection, listing, instructions cap, and lifecycle transitions", () => {
    assert.equal(db.hasProjectInitialized(wsA), true);
    assert.equal(fs.existsSync(path.join(wsA, ".agy-project", "config.json")), true);
    assert.equal(fs.existsSync(path.join(wsA, ".agy-project", "state", "project_index.db")), true);

    db.selectProject({ projectId: pidA });
    const listed = db.listProjects({ includeArchived: true });
    assert.equal(listed.projects.length, 2);
    assert.equal(listed.activeProjectId, pidA);

    assert.throws(
      () => db.updateProjectSettings(wsA, { instructions: "x".repeat(16001) }),
      /exceed.*16000/i
    );

    const paused = db.transitionProjectLifecycle(wsA, { status: "paused", starred: true });
    assert.equal(paused.config.status, "paused");
    assert.equal(paused.config.starred, true);

    const resumed = db.transitionProjectLifecycle(wsA, { status: "active" });
    assert.equal(resumed.config.status, "active");
  });

  await t.test("resolveActiveWorkspace strictly enforces explicit workspacePath and projectId (GAP-04)", () => {
    assert.equal(db.resolveActiveWorkspace(wsA), path.resolve(wsA));
    assert.equal(db.resolveActiveWorkspace(wsA, pidA), path.resolve(wsA));
    assert.equal(db.resolveActiveWorkspace(undefined, pidB), path.resolve(wsB));
    assert.equal(db.resolveActiveWorkspace(), path.resolve(wsA));

    assert.throws(
      () => db.resolveActiveWorkspace(wsUninit),
      (err) => err.statusCode === 400 && err.code === "UNINITIALIZED_WORKSPACE"
    );
    assert.throws(
      () => db.resolveActiveWorkspace(undefined, "nonexistent-pid"),
      (err) => err.statusCode === 400 && err.code === "INVALID_PROJECT_ID"
    );
    assert.throws(
      () => db.resolveActiveWorkspace(wsA, pidB),
      (err) => err.statusCode === 400 && err.code === "PROJECT_WORKSPACE_MISMATCH"
    );
    assert.throws(
      () => db.buildFullWorkspaceSnapshot(wsUninit),
      (err) => err.statusCode === 400 && err.code === "UNINITIALIZED_WORKSPACE"
    );
  });

  await t.test("updateProjectSettings enforces paid-tier guard and clamps GAP-05 fields", () => {
    assert.throws(
      () => db.updateProjectSettings(wsA, { embeddingProvider: "gemini_cloud" }),
      /Paid-Tier/i
    );
    assert.throws(
      () => db.updateProjectSettings(wsA, { contextualHeaderMode: "gemini_flash_lite" }),
      /Paid-Tier/i
    );

    const upd = db.updateProjectSettings(wsA, {
      maxIndexChars: 50000,
      executionEngine: "subagent",
      autoSpawnSwarmMonitor: true,
      dispatchClaimTtlSeconds: 10,
      dispatchMatchTtlSeconds: 99999
    });
    assert.equal(upd.config.memory.maxIndexChars, 16000);
    assert.equal(upd.config.orchestration.executionEngine, "subagent");
    assert.equal(upd.config.orchestration.autoSpawnSwarmMonitor, true);
    assert.equal(upd.config.orchestration.dispatchClaimTtlSeconds, 30);
    assert.equal(upd.config.orchestration.dispatchMatchTtlSeconds, 3600);

    db.updateProjectSettings(wsA, { executionEngine: "swarm", maxConcurrentThreads: 20 });
  });

  await t.test("roleOverrides 'inherit' never shadows defaultThreadModel across all resolution paths (GAP-02)", () => {
    const rawLegacy = {
      models: {
        defaultThreadModel: "claude-opus-5-5-medium",
        roleOverrides: { explorer: "inherit", implementer: "gemini-4-hydrogen-high", pr_fixer: "inherit" }
      }
    };
    assert.equal(db.getRoleModelOverride(rawLegacy, "explorer"), null);
    assert.equal(db.getRoleModelOverride(rawLegacy, "pr-fixer"), null);
    assert.equal(db.getRoleModelOverride(rawLegacy, "implementer"), "gemini-4-hydrogen-high");
    assert.equal(db.resolveConfiguredThreadModel(rawLegacy, "explorer"), "claude-opus-5-5-medium");
    assert.equal(db.resolveConfiguredThreadModel(rawLegacy, "implementer"), "gemini-4-hydrogen-high");
    assert.equal(db.resolveConfiguredThreadModel(rawLegacy, "implementer", "claude-sonnet-5-5-medium"), "claude-sonnet-5-5-medium");

    // Inject legacy config.json containing "inherit" on disk and verify loadProjectConfig strips it
    const cfgPath = path.join(wsA, ".agy-project", "config.json");
    const diskCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    diskCfg.models.defaultThreadModel = "claude-opus-5-5-medium";
    diskCfg.models.roleOverrides = { explorer: "inherit", verifier: "pro", pr_fixer: "inherit" };
    fs.writeFileSync(cfgPath, JSON.stringify(diskCfg, null, 2));

    const loaded = db.loadProjectConfig(wsA);
    assert.deepEqual(loaded.models.roleOverrides, { verifier: "pro" });

    // proposeThreads + explicit swarmModel precedence over roleOverrides in Headless & Subagent
    const [tExp, tVerExplicit] = db.proposeThreads(wsA, [
      { title: "Explore", description: "read", role: "explorer" },
      { title: "Verify fast", description: "qa", role: "verifier", swarmModel: "flash_lite" }
    ]);
    assert.equal(tExp.model, "claude-opus-5-5-medium");
    assert.equal(tVerExplicit.model, "flash_lite");
    assert.equal(tVerExplicit.swarm_model, "flash_lite");
    assert.equal(db.resolveHeadlessModel(tVerExplicit, loaded), "flash_lite");
    assert.equal(db.resolveSubagentModel(tVerExplicit, loaded), "flash_lite");

    // updateProjectSettings strips "inherit" and clears on null
    const cleared = db.updateProjectSettings(wsA, {
      models: { roleOverrides: { explorer: "inherit", verifier: null } }
    });
    assert.deepEqual(cleared.config.models.roleOverrides, {});
    assert.throws(
      () => db.updateProjectSettings(wsA, { models: { roleOverrides: { explorer: "bad model!!" } } }),
      /Invalid model/
    );
  });
});
