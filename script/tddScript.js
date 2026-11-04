import fs from "fs";
import path from "path";
import { spawn } from "cross-spawn";
import { TddStore, nowIso } from "./tddStore.js";
import { captureGitContext } from "./gitContext.js";

const COMMAND = "jest";
const args = ["--json", "--outputFile=./script/report.json"];

const DB_DIR = ".tddlab";
const DB_FILE = "tddlab.db";

function logError(message, error) {
	console.error(`[TDD Logging] ${message}`);
	if (error) {
		console.error(`  ${error.message}`);
	}
}

function runCommand(command, commandArgs) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, {
			stdio: "inherit",
		});

		child.on("close", (code) => {
			resolve({ code });
		});

		child.on("error", (error) => {
			reject(error);
		});
	});
}

const readJSONFile = (filePath) => {
	const rawData = fs.readFileSync(filePath, "utf8");
	return JSON.parse(rawData);
};

function emptyGitContext() {
	return {
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
		inGitRepo: false,
	};
}

async function extractAndAddObject(reportFile, store) {
	let childResult;
	let jestError = null;

	try {
		childResult = await runCommand(COMMAND, args);
	} catch (error) {
		jestError = error;
		childResult = { code: null };
	}

	const executedAt = nowIso();

	const exitCode =
		childResult && typeof childResult.code === "number" ? childResult.code : 1;

	const success = exitCode === 0;

	// Read the Jest report if it exists.
	// This preserves evidence even when tests fail.
	let report = null;

	try {
		if (fs.existsSync(reportFile)) {
			report = readJSONFile(reportFile);
		}
	} catch (readError) {
		jestError = jestError || readError;
	}

	const testsPassed = report ? report.numPassedTests : 0;
	const testsFailed = report ? report.numFailedTests : 0;
	const testsTotal = report ? report.numTotalTests : 0;

	// Capture Git context.
	let gitContext;

	try {
		gitContext = captureGitContext();
	} catch (error) {
		gitContext = emptyGitContext();
	}

	const commitSha = gitContext.headSha || null;
	let executionId = null;

	try {
		if (commitSha) {
			// La rama se registra primero: tdd_commit.branch la referencia.
			// Detached HEAD no tiene nombre de rama; el commit se guarda sin rama.
			if (gitContext.branchName) {
				store.upsertBranch({ name: gitContext.branchName });
			}

			const parents = gitContext.parents || [];

			store.upsertCommit({
				sha: commitSha,
				parentSha: parents[0] || null,
				branch: gitContext.branchName || null,
				author: null,
				message: gitContext.commitMessage || null,
				committedAt: null,
			});
		}

		// Sin reporte de Jest no hay conteos reales; guardar 0/0/0 contaminaría
		// las métricas, así que no se registra la ejecución.
		if (report) {
			executionId = store.insertExecution({
				commitSha,
				testsTotal,
				testsPassed,
				testsFailed,
				executedAt: Number.isFinite(report.endTime)
					? new Date(report.endTime).toISOString()
					: executedAt,
			});

			const databasePath =
				store.dbPath === ":memory:" ? store.dbPath : path.resolve(store.dbPath);
			console.log(
				`[TDD Logging] Execution saved to SQLite: id=${executionId}, branch=${gitContext.branchName || "(no branch)"}, commit=${commitSha || "(manual)"}, database=${databasePath}`,
			);
		} else {
			logError(
				"No se encontró el reporte de Jest; la ejecución NO se guardó.",
				jestError,
			);
		}
	} catch (persistError) {
		// Persistence failures must not be confused with test failures.
		// Report to console so the user sees what happened, even if SQLite is broken.
		logError(
			"Persistence failed — execution was NOT saved to SQLite:",
			persistError,
		);
	}

	return {
		executionId,
		commitSha,
		exitCode,
		success,
		testsPassed,
		testsFailed,
		testsTotal,
		report,
		jestError,
	};
}

async function main() {
	const reportFile = path.join(process.cwd(), "script", "report.json");

	// Asegurar que el directorio .tddlab existe antes de abrir la base de datos
	try {
		fs.mkdirSync(path.join(process.cwd(), DB_DIR), { recursive: true });
	} catch (mkdirError) {
		logError("No se pudo crear el directorio .tddlab:", mkdirError);
		process.exitCode = 1;
		return;
	}

	const store = new TddStore({
		dbPath: path.join(process.cwd(), DB_DIR, DB_FILE),
	});

	try {
		store.initialize();
	} catch (initError) {
		logError("No se pudo inicializar la base de datos SQLite:", initError);
		console.error(
			"  Verifique que tiene permisos de escritura en:",
			process.cwd(),
		);
		process.exitCode = 1;
		return;
	}

	try {
		const result = await extractAndAddObject(reportFile, store);

		console.log("");
		console.log("TDD execution result:");
		console.log(`Passed: ${result.testsPassed}`);
		console.log(`Failed: ${result.testsFailed}`);
		console.log(`Total:  ${result.testsTotal}`);

		process.exitCode = result.exitCode === 0 ? 0 : 1;
	} catch (error) {
		console.error("Error while executing the TDD test runner:");
		console.error(error);

		process.exitCode = 1;
	} finally {
		store.close();
	}
}

// Ejecutar solo cuando este archivo es el punto de entrada directo (npm test),
// no cuando se importa como módulo desde pruebas.
if (process.argv[1] && path.basename(process.argv[1]) === "tddScript.js") {
	main().catch((error) => {
		console.error("Unhandled TDD runner error:");
		console.error(error);
		process.exitCode = 1;
	});
}

export { extractAndAddObject, TddStore };
