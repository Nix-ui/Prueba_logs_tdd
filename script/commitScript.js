import { TddStore } from './tddStore.js';
import {
  captureGitContext,
  getCommitStats,
  getCommitAuthor,
  getCommitDate
} from './gitContext.js';

import path from 'path';

const DB_DIR = '.tddlab';
const DB_FILE = 'tddlab.db';

function main() {
  const store = new TddStore({
    dbPath: path.join(process.cwd(), DB_DIR, DB_FILE)
  });

  try {
    store.initialize();

    const ctx = captureGitContext();

    if (!ctx.inGitRepo || !ctx.headSha) {
      // No hay repositorio Git ni commit: no hay nada que registrar.
      process.exit(0);
    }

    const repositoryId = store.ensureRepository({
      rootPath: ctx.repoRoot || process.cwd(),
      remoteUrl: ctx.remoteUrl
    });

    const parents = ctx.parents || [];
    const stats = getCommitStats({
      parentSha: parents[0] || null,
      sha: ctx.headSha
    });

    const author = getCommitAuthor({ sha: ctx.headSha }) || null;
    const committedAt = getCommitDate({ sha: ctx.headSha }) || null;

    // SHA real como identificador de commit. Nunca se usa el literal 'HEAD'.
    store.upsertCommit({
      commitId: ctx.headSha,
      repositoryId,
      author,
      message: ctx.commitMessage || null,
      committedAt,
      additions: stats.additions,
      deletions: stats.deletions,
      coverage: null,
      conclusion: 'success',
      parents
    });

    // Registrar/actualizar rama solo si hay nombre (detached HEAD no tiene rama).
    if (ctx.branchName) {
      store.upsertBranch({
        repositoryId,
        name: ctx.branchName,
        headSha: ctx.headSha,
        deletedAt: null
      });
    }

    store.close();
    process.exit(0);
  } catch (error) {
    console.error('Error en commitScript.js:', error.message);
    try {
      store.close();
    } catch (e) {
      // Ignorar errores al cerrar
    }
    process.exit(1);
  }
}

// No auto-ejecutar al importarse en entorno de pruebas.
if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
  try {
    main();
  } catch (e) {
    // Si falla al importar en tests, no romper el suite
  }
}

export { TddStore, main };
