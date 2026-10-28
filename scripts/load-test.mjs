// Load test: simulates N phones polling get_live every ~3s and voting in a burst, plus a presenter polling every 1s.
// Run: node --env-file=.env.local scripts/load-test.mjs [voters=200] [seconds=30] [poll-code=rt53]
// Uses the first multiple-choice question, then deletes the test votes and restores the poll's state.
import { randomUUID } from 'node:crypto';

const { SUPABASE_URL: URL, SUPABASE_PUBLISHABLE_KEY: PUB, SUPABASE_SECRET_KEY: SECRET } = process.env;
const VOTERS = Number(process.argv[2] || 200);
const SECONDS = Number(process.argv[3] || 30);
const CODE = process.argv[4] || 'rt53';

const stats = { get_live: [], submit_vote: [], get_results: [], errors: 0, rejected: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(fn, args) {
  const t = performance.now();
  try {
    const res = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: PUB, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data)}`);
    stats[fn].push(performance.now() - t);
    return data;
  } catch (e) {
    stats.errors++;
    if (stats.errors <= 5) console.error(`  ${fn} error: ${e.message}`);
    return null;
  }
}

const admin = (method, path, body) =>
  fetch(`${URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SECRET, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json().catch(() => null));

const [poll] = await admin('GET', `polls?code=eq.${CODE}&select=*`);
const questions = await admin('GET', `questions?poll_id=eq.${poll.id}&kind=eq.choice&select=*&order=position`);
const q = questions[0];
const originalActive = poll.active_question_id;
const originalOpen = q.is_open;
const existing = await admin('GET', `votes?question_id=eq.${q.id}&select=id`);
if (existing.length) {
  console.error(`Question "${q.prompt}" already has ${existing.length} votes. Reset it first; the load test won't touch real votes.`);
  process.exit(1);
}

await admin('PATCH', `polls?id=eq.${poll.id}`, { active_question_id: q.id });
await admin('PATCH', `questions?id=eq.${q.id}`, { is_open: true });
console.log(`Load test: ${VOTERS} phones for ${SECONDS}s on "${q.prompt}"`);

const end = Date.now() + SECONDS * 1000;
const expected = new Array(q.options.length).fill(0);

async function phone() {
  const voter = randomUUID();
  const choice = Math.floor(Math.random() * q.options.length);
  const voteAt = Date.now() + 2000 + Math.random() * 10000;
  let voted = false;
  await sleep(Math.random() * 3000);
  while (Date.now() < end) {
    const live = await rpc('get_live', { p_code: CODE });
    if (!voted && Date.now() >= voteAt && live?.question?.id === q.id) {
      const r = await rpc('submit_vote', { p_question_id: q.id, p_voter_id: voter, p_choice: choice });
      if (r?.ok) {
        voted = true;
        expected[choice]++;
      } else if (r) stats.rejected++;
    }
    await sleep(3000 + Math.random() * 1000);
  }
}

async function presenter() {
  while (Date.now() < end) {
    await rpc('get_live', { p_code: CODE });
    await rpc('get_results', { p_question_id: q.id });
    await sleep(1000);
  }
}

function summary(name, arr) {
  if (!arr.length) return `${name}: none`;
  const s = [...arr].sort((a, b) => a - b);
  const p = (x) => s[Math.min(s.length - 1, Math.floor(x * s.length))].toFixed(0);
  return `${name}: ${s.length} calls · p50 ${p(0.5)} ms · p95 ${p(0.95)} ms · max ${s.at(-1).toFixed(0)} ms`;
}

try {
  await Promise.all([presenter(), ...Array.from({ length: VOTERS }, phone)]);
  const res = await rpc('get_results', { p_question_id: q.id });
  const total = stats.get_live.length + stats.submit_vote.length + stats.get_results.length;
  console.log(summary('get_live', stats.get_live));
  console.log(summary('submit_vote', stats.submit_vote));
  console.log(summary('get_results', stats.get_results));
  console.log(`Requests: ${total} in ${SECONDS}s (~${(total / SECONDS).toFixed(0)}/s) · errors ${stats.errors} · rejected ${stats.rejected}`);
  console.log(`Votes counted: ${res.total}/${VOTERS} · counts ${JSON.stringify(res.counts)} · expected ${JSON.stringify(expected)}`);
  const ok = res.total === VOTERS && JSON.stringify(res.counts) === JSON.stringify(expected) && stats.errors === 0;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await admin('DELETE', `votes?question_id=eq.${q.id}`);
  await admin('PATCH', `questions?id=eq.${q.id}`, { is_open: originalOpen });
  await admin('PATCH', `polls?id=eq.${poll.id}`, { active_question_id: originalActive });
}
