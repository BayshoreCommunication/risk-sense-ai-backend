/**
 * npm run accuracy [-- --tenant acme] [--days 365]
 * BRD §12 / ISS-002: accuracy = share of decided assessments where the human ACCEPTED the AI classification
 * (override = disagreement; escalations excluded). Prints per tenant, per persona and per classification so
 * TAC can see where the matrix drifts. Target: 75 % (BusinessRules §12 #2).
 */
import mongoose from 'mongoose';
import { connectDb } from '../lib/db';
import { AssessmentModel } from '../modules/assessments/model';
import { TenantModel } from '../modules/tenants/model';

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };

async function main() {
  await connectDb();
  const days = Number(arg('--days', '365'));
  const slug = arg('--tenant', '');
  const tenants = await TenantModel.find(slug ? { slug } : {}).lean();
  for (const t of tenants) {
    const rows = await AssessmentModel.aggregate<{ _id: { by: string; key: string }; accepted: number; overridden: number }>([
      { $match: { tenantId: t._id, 'decision.type': { $in: ['accept', 'override'] }, createdAt: { $gte: new Date(Date.now() - days * 86400e3) } } },
      { $facet: {
        total: [{ $group: { _id: { by: 'total', key: 'all' }, accepted: { $sum: { $cond: [{ $eq: ['$decision.type', 'accept'] }, 1, 0] } }, overridden: { $sum: { $cond: [{ $eq: ['$decision.type', 'override'] }, 1, 0] } } } }],
        persona: [{ $group: { _id: { by: 'persona', key: { $ifNull: ['$personaKey', '(none)'] } }, accepted: { $sum: { $cond: [{ $eq: ['$decision.type', 'accept'] }, 1, 0] } }, overridden: { $sum: { $cond: [{ $eq: ['$decision.type', 'override'] }, 1, 0] } } } }],
        classification: [{ $group: { _id: { by: 'classification', key: { $ifNull: ['$result.classification', '(none)'] } }, accepted: { $sum: { $cond: [{ $eq: ['$decision.type', 'accept'] }, 1, 0] } }, overridden: { $sum: { $cond: [{ $eq: ['$decision.type', 'override'] }, 1, 0] } } } }],
      } },
      { $project: { rows: { $concatArrays: ['$total', '$persona', '$classification'] } } },
      { $unwind: '$rows' },
      { $replaceRoot: { newRoot: '$rows' } },
    ]);
    console.log(`\n== ${t.slug} (${t.plan}) — last ${days} days`);
    for (const r of rows.sort((a, b) => a._id.by.localeCompare(b._id.by) || a._id.key.localeCompare(b._id.key))) {
      const n = r.accepted + r.overridden;
      const acc = n ? ((r.accepted / n) * 100).toFixed(1) : '—';
      console.log(`  ${r._id.by.padEnd(14)} ${r._id.key.padEnd(30)} decided=${String(n).padStart(4)} accepted=${String(r.accepted).padStart(4)} overridden=${String(r.overridden).padStart(4)} accuracy=${acc}%${n && r.accepted / n < 0.75 ? '  (below 75 % target)' : ''}`);
    }
  }
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
