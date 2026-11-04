import { TddStore } from "./tddStore.js";
import {
	captureGitContext,
	getCommitAuthor,
	getCommitDate,
} from "./gitContext.js";
import { handleMerge } from "./trackGitEvent.js";

import path from "path";

const DB_DIR = ".tddlab";
const DB_FILE = "tddlab.db";

function main() {
	const store = new TddStore({
		dbPath: path.join(process.cwd(), DB_DIR, DB_FILE),
	});

	try {
		store.initialize();

		const ctx = captureGitContext();

		if (!ctx.inGitRepo || !ctx.headSha) {
			// No hay repositorio Git ni commit: no hay nada que registrar.
			store.close();
			process.exit(0);
		}

		const parents = ctx.parents || [];

		// La rama se registra primero: tdd_commit.branch la referencia.
		// Detached HEAD no tiene nombre de rama; el commit se guarda sin rama.
		if (ctx.branchName) {
			store.upsertBranch({ name: ctx.branchName });
		}

		// SHA real como identificador de commit. Nunca se usa el literal 'HEAD'.
		store.upsertCommit({
			sha: ctx.headSha,
			parentSha: parents[0] || null,
			branch: ctx.branchName || null,
			author: getCommitAuthor({ sha: ctx.headSha }) || null,
			message: ctx.commitMessage || null,
			committedAt: getCommitDate({ sha: ctx.headSha }) || null,
		});

		// Un commit con dos padres es un merge concluido a mano tras resolver
		// conflictos: en ese caso git NO dispara post-merge, así que se registra aquí.
		// insertMerge es idempotente, no duplica filas.
		if (parents.length > 1) {
			handleMerge(store, []);
		}

		store.close();
		process.exit(0);
	} catch (error) {
		console.error("Error en commitScript.js:", error.message);
		try {
			store.close();
		} catch (e) {
			// Ignorar errores al cerrar
		}
		process.exit(1);
	}
}

// No auto-ejecutar al importarse en entorno de pruebas.
if (process.env.NODE_ENV !== "test" && !process.env.JEST_WORKER_ID) {
	try {
		main();
	} catch (e) {
		// Si falla al importar en tests, no romper el suite
	}
}

export { TddStore, main };
