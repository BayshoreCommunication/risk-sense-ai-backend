/**
 * npm run templates — writes templates/risksense-content-template.xlsx and templates/sample-content.json
 * from the contract in src/modules/datasets/template.ts (T-006, FR-13).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SAMPLE, TEMPLATE_VERSION, buildTemplateWorkbook } from '../modules/datasets/template';

async function main() {
  const outDir = join(process.cwd(), 'templates');
  mkdirSync(outDir, { recursive: true });
  const xlsxPath = join(outDir, 'risksense-content-template.xlsx');
  writeFileSync(xlsxPath, await buildTemplateWorkbook());
  const jsonPath = join(outDir, 'sample-content.json');
  writeFileSync(jsonPath, JSON.stringify({ version: TEMPLATE_VERSION, ...SAMPLE }, null, 2));
  console.log(`wrote ${xlsxPath}\nwrote ${jsonPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
