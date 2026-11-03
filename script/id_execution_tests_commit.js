import path from 'path';
import { TddStore } from './tddStore.js';

const DEFAULT_DB_DIR = '.tddlab';
const DEFAULT_DB_FILE = 'tddlab.db';

function resolveStore() {
  const storePath = path.join(process.cwd(), DEFAULT_DB_DIR, DEFAULT_DB_FILE);
  return new TddStore({ dbPath: storePath });
}

/**
 * Obtiene el siguiente testId secuencial consultando SQLite.
 *
 * Mantiene compatibilidad con consumidores anteriores que esperaban
 * un entero basado en el historial JSON. Ahora la fuente de verdad es
 * tdd_execution en SQLite, calculada por rama y (opcionalmente) commit.
 *
 * @param {import('./tddStore.js').TddStore | null} store - Instancia de TddStore.
 *   Si se omite, se crea una instancia temporal apuntando a .tddlab/tddlab.db.
 * @param {string|null} branchName - Rama observada (filtro opcional).
 * @param {string|null} commitId - SHA del commit (filtro opcional).
 * @returns {number} Siguiente testId (maximo existente + 1, o 0 si no hay ninguno).
 */
export function getLastTestId(store = null, branchName = null, commitId = null) {
  const ownStore = !store;
  if (ownStore) {
    store = resolveStore();
  }
  store.initialize();
  try {
    return store.getMaxTestId({ branchName, commitId }) + 1;
  } finally {
    if (ownStore) {
      store.close();
    }
  }
}

export { TddStore };
export default { getLastTestId };
