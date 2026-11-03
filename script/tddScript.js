import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'cross-spawn';
import { TddStore, nowIso } from './tddStore.js';
import {
  captureGitContext,
  getCommitStats
} from './gitContext.js';

const COMMAND = 'jest';
const args = ['--json', '--outputFile=./script/report.json'];
const DB_DIR = '.tddlab';
const DB_FILE = 'tddlab.db';

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('close', (code) => {
      resolve({ code });
    });
    child.on('error', (error) => {
      reject(error);
    });
  });
}

const readJSONFile = (filePath) => {
  const rawData = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(rawData);
};

async function extractAndAddObject(reportFile, store) {
  const startTime = nowIso();
  let childResult;
  let jestError = null;

  try {
    childResult = await runCommand(COMMAND, args);
  } catch (error) {
    jestError = error;
    childResult = { code: null };
  }

  const endTime = nowIso();
  const exitCode = childResult && typeof childResult.code === 'number'
    ? childResult.code
    : 1;
  const success = exitCode === 0;

  // Read Jest report if it exists (preserve evidence even on failure).
  let report = null;
  try {
    if (fs.existsSync(reportFile)) {
      report = readJSONFile(reportFile);
    }
  } catch (readError) {
    jestError = jestError || readError;
  }

  const durationMs = report && typeof report.endTime === 'number'
    && typeof report.startTime === 'number'
    ? report.endTime - report.startTime
    : null;

  const testsPassed = report ? report.numPassedTests : 0;
  const testsFailed = report ? report.numFailedTests : 0;
  const testsTotal = report ? report.numTotalTests : 0;

  // Capture Git context.
  let gitContext;
  try {
    gitContext = captureGitContext();
  } catch (e) {
    gitContext = {
      repoRoot: null,
      headSha: null,
      branchName: null,
      isDetachedHead: false,
      parents: [],
      commitMessage: null,
      workingTreeDirty: false,
      workingTreeEntries: [],
      remoteUrl: null,
      gitAvailable: false,
      inGitRepo: false
    };
  }

  const runId = crypto.randomUUID();
  let testId = 0;
  let commitId = null;
  let repositoryId = null;

  try {
    repositoryId = store.ensureRepository({
      rootPath: gitContext.repoRoot || __dirname,
      remoteUrl: gitContext.remoteUrl
    });

    if (gitContext.headSha) {
      commitId = gitContext.headSha;
    }

    // test_id secuencial por rama + commit (compatibilidad).
    testId = store.getMaxTestId({
      branchName: gitContext.branchName,
      commitId
    }) + 1;

    if (commitId) {
      const parents = gitContext.parents || [];
      const stats = gitContext.headSha
        ? getCommitStats({
            parentSha: parents[0] || null,
            sha: gitContext.headSha
          })
        : { additions: 0, deletions: 0, total: 0 };

      store.upsertCommit({
        commitId: gitContext.headSha,
        repositoryId,
        author: null,
        message: gitContext.commitMessage || null,
        committedAt: null,
        additions: stats.additions,
        deletions: stats.deletions,
        coverage: null,
        conclusion: success ? 'success' : 'failure',
        parents
      });

      // Registrar rama solo si hay nombre (detached HEAD no tiene rama).
      if (gitContext.branchName) {
        store.upsertBranch({
          repositoryId,
          name: gitContext.branchName,
          headSha: gitContext.headSha,
          deletedAt: null
        });
      }
    }

    store.insertExecution({
      runId,
      testId,
      repositoryId,
      commitId,
      branchName: gitContext.branchName,
      workingTreeDirty: gitContext.workingTreeDirty,
      trigger: 'manual',
      startTime: report
        ? new Date(report.startTime).toISOString()
        : startTime,
      endTime: report
        ? new Date(report.endTime).toISOString()
        : endTime,
      durationMs,
      success,
      testsPassed,
      testsFailed,
      testsTotal,
      coverage: null,
      exitCode,
      failureMessage: jestError ? jestError.message : null
    });

    if (report && report.numFailedTests > 0 && report.testResults) {
      for (const suite of report.testResults) {
        for (const failure of suite.failureMessages || []) {
          store.insertRunFailure({
            runId,
            testPath: suite.testFilePath || '',
            title: failure,
            failure: failure
          });
        }
      }
    }

    if (jestError) {
      store.insertEventLog({
        level: 'error',
        component: 'jest-runner',
        message: jestError.message,
        runId
      });
    }
  } catch (persistError) {
    // Persistence failure must NOT be confused with test failure.
    try {
      store.insertEventLog({
        level: 'error',
        component: 'persistence',
        message: persistError.message,
        runId
      });
    } catch (e) {
      // If even event logging fails, tests are still reported by exit code.
    }
  }

  return {
    runId,
    testId,
    commitId,
    exitCode,
    success,
    testsPassed,
    testsFailed,
    testsTotal,
    durationMs,
    report,
    jestError
  };
}

// El flujo de ejecucion se dispara al importar solo cuando NO estamos en un
// entorno de pruebas (Jest establece NODE_ENV=test). Esto permite importar
// extractAndAddObject en pruebas sin ejecutar Jest ni salir del proceso.
if (process.env.NODE_ENV !== 'test') {
  const reportFile = path.join(process.cwd(), 'script', 'report.json');
  const store = new TddStore({
    dbPath: path.join(process.cwd(), DB_DIR, DB_FILE)
  });

  let result;
  try {
    result = extractAndAddObject(reportFile, store);
  } finally {
    store.close();
  }

  process.exit(result.exitCode === 0 ? 0 : 1);
}

export { extractAndAddObject, TddStore };
