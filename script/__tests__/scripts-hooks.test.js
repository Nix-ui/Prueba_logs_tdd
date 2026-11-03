import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello');
  execSync('git add file.txt', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "commit inicial"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    // Ignorar
  }
}

async function getDb() {
  const mod = await import('better-sqlite3');
  return mod.default;
}

describe('commitScript.js - funcion main', () => {
  let exitMock;
  let originalCwd;
  let repoDir;

  beforeEach(async () => {
    exitMock = jest.spyOn(process, 'exit').mockImplementation(() => {});
    originalCwd = process.cwd();
    repoDir = makeTempRepo();
    process.chdir(repoDir);
  });

  afterEach(() => {
    exitMock.mockRestore();
    process.chdir(originalCwd);
    removeDir(repoDir);
  });

  it('debe insertar el commit con SHA real en SQLite y salir con codigo 0', async () => {
    const mod = await import('../commitScript.js');
    const { main } = mod;
    main();
    expect(exitMock).toHaveBeenCalledWith(0);

    const dbPath = path.join(repoDir, '.tddlab', 'tddlab.db');
    expect(fs.existsSync(dbPath)).toBe(true);

    const Database = await getDb();
    const headSha = execSync('git rev-parse HEAD', { cwd: repoDir, stdio: 'pipe' }).toString().trim();
    const db = new Database(dbPath, { readonly: true });
    const commit = db.prepare('SELECT * FROM tdd_commit WHERE commit_id = ?').get(headSha);
    expect(commit).toBeDefined();
    expect(commit.message).toBe('commit inicial');
    expect(commit.commit_id).toMatch(/^[0-9a-f]+$/);
    db.close();
  });

  it('no debe registrar el literal HEAD como commit_id', async () => {
    const mod = await import('../commitScript.js');
    const { main } = mod;
    main();
    const dbPath = path.join(repoDir, '.tddlab', 'tddlab.db');
    const Database = await getDb();
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT commit_id FROM tdd_commit').all();
    db.close();
    for (const row of rows) {
      expect(row.commit_id).not.toBe('HEAD');
      expect(row.commit_id).toMatch(/^[0-9a-f]+$/);
    }
  });
});

describe('commit-tracker.js - funcion main', () => {
  let exitMock;
  let originalCwd;
  let repoDir;

  beforeEach(() => {
    exitMock = jest.spyOn(process, 'exit').mockImplementation(() => {});
    originalCwd = process.cwd();
    repoDir = makeTempRepo();
    process.chdir(repoDir);
  });

  afterEach(() => {
    exitMock.mockRestore();
    process.chdir(originalCwd);
    removeDir(repoDir);
  });

  it('debe insertar el commit en SQLite sin relanzar Jest y salir con codigo 0', async () => {
    const mod = await import('../commit-tracker.js');
    const { main } = mod;
    main();
    expect(exitMock).toHaveBeenCalledWith(0);

    const dbPath = path.join(repoDir, '.tddlab', 'tddlab.db');
    expect(fs.existsSync(dbPath)).toBe(true);

    const Database = await getDb();
    const headSha = execSync('git rev-parse HEAD', { cwd: repoDir, stdio: 'pipe' }).toString().trim();
    const db = new Database(dbPath, { readonly: true });
    const commit = db.prepare('SELECT * FROM tdd_commit WHERE commit_id = ?').get(headSha);
    expect(commit).toBeDefined();
    expect(commit.sha).not.toBe('HEAD');
    db.close();
  });
});

describe('tddScript.js - exportaciones y TddStore', () => {
  it('debe exportar extractAndAddObject y TddStore', async () => {
    const mod = await import('../tddScript.js');
    expect(typeof mod.extractAndAddObject).toBe('function');
    expect(typeof mod.TddStore).toBe('function');
  });

  it('TddStore debe poder inicializarse desde tddScript', async () => {
    const { TddStore } = await import('../tddScript.js');
    const store = new TddStore({ dbPath: ':memory:' });
    store.initialize();
    expect(store.db).toBeDefined();
    store.close();
  });
});
