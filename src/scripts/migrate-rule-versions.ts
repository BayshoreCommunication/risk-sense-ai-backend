/**
 * Dry-run: npm run rules:migrate-versions
 * Apply:   npm run rules:migrate-versions -- --apply --database <exact-db-name>
 */
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../lib/db';
import { migrateRuleVersions } from '../modules/rules/migration';

const argv = process.argv.slice(2);
const value = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

async function main() {
  const apply = argv.includes('--apply');
  // Do not let model auto-indexing race the legacy-index migration.
  mongoose.set('autoIndex', false);
  await connectDb();
  const report = await migrateRuleVersions({ apply, expectedDatabase: value('--database') });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(disconnectDb);
