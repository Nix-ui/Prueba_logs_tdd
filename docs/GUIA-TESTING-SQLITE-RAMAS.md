# Guia de Testing - SQLite con Soporte de Ramas Git

**Sistema:** TDDLabBaseProject  
**Componente:** Sistema de logging y registro de ejecuciones TDD con SQLite  
**Versión:** 1.0.0  
**Objetivo:** Permitir que cualquier integrante del equipo valide la implementación de persistencia SQLite con soporte de ramas Git.

---

## 1. Portada y objetivo

Esta guía documenta cómo ejecutar y validar el sistema de logging y registro de ejecuciones de TDDLab basado en SQLite con soporte completo de ramas Git. Incluye pruebas unitarias, de integración, end-to-end (E2E) y smoke tests, además de la configuración de cobertura de código.

El objetivo es verificar que:

- Cada ejecución de pruebas (`npm test`) se registra en SQLite con un `run_id` único.
- Los commits se identifican por su SHA real de Git (nunca por el literal `HEAD`).
- Las ejecuciones se asocian a la rama observada y al commit correspondiente.
- Los merge commits representan correctamente múltiples padres.
- El historial se preserva al cambiar de rama, al borrar una rama y en detached HEAD.
- No se pierde información ante fallos de infraestructura.

---

## 2. Requisitos previos

Antes de ejecutar las pruebas, asegúrate de tener instalado:

| Herramienta | Versión mínima | Propósito |
|-------------|---------------|-----------|
| Node.js | 20.x | Entorno de ejecución |
| npm | 10.x | Gestor de paquetes |
| Git | 2.x | Control de versiones |

El proyecto utiliza **ES Modules** (`"type": "module"` en `package.json`).

---

## 3. Instalación

Clona el repositorio e instala las dependencias:

```bash
git clone <tu-fork>
cd TDDLabBaseProject
npm ci
```

Durante la instalación se:

1. Descarga e instala `better-sqlite3` (dependencia nativa para SQLite).
2. Instala las dependencias de desarrollo (Jest, ESLint, Husky, etc.).
3. Ejecuta `postinstall` que inicializa Git y configura Husky.

Verifica la instalación:

```bash
node --version      # Debe mostrar v20.x
npm --version       # Debe mostrar 10.x+
```

---

## 4. Estructura de almacenamiento

El sistema utiliza **SQLite** como almacén local-first. La base de datos se crea automáticamente en:

```text
.tddlab/
  tddlab.db         # Base de datos SQLite principal
  tddlab.db-wal     # Archivo de registro anticipado (WAL)
  tddlab.db-shm     # Memoria compartida (WAL)
```

El directorio `.tddlab/` está ignorado por Git (`.gitignore`), por lo que cada clon o worktree tiene su propia base de datos y no hay conflictos entre ramas.

### Tablas principales

| Tabla | Propósito |
|-------|-----------|
| `tdd_repository` | Metadatos del repositorio (ruta raíz, URL remota) |
| `tdd_branch` | Referencias de ramas (nombre mutable, SHA actual, estado de eliminación) |
| `tdd_commit` | Información de commits (SHA real, autor, mensaje, fecha, diff, cobertura) |
| `tdd_commit_parent` | Relaciones de parentesco entre commits (soporta merges con múltiples padres) |
| `tdd_execution` | Ejecuciones de pruebas (`run_id` UUID, `test_id`, commit, rama, resultado) |
| `tdd_run_failures` | Detalles de pruebas fallidas asociadas a una ejecución |
| `tdd_event_log` | Eventos operacionales y errores (nivel, componente, mensaje) |

---

## 5. Comandos de testing

Todos los comandos están definidos en `package.json`. Ejecútalos desde la raíz del proyecto.

| Comando | Objetivo | Qué ejecuta | Código de salida |
|---------|----------|-------------|------------------|
| `npm test` | Ejecución de pruebas + registro | `node ./script/tddScript.js` (corre Jest y registra en SQLite) | 0 si las pruebas pasan, 1 si fallan |
| `npm run test:unit` | Pruebas unitarias | Jest sobre `database.test.js`, `persistence.test.js`, `integration-sqlite.test.js` | 0 si todas pasan |
| `npm run test:integration` | Pruebas de integración | Jest sobre `integration-sqlite.test.js`, `branch-support.test.js` | 0 si todas pasan |
| `npm run test:e2e` | Pruebas end-to-end | Jest sobre `branch-support.test.js` (flujo real Git + SQLite) | 0 si todas pasan |
| `npm run test:smoke` | Smoke tests | Jest sobre `smoke.test.js` (verificación rápida de funcionalidad esencial) | 0 si todas pasan |
| `npm run test:coverage` | Pruebas con cobertura | Jest con informe de cobertura y umbrales | 0 si pasa y cobertura ≥85% |
| `npm run lint` | Análisis estático | ESLint sobre todo el proyecto | 0 si no hay errores |
| `npm run build` | Build de Parcel | `parcel build index.html` | 0 si compila |

**No ejecutes comandos que no estén listados aquí.**

### Interpretación de errores

| Síntoma | Causa probable | Solución |
|---------|---------------|----------|
| `Cannot find module 'better-sqlite3'` | Dependencia no instalada | Ejecuta `npm ci` |
| `SQLITE_CANTOPEN` | No se puede crear `.tddlab/` | Verifica permisos de escritura en la carpeta del proyecto |
| `GitContextError: Not a git repository` | No estás dentro de un repo Git | Ejecuta los comandos desde la raíz del repositorio |
| `Jest: coverage threshold not met` | Cobertura por debajo del 85% | Añade más pruebas o revisa el código no cubierto |
| `git checkout main: pathspec did not match` | Rama por defecto es `master` no `main` | Usa `git branch --show-current` para verificar |

---

## 6. Pruebas unitarias

Validan los módulos de persistencia y el contexto Git de forma aislada.

**Archivos:**
- `script/__tests__/database.test.js` — Inicialización, esquema, migraciones, CRUD, restricciones de integridad, transacciones, consultas por rama/commit/run_id.
- `script/__tests__/persistence.test.js` — `getLastTestId` sobre SQLite, UUID únicos, claves foráneas, FK violations, consultas por rama/commit.

**Ejecutar:**
```bash
npm run test:unit
```

**Qué validan:**
- Inicialización de SQLite y creación del esquema (7 tablas).
- Foreign keys habilitadas (`PRAGMA foreign_keys = ON`).
- Inserción y lectura de ejecuciones, commits, ramas y fallos.
- `test_id` secuencial por rama (sin colisiones).
- `run_id` UUID único.
- Rechazo de `commit_id` inexistentes (restricción FK).
- Migraciones versionadas.

---

## 7. Pruebas de integración

Validan la interacción real entre `tddScript.js`, `tddStore.js`, `gitContext.js`, `commitScript.js` y `commit-tracker.js` usando SQLite real en archivos temporales.

**Archivo:**
- `script/__tests__/integration-sqlite.test.js`

**Ejecutar:**
```bash
npm run test:integration
```

**Qué validan:**
- Persistencia en archivo `.tddlab/tddlab.db` (sobrevive al cierre de la conexión).
- Registro integrado: repositorio → rama → commit → ejecución.
- Asociación ejecución ↔ commit ↔ rama.
- Detección de rama y SHA de commit desde Git real.
- Prevención de duplicados (`run_id` PK).

---

## 8. Pruebas E2E

Recorren el flujo completo con Git y SQLite reales en un repositorio temporal aislado (no modifica el historial del fork).

**Archivo:**
- `script/__tests__/branch-support.test.js`

**Escenarios cubiertos:**

| Escenario | Qué valida |
|-----------|------------|
| Dos ramas independientes | Ejecuciones diferenciadas por rama, `run_id` únicos |
| Merge commit | Commit con múltiples padres, ejecución post-merge con `run_id` nuevo |
| Cambio de rama | Ejecuciones preservadas al cambiar de rama, no hay contaminación |
| Eliminación de rama | Ejecuciones históricas preservadas tras borrar rama |
| Detached HEAD | `branch_name` NULL, SHA registrado correctamente |
| Ejecución fallida | Diferenciación entre fallo de prueba y fallo de infraestructura |

**Ejecutar:**
```bash
npm run test:e2e
```

---

## 9. Smoke tests

Pruebas rápidas que verifican que la funcionalidad esencial está operativa. Usan una base temporal y no modifican el historial del repositorio.

**Archivo:**
- `script/__tests__/smoke.test.js`

**Comprobaciones (10):**
1. Node.js disponible.
2. Dependencia SQLite (`better-sqlite3`) importable.
3. SQLite inicializable.
4. Base de datos abrible.
5. Esquema existente (tablas `tdd_execution`, `tdd_commit`, etc.).
6. Inserción y consulta de registro temporal.
7. Foreign keys habilitadas.
8. Git identificable dentro de un repositorio.
9. Módulo de persistencia responde correctamente.
10. Conexiones cerradas sin errores.

**Ejecutar:**
```bash
npm run test:smoke
```

**Resultado esperado:** Todas las 10 comprobaciones pasan con código de salida 0.

---

## 10. Cobertura

El proyecto requiere una cobertura mínima del **85 %** en las cuatro métricas de Jest.

| Métrica | Umbral | Cómo medir |
|---------|--------|------------|
| Statements | 85 % | `npm run test:coverage` |
| Branches | 85 % | `npm run test:coverage` |
| Functions | 85 % | `npm run test:coverage` |
| Lines | 85 % | `npm run test:coverage` |

**Informes generados:**
- `coverage/lcov.info` — Formato LCOV para integración con herramientas de CI.
- `coverage/lcov-report/index.html` — Informe HTML navegable.
- `coverage/coverage-final.json` — Resumen en JSON.

**Umbral configurado en `package.json`:**
```json
"coverageThreshold": {
  "global": {
    "statements": 85,
    "branches": 85,
    "functions": 85,
    "lines": 85
  }
}
```

**Si la cobertura está por debajo del umbral:**
1. Identifica los archivos y ramas no cubiertos en el informe HTML.
2. Añade pruebas que cubran las rutas faltantes.
3. Vuelve a ejecutar `npm run test:coverage`.

---

## 11. Pruebas manuales

La siguiente matriz permite validación manual sin modificar el historial del repositorio.

| ID | Escenario | Pasos | Resultado esperado | Estado |
|----|-----------|-------|-------------------|--------|
| M1 | `npm test` registra ejecución | Ejecutar `npm test`, consultar SQLite | Nueva fila en `tdd_execution` | |
| M2 | `run_id` único | Ejecutar `npm test` dos veces, comparar `run_id` | UUIDs distintos | |
| M3 | Cambio de rama | Crear rama, ejecutar `npm test`, cambiar a otra rama, ejecutar nuevamente | Ambas ejecuciones existen con sus respectivas `branch_name` | |
| M4 | Commit con SHA real | Hacer `git commit`, ejecutar `npm test`, verificar `commit_id` | `commit_id` es el SHA real, no `'HEAD'` | |
| M5 | Eliminación de rama | Crear rama, ejecutar pruebas, eliminar rama, consultar SQLite | Ejecuciones de la rama borrada aún existen | |
| M6 | SQLite sin red | Desconectar red, ejecutar `npm test` | Ejecución registrada localmente sin error | |
| M7 | Informe de cobertura | Ejecutar `npm run test:coverage` | Informe HTML generado en `coverage/` | |

---

## 12. Verificación de SQLite

Consultas SQL de diagnóstico para inspeccionar la base de datos:

```bash
# Abrir la base de datos
sqlite3 .tddlab/tddlab.db

# Listar tablas
.tables

# Consultar ejecuciones
SELECT run_id, branch_name, success, tests_passed, tests_failed, tests_total, created_at FROM tdd_execution ORDER BY created_at DESC;

# Consultar commits
SELECT commit_id, message, additions, deletions, conclusion FROM tdd_commit ORDER BY committed_at DESC;

# Consultar ramas
SELECT name, head_sha, deleted_at FROM tdd_branch;

# Consultar relaciones de padres (merges)
SELECT commit_id, parent_id, ord FROM tdd_commit_parent ORDER BY commit_id, ord;

# Contar ejecuciones por rama
SELECT branch_name, COUNT(*) as runs FROM tdd_execution GROUP BY branch_name;

# Identificar registros sin SHA (ejecuciones manuales)
SELECT run_id, branch_name FROM tdd_execution WHERE commit_id IS NULL;

# Detectar identificadores duplicados
SELECT run_id, COUNT(*) as c FROM tdd_execution GROUP BY run_id HAVING c > 1;

# Verificar integridad referencial
PRAGMA foreign_key_check;
```

Sal de `sqlite3` con `.quit` o `Ctrl+D`.

---

## 13. Troubleshooting

| Problema | Causa posible | Solución |
|----------|---------------|----------|
| `Error: Cannot find module 'better-sqlite3'` | Dependencia no instalada | `npm ci` |
| `SQLITE_CANTOPEN: unable to open database file` | Permisos de carpeta | Verifica escritura en la carpeta del proyecto |
| `GitContextError: Not a git repository` | No estás dentro de un repo Git | Ejecuta desde la raíz del repositorio |
| `Jest: coverage threshold not met` | Cobertura baja | Añade pruebas para las ramas no cubiertas |
| `git checkout main: pathspec did not match` | Rama por defecto es `master` | Usa `git branch --show-current` |
| `Error: emit() after close` | Conexión SQLite cerrada prematuramente | Reinicia el proceso de prueba |
| Cobertura de ramas baja | Condicionales no probados | Añade pruebas que cubran ambos caminos de los `if` |

---

## 14. Criterios finales de aceptación

Antes de considerar la implementación lista, verifica:

- [ ] `npm ci` se completa sin errores.
- [ ] `npm test` registra una ejecución en `.tddlab/tddlab.db`.
- [ ] `npm run test:smoke` pasa las 10 comprobaciones.
- [ ] `npm run test:unit` pasa todas las pruebas unitarias.
- [ ] `npm run test:integration` pasa todas las pruebas de integración.
- [ ] `npm run test:e2e` pasa todas las pruebas E2E (ramas, merge, detached HEAD).
- [ ] `npm run test:coverage` alcanza ≥85 % en las cuatro métricas.
- [ ] `npm run lint` no reporta errores.
- [ ] `npm run build` compila sin errores.
- [ ] `tdd_execution` contiene filas con `run_id` único.
- [ ] `tdd_commit` contiene SHA reales (no `'HEAD'`).
- [ ] Las ejecuciones se conservan al cambiar de rama.
- [ ] No hay archivos `.db`, `.db-wal`, `.db-shm` versionados en Git.

Cuando todos los criterios se cumplen, la implementación está correctamente validada.

---

## 15. Conclusión

La implementación de SQLite con soporte de ramas Git permite registrar de forma confiable cada ejecución de pruebas y commit en una base de datos local-first. El sistema es resistente a fallos de infraestructura, preserva el historial al cambiar de rama y soporta merges con múltiples padres. Utiliza esta guía para validar cualquier cambio futuro en el sistema de logging.
