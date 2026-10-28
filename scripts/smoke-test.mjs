// API smoke test against the live project. Uses .env.local; restores the poll's state when done.
// Run: node --env-file=.env.local scripts/smoke-test.mjs [poll-code]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { SUPABASE_URL: URL, SUPABASE_PUBLISHABLE_KEY: PUB, SUPABASE_SECRET_KEY: SECRET } = process.env;
const CODE = process.argv[2] || 'rt53';

async function call(key, method, path, body) {
  const res = await fetch(`${URL}${path}`, {
    method,
    headers: { apikey: key, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
const anonRpc = (fn, args) => call(PUB, 'POST', `/rest/v1/rpc/${fn}`, args);
const admin = (method, path, body) => call(SECRET, method, `/rest/v1/${path}`, body);

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const { data: [poll] } = await admin('GET', `polls?code=eq.${CODE}&select=*`);
assert.ok(poll, `poll ${CODE} not found`);
const { data: questions } = await admin('GET', `questions?poll_id=eq.${poll.id}&select=*&order=position`);
const choiceQ = questions.find((q) => q.kind === 'choice');
const ratingQ = questions.find((q) => q.kind === 'rating');
const wordQ = questions.find((q) => q.kind === 'word');
const original = { active: poll.active_question_id };
const voter = randomUUID();
const setActive = (id) => admin('PATCH', `polls?id=eq.${poll.id}`, { active_question_id: id });

try {
  console.log(`Smoke test for poll "${CODE}"`);

  await check('anonymous users cannot read or write tables directly', async () => {
    const read = await call(PUB, 'GET', '/rest/v1/votes?select=*');
    assert.ok(read.status === 401 || read.status === 403 || (Array.isArray(read.data) && read.data.length === 0));
    const ins = await call(PUB, 'POST', '/rest/v1/votes', { question_id: choiceQ.id, voter_id: voter, choice: 0 });
    assert.ok(ins.status >= 400, `insert status ${ins.status}`);
    const upd = await call(PUB, 'PATCH', `/rest/v1/polls?id=eq.${poll.id}`, { title: 'hacked' });
    assert.ok(upd.status >= 400 || (Array.isArray(upd.data) && upd.data.length === 0));
    const admins = await call(PUB, 'GET', '/rest/v1/admins?select=*');
    assert.ok(admins.status >= 400 || (Array.isArray(admins.data) && admins.data.length === 0));
  });

  await check('get_live returns the poll and unknown codes return null', async () => {
    await setActive(null);
    const live = await anonRpc('get_live', { p_code: CODE });
    assert.equal(live.data.poll.code, CODE);
    assert.equal(live.data.question, null);
    const missing = await anonRpc('get_live', { p_code: 'no-such-poll' });
    assert.equal(missing.data, null);
  });

  await check('votes are rejected when the question is not live', async () => {
    const r = await anonRpc('submit_vote', { p_question_id: choiceQ.id, p_voter_id: voter, p_choice: 0 });
    assert.deepEqual(r.data, { ok: false, error: 'not_active' });
  });

  await check('choice: one vote per phone, changeable, validated', async () => {
    await admin('DELETE', `votes?question_id=eq.${choiceQ.id}`);
    await setActive(choiceQ.id);
    assert.equal((await anonRpc('submit_vote', { p_question_id: choiceQ.id, p_voter_id: voter, p_choice: 0 })).data.ok, true);
    assert.equal((await anonRpc('submit_vote', { p_question_id: choiceQ.id, p_voter_id: voter, p_choice: 1 })).data.ok, true);
    assert.equal((await anonRpc('submit_vote', { p_question_id: choiceQ.id, p_voter_id: voter, p_choice: 99 })).data.error, 'invalid_choice');
    const res = (await anonRpc('get_results', { p_question_id: choiceQ.id })).data;
    assert.equal(res.total, 1);
    assert.equal(res.counts[0], 0);
    assert.equal(res.counts[1], 1);
    const live = (await anonRpc('get_live', { p_code: CODE })).data;
    assert.equal(live.question.id, choiceQ.id);
    assert.equal(live.question.total, questions.length);
  });

  await check('closed questions reject votes', async () => {
    await admin('PATCH', `questions?id=eq.${choiceQ.id}`, { is_open: false });
    const r = await anonRpc('submit_vote', { p_question_id: choiceQ.id, p_voter_id: voter, p_choice: 0 });
    assert.equal(r.data.error, 'closed');
    await admin('PATCH', `questions?id=eq.${choiceQ.id}`, { is_open: true });
  });

  await check('rating: range enforced, average computed', async () => {
    await admin('DELETE', `votes?question_id=eq.${ratingQ.id}`);
    await setActive(ratingQ.id);
    assert.equal((await anonRpc('submit_vote', { p_question_id: ratingQ.id, p_voter_id: voter, p_rating: 6 })).data.error, 'invalid_rating');
    await anonRpc('submit_vote', { p_question_id: ratingQ.id, p_voter_id: voter, p_rating: 4 });
    await anonRpc('submit_vote', { p_question_id: ratingQ.id, p_voter_id: randomUUID(), p_rating: 2 });
    const res = (await anonRpc('get_results', { p_question_id: ratingQ.id })).data;
    assert.equal(res.total, 2);
    assert.equal(Number(res.average), 3);
    assert.deepEqual(res.counts, [0, 1, 0, 1, 0]);
  });

  await check('word cloud: up to 3 per phone, duplicates ignored, hidden words excluded', async () => {
    await admin('DELETE', `votes?question_id=eq.${wordQ.id}`);
    await setActive(wordQ.id);
    for (const w of ['Approvals', 'approvals', 'tone', 'compliance']) {
      await anonRpc('submit_vote', { p_question_id: wordQ.id, p_voter_id: voter, p_word: w });
    }
    const limit = await anonRpc('submit_vote', { p_question_id: wordQ.id, p_voter_id: voter, p_word: 'fourth' });
    assert.equal(limit.data.error, 'word_limit');
    assert.equal((await anonRpc('submit_vote', { p_question_id: wordQ.id, p_voter_id: randomUUID(), p_word: ' ' })).data.error, 'invalid_word');
    await anonRpc('submit_vote', { p_question_id: wordQ.id, p_voter_id: randomUUID(), p_word: 'APPROVALS' });
    let res = (await anonRpc('get_results', { p_question_id: wordQ.id })).data;
    assert.deepEqual(res.words[0], { w: 'approvals', n: 2 });
    await admin('PATCH', `votes?question_id=eq.${wordQ.id}&word=ilike.tone`, { hidden: true });
    res = (await anonRpc('get_results', { p_question_id: wordQ.id })).data;
    assert.ok(!res.words.some((w) => w.w === 'tone'));
  });

  console.log(`\nAll ${passed} checks passed.`);
} finally {
  for (const q of [choiceQ, ratingQ, wordQ]) await admin('DELETE', `votes?question_id=eq.${q.id}`);
  await setActive(original.active);
}
