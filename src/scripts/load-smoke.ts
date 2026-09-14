/**
 * npm run load:smoke -- [--base http://localhost:4100/api/v1] [--users 100] [--rounds 2]
 * Node-only stand-in for the k6 script (T-092): N concurrent users each run a full MCQ intake + list + report
 * against a backend running with AI_PROVIDER=mock. Prints p50/p95/max per step and fails (exit 2) when
 * p95 > 3000 ms (NFR-01) or any request errors.
 */
const argv = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1]! : d; };
const BASE = arg('--base', 'http://localhost:4100/api/v1');
const USERS = Number(arg('--users', '100'));
const ROUNDS = Number(arg('--rounds', '1'));
const ACCOUNTS = ['requestor@paid.local', 'colleague@paid.local', 'itlead@paid.local', 'requestor@dev.local'];
const lat: Record<string, number[]> = {};
let errors = 0;

async function call(step: string, method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  (lat[step] ??= []).push(performance.now() - t0);
  if (!res.ok) { errors++; return null; }
  return (await res.json()) as { data: Record<string, unknown> };
}

async function user(i: number) {
  const email = ACCOUNTS[i % ACCOUNTS.length]!;
  const s = await call('session', 'POST', '/auth/session', { 'X-Dev-User': email });
  if (!s) return;
  const h = { 'X-Dev-User': email, 'X-Session-Id': String(s.data.sessionId) };
  const start = await call('start', 'POST', '/assessments', h, { personaKey: 'finance_officer', text: 'unauthorized wire transfer without approval' });
  if (!start) return;
  const id = String(start.data._id);
  let next = start.data.nextQuestion as { type: string; options?: { id: string }[] } | null;
  let guard = 0;
  while (next && guard++ < 40) {
    const body = next.type === 'mcq' ? { value: next.options![0]!.id } : next.type === 'yes_no' ? { value: false } : next.type === 'number' ? { value: 100 } : { text: 'A short description of what happened, with enough words to be useful.' };
    const r = await call('turn', 'POST', `/assessments/${id}/messages`, h, body);
    if (!r) return;
    if (r.data.intakeComplete) break;
    next = r.data.nextQuestion as typeof next;
  }
  await call('submit', 'POST', `/assessments/${id}/submit`, h);
  await call('list', 'GET', '/assessments?limit=25', h);
  await call('logout', 'DELETE', '/auth/session', h);
}

const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };

async function main() {
  const t0 = Date.now();
  for (let r = 0; r < ROUNDS; r++) await Promise.all(Array.from({ length: USERS }, (_, i) => user(i)));
  const wall = Date.now() - t0;
  console.log(`load-smoke: ${USERS} concurrent users × ${ROUNDS} round(s) against ${BASE} in ${wall} ms, errors=${errors}`);
  let worstP95 = 0;
  for (const [step, xs] of Object.entries(lat)) {
    const p95 = q(xs, 0.95);
    worstP95 = Math.max(worstP95, p95);
    console.log(`  ${step.padEnd(8)} n=${String(xs.length).padStart(5)}  p50=${q(xs, 0.5).toFixed(0).padStart(5)} ms  p95=${p95.toFixed(0).padStart(5)} ms  max=${Math.max(...xs).toFixed(0).padStart(5)} ms`);
  }
  const ok = errors === 0 && worstP95 <= 3000;
  console.log(ok ? 'PASS: p95 ≤ 3000 ms and no errors (NFR-01)' : `FAIL: p95=${worstP95.toFixed(0)} ms errors=${errors}`);
  process.exit(ok ? 0 : 2);
}
main().catch((e) => { console.error(e); process.exit(1); });
