import { connectDb, disconnectDb } from '../lib/db';
import { conformanceService } from '../modules/conformance/service';

async function main() {
  await connectDb();
  const tenantId = process.argv.find((arg) => arg.startsWith('--tenant='))?.split('=')[1];
  const results = await conformanceService.scan({ trigger: 'script', actor: null, tenantId });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  await disconnectDb();
}

main().catch(async (error) => {
  process.stderr.write(`${(error as Error).stack ?? error}\n`);
  await disconnectDb();
  process.exitCode = 1;
});
