import fs from "fs";
import { execSync, exec } from "child_process";
import { tmpdir } from "os";
import path from "path";
import crypto from "crypto";

const DATA_FILE = "script/commit-history.json";
const HEAD_MARKER = "HEAD";

function getCommitInfo(sha) {
  let commitMessage, commitDate, author;
  const isHeadCommit = sha === HEAD_MARKER;
  const gitSha = isHeadCommit ? "HEAD" : sha;

  try {
    commitMessage = execSync(`git log -1 --pretty=%B ${gitSha}`)
      .toString()
      .trim();
    commitDate = new Date(
      execSync(`git log -1 --format=%cd ${gitSha}`).toString()
    ).toISOString();
    author = execSync(`git log -1 --pretty=format:%an ${gitSha}`)
      .toString()
      .trim();
  } catch (error) {
    console.error(`Error al obtener información del commit ${gitSha}:`, error);
    return null;
  }

  let repoUrl = "";
  try {
    repoUrl = execSync("git config --get remote.origin.url")
      .toString()
      .trim()
      .replace(/\.git$/, "");
    if (repoUrl.startsWith("git@")) {
      repoUrl = repoUrl.replace(/^git@([^:]+):(.+)$/, "https://$1/$2");
    }
  } catch {
    console.warn("No se encontró un repositorio remoto.");
  }

  let additions = 0,
    deletions = 0;

  try {
    // Obtener el parent del commit actual para comparar
    let parentRef;
    const isMergeCommit = commitMessage.startsWith("Merge ");

    if (isMergeCommit) {
      // Para commits de merge, usar el primer parent
      try {
        parentRef = execSync(`git log -1 --pretty=%P ${gitSha}`)
          .toString()
          .trim()
          .split(" ")[0];
      } catch (error) {
        parentRef = `${gitSha}~1`;
      }
    } else {
      // Para commits normales
      parentRef = `${gitSha}~1`;
    }

    try {
      // Excluir commit-history.json al obtener las estadísticas del diff
      const diffStats = execSync(
        `git diff --stat ${parentRef} ${gitSha} -- ":!${DATA_FILE}"`
      ).toString();
      const additionsMatch = diffStats.match(/(\d+) insertion/);
      const deletionsMatch = diffStats.match(/(\d+) deletion/);
      additions = additionsMatch ? parseInt(additionsMatch[1]) : 0;
      deletions = deletionsMatch ? parseInt(deletionsMatch[1]) : 0;
    } catch (error) {
      console.warn(
        `Error al obtener estadísticas del diff para ${gitSha}, puede ser el primer commit:`,
        error.message
      );

      // Si es el primer commit, no hay parent para comparar
      try {
        const diffStats = execSync(
          `git show --stat ${gitSha} -- ":!${DATA_FILE}"`
        ).toString();
        const additionsMatch = diffStats.match(/(\d+) insertion/);
        additions = additionsMatch ? parseInt(additionsMatch[1]) : 0;
        deletions = 0; // En el primer commit no hay eliminaciones
      } catch (innerError) {
        console.warn(
          `Error al obtener estadísticas para el primer commit:`,
          innerError.message
        );
      }
    }
  } catch (error) {
    console.warn(
      `Error general al calcular estadísticas para ${gitSha}:`,
      error.message
    );
  }

  let testCount = 0,
    coverage = 0,
    failedTests = 0;

  let conclusion = "neutral"; // valor por defecto

  if (fs.existsSync("package.json")) {
    const tempDir = tmpdir();
    const randomId = crypto.randomBytes(8).toString("hex");
    const outputPath = path.join(tempDir, `jest-results-${randomId}.json`);

    try {
      try {
        execSync(
          `npx jest --coverage --json --outputFile=${outputPath} --passWithNoTests`,
          {
            stdio: "pipe",
          }
        );
      } catch (jestError) {}

      // Procesar los resultados si el archivo existe
      if (fs.existsSync(outputPath)) {
        const jestResults = JSON.parse(fs.readFileSync(outputPath, "utf8"));
        testCount = jestResults.numTotalTests || 0;
        failedTests = jestResults.numFailedTests || 0;

        // Calcular cobertura si existe
        if (jestResults.coverageMap) {
          const coverageMap = jestResults.coverageMap;
          let covered = 0,
            total = 0;

          for (const file of Object.values(coverageMap)) {
            const s = file.s;
            const fileTotal = Object.keys(s).length;
            const fileCovered = Object.values(s).filter((v) => v > 0).length;
            total += fileTotal;
            covered += fileCovered;
          }

          if (total > 0) {
            coverage = (covered / total) * 100;
            coverage = Math.round(coverage * 100) / 100;
          }
        }

        // Establecer conclusión según pruebas
        if (testCount > 0) {
          conclusion = failedTests > 0 ? "failure" : "success";
        }

        // Limpieza del archivo temporal
        try {
          fs.unlinkSync(outputPath);
        } catch (unlinkError) {
          console.warn(
            `No se pudo eliminar el archivo temporal: ${unlinkError.message}`
          );
        }
      } else {
        console.warn("El archivo de resultados de Jest no fue creado");
      }
    } catch (error) {
      console.warn("Error al procesar resultados de pruebas:", error.message);
    }
  }

  return {
    sha: isHeadCommit ? HEAD_MARKER : sha,
    author,
    commit: {
      date: commitDate,
      message: commitMessage,
      url: !isHeadCommit
        ? `${repoUrl}/commit/HEAD`
        : `${repoUrl}/commit/${sha}`,
    },
    stats: {
      total: additions + deletions,
      additions,
      deletions,
      date: commitDate.split("T")[0],
    },
    coverage,
    test_count: testCount,
    failed_tests: failedTests,
    conclusion,
  };
}

function saveCommitData(commitData) {
  let commits = [];
  if (fs.existsSync(DATA_FILE)) {
    try {
      commits = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    } catch (error) {
      console.error("Error al leer el archivo de datos:", error);
      commits = [];
    }
  }

  // Actualizar el commit HEAD anterior con su SHA real
  const headIndex = commits.findIndex((c) => c.sha === HEAD_MARKER);
  if (headIndex >= 0) {
    // Obtener el SHA del commit anterior (que antes era HEAD)
    const currentSha = execSync("git rev-parse HEAD~1").toString().trim();

    // Actualizar el registro con el SHA real
    commits[headIndex].sha = currentSha;
    if (commits[headIndex].commit.url && currentSha) {
      const baseUrl = commits[headIndex].commit.url.split("/commit/")[0];
      commits[headIndex].commit.url = `${baseUrl}/commit/${currentSha}`;
    }
  }

  // Actualizar o agregar el commit actual (HEAD)
  const existingIndex = commits.findIndex((c) => c.sha === commitData.sha);
  if (existingIndex >= 0 && commitData.sha !== HEAD_MARKER) {
    // Actualizar commit existente
    commits[existingIndex] = commitData;
  } else {
    // Agregar el nuevo commit HEAD
    commits.push(commitData);
  }

  // Actualizar URLs para commits que no la tengan si tenemos una URL base
  if (commitData.commit.url) {
    const baseUrl = commitData.commit.url.split("/commit/")[0];
    commits.forEach((commit) => {
      if (!commit.commit.url && commit.sha !== HEAD_MARKER) {
        commit.commit.url = `${baseUrl}/commit/${commit.sha}`;
      }
    });
  }

  // Ordenar commits por fecha
  commits.sort((a, b) => new Date(a.commit.date) - new Date(b.commit.date));

  fs.writeFileSync(DATA_FILE, JSON.stringify(commits, null, 2));
}

try {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
  }

  // Obtener información del commit actual como HEAD
  const currentCommitData = getCommitInfo(HEAD_MARKER);
  if (currentCommitData) {
    saveCommitData(currentCommitData);
  }
} catch (error) {
  console.error("Error en el script de seguimiento de commits:", error);
  process.exit(1);
}
