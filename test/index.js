// Punto de entrada de `node --test test/` (script "test" de package.json).
// Node ≥ 22 trata "test/" como patrón glob: casa con la propia carpeta y la ejecuta como módulo
// (es decir, este index.js). Aquí se importan todos los *.test.js de la carpeta en ese proceso.
// En Node 18/20 el runner ya ejecuta cada archivo de test/ por separado (también este, con
// argv[1] = .../index.js): entonces no hace nada, para no repetir las pruebas.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const comoCarpeta = path.basename(process.argv[1] || '') !== 'index.js';

if (comoCarpeta) {
  for (const f of readdirSync(DIR).filter((n) => /\.test\.m?js$/.test(n)).sort()) {
    await import(pathToFileURL(path.join(DIR, f)).href);
  }
}
