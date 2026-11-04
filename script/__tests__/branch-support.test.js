import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TddStore } from '../tddStore.js';
import { captureGitContext } from '../gitContext.js';

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  const defaultBranch = execSync('git branch --show-current', {
    cwd: dir,
    stdio: 'pipe'
  }).toString().trim() || 'master';
  return { dir, defaultBranch };
}

function commitInRepo(dir, message) {
  const file = path.join(dir, `file_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(file, message);
  execSync('git add -A', { cwd: dir, stdio: 'pipe' });
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: 'pipe' });
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    // Ignorar
  }
}

function setupStoreInRepo(repoDir) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-'));
  const dbPath = path.join(tmpDir, 'tddlab.db');
  const store = new TddStore({ dbPath });
  store.initialize();
  const ctx = captureGitContext({ cwd: repoDir });
  const repoId = store.ensureRepository({
    rootPath: ctx.repoRoot,
    remoteUrl: ctx.remoteUrl
  });
  return { store, repoId, ctx, tmpDir };
}

function recordCommit(store, repoId, ctx) {
  const parents = ctx.parents || [];
  store.upsertCommit({
    commitId: ctx.headSha,
    repositoryId: repoId,
    author: 'Test',
    message: ctx.commitMessage,
    committedAt: '2024-01-01T00:00:00Z',
    additions: 0,
    deletions: 0,
    coverage: null,
    conclusion: 'success',
    parents
  });
  if (ctx.branchName) {
    store.upsertBranch({
      repositoryId: repoId,
      name: ctx.branchName,
      headSha: ctx.headSha,
      deletedAt: null
    });
  }
}

function recordExecution(store, repoId, ctx, runId, testId, branchName, success = 1) {
  store.insertExecution({
    runId,
    testId,
    repositoryId: repoId,
    commitId: ctx.headSha,
    branchName,
    workingTreeDirty: 0,
    trigger: 'manual',
    startTime: '2024-01-01T00:00:00Z',
    endTime: '2024-01-01T00:00:05Z',
    durationMs: 5000,
    success,
    testsPassed: success ? 3 : 0,
    testsFailed: success ? 0 : 1,
    testsTotal: 3,
    coverage: 85.0,
    exitCode: success ? 0 : 1,
    failureMessage: null
  });
}

describe('E2E - dos ramas independientes desde una misma base', () => {
  let repoDir;
  let defaultBranch;
  let store;
  let repoId;

  beforeEach(() => {
    const { dir, defaultBranch: db } = makeTempRepo();
    repoDir = dir;
    defaultBranch = db;
    commitInRepo(repoDir, 'commit base en ' + defaultBranch);
    const setup = setupStoreInRepo(repoDir);
    store = setup.store;
    repoId = setup.repoId;

    const ctxBase = captureGitContext({ cwd: repoDir });
    recordCommit(store, repoId, ctxBase);
    recordExecution(store, repoId, ctxBase, 'run-base', 1, defaultBranch, 1);
  });

  afterEach(() => {
    if (store) {store.close();}
    removeDir(repoDir);
  });

  it('debe mantener ejecuciones diferenciadas por rama', () => {
    execSync('git checkout -b feature-a', { cwd: repoDir, stdio: 'pipe' });
    commitInRepo(repoDir, 'commit en feature-a');

    const ctxA = captureGitContext({ cwd: repoDir });
    recordCommit(store, repoId, ctxA);
    recordExecution(store, repoId, ctxA, 'run-a', 1, 'feature-a', 1);

    execSync('git checkout ' + defaultBranch, { cwd: repoDir, stdio: 'pipe' });
    commitInRepo(repoDir, 'otro commit en ' + defaultBranch);

    const ctxM = captureGitContext({ cwd: repoDir });
    recordCommit(store, repoId, ctxM);
    recordExecution(store, repoId, ctxM, 'run-main-2', 2, defaultBranch, 1);

    const baseExecs = store.getExecutionsByBranch(defaultBranch);
    const featExecs = store.getExecutionsByBranch('feature-a');
    expect(baseExecs.length).toBe(2);
    expect(featExecs.length).toBe(1);

    const allRunIds = [...baseExecs, ...featExecs].map((e) => e.run_id);
    expect(new Set(allRunIds).size).toBe(allRunIds.length);
  });

  it('debe registrar merge commit con varios padres', () => {
    execSync('git checkout -b feature-a', { cwd: repoDir, stdio: 'pipe' });
    commitInRepo(repoDir, 'commit en feature-a');

    const ctxA = captureGitContext({ cwd: repoDir });
    recordCommit(store, repoId, ctxA);
    recordExecution(store, repoId, ctxA, 'run-a', 1, 'feature-a', 1);

    execSync('git checkout ' + defaultBranch, { cwd: repoDir, stdio: 'pipe' });
    commitInRepo(repoDir, 'commit en ' + defaultBranch + ' despues de branch');

    const ctxM = captureGitContext({ cwd: repoDir });
    recordCommit(store, repoId, ctxM);
    recordExecution(store, repoId, ctxM, 'run-main-2', 2, defaultBranch, 1);

    execSync('git merge feature-a -m "merge feature-a en ' + defaultBranch + '"', {
      cwd: repoDir,
      stdio: 'pipe'
    });

    const ctxMerge = captureGitContext({ cwd: repoDir });
    recordCommit(store, repoId, ctxMerge);

    // Verificar que el commit de merge fue registrado con su SHA real
    const mergeCommit = store.db
      .prepare('SELECT * FROM tdd_commit WHERE commit_id = ?')
      .get(ctxMerge.headSha);
    expect(mergeCommit).toBeDefined();
    expect(mergeCommit.commit_id).toMatch(/^[0-9a-f]+$/);
    expect(mergeCommit.message).toContain('merge');

    // Ejecucion posterior al merge: nuevo run_id
    recordExecution(store, repoId, ctxMerge, 'run-post-merge', 3, defaultBranch, 1);
    // Al menos las ejecuciones de base, feature-a, main-2 y post-merge deben existir
    expect(store.countExecutions()).toBeGreaterThanOrEqual(4);

    const postMerge = store.getExecutionByRunId('run-post-merge');
    expect(postMerge).toBeDefined();
    expect(postMerge.run_id).toBe('run-post-merge');
    expect(postMerge.commit_id).toBe(ctxMerge.headSha);
  });

  it('debe preservar ejecuciones al cambiar de rama', () => {
    expect(store.getExecutionsByBranch(defaultBranch).length).toBe(1);

    execSync('git checkout -b feature-a', { cwd: repoDir, stdio: 'pipe' });
    commitInRepo(repoDir, 'commit en feature-a');

    const ctxA = captureGitContext({ cwd: repoDir });
    recordCommit(store, repoId, ctxA);
    recordExecution(store, repoId, ctxA, 'run-feat', 1, 'feature-a', 1);

    execSync('git checkout ' + defaultBranch, { cwd: repoDir, stdio: 'pipe' });

    expect(store.getExecutionsByBranch(defaultBranch).length).toBe(1);
    expect(store.getExecutionsByBranch('feature-a').length).toBe(1);

    const runBase = store.getExecutionByRunId('run-base');
    expect(runBase.branch_name).toBe(defaultBranch);
    const runFeat = store.getExecutionByRunId('run-feat');
    expect(runFeat.branch_name).toBe('feature-a');
  });

  it('debe preservar ejecuciones al eliminar una rama', () => {
    execSync('git checkout -b feature-delete', { cwd: repoDir, stdio: 'pipe' });
    commitInRepo(repoDir, 'commit en feature-delete');

    const ctxD = captureGitContext({ cwd: repoDir });
    recordCommit(store, repoId, ctxD);
    recordExecution(store, repoId, ctxD, 'run-delete', 1, 'feature-delete', 1);

    expect(store.getExecutionsByBranch('feature-delete').length).toBe(1);

    store.upsertBranch({
      repositoryId: repoId,
      name: 'feature-delete',
      headSha: ctxD.headSha,
      deletedAt: '2024-01-02T00:00:00Z'
    });

    expect(store.getExecutionsByBranch('feature-delete').length).toBe(1);
    const exec = store.getExecutionByRunId('run-delete');
    expect(exec).toBeDefined();
    expect(exec.branch_name).toBe('feature-delete');
  });

  it('debe soportar detached HEAD (branch_name NULL, SHA registrado)', () => {
    const sha = execSync('git rev-parse HEAD', { cwd: repoDir, stdio: 'pipe' }).toString().trim();
    execSync(`git checkout --detach ${sha}`, { cwd: repoDir, stdio: 'pipe' });

    const ctx = captureGitContext({ cwd: repoDir });
    expect(ctx.isDetachedHead).toBe(true);
    expect(ctx.branchName).toBeNull();
    expect(ctx.headSha).toBe(sha);

    recordCommit(store, repoId, ctx);
    recordExecution(store, repoId, ctx, 'run-detached', 1, null, 1);

    const exec = store.getExecutionByRunId('run-detached');
    expect(exec.branch_name).toBeNull();
    expect(exec.commit_id).toBe(sha);
  });
});

describe('E2E - ejecucion fallida no se confunde con fallo de infraestructura', () => {
  let repoDir;
  let defaultBranch;
  let store;
  let repoId;

  beforeEach(() => {
    const { dir, defaultBranch: db } = makeTempRepo();
    repoDir = dir;
    defaultBranch = db;
    commitInRepo(repoDir, 'commit base');
    const setup = setupStoreInRepo(repoDir);
    store = setup.store;
    repoId = setup.repoId;
    const ctx = captureGitContext({ cwd: repoDir });
    recordCommit(store, repoId, ctx);
  });

  afterEach(() => {
    if (store) {store.close();}
    removeDir(repoDir);
  });

  it('debe registrar una ejecucion con tests fallidos (success=0) diferente a fallo de infraestructura', () => {
    const ctx = captureGitContext({ cwd: repoDir });

    store.insertExecution({
      runId: 'run-tests-fail',
      testId: 1,
      repositoryId: repoId,
      commitId: ctx.headSha,
      branchName: defaultBranch,
      workingTreeDirty: 0,
      trigger: 'manual',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:00:05Z',
      durationMs: 5000,
      success: 0,
      testsPassed: 2,
      testsFailed: 1,
      testsTotal: 3,
      coverage: 80.0,
      exitCode: 1,
      failureMessage: null
    });
    store.insertRunFailure({
      runId: 'run-tests-fail',
      testPath: 'src/sumador.test.js',
      title: 'debería sumar',
      failure: 'Expected 3 to be 4'
    });

    const exec = store.getExecutionByRunId('run-tests-fail');
    expect(exec.success).toBe(0);
    expect(exec.exit_code).toBe(1);
    expect(exec.tests_failed).toBe(1);

    const failures = store.db
      .prepare('SELECT * FROM tdd_run_failures WHERE run_id = ?')
      .all('run-tests-fail');
    expect(failures.length).toBe(1);
    expect(failures[0].failure).toBe('Expected 3 to be 4');
  });
});
