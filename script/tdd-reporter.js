import fs from "fs";
import path from "path";

// ==========================================
// 1. CONFIGURACIÓN Y CONSTANTES
// ==========================================
const EVENTS_DIR = path.join(process.cwd(), ".tdd-events");

// ==========================================
// 2. UTILIDADES DE SISTEMA DE ARCHIVOS
// ==========================================
function ensureDirectoryExists(dirPath) {
	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true });
	}
}

function writeJsonFile(filePath, data) {
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function buildEventFilePath(timestamp) {
	return path.join(EVENTS_DIR, `test-${timestamp}.json`);
}

// ==========================================
// 3. TRANSFORMADOR DE DATOS (Dominio)
// ==========================================
function createTestRunRecord(results) {
	const numPassedTests = results.numPassedTests || 0;
	const failedTests = results.numFailedTests || 0;
	const numTotalTests = results.numTotalTests || 0;

	return {
		numPassedTests,
		failedTests,
		numTotalTests,
		timestamp: Date.now(),
		success: failedTests === 0 && numTotalTests > 0,
	};
}

// ==========================================
// 4. CLASE PRINCIPAL (Interfaz Reporter de Jest)
// ==========================================
export default class TddReporter {
	onRunComplete(_, results) {
		try {
			ensureDirectoryExists(EVENTS_DIR);

			const record = createTestRunRecord(results);
			writeJsonFile(buildEventFilePath(record.timestamp), record);
		} catch (error) {
			console.error(
				"Error al registrar evento de ejecución en TddReporter:",
				error,
			);
		}
	}
}
