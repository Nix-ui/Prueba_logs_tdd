import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DEFAULT_DB_DIR = '.tddlab';
const DEFAULT_DB_FILE = 'tddlab.db';
const SCHEMA_VERSION = 1;

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tdd_repository (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_path TEXT NOT NULL UNIQUE,
  remote_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tdd_branch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL REFERENCES tdd_repository(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  head_sha TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repository_id, name)
);

CREATE TABLE IF NOT EXISTS tdd_commit (
  commit_id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES tdd_repository(id) ON DELETE CASCADE,
  author TEXT,
  message TEXT,
  committed_at TEXT,
  additions INTEGER DEFAULT 0,
  deletions INTEGER DEFAULT 0,
  coverage REAL,
  conclusion TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tdd_commit_parent (
  commit_id TEXT NOT NULL REFERENCES tdd_commit(commit_id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL REFERENCES tdd_commit(commit_id) ON DELETE CASCADE,
  ord INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (commit_id, parent_id)
);

CREATE TABLE IF NOT EXISTS tdd_execution (
  run_id TEXT PRIMARY KEY,
  test_id INTEGER,
  repository_id INTEGER NOT NULL REFERENCES tdd_repository(id) ON DELETE CASCADE,
  commit_id TEXT REFERENCES tdd_commit(commit_id) ON DELETE SET NULL,
  branch_name TEXT,
  working_tree_dirty INTEGER DEFAULT 0,
  trigger TEXT NOT NULL DEFAULT 'manual',
  start_time TEXT,
  end_time TEXT,
  duration_ms INTEGER,
  success INTEGER NOT NULL DEFAULT 0,
  tests_passed INTEGER DEFAULT 0,
  tests_failed INTEGER DEFAULT 0,
  tests_total INTEGER DEFAULT 0,
  coverage REAL,
  exit_code INTEGER,
  failure_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tdd_execution_commit ON tdd_execution(commit_id);
CREATE INDEX IF NOT EXISTS idx_tdd_execution_branch ON tdd_execution(branch_name);
CREATE INDEX IF NOT EXISTS idx_tdd_execution_created ON tdd_execution(created_at);
CREATE INDEX IF NOT EXISTS idx_tdd_execution_run ON tdd_execution(run_id);

CREATE TABLE IF NOT EXISTS tdd_run_failures (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES tdd_execution(run_id) ON DELETE CASCADE,
  test_path TEXT NOT NULL,
  title TEXT NOT NULL,
  failure TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tdd_run_failures_run ON tdd_run_failures(run_id);

CREATE TABLE IF NOT EXISTS tdd_event_log (
  id TEXT PRIMARY KEY,
  event_time TEXT NOT NULL DEFAULT (datetime('now')),
  level TEXT NOT NULL CHECK(level IN ('info','warn','error')),
  component TEXT NOT NULL,
  run_id TEXT REFERENCES tdd_execution(run_id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  attributes TEXT
);

CREATE INDEX IF NOT EXISTS idx_tdd_event_log_run ON tdd_event_log(run_id);
CREATE INDEX IF NOT EXISTS idx_tdd_event_log_level ON tdd_event_log(level);
`;

const MIGRATIONS = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS tdd_schema_migration (
        version INTEGER PRIMARY KEY
      );
    `
  }
];

function generateUuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

export class TddStore {
  constructor({ dbPath } = {}) {
    const dbDir = dbPath ? path.dirname(dbPath) : DEFAULT_DB_DIR;
    const dbFile = dbPath || path.join(DEFAULT_DB_DIR, DEFAULT_DB_FILE);
    this.dbPath = dbFile;
    this.dbDir = dbDir;
    this.db = null;
    this._initialized = false;
  }

  initialize() {
    if (this._initialized) return this.db;
    fs.mkdirSync(this.dbDir, { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this._applySchema();
    this._initialized = true;
    return this.db;
  }

  _applySchema() {
    this.db.exec(SCHEMA);
    this.db.exec(MIGRATIONS[0].up);
    const row = this.db.prepare('SELECT MAX(version) AS v FROM tdd_schema_migration').get();
    const current = row && row.v ? row.v : 0;
    if (current < SCHEMA_VERSION) {
      const tx = this.db.transaction(() => {
        const insert = this.db.prepare('INSERT INTO tdd_schema_migration (version) VALUES (?)');
        insert.run(SCHEMA_VERSION);
      });
      tx();
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      this._initialized = false;
    }
  }

  ensureRepository({ rootPath, remoteUrl }) {
    this.initialize();
    const existing = this.db
      .prepare('SELECT id FROM tdd_repository WHERE root_path = ?')
      .get(rootPath);
    if (existing) return existing.id;
    const insert = this.db.prepare(
      'INSERT INTO tdd_repository (root_path, remote_url) VALUES (?, ?)'
    );
    const result = insert.run(rootPath, remoteUrl || null);
    return result.lastInsertRowid;
  }

  upsertBranch({ repositoryId, name, headSha, deletedAt }) {
    this.initialize();
    const existing = this.db
      .prepare('SELECT id FROM tdd_branch WHERE repository_id = ? AND name = ?')
      .get(repositoryId, name);
    if (existing) {
      this.db
        .prepare(
          'UPDATE tdd_branch SET head_sha = ?, deleted_at = ? WHERE id = ?'
        )
        .run(headSha || null, deletedAt || null, existing.id);
      return existing.id;
    }
    const insert = this.db.prepare(
      'INSERT INTO tdd_branch (repository_id, name, head_sha, deleted_at) VALUES (?, ?, ?, ?)'
    );
    const result = insert.run(repositoryId, name, headSha || null, deletedAt || null);
    return result.lastInsertRowid;
  }

  upsertCommit({
    commitId,
    repositoryId,
    author,
    message,
    committedAt,
    additions,
    deletions,
    coverage,
    conclusion,
    parents
  }) {
    this.initialize();
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT commit_id FROM tdd_commit WHERE commit_id = ?')
        .get(commitId);
      if (existing) {
        this.db
          .prepare(
            `UPDATE tdd_commit SET
              author = ?, message = ?, committed_at = ?, additions = ?,
              deletions = ?, coverage = ?, conclusion = ?
            WHERE commit_id = ?`
          )
          .run(
            author, message, committedAt, additions, deletions,
            coverage, conclusion, commitId
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO tdd_commit
              (commit_id, repository_id, author, message, committed_at,
               additions, deletions, coverage, conclusion)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            commitId, repositoryId, author, message, committedAt,
            additions, deletions, coverage, conclusion
          );
      }
      // Replace parents. Solo se insertan padres que ya existen en tdd_commit
      // (un commit padre puede no haberse registrado aún si los commits
      // llegan fuera de orden, p. ej. tras un fetch o merge).
      this.db.prepare('DELETE FROM tdd_commit_parent WHERE commit_id = ?').run(commitId);
      const insertParent = this.db.prepare(
        'INSERT INTO tdd_commit_parent (commit_id, parent_id, ord) VALUES (?, ?, ?)'
      );
      (parents || []).forEach((parentId, ord) => {
        const exists = this.db
          .prepare('SELECT 1 FROM tdd_commit WHERE commit_id = ?')
          .get(parentId);
        if (exists) {
          insertParent.run(commitId, parentId, ord);
        }
        // Si el padre no existe aún (commit recibido fuera de orden), se salta silenciosamente
      });
    });
    tx();
  }

  insertExecution({
    runId,
    testId,
    repositoryId,
    commitId,
    branchName,
    workingTreeDirty,
    trigger,
    startTime,
    endTime,
    durationMs,
    success,
    testsPassed,
    testsFailed,
    testsTotal,
    coverage,
    exitCode,
    failureMessage
  }) {
    this.initialize();
    const insert = this.db.prepare(
      `INSERT INTO tdd_execution
        (run_id, test_id, repository_id, commit_id, branch_name,
         working_tree_dirty, trigger, start_time, end_time, duration_ms,
         success, tests_passed, tests_failed, tests_total, coverage,
         exit_code, failure_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      runId, testId, repositoryId, commitId, branchName,
      workingTreeDirty ? 1 : 0, trigger, startTime, endTime, durationMs,
      success ? 1 : 0, testsPassed, testsFailed, testsTotal,
      coverage, exitCode, failureMessage
    );
    return runId;
  }

  insertRunFailure({ runId, testPath, title, failure }) {
    this.initialize();
    const id = generateUuid();
    this.db
      .prepare(
        'INSERT INTO tdd_run_failures (id, run_id, test_path, title, failure) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, runId, testPath, title, failure);
    return id;
  }

  insertEventLog({ level, component, message, runId, attributes }) {
    this.initialize();
    const id = generateUuid();
    this.db
      .prepare(
        'INSERT INTO tdd_event_log (id, level, component, message, run_id, attributes) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(id, level, component, message, runId || null, attributes || null);
    return id;
  }

  getExecutionsByCommit(commitId) {
    this.initialize();
    return this.db
      .prepare('SELECT * FROM tdd_execution WHERE commit_id = ? ORDER BY created_at DESC')
      .all(commitId);
  }

  getExecutionsByBranch(branchName) {
    this.initialize();
    return this.db
      .prepare('SELECT * FROM tdd_execution WHERE branch_name = ? ORDER BY created_at DESC')
      .all(branchName);
  }

  getExecutionByRunId(runId) {
    this.initialize();
    return this.db
      .prepare('SELECT * FROM tdd_execution WHERE run_id = ?')
      .get(runId);
  }

  getCommitParents(commitId) {
    this.initialize();
    return this.db
      .prepare('SELECT parent_id FROM tdd_commit_parent WHERE commit_id = ? ORDER BY ord')
      .all(commitId)
      .map((r) => r.parent_id);
  }

  getMaxTestId({ branchName, commitId }) {
    this.initialize();
    if (branchName && commitId) {
      const row = this.db
        .prepare(
          'SELECT MAX(test_id) AS m FROM tdd_execution WHERE branch_name = ? AND commit_id = ?'
        )
        .get(branchName, commitId);
      return row && row.m !== null ? row.m : 0;
    }
    if (branchName) {
      const row = this.db
        .prepare('SELECT MAX(test_id) AS m FROM tdd_execution WHERE branch_name = ?')
        .get(branchName);
      return row && row.m !== null ? row.m : 0;
    }
    const row = this.db
      .prepare('SELECT MAX(test_id) AS m FROM tdd_execution')
      .get();
    return row && row.m !== null ? row.m : 0;
  }

  countExecutions() {
    this.initialize();
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM tdd_execution').get();
    return row ? row.c : 0;
  }

  countCommits() {
    this.initialize();
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM tdd_commit').get();
    return row ? row.c : 0;
  }
}

export { generateUuid, nowIso, DEFAULT_DB_DIR, DEFAULT_DB_FILE, SCHEMA_VERSION };
export default TddStore;
