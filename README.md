#### Proyecto base para proyectos tddlab:

#### Creado a partir de proyecto usado en IngSoftware: parcel-jest-base

https://github.com/israelantezana/parcel-jest-base

#### Comandos creados en package json:

#### Para instalar las dependencias:

npm install

#### Comandos de uso:

Ejecutar web-sever local parcel:
npm start

Ejecutar pruebas de unidad de forma continua --watch:
npm test

Ejecutar pruebas de unidad solo una vez:
npm run test-once

## Sistema de logging y registro de ejecuciones (SQLite)

Este proyecto registra cada ejecucion de pruebas y sus metadatos de commit en una
base de datos SQLite local, ubicada en `.tddlab/tddlab.db` (ignorado por Git).

### Persistencia local-first

- Cada ejecucion de `npm test` se registra en `tdd_execution` con un `run_id`
  (UUID) único y un `test_id` secuencial para compatibilidad.
- Los commits se identifican por su SHA real de Git (nunca por el literal
  `HEAD`).
- Las ejecuciones se asocian a la rama observada y al commit correspondiente.
- El historial es independiente del cambio de rama: borrar o renombrar una rama
  no elimina las ejecuciones registradas.
- Funciona sin conexion a Internet (local-first).

### Comandos de testing disponibles

| Comando | Descripcion |
|---------|-------------|
| `npm test` | Ejecuta Jest y registra la ejecucion en SQLite |
| `npm run test:unit` | Pruebas unitarias de persistencia y contexto Git |
| `npm run test:integration` | Pruebas de integracion SQLite + scripts |
| `npm run test:e2e` | Pruebas end-to-end con Git y SQLite reales |
| `npm run test:smoke` | Smoke tests rapidos de funcionalidad esencial |
| `npm run test:coverage` | Ejecuta pruebas con reporte de cobertura (umbral 85%) |
| `npm run lint` | Analisis estatico con ESLint |

### Base de datos

La base de datos SQLite se crea automaticamente en `.tddlab/tddlab.db` al
ejecutar `npm test`. El directorio `.tddlab/` esta ignorado por Git para que
cada clon o worktree tenga su propia base de datos y no haya conflictos entre
ramas.

Para consultar el historial manualmente:

```bash
# Ejecuciones registradas
sqlite3 .tddlab/tddlab.db "SELECT run_id, branch_name, success, tests_total FROM tdd_execution;"

# Commits registrados
sqlite3 .tddlab/tddlab.db "SELECT commit_id, message, additions, deletions FROM tdd_commit;"

# Relaciones de padres (merges)
sqlite3 .tddlab/tddlab.db "SELECT commit_id, parent_id, ord FROM tdd_commit_parent;"
```

Nota: `sqlite3` es una herramienta externa; si no esta instalada, se puede
acceder a la base desde cualquier cliente SQLite compatible.

## Guia de testing

Consulte `docs/GUIA-TESTING-SQLITE-RAMAS.md` para instrucciones completas de
validacion (unitarias, integracion, E2E, smoke tests, cobertura y solucion de
problemas).
