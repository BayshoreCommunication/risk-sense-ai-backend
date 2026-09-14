// k6 load test (T-092, NFR-01 / NFR-03): 100 concurrent requestors run a full MCQ intake against a backend
// started with AI_PROVIDER=mock (so no model calls). Thresholds: p95 ≤ 3 s per request, error rate < 1 %.
//   AI_PROVIDER=mock PORT=4100 npm run dev            (in one terminal)
//   k6 run -e BASE=http://localhost:4100/api/v1 load/k6-intake.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: { intake: { executor: 'constant-vus', vus: Number(__ENV.VUS || 100), duration: __ENV.DURATION || '2m' } },
  thresholds: { http_req_duration: ['p(95)<3000'], http_req_failed: ['rate<0.01'] },
};
const BASE = __ENV.BASE || 'http://localhost:4100/api/v1';
const USERS = ['requestor@paid.local', 'colleague@paid.local', 'itlead@paid.local', 'requestor@dev.local'];

export default function () {
  const email = USERS[__VU % USERS.length];
  const sess = http.post(`${BASE}/auth/session`, null, { headers: { 'X-Dev-User': email } });
  check(sess, { 'session 201': (r) => r.status === 201 });
  const h = { headers: { 'X-Dev-User': email, 'X-Session-Id': sess.json('data.sessionId'), 'Content-Type': 'application/json' } };
  const start = http.post(`${BASE}/assessments`, JSON.stringify({ personaKey: 'finance_officer', text: 'unauthorized wire transfer without approval' }), h);
  check(start, { 'start 201': (r) => r.status === 201 });
  let next = start.json('data.nextQuestion');
  const id = start.json('data._id');
  let guard = 0;
  while (next && guard++ < 40) {
    const t = next.type;
    const body = t === 'mcq' ? { value: next.options[0].id } : t === 'yes_no' ? { value: false } : t === 'number' ? { value: 100 } : { text: 'A short description of what happened, with enough words to be useful.' };
    const r = http.post(`${BASE}/assessments/${id}/messages`, JSON.stringify(body), h);
    check(r, { 'turn 200': (x) => x.status === 200 });
    if (r.json('data.intakeComplete')) break;
    next = r.json('data.nextQuestion');
  }
  const sub = http.post(`${BASE}/assessments/${id}/submit`, null, h);
  check(sub, { 'submit 200': (r) => r.status === 200 });
  http.get(`${BASE}/assessments?limit=25`, h);
  http.del(`${BASE}/auth/session`, null, h);
  sleep(1);
}
