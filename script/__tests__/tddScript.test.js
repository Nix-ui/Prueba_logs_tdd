import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest
} from '@jest/globals';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

jest.mock('cross-spawn', () => ({
  spawn: jest.fn()
}));

import { spawn } from 'cross-spawn';
import { TddStore } from '../tddStore.js';
import { extractAndAddObject } from '../tddScript.js';

const mockSpawn = spawn;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tdscript-'));
}

function removeDir(dirPath) {
  try {
    fs.rmSync(dirPath, {
      recursive: true,
      force: true
    });
  } catch {
    // Ignorar errores durante la limpieza.
  }
}

function mockSpawnExit(code) {
  mockSpawn.mockImplementation(() => {
    const emitter = new EventEmitter();

    process.nextTick(() => {
      emitter.emit('close', code);
    });

    return emitter;
  });
}

describe(
  'tddScript.js - extractAndAddObject con store real y spawn mockeado',
  () => {
    let tmpDir;
    let reportFile;
    let store;

    beforeEach(() => {
      tmpDir = makeTempDir();
      reportFile = path.join(tmpDir, 'script', 'report.json');

      fs.mkdirSync(path.dirname(reportFile), {
        recursive: true
      });

      fs.writeFileSync(
        reportFile,
        JSON.stringify({
          numPassedTests: 3,
          numFailedTests: 0,
          numTotalTests: 3,
          startTime: Date.now(),
          endTime: Date.now() + 5000,
          success: true,
          coverageMap: {}
        })
      );

      store = new TddStore({
        dbPath: ':memory:'
      });

      store.initialize();
      mockSpawnExit(0);
    });

    afterEach(() => {
      store.close();
      removeDir(tmpDir);
      jest.clearAllMocks();
    });

    it('debe registrar una ejecucion exitosa en SQLite', async () => {
      const result = await extractAndAddObject(reportFile, store);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.testsPassed).toBe(3);
      expect(result.runId).toBeDefined();

      const execution = store.getExecutionByRunId(result.runId);

      expect(execution).toBeDefined();
      expect(execution.success).toBe(1);
      expect(execution.tests_passed).toBe(3);
      expect(mockSpawn).toHaveBeenCalled();
    });

    it(
      'debe manejar Jest fallido sin tratarlo como error de persistencia',
      async () => {
        mockSpawnExit(1);

        const result = await extractAndAddObject(reportFile, store);

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(1);

        const execution = store.getExecutionByRunId(result.runId);

        expect(execution.success).toBe(0);
      }
    );

    it(
      'debe manejar Jest que falla al lanzar',
      async () => {
        mockSpawn.mockImplementation(() => {
          throw new Error('Jest no encontrado');
        });

        const result = await extractAndAddObject(reportFile, store);

        expect(result.success).toBe(false);
        expect(result.jestError).toBeDefined();

        const execution = store.getExecutionByRunId(result.runId);

        expect(execution).toBeDefined();
        expect(execution.success).toBe(0);
      }
    );

    it(
      'debe funcionar sin repositorio Git',
      async () => {
        const nonGitDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'nogit-')
        );

        const originalCwd = process.cwd();

        process.chdir(nonGitDir);

        const nonGitReport = path.join(
          nonGitDir,
          'script',
          'report.json'
        );

        fs.mkdirSync(path.dirname(nonGitReport), {
          recursive: true
        });

        fs.writeFileSync(
          nonGitReport,
          JSON.stringify({
            numPassedTests: 1,
            numFailedTests: 0,
            numTotalTests: 1,
            startTime: Date.now(),
            endTime: Date.now() + 1000,
            success: true
          })
        );

        try {
          const result = await extractAndAddObject(
            nonGitReport,
            store
          );

          expect(result.runId).toBeDefined();

          const execution = store.getExecutionByRunId(
            result.runId
          );

          expect(execution.branch_name).toBeNull();
          expect(execution.commit_id).toBeNull();
        } finally {
          process.chdir(originalCwd);
          removeDir(nonGitDir);
        }
      }
    );

    it(
      'debe manejar error de persistencia sin confundirlo con fallo de Jest',
      async () => {
        const failingStore = {
          initialize: jest.fn(),
          close: jest.fn(),
          ensureRepository: jest.fn(() => 1),
          upsertCommit: jest.fn(),
          upsertBranch: jest.fn(),

          insertExecution: jest.fn(() => {
            throw new Error('DB write failed');
          }),

          getMaxTestId: jest.fn(() => 0),
          insertEventLog: jest.fn(),
          insertRunFailure: jest.fn(),

          db: {
            prepare: jest.fn(() => ({
              get: jest.fn(() => undefined)
            }))
          }
        };

        mockSpawnExit(0);

        const result = await extractAndAddObject(
          reportFile,
          failingStore
        );

        expect(result.success).toBe(true);
        expect(result.exitCode).toBe(0);

        expect(
          failingStore.insertEventLog
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            level: 'error',
            component: 'persistence'
          })
        );
      }
    );

    it(
      'debe registrar ejecucion con fallos de prueba',
      async () => {
        fs.writeFileSync(
          reportFile,
          JSON.stringify({
            numPassedTests: 1,
            numFailedTests: 2,
            numTotalTests: 3,
            startTime: Date.now(),
            endTime: Date.now() + 5000,
            success: false,
            testResults: [
              {
                testFilePath: 'src/sumador.test.js',
                failureMessages: [
                  'Expected 3 to be 4'
                ]
              }
            ]
          })
        );

        mockSpawnExit(1);

        const result = await extractAndAddObject(
          reportFile,
          store
        );

        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(1);
        expect(result.testsFailed).toBe(2);

        const execution = store.getExecutionByRunId(
          result.runId
        );

        expect(execution.tests_failed).toBe(2);

        const failures = store.db
          .prepare(
            'SELECT * FROM tdd_run_failures WHERE run_id = ?'
          )
          .all(result.runId);

        expect(failures.length).toBeGreaterThanOrEqual(1);
      }
    );

    it(
      'debe registrar ejecucion con commit y rama',
      async () => {
        const result = await extractAndAddObject(
          reportFile,
          store
        );

        expect(result.success).toBe(true);
        expect(result.commitId).toBeDefined();
        expect(result.commitId).toMatch(/^[0-9a-f]+$/);

        const execution = store.getExecutionByRunId(
          result.runId
        );

        expect(execution.commit_id).toBe(result.commitId);

        if (execution.branchName) {
          expect(execution.branchName).toMatch(
            /^(main|master)$/
          );
        }
      }
    );
  }
);