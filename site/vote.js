import { pollCode, rpc, esc, $, ratingRange, PALETTE, sleep } from './common.js';

const code = pollCode();
const app = $('#app');
const store = safeStorage();
const voterId = getVoterId();
const MAX_WORDS = 3;

let live = null;
let renderedKey = '';
let busy = false;
let resultsFor = null;
let wake = null;

const ERRORS = {
  closed: 'Voting just closed for this question.',
  not_active: 'This question is no longer live.',
  word_limit: `You've already added ${MAX_WORDS} answers.`,
  invalid_word: 'Use 1 to 30 characters.',
  invalid_choice: 'That option is no longer available.',
  invalid_rating: 'That rating is out of range.',
};

function safeStorage() {
  const memory = {};
  try {
    localStorage.setItem('lp-test', '1');
    localStorage.removeItem('lp-test');
    return localStorage;
  } catch {
    return { getItem: (k) => memory[k] ?? null, setItem: (k, v) => (memory[k] = String(v)) };
  }
}

function getVoterId() {
  let id = store.getItem('live-poll-voter');
  if (!id) {
    id = crypto.randomUUID
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
    store.setItem('live-poll-voter', id);
  }
  return id;
}

function getAnswer(qid) {
  try {
    return JSON.parse(store.getItem(`lp-ans-${qid}`));
  } catch {
    return null;
  }
}

function setAnswer(qid, value) {
  store.setItem(`lp-ans-${qid}`, JSON.stringify(value));
}

function waitOrWake(ms) {
  return new Promise((resolve) => {
    wake = resolve;
    setTimeout(resolve, ms);
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wake) wake();
});

async function pollLoop() {
  let delay = 3000;
  for (;;) {
    if (document.visibilityState === 'visible') {
      try {
        onLive(await rpc('get_live', { p_code: code }));
        delay = 3000;
      } catch {
        delay = Math.min(delay * 1.5, 10000);
        if (!live) app.innerHTML = '<div class="center muted">Trying to connect…</div>';
      }
    }
    await waitOrWake(delay + Math.random() * 1000);
  }
}

function onLive(data) {
  live = data;
  if (!data) {
    if (renderedKey !== 'missing') {
      renderedKey = 'missing';
      app.innerHTML = `<div class="center"><h2>Poll not found</h2><p class="muted">Check the link or scan the QR code again.</p></div>`;
    }
    return;
  }
  $('#poll-title').textContent = data.poll.title;
  document.title = data.poll.title;
  const q = data.question;
  $('#qnum').textContent = q ? `${q.number} of ${q.total}` : '';
  const key = q ? `${q.id}|${q.is_open}|${data.poll.show_results_on_phones}` : 'waiting';
  if (key !== renderedKey && !busy) {
    renderedKey = key;
    render();
  }
}

function render() {
  const q = live?.question;
  if (!q) {
    resultsFor = null;
    app.innerHTML = `
      <div class="center waiting">
        <div class="pulse"></div>
        <h2>You're in!</h2>
        <p class="muted">Waiting for the next question…</p>
      </div>`;
    return;
  }
  const answer = getAnswer(q.id);
  let body = '';
  if (q.kind === 'choice') {
    body = `<div class="choices">${q.options
      .map(
        (opt, i) => `
        <button class="choice ${answer?.choice === i ? 'selected' : ''}" data-choice="${i}" style="--c:${PALETTE[i % PALETTE.length]}" ${q.is_open ? '' : 'disabled'}>
          <span class="dot"></span><span>${esc(opt)}</span>
        </button>`,
      )
      .join('')}</div>`;
  } else if (q.kind === 'rating') {
    const { min, max, minLabel, maxLabel } = ratingRange(q.options);
    const buttons = [];
    for (let v = min; v <= max; v++) {
      buttons.push(`<button class="rate ${answer?.rating === v ? 'selected' : ''}" data-rating="${v}" ${q.is_open ? '' : 'disabled'}>${v}</button>`);
    }
    body = `<div class="rating">${buttons.join('')}</div>
      <div class="rating-labels muted"><span>${esc(minLabel)}</span><span>${esc(maxLabel)}</span></div>`;
  } else {
    const words = answer?.words || [];
    const left = MAX_WORDS - words.length;
    body = `
      <form class="word-form" autocomplete="off">
        <input id="word" name="word" maxlength="30" placeholder="Type a short answer" ${q.is_open && left > 0 ? '' : 'disabled'} aria-label="Your answer">
        <button type="submit" class="primary" ${q.is_open && left > 0 ? '' : 'disabled'}>Send</button>
      </form>
      <div class="chips">${words.map((w) => `<span class="chip">${esc(w)}</span>`).join('')}</div>
      <p class="muted small">${q.is_open ? (left > 0 ? `You can send ${left} more.` : 'Thanks! That was your last answer.') : ''}</p>`;
  }

  let status = '';
  if (!q.is_open) status = 'Voting is closed for this question.';
  else if (answer && q.kind !== 'word') status = '✓ Vote received. Tap another option to change it.';
  else if (answer?.words?.length) status = '✓ Received.';

  app.innerHTML = `
    <h1 class="prompt">${esc(q.prompt)}</h1>
    ${body}
    <div id="status" class="status ${answer || !q.is_open ? 'show' : ''}">${status}</div>
    <div id="phone-results"></div>`;

  if (live.poll.show_results_on_phones && (answer || !q.is_open)) startResults(q);
  else resultsFor = null;
}

async function submit(payload) {
  const q = live?.question;
  if (!q || busy) return;
  busy = true;
  app.classList.add('busy');
  const args = { p_question_id: q.id, p_voter_id: voterId, p_choice: null, p_rating: null, p_word: null, ...payload };
  let res;
  for (let attempt = 0; attempt < 3 && !res; attempt++) {
    try {
      res = await rpc('submit_vote', args);
    } catch {
      await sleep(600 * (attempt + 1));
    }
  }
  busy = false;
  app.classList.remove('busy');
  if (!res) {
    showStatus("Couldn't send. Check your connection and try again.", true);
    return;
  }
  if (!res.ok) {
    showStatus(ERRORS[res.error] || 'Something went wrong. Try again.', true);
    return;
  }
  const prev = getAnswer(q.id) || {};
  if (q.kind === 'word') setAnswer(q.id, { words: [...(prev.words || []), payload.p_word.trim()] });
  else setAnswer(q.id, payload.p_choice !== null && payload.p_choice !== undefined ? { choice: payload.p_choice } : { rating: payload.p_rating });
  if (navigator.vibrate) navigator.vibrate(30);
  render();
  if (q.kind === 'word') $('#word')?.focus();
}

function showStatus(message, isError) {
  const el = $('#status');
  if (!el) return;
  el.textContent = message;
  el.className = `status show ${isError ? 'error' : ''}`;
}

let lastResults = null;

async function startResults(q) {
  if (resultsFor === q.id) {
    if (lastResults?.qid === q.id) renderPhoneResults(q, lastResults.res);
    return;
  }
  resultsFor = q.id;
  while (resultsFor === q.id) {
    try {
      const res = await rpc('get_results', { p_question_id: q.id });
      if (resultsFor !== q.id) break;
      lastResults = { qid: q.id, res };
      renderPhoneResults(q, res);
    } catch {
      // keep the last results on screen
    }
    await sleep(5000 + Math.random() * 1500);
  }
}

function renderPhoneResults(q, res) {
  const el = $('#phone-results');
  if (!el || !res) return;
  if (res.kind === 'word') {
    el.innerHTML = `<h3>What the room said</h3><div class="chips">${res.words
      .slice(0, 20)
      .map((w) => `<span class="chip">${esc(w.w)} <b>${w.n}</b></span>`)
      .join('')}</div>`;
    return;
  }
  const labels = res.kind === 'choice' ? q.options : res.counts.map((_, i) => String(res.min + i));
  const max = Math.max(1, ...res.counts);
  el.innerHTML = `<h3>Live results · ${res.total} ${res.total === 1 ? 'response' : 'responses'}${res.kind === 'rating' && res.average ? ` · average ${res.average}` : ''}</h3>
    ${res.counts
      .map(
        (n, i) => `
      <div class="hbar"><span class="hlabel">${esc(labels[i])}</span>
        <span class="htrack"><span class="hfill" style="width:${(n / max) * 100}%;background:${PALETTE[i % PALETTE.length]}"></span></span>
        <span class="hcount">${n}</span></div>`,
      )
      .join('')}`;
}

app.addEventListener('click', (e) => {
  const choice = e.target.closest('[data-choice]');
  if (choice && !choice.disabled) submit({ p_choice: Number(choice.dataset.choice) });
  const rate = e.target.closest('[data-rating]');
  if (rate && !rate.disabled) submit({ p_rating: Number(rate.dataset.rating) });
});

app.addEventListener('submit', (e) => {
  e.preventDefault();
  const word = $('#word')?.value.trim();
  if (!word) return;
  const existing = (getAnswer(live?.question?.id)?.words || []).map((w) => w.toLowerCase());
  if (existing.includes(word.toLowerCase())) {
    showStatus('You already sent that one.', true);
    return;
  }
  submit({ p_word: word });
});

pollLoop();
