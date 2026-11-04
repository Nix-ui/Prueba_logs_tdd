import { execFileSync } from 'child_process';

export class GitContextError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GitContextError';
    this.code = code;
  }
}

function runGit(
  args,
  {
    cwd = process.cwd(),
    throwOnError = false
  } = {}
) {
  try {
    const result = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });

    return {
      ok: true,
      stdout: result.toString().trim(),
      stderr: '',
      code: 0
    };
  } catch (err) {
    const stdout = err.stdout
      ? err.stdout.toString().trim()
      : '';

    const stderr = err.stderr
      ? err.stderr.toString().trim()
      : '';

    const code =
      err.status !== null && err.status !== undefined
        ? err.status
        : 1;

    if (throwOnError) {
      throw new GitContextError(
        stderr || stdout || err.message,
        code
      );
    }

    return {
      ok: false,
      stdout,
      stderr,
      code
    };
  }
}

export function isGitAvailable() {
  const result = runGit(
    ['--version'],
    {
      throwOnError: false
    }
  );

  return result.ok;
}

export function isInGitRepo({
  cwd = process.cwd()
} = {}) {
  const result = runGit(
    ['rev-parse', '--is-inside-work-tree'],
    {
      cwd,
      throwOnError: false
    }
  );

  return result.ok;
}

export function getRepoRoot({
  cwd = process.cwd()
} = {}) {
  if (!isInGitRepo({ cwd })) {
    throw new GitContextError(
      'No se encuentra dentro de un repositorio Git',
      'NOT_GIT_REPO'
    );
  }

  const result = runGit(
    ['rev-parse', '--show-toplevel'],
    {
      cwd,
      throwOnError: true
    }
  );

  return result.stdout;
}

export function getHeadSha({
  cwd = process.cwd()
} = {}) {
  const result = runGit(
    ['rev-parse', 'HEAD'],
    {
      cwd,
      throwOnError: true
    }
  );

  return result.stdout || null;
}

export function getCurrentBranch({
  cwd = process.cwd()
} = {}) {
  const result = runGit(
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    {
      cwd,
      throwOnError: false
    }
  );

  if (!result.ok || !result.stdout) {
    return null;
  }

  return result.stdout;
}

export function isDetachedHead({
  cwd = process.cwd()
} = {}) {
  return !getCurrentBranch({ cwd });
}

export function getCommitMessage({
  sha = 'HEAD',
  cwd = process.cwd()
} = {}) {
  const result = runGit(
    ['log', '-1', '--pretty=%B', sha],
    {
      cwd,
      throwOnError: true
    }
  );

  return result.stdout;
}

export function getCommitAuthor({
  sha = 'HEAD',
  cwd = process.cwd()
} = {}) {
  const result = runGit(
    ['log', '-1', '--pretty=format:%an', sha],
    {
      cwd,
      throwOnError: true
    }
  );

  return result.stdout || null;
}

export function getCommitDate({
  sha = 'HEAD',
  cwd = process.cwd()
} = {}) {
  const result = runGit(
    ['log', '-1', '--format=%cd', sha],
    {
      cwd,
      throwOnError: true
    }
  );

  return result.stdout || null;
}

export function getCommitParents({
  sha = 'HEAD',
  cwd = process.cwd()
} = {}) {
  const result = runGit(
    ['rev-list', '--parents', '-n', '1', sha],
    {
      cwd,
      throwOnError: true
    }
  );

  const line = (result.stdout || '').trim();

  if (!line) {
    return [];
  }

  const parts = line.split(/\s+/);

  // El primer token es el propio commit; el resto son sus padres.
  return parts.slice(1);
}

export function getWorkingTreeStatus({
  cwd = process.cwd()
} = {}) {
  const result = runGit(
    ['status', '--porcelain=v1'],
    {
      cwd,
      throwOnError: false
    }
  );

  if (!result.ok) {
    return {
      dirty: false,
      entries: []
    };
  }

  const entries = result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => ({
      raw: line
    }));

  return {
    dirty: entries.length > 0,
    entries
  };
}

export function getCommitStats({
  parentSha,
  sha,
  cwd = process.cwd()
} = {}) {
  const diffArguments = parentSha
    ? ['diff', '--stat', parentSha, sha]
    : ['show', '--stat', '--format=', sha];

  const result = runGit(
    diffArguments,
    {
      cwd,
      throwOnError: false
    }
  );

  if (!result.ok || !result.stdout) {
    return {
      additions: 0,
      deletions: 0,
      total: 0
    };
  }

  const text = result.stdout.toString();
  const additionsMatch = text.match(/(\d+) insertion/);
  const deletionsMatch = text.match(/(\d+) deletion/);

  const additions = additionsMatch
    ? Number.parseInt(additionsMatch[1], 10)
    : 0;

  const deletions = deletionsMatch
    ? Number.parseInt(deletionsMatch[1], 10)
    : 0;

  return {
    additions,
    deletions,
    total: additions + deletions
  };
}

export function getFirstCommitSha({
  cwd = process.cwd()
} = {}) {
  const result = runGit(
    ['rev-list', '--max-parents=0', 'HEAD'],
    {
      cwd,
      throwOnError: false
    }
  );

  if (!result.ok || !result.stdout) {
    return null;
  }

  return result.stdout
    .trim()
    .split('\n')[0] || null;
}

export function getRemoteUrl({
  cwd = process.cwd()
} = {}) {
  const result = runGit(
    ['config', '--get', 'remote.origin.url'],
    {
      cwd,
      throwOnError: false
    }
  );

  if (!result.ok) {
    return null;
  }

  let url = result.stdout.trim();

  if (url.startsWith('git@')) {
    url = url.replace(
      /^git@([^:]+):(.+)$/,
      'https://$1/$2'
    );
  }

  return url.replace(/\.git$/, '') || null;
}

export function captureGitContext({
  cwd = process.cwd()
} = {}) {
  let repoRoot = null;
  let headSha = null;
  let branchName = null;
  let isDetached = false;
  let parents = [];
  let commitMessage = null;
  let workingTree = {
    dirty: false,
    entries: []
  };
  let remoteUrl = null;

  try {
    repoRoot = getRepoRoot({ cwd });
  } catch {
    repoRoot = null;
  }

  if (repoRoot) {
    try {
      headSha = getHeadSha({ cwd });
    } catch {
      headSha = null;
    }

    branchName = getCurrentBranch({ cwd });
    isDetached = isDetachedHead({ cwd });

    try {
      parents = getCommitParents({
        sha: headSha,
        cwd
      });
    } catch {
      parents = [];
    }

    try {
      commitMessage = getCommitMessage({
        sha: headSha,
        cwd
      });
    } catch {
      commitMessage = null;
    }

    workingTree = getWorkingTreeStatus({ cwd });

    try {
      remoteUrl = getRemoteUrl({ cwd });
    } catch {
      remoteUrl = null;
    }
  }

  return {
    repoRoot,
    headSha,
    branchName,
    isDetachedHead: isDetached,
    parents,
    commitMessage,
    workingTreeDirty: workingTree.dirty,
    workingTreeEntries: workingTree.entries,
    remoteUrl,
    gitAvailable: isGitAvailable(),
    inGitRepo: Boolean(repoRoot)
  };
}

export default {
  GitContextError,
  isGitAvailable,
  isInGitRepo,
  getRepoRoot,
  getHeadSha,
  getCurrentBranch,
  isDetachedHead,
  getCommitMessage,
  getCommitAuthor,
  getCommitDate,
  getCommitParents,
  getWorkingTreeStatus,
  getCommitStats,
  getFirstCommitSha,
  getRemoteUrl,
  captureGitContext
};