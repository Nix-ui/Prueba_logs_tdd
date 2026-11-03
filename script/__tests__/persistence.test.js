import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { TddStore } from '../tddStore.js';
import { getLastTestId } from '../id_execution_tests_commit.js';

describe('getLastTestId sobre SQLite', () => {
  let store;
  let repoId;

  beforeEach(() => {
    store = new TddStore({ dbPath: ':memory:' });
    store.initialize();
    repoId = store.ensureRepository({
      rootPath: '/tmp/test-repo',
      remoteUrl: null
    });
  });

  afterEach(() => {
    store.close();
  });

  it('debe devolver 1 cuando no hay ejecuciones previas', () => {
    const next = getLastTestId(store);
    expect(next).toBe(1);
  });

  it('debe devolver max(test_id) + 1 por rama', () => {
    store.insertExecution({
      runId: 'run-a',
      testId: 2,
      repositoryId: repoId,
      commitId: null,
      branchName: 'main',
      workingTreeDirty: 0,
      trigger: 'manual',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:00:05Z',
      durationMs: 5000,
      success: 1,
      testsPassed: 3,
      testsFailed: 0,
      testsTotal: 3,
      coverage: 85.0,
      exitCode: 0,
      failureMessage: null
    });
    expect(getLastTestId(store, 'main')).toBe(3);
  });

  it('debe aislar contadores de test_id por rama', () => {
    store.insertExecution({
      runId: 'run-main',
      testId: 4,
      repositoryId: repoId,
      commitId: null,
      branchName: 'main',
      workingTreeDirty: 0,
      trigger: 'manual',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:00:05Z',
      durationMs: 5000,
      success: 1,
      testsPassed: 3,
      testsFailed: 0,
      testsTotal: 3,
      coverage: 85.0,
      exitCode: 0,
      failureMessage: null
    });
    store.insertExecution({
      runId: 'run-feat',
      testId: 7,
      repositoryId: repoId,
      commitId: null,
      branchName: 'feature-a',
      workingTreeDirty: 0,
      trigger: 'manual',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:00:05Z',
      durationMs: 5000,
      success: 1,
      testsPassed: 3,
      testsFailed: 0,
      testsTotal: 3,
      coverage: 85.0,
      exitCode: 0,
      failureMessage: null
    });
    expect(getLastTestId(store, 'main')).toBe(5);
    expect(getLastTestId(store, 'feature-a')).toBe(8);
  });

  it('debe funcionar cuando se crea una instancia temporal (sin store)', () => {
    // No hay tablas aun en esta instancia nueva; getMaxTestId devuelve 0
    expect(getLastTestId(null, 'main')).toBe(1);
  });
});

describe('tddStore - integridad referencial y unicidad', () => {
  let store;
  let repoId;

  beforeEach(() => {
    store = new TddStore({ dbPath: ':memory:' });
    store.initialize();
    repoId = store.ensureRepository({
      rootPath: '/tmp/test-repo',
      remoteUrl: null
    });
    store.upsertCommit({
      commitId: 'sha-valid',
      repositoryId: repoId,
      author: 'A',
      message: 'valido',
      committedAt: '2024-01-01T00:00:00Z',
      additions: 0,
      deletions: 0,
      coverage: null,
      conclusion: 'neutral',
      parents: []
    });
  });

  afterEach(() => {
    store.close();
  });

  it('debe generar run_id unicos (UUID)', () => {
    const ids = new Set();
    for (let i = 0; i < 50; i++) {
      const runId = store.insertExecution({
        runId: crypto.randomUUID(),
        testId: i,
        repositoryId: repoId,
        commitId: 'sha-valid',
        branchName: 'main',
        workingTreeDirty: 0,
        trigger: 'manual',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:05Z',
        durationMs: 5000,
        success: 1,
        testsPassed: 3,
        testsFailed: 0,
        testsTotal: 3,
        coverage: 85.0,
        exitCode: 0,
        failureMessage: null
      });
      ids.add(runId);
    }
    expect(ids.size).toBe(50);
  });

  it('debe aceptar commit_id valido con foreign key', () => {
    const runId = store.insertExecution({
      runId: 'run-fk-ok',
      testId: 1,
      repositoryId: repoId,
      commitId: 'sha-valid',
      branchName: 'main',
      workingTreeDirty: 0,
      trigger: 'manual',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:00:05Z',
      durationMs: 5000,
      success: 1,
      testsPassed: 3,
      testsFailed: 0,
      testsTotal: 3,
      coverage: 85.0,
      exitCode: 0,
      failureMessage: null
    });
    expect(runId).toBe('run-fk-ok');
    const row = store.db
      .prepare('SELECT commit_id FROM tdd_execution WHERE run_id = ?')
      .get(runId);
    expect(row.commit_id).toBe('sha-valid');
  });

  it('debe aceptar commit_id NULL (ejecucion manual)', () => {
    const runId = store.insertExecution({
      runId: 'run-manual',
      testId: 1,
      repositoryId: repoId,
      commitId: null,
      branchName: null,
      workingTreeDirty: 1,
      trigger: 'manual',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:00:05Z',
      durationMs: 5000,
      success: 0,
      testsPassed: 0,
      testsFailed: 1,
      testsTotal: 1,
      coverage: null,
      exitCode: 1,
      failureMessage: 'infraestructura'
    });
    expect(runId).toBe('run-manual');
    const row = store.getExecutionByRunId('run-manual');
    expect(row.commit_id).toBeNull();
    expect(row.branch_name).toBeNull();
  });

  it('debe rechazar un commit_id inexistente (restriccion foreign key)', () => {
    expect(() => {
      store.insertExecution({
        runId: 'run-bad-fk',
        testId: 1,
        repositoryId: repoId,
        commitId: 'sha-inexistente',
        branchName: 'main',
        workingTreeDirty: 0,
        trigger: 'manual',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T00:00:05Z',
        durationMs: 5000,
        success: 1,
        testsPassed: 3,
        testsFailed: 0,
        testsTotal: 3,
        coverage: 85.0,
        exitCode: 0,
        failureMessage: null
      });
    }).toThrow();
  });

  it('debe consultar ejecuciones por commit, rama y run_id', () => {
    store.insertExecution({
      runId: 'run-q1',
      testId: 1,
      repositoryId: repoId,
      commitId: 'sha-valid',
      branchName: 'main',
      workingTreeDirty: 0,
      trigger: 'manual',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:00:05Z',
      durationMs: 5000,
      success: 1,
      testsPassed: 3,
      testsFailed: 0,
      testsTotal: 3,
      coverage: 85.0,
      exitCode: 0,
      failureMessage: null
    });
    store.insertExecution({
      runId: 'run-q2',
      testId: 2,
      repositoryId: repoId,
      commitId: 'sha-valid',
      branchName: 'main',
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

    expect(store.getExecutionsByCommit('sha-valid').length).toBe(2);
    expect(store.getExecutionsByBranch('main').length).toBe(2);
    expect(store.getExecutionByRunId('run-q1').run_id).toBe('run-q1');
    expect(store.getExecutionByRunId('run-q2').run_id).toBe('run-q2');
  });
});
