import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DEFAULT_DB_DIR = ".tddlab";
const DEFAULT_DB_FILE = "tddlab.db";
const SCHEMA_VERSION = 2;

// Tablas de la versión 1 (schema anterior). Se eliminan al migrar.
// Orden: hijas primero.
const LEGACY_TABLES = [
	"tdd_run_failures",
	"tdd_event_log",
	"tdd_commit_parent",
	"tdd_execution",
	"tdd_merge",
	"tdd_commit",
	"tdd_branch",
	"tdd_repository",
	"tdd_schema_migration",
];

// Notas de diseño:
// - fork_commit_sha, parent_sha, source_commit_sha y merge_commit_sha NO tienen
//   FOREIGN KEY a tdd_commit: el commit referenciado puede no haberse registrado
//   todavía (commits que llegan fuera de orden tras un fetch o merge) y, en el
//   caso de tdd_branch, evita una referencia circular con tdd_commit.
// - tdd_commit.branch es la rama donde se HIZO el commit; no se sobrescribe
//   (tras un fast-forward el commit sigue figurando en su rama de origen).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tdd_branch (
  name TEXT PRIMARY KEY,
  fork_commit_sha TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tdd_commit (
  sha TEXT PRIMARY KEY,
  parent_sha TEXT,
  branch TEXT REFERENCES tdd_branch(name) ON DELETE SET NULL,
  author TEXT,
  message TEXT,
  committed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tdd_commit_branch ON tdd_commit(branch);

CREATE TABLE IF NOT EXISTS tdd_execution (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_sha TEXT REFERENCES tdd_commit(sha) ON DELETE SET NULL,
  tests_total INTEGER NOT NULL DEFAULT 0,
  tests_passed INTEGER NOT NULL DEFAULT 0,
  tests_failed INTEGER NOT NULL DEFAULT 0,
  executed_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (tests_passed + tests_failed <= tests_total)
);

CREATE INDEX IF NOT EXISTS idx_tdd_execution_commit ON tdd_execution(commit_sha);

CREATE TABLE IF NOT EXISTS tdd_merge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_branch TEXT NOT NULL REFERENCES tdd_branch(name),
  target_branch TEXT NOT NULL REFERENCES tdd_branch(name),
  source_commit_sha TEXT NOT NULL,
  merge_commit_sha TEXT NOT NULL,
  is_fast_forward INTEGER NOT NULL DEFAULT 0 CHECK (is_fast_forward IN (0, 1)),
  merged_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (merge_commit_sha, target_branch)
);
`;

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
		if (this._initialized) {
			return this.db;
		}
		fs.mkdirSync(this.dbDir, { recursive: true });
		this.db = new Database(this.dbPath);
		this.db.pragma("foreign_keys = ON");
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("busy_timeout = 5000");
		this._applySchema();
		this._initialized = true;
		return this.db;
	}

	_applySchema() {
		const version = this.db.pragma("user_version", { simple: true });

		if (version < SCHEMA_VERSION) {
			if (this._hasLegacyTables()) {
				this._backupAndDropLegacy();
			}
			this.db.exec(SCHEMA);
			this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
			return;
		}

		// Ya migrada: CREATE ... IF NOT EXISTS es idempotente.
		this.db.exec(SCHEMA);
	}

	_hasLegacyTables() {
		const row = this.db
			.prepare(
				`SELECT 1 AS found FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('tdd_schema_migration', 'tdd_repository')
         LIMIT 1`,
			)
			.get();
		return Boolean(row);
	}

	_backupAndDropLegacy() {
		// Copia de seguridad del historial de la v1 antes de borrarlo.
		if (this.dbPath !== ":memory:") {
			const backupPath = `${this.dbPath}.v1.bak`;
			fs.rmSync(backupPath, { force: true });
			this.db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
		}

		this.db.pragma("foreign_keys = OFF");
		try {
			for (const table of LEGACY_TABLES) {
				this.db.exec(`DROP TABLE IF EXISTS ${table}`);
			}
		} finally {
			this.db.pragma("foreign_keys = ON");
		}
	}

	close() {
		if (this.db) {
			this.db.close();
			this.db = null;
			this._initialized = false;
		}
	}

	// ---------------------------------------------------------------- escritura

	// fork_commit_sha solo se fija la primera vez que llega un valor; después
	// no se sobrescribe (el punto de nacimiento de una rama no cambia).
	upsertBranch({ name, forkCommitSha }) {
		this.initialize();
		this.db
			.prepare(
				`INSERT INTO tdd_branch (name, fork_commit_sha)
         VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET
           fork_commit_sha = COALESCE(tdd_branch.fork_commit_sha, excluded.fork_commit_sha)`,
			)
			.run(name, forkCommitSha || null);
		return name;
	}

	// La rama debe existir antes (llamar a upsertBranch primero).
	// branch no se sobrescribe: es la rama donde se hizo el commit.
	upsertCommit({ sha, parentSha, branch, author, message, committedAt }) {
		this.initialize();
		this.db
			.prepare(
				`INSERT INTO tdd_commit (sha, parent_sha, branch, author, message, committed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(sha) DO UPDATE SET
           parent_sha   = COALESCE(excluded.parent_sha, tdd_commit.parent_sha),
           branch       = COALESCE(tdd_commit.branch, excluded.branch),
           author       = COALESCE(excluded.author, tdd_commit.author),
           message      = COALESCE(excluded.message, tdd_commit.message),
           committed_at = COALESCE(excluded.committed_at, tdd_commit.committed_at)`,
			)
			.run(
				sha,
				parentSha || null,
				branch || null,
				author || null,
				message || null,
				committedAt || null,
			);
		return sha;
	}

	insertExecution({
		commitSha,
		testsTotal,
		testsPassed,
		testsFailed,
		executedAt,
	}) {
		this.initialize();
		const result = this.db
			.prepare(
				`INSERT INTO tdd_execution
           (commit_sha, tests_total, tests_passed, tests_failed, executed_at)
         VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				commitSha || null,
				testsTotal || 0,
				testsPassed || 0,
				testsFailed || 0,
				executedAt || nowIso(),
			);
		return Number(result.lastInsertRowid);
	}

	// Para merge normal: sourceCommitSha = HEAD^2, mergeCommitSha = HEAD.
	// Para fast-forward: sourceCommitSha = mergeCommitSha = HEAD e isFastForward = true.
	// Es idempotente: (mergeCommitSha, targetBranch) es único.
	insertMerge({
		sourceBranch,
		targetBranch,
		sourceCommitSha,
		mergeCommitSha,
		isFastForward,
		mergedAt,
	}) {
		this.initialize();
		const tx = this.db.transaction(() => {
			this.upsertBranch({ name: sourceBranch });
			this.upsertBranch({ name: targetBranch });
			return this.db
				.prepare(
					`INSERT OR IGNORE INTO tdd_merge
             (source_branch, target_branch, source_commit_sha,
              merge_commit_sha, is_fast_forward, merged_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.run(
					sourceBranch,
					targetBranch,
					sourceCommitSha,
					mergeCommitSha,
					isFastForward ? 1 : 0,
					mergedAt || nowIso(),
				);
		});
		const result = tx();
		return result.changes > 0 ? Number(result.lastInsertRowid) : null;
	}

	// ----------------------------------------------------------------- lectura

	getBranch(name) {
		this.initialize();
		return this.db.prepare("SELECT * FROM tdd_branch WHERE name = ?").get(name);
	}

	getCommit(sha) {
		this.initialize();
		return this.db.prepare("SELECT * FROM tdd_commit WHERE sha = ?").get(sha);
	}

	// Rama donde se hizo un commit (útil para resolver source_branch en un merge).
	getCommitBranch(sha) {
		this.initialize();
		const row = this.db
			.prepare("SELECT branch FROM tdd_commit WHERE sha = ?")
			.get(sha);
		return row ? row.branch : null;
	}

	// Rama padre: la rama del commit de donde nació la rama.
	getParentBranch(name) {
		this.initialize();
		const row = this.db
			.prepare(
				`SELECT c.branch AS parent_branch
         FROM tdd_branch b
         JOIN tdd_commit c ON c.sha = b.fork_commit_sha
         WHERE b.name = ?`,
			)
			.get(name);
		return row ? row.parent_branch : null;
	}

	getExecutionsByCommit(sha) {
		this.initialize();
		return this.db
			.prepare(
				"SELECT * FROM tdd_execution WHERE commit_sha = ? ORDER BY executed_at DESC",
			)
			.all(sha);
	}

	// Ejecuciones de los commits hechos en una rama.
	getExecutionsByBranch(branchName) {
		this.initialize();
		return this.db
			.prepare(
				`SELECT e.*
         FROM tdd_execution e
         JOIN tdd_commit c ON c.sha = e.commit_sha
         WHERE c.branch = ?
         ORDER BY e.executed_at DESC`,
			)
			.all(branchName);
	}

	getMergesByTargetBranch(targetBranch) {
		this.initialize();
		return this.db
			.prepare(
				"SELECT * FROM tdd_merge WHERE target_branch = ? ORDER BY merged_at DESC",
			)
			.all(targetBranch);
	}

	countExecutions() {
		this.initialize();
		const row = this.db
			.prepare("SELECT COUNT(*) AS c FROM tdd_execution")
			.get();
		return row ? row.c : 0;
	}

	countCommits() {
		this.initialize();
		const row = this.db.prepare("SELECT COUNT(*) AS c FROM tdd_commit").get();
		return row ? row.c : 0;
	}
}

export { nowIso, DEFAULT_DB_DIR, DEFAULT_DB_FILE, SCHEMA_VERSION };
export default TddStore;
