import fs from 'fs';

const readJSONFile = (filePath) => {
  const rawData = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(rawData);
};

const writeJSONFile = (filePath, data) => {
  const jsonString = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, jsonString, 'utf-8');
};

const ensureFileExists = (filePath, initialData) => {
  if (!fs.existsSync(filePath)) {
    writeJSONFile(filePath, initialData);
  }
};

const isACommit = (lastEntry) => {
  return lastEntry.hasOwnProperty('commitId');
};

const getLastTestId = (filePath) => {
  ensureFileExists(filePath, []);
  const historyExecutionData = readJSONFile(filePath);
  const lastEntry = historyExecutionData[historyExecutionData.length - 1];
  
  if (lastEntry) {
    if (isACommit(lastEntry)) {
      return lastEntry.testId + 1; // Si el último es un commit, el próximo testId se incrementa
    } else { //Ejecución de pruebas
      return lastEntry.hasOwnProperty('testId') ? lastEntry.testId : 0; // Incrementa el testId
    }
  } else {
    return 0; // Si el archivo está vacío, comienza con testId 0
  }
};

export {getLastTestId };