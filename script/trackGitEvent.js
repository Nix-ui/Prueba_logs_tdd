import { execFileSync } from "node:child_process";
import path from "node:path";
import { TddStore } from "./tddStore.js";

const DB_DIR = ".tddlab";
const DB_FILE = "tddlab.db";

// Ejecuta git y devuelve la salida sin espacios finales.
// Devuelve null si el comando falla (por ejemplo, HEAD^2 no existe).
function git(...args) {
	try {
		return execFileSync("git", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

// Rama de la que venimos, leída del reflog de HEAD:
// "checkout: moving from main to feat/x"
function previousBranchFromReflog() {
	const entry = git("reflog", "-1", "--format=%gs", "HEAD");
	const match = entry && entry.match(/^checkout: moving from (.+) to (.+)$/);
	if (!match) return null;
	const name = match[1];
	// Si veníamos de un HEAD desacoplado, "name" es un sha, no una rama.
	return git("show-ref", "--verify", "--quiet", `refs/heads/${name}`) !== null
		? name
		: null;
}

// Una rama recién creada tiene un único registro en su reflog: "branch: Created from ..."
function isFreshlyCreated(branch) {
	const log = git("reflog", "show", "--format=%gs", `refs/heads/${branch}`);
	if (!log) return false;
	const lines = log.split("\n").filter(Boolean);
	return lines.length === 1 && lines[0].startsWith("branch: Created from");
}

// Nombre de la rama más cercana a un commit; se usa solo como respaldo
// cuando el commit de origen nunca se registró en la base.
function guessBranch(sha) {
	const name = git("name-rev", "--name-only", "--refs=refs/heads/*", sha);
	if (!name || name === "undefined") return null;
	return name.replace(/[~^].*$/, "");
}

// post-checkout: args = [prevSha, newSha, flag]  (flag 1 = cambio de rama)
function handleCheckout(store, [prevSha, newSha, flag]) {
	if (flag !== "1") return; // checkout de archivos, no de rama

	const branch = git("branch", "--show-current");
	if (!branch) return; // HEAD desacoplado

	if (store.getBranch(branch)) return; // ya conocida; el fork no se reescribe

	// Solo una rama creada ahora (git checkout -b / git switch -c) nace del
	// commit en el que estábamos. Una rama existente no tiene fork conocido.
	const isNew = prevSha === newSha && isFreshlyCreated(branch);

	if (isNew) {
		const parentBranch = previousBranchFromReflog();
		if (parentBranch) {
			// El commit de origen se registra con su rama para poder deducir la rama padre.
			store.upsertBranch({ name: parentBranch });
			store.upsertCommit({ sha: prevSha, branch: parentBranch });
		}
	}

	store.upsertBranch({ name: branch, forkCommitSha: isNew ? prevSha : null });
}

// post-merge: args = [squashFlag]  (1 = merge --squash)
function handleMerge(store, [squashFlag]) {
	if (squashFlag === "1") return; // un squash no crea relación de merge

	const target = git("branch", "--show-current");
	const headSha = git("rev-parse", "HEAD");
	if (!target || !headSha) return;

	const firstParent = git("rev-parse", "--verify", "-q", "HEAD^1");
	const secondParent = git("rev-parse", "--verify", "-q", "HEAD^2");
	const isFastForward = !secondParent;
	const sourceSha = secondParent || headSha;

	store.upsertBranch({ name: target });

	// Un merge normal crea un commit nuevo; hay que registrarlo.
	// (git merge no dispara post-commit.)
	if (!isFastForward) {
		store.upsertCommit({
			sha: headSha,
			parentSha: firstParent,
			branch: target,
			message: git("log", "-1", "--format=%s"),
		});
	}

	let sourceBranch = store.getCommitBranch(sourceSha);
	if (!sourceBranch && !isFastForward) {
		sourceBranch = guessBranch(sourceSha);
	}

	// Sin rama de origen conocida, o igual al destino (típico de `git pull`
	// con fast-forward desde el remoto), no hay un merge entre ramas que registrar.
	if (!sourceBranch || sourceBranch === target) return;

	store.insertMerge({
		sourceBranch,
		targetBranch: target,
		sourceCommitSha: sourceSha,
		mergeCommitSha: headSha,
		isFastForward,
	});
}

function main() {
	const [event, ...args] = process.argv.slice(2);
	const root = git("rev-parse", "--show-toplevel") || process.cwd();
	const store = new TddStore({ dbPath: path.join(root, DB_DIR, DB_FILE) });

	try {
		store.initialize();
		if (event === "checkout") handleCheckout(store, args);
		else if (event === "merge") handleMerge(store, args);
	} catch (error) {
		// Nunca debe romper el flujo de git.
		console.error(
			`[TDD Logging] No se pudo registrar "${event}": ${error.message}`,
		);
	} finally {
		store.close();
	}
}

if (process.argv[1] && path.basename(process.argv[1]) === "trackGitEvent.js") {
	main();
}

export { handleCheckout, handleMerge };
