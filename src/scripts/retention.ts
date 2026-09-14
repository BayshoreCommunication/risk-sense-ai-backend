/** npm run retention [-- --dry-run] [--tenant <id>] — SEC-06 enforcement from a cron job or by hand. */
import mongoose from 'mongoose';
import { connectDb } from '../lib/db';
import { retentionService } from '../modules/retention/service';

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const ti = args.indexOf('--tenant');
  const tenantId = ti >= 0 ? args[ti + 1] : undefined;
  await connectDb();
  const results = await retentionService.run({ dryRun, trigger: 'script', actor: null, tenantId });
  for (const r of results) console.log(JSON.stringify(r));
  await mongoose.disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
