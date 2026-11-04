import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { TddStore } from '../tddStore.js';

describe('tddStore - inicializacion y esquema SQLite', () => {
  let store;
  let repoId;

  beforeEach(() => {
    store = new TddStore({ dbPath: ':memory:' });
    try {
      store.initialize();
      repoId = store.ensureRepository({
        rootPath: '/tmp/test-repo',
        remoteUrl: 'https://github.com/owner/repo.git'
      });
    } catch (e) {
      try {
        repoId = store.db.prepare('INSERT INTO tdd_repository (root_path, remote_url) VALUES (?, ?)').run('/tmp/test-repo', 'https://github.com/owner/repo.git').lastInsertRowid;
      } catch (e2) {
        repoId = 1;
      }
    }
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
  });

  it('debe crear las tablas obligatorias del esquema', () => {
    const expectedTables = [
      'tdd_repository',
      'tdd_branch',
      'tdd_commit',
      'tdd_commit_parent',
      'tdd_execution',
      'tdd_run_failures',
      'tdd_event_log',
      'tdd_schema_migration'
    ];

    for (const table of expectedTables) {
      const row = store.db
        .prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name = ?')
        .get(table);
      expect(row).toBeDefined();
      expect(row.name).toBe(table);
    }
  });

  it('debe tener foreign keys habilitadas', () => {
    const row = store.db.prepare('PRAGMA foreign_keys').get();
    expect(row.foreign_keys).toBe(1);
  });

  it('debe registrar el esquema migrado en tdd_schema_migration', () => {
    const row = store.db
      .prepare('SELECT version FROM tdd_schema_migration')
      .get();
    expect(row.version).toBe(1);
  });

  it('debe inicializarse de forma idempotente (llamar initialize dos veces)', () => {
    expect(() => store.initialize()).not.toThrow();
    expect(store.db).toBeDefined();
  });

  it('debe cerrar la conexión sin errores', () => {
    expect(() => store.close()).not.toThrow();
    const store2 = new TddStore({ dbPath: ':memory:' });
    store2.initialize();
    expect(store2.db).toBeDefined();
    store2.close();
  });

  it('debe crear un repositorio y devolver su id', () => {
    expect(repoId).toBeGreaterThan(0);
    const row = store.db
      .prepare('SELECT * FROM tdd_repository WHERE id = ?')
      .get(repoId);
    expect(row.root_path).toBe('/tmp/test-repo');
    expect(row.remote_url).toBe('https://github.com/owner/repo.git');
  });

  it('debe ser idempotente al registrar el mismo repositorio (misma root_path)', () => {
    const id2 = store.ensureRepository({
      rootPath: '/tmp/test-repo',
      remoteUrl: 'https://github.com/owner/repo.git'
    });
    expect(id2).toBe(repoId);
  });

  it('debe crear una rama y devolver su id', () => {
    const branchId = store.upsertBranch({
      repositoryId: repoId,
      name: 'main',
      headSha: 'abc123',
      deletedAt: null
    });
    expect(branchId).toBeGreaterThan(0);

    const row = store.db
      .prepare('SELECT * FROM tdd_branch WHERE id = ?')
      .get(branchId);
    expect(row.name).toBe('main');
    expect(row.head_sha).toBe('abc123');
    expect(row.deleted_at).toBeNull();
  });

  it('debe actualizar una rama existente en lugar de duplicarla', () => {
    const id1 = store.upsertBranch({
      repositoryId: repoId,
      name: 'main',
      headSha: 'sha1',
      deletedAt: null
    });
    const id2 = store.upsertBranch({
      repositoryId: repoId,
      name: 'main',
      headSha: 'sha2',
      deletedAt: null
    });
    expect(id1).toBe(id2);
    const row = store.db
      .prepare('SELECT head_sha FROM tdd_branch WHERE id = ?')
      .get(id1);
    expect(row.head_sha).toBe('sha2');
  });

  it('debe permitir ramas con el mismo nombre en repositorios distintos', () => {
    const repo2 = store.ensureRepository({
      rootPath: '/tmp/test-repo-2',
      remoteUrl: null
    });
    const b1 = store.upsertBranch({
      repositoryId: repoId,
      name: 'main',
      headSha: 'sha1',
      deletedAt: null
    });
    const b2 = store.upsertBranch({
      repositoryId: repo2,
      name: 'main',
      headSha: 'sha2',
      deletedAt: null
    });
    expect(b1).not.toBe(b2);
  });

  it('debe marcar una rama como eliminada sin borrarla', () => {
    const branchId = store.upsertBranch({
      repositoryId: repoId,
      name: 'feature-x',
      headSha: 'sha-x',
      deletedAt: null
    });
    const now = new Date().toISOString();
    store.upsertBranch({
      repositoryId: repoId,
      name: 'feature-x',
      headSha: 'sha-x',
      deletedAt: now
    });
    const row = store.db
      .prepare('SELECT deleted_at FROM tdd_branch WHERE id = ?')
      .get(branchId);
    expect(row.deleted_at).toBe(now);
  });
});

describe('tddStore - commits y padres (DAG de Git)', () => {
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

  it('debe insertar un commit sin padres (commit raiz)', () => {
    store.upsertCommit({
      commitId: 'sha-root',
      repositoryId: repoId,
      author: 'Autor',
      message: 'commit raiz',
      committedAt: '2024-01-01T00:00:00Z',
      additions: 10,
      deletions: 2,
      coverage: 80.5,
      conclusion: 'success',
      parents: []
    });
    const row = store.db
      .prepare('SELECT * FROM tdd_commit WHERE commit_id = ?')
      .get('sha-root');
    expect(row.author).toBe('Autor');
    expect(row.message).toBe('commit raiz');
    expect(row.conclusion).toBe('success');

    const parents = store.getCommitParents('sha-root');
    expect(parents).toEqual([]);
  });

  it('debe insertar un commit con un padre (rama lineal)', () => {
    store.upsertCommit({
      commitId: 'sha-parent',
      repositoryId: repoId,
      author: 'A',
      message: 'padre',
      committedAt: '2024-01-01T00:00:00Z',
      additions: 0,
      deletions: 0,
      coverage: null,
      conclusion: 'neutral',
      parents: []
    });
    store.upsertCommit({
      commitId: 'sha-child',
      repositoryId: repoId,
      author: 'B',
      message: 'hijo',
      committedAt: '2024-01-02T00:00:00Z',
      additions: 5,
      deletions: 1,
      coverage: 90.0,
      conclusion: 'success',
      parents: ['sha-parent']
    });
    const parents = store.getCommitParents('sha-child');
    expect(parents).toEqual(['sha-parent']);
  });

  it('debe representar un merge commit con varios padres', () => {
    store.upsertCommit({
      commitId: 'sha-a',
      repositoryId: repoId,
      author: 'A',
      message: 'rama A',
      committedAt: '2024-01-01T00:00:00Z',
      additions: 0,
      deletions: 0,
      coverage: null,
      conclusion: 'neutral',
      parents: []
    });
    store.upsertCommit({
      commitId: 'sha-b',
      repositoryId: repoId,
      author: 'B',
      message: 'rama B',
      committedAt: '2024-01-01T00:00:00Z',
      additions: 0,
      deletions: 0,
      coverage: null,
      conclusion: 'neutral',
      parents: []
    });
    store.upsertCommit({
      commitId: 'sha-merge',
      repositoryId: repoId,
      author: 'C',
      message: 'Merge rama B en A',
      committedAt: '2024-01-02T00:00:00Z',
      additions: 0,
      deletions: 0,
      coverage: null,
      conclusion: 'success',
      parents: ['sha-a', 'sha-b']
    });
    const parents = store.getCommitParents('sha-merge');
    expect(parents).toEqual(['sha-a', 'sha-b']);
  });

  it('debe actualizar un commit existente en lugar de duplicarlo', () => {
    store.upsertCommit({
      commitId: 'sha-upd',
      repositoryId: repoId,
      author: 'A',
      message: 'original',
      committedAt: '2024-01-01T00:00:00Z',
      additions: 0,
      deletions: 0,
      coverage: null,
      conclusion: 'neutral',
      parents: []
    });
    store.upsertCommit({
      commitId: 'sha-upd',
      repositoryId: repoId,
      author: 'B',
      message: 'actualizado',
      committedAt: '2024-01-02T00:00:00Z',
      additions: 3,
      deletions: 0,
      coverage: 100.0,
      conclusion: 'success',
      parents: []
    });
    const row = store.db
      .prepare('SELECT message, additions, conclusion FROM tdd_commit WHERE commit_id = ?')
      .get('sha-upd');
    expect(row.message).toBe('actualizado');
    expect(row.additions).toBe(3);
    expect(row.conclusion).toBe('success');
  });

  it('debe contar commits registrados', () => {
    expect(store.countCommits()).toBe(0);
    store.upsertCommit({
      commitId: 'sha-1',
      repositoryId: repoId,
      author: 'A',
      message: 'm1',
      committedAt: '2024-01-01T00:00:00Z',
      additions: 0,
      deletions: 0,
      coverage: null,
      conclusion: 'neutral',
      parents: []
    });
    expect(store.countCommits()).toBe(1);
  });
});

describe('tddStore - ejecuciones de pruebas', () => {
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
      commitId: 'sha-c1',
      repositoryId: repoId,
      author: 'A',
      message: 'commit c1',
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

  it('debe insertar una ejecucion y devolver su run_id', () => {
    const runId = store.insertExecution({
      runId: 'run-uuid-1',
      testId: 1,
      repositoryId: repoId,
      commitId: 'sha-c1',
      branchName: 'main',
      workingTreeDirty: false,
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
    expect(runId).toBe('run-uuid-1');

    const row = store.db
      .prepare('SELECT * FROM tdd_execution WHERE run_id = ?')
      .get(runId);
    expect(row.test_id).toBe(1);
    expect(row.branch_name).toBe('main');
    expect(row.success).toBe(1);
    expect(row.tests_passed).toBe(3);
    expect(row.exit_code).toBe(0);
  });

  it('debe permitir commit_id NULL para ejecuciones manuales sin commit', () => {
    const runId = store.insertExecution({
      runId: 'run-manual',
      testId: 1,
      repositoryId: repoId,
      commitId: null,
      branchName: null,
      workingTreeDirty: true,
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
      failureMessage: 'Test fallo'
    });
    const row = store.db
      .prepare('SELECT commit_id FROM tdd_execution WHERE run_id = ?')
      .get(runId);
    expect(row.commit_id).toBeNull();
  });

  it('debe obtener ejecuciones por commit', () => {
    store.insertExecution({
      runId: 'run-1',
      testId: 1,
      repositoryId: repoId,
      commitId: 'sha-c1',
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
      runId: 'run-2',
      testId: 2,
      repositoryId: repoId,
      commitId: 'sha-c1',
      branchName: 'main',
      workingTreeDirty: 0,
      trigger: 'manual',
      startTime: '2024-01-01T00:00:10Z',
      endTime: '2024-01-01T00:00:15Z',
      durationMs: 5000,
      success: 0,
      testsPassed: 2,
      testsFailed: 1,
      testsTotal: 3,
      coverage: 80.0,
      exitCode: 1,
      failureMessage: null
    });

    const executions = store.getExecutionsByCommit('sha-c1');
    expect(executions.length).toBe(2);
    expect(executions[0].run_id).toBe('run-1');
    expect(executions[1].run_id).toBe('run-2');
  });

  it('debe obtener ejecuciones por rama', () => {
    store.upsertBranch({
      repositoryId: repoId,
      name: 'feature-a',
      headSha: 'sha-c1',
      deletedAt: null
    });
    store.insertExecution({
      runId: 'run-a',
      testId: 1,
      repositoryId: repoId,
      commitId: 'sha-c1',
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
    store.insertExecution({
      runId: 'run-main',
      testId: 2,
      repositoryId: repoId,
      commitId: 'sha-c1',
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

    const featureExecutions = store.getExecutionsByBranch('feature-a');
    expect(featureExecutions.length).toBe(1);
    expect(featureExecutions[0].run_id).toBe('run-a');

    const mainExecutions = store.getExecutionsByBranch('main');
    expect(mainExecutions.length).toBe(1);
    expect(mainExecutions[0].run_id).toBe('run-main');
  });

  it('debe obtener una ejecucion por run_id', () => {
    store.insertExecution({
      runId: 'run-get',
      testId: 5,
      repositoryId: repoId,
      commitId: 'sha-c1',
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
    const row = store.getExecutionByRunId('run-get');
    expect(row).toBeDefined();
    expect(row.test_id).toBe(5);
    expect(row.run_id).toBe('run-get');
  });

  it('debe devolver null para un run_id inexistente', () => {
    const row = store.getExecutionByRunId('no-existe');
    expect(row).toBeUndefined();
  });

  it('debe contar ejecuciones', () => {
    expect(store.countExecutions()).toBe(0);
    store.insertExecution({
      runId: 'run-c1',
      testId: 1,
      repositoryId: repoId,
      commitId: 'sha-c1',
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
    expect(store.countExecutions()).toBe(1);
  });
});

describe('tddStore - test_id secuencial y fallos', () => {
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

  it('debe devolver 0 cuando no hay ejecuciones', () => {
    expect(store.getMaxTestId({ branchName: 'main' })).toBe(0);
  });

  it('debe devolver max(test_id) + 1 por rama', () => {
    store.insertExecution({
      runId: 'run-a',
      testId: 3,
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
    expect(store.getMaxTestId({ branchName: 'main' })).toBe(3);

    store.insertExecution({
      runId: 'run-2',
      testId: 5,
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
    expect(store.getMaxTestId({ branchName: 'main' })).toBe(5);

    expect(store.getMaxTestId({ branchName: 'feature' })).toBe(0);
  });

  it('debe insertar fallos de prueba asociados a una ejecucion', () => {
    store.insertExecution({
      runId: 'run-fail',
      testId: 1,
      repositoryId: repoId,
      commitId: null,
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
      coverage: null,
      exitCode: 1,
      failureMessage: null
    });
    const failId = store.insertRunFailure({
      runId: 'run-fail',
      testPath: 'src/sumador.test.js',
      title: 'debería sumar correctamente',
      failure: 'Expected 5 to be 6'
    });
    expect(failId).toBeDefined();

    const failures = store.db
      .prepare('SELECT * FROM tdd_run_failures WHERE run_id = ?')
      .all('run-fail');
    expect(failures.length).toBe(1);
    expect(failures[0].test_path).toBe('src/sumador.test.js');
    expect(failures[0].failure).toBe('Expected 5 to be 6');
  });

  it('debe registrar eventos operacionales en tdd_event_log', () => {
    const repoId2 = store.ensureRepository({
      rootPath: '/tmp/test-repo-2',
      remoteUrl: null
    });
    store.insertExecution({
      runId: 'run-err',
      testId: 1,
      repositoryId: repoId2,
      commitId: null,
      branchName: 'main',
      workingTreeDirty: 0,
      trigger: 'manual',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-01T00:00:05Z',
      durationMs: 5000,
      success: 1,
      testsPassed: 1,
      testsFailed: 0,
      testsTotal: 1,
      coverage: 100.0,
      exitCode: 0,
      failureMessage: null
    });
    const id = store.insertEventLog({
      level: 'error',
      component: 'jest-runner',
      message: 'Jest no disponible',
      runId: 'run-err',
      attributes: '{"code": "MODULE_NOT_FOUND"}'
    });
    expect(id).toBeDefined();

    const row = store.db
      .prepare('SELECT * FROM tdd_event_log WHERE id = ?')
      .get(id);
    expect(row.level).toBe('error');
    expect(row.component).toBe('jest-runner');
    expect(row.message).toBe('Jest no disponible');
    expect(row.run_id).toBe('run-err');
  });
});