import { sb, pollCode, voteUrl, displayUrl, qrDataUrl, rpc, esc, $, ratingRange, PALETTE, sleep, toast } from './common.js';

const code = pollCode();
const joinHref = voteUrl(code);
const main = $('#main');

let live = null;
let built = '';
let hidden = false;
let isAdmin = false;
let lastResultsJson = '';

$('#join-url').textContent = displayUrl(joinHref);
$('#join-url-big').textContent = displayUrl(joinHref);
$('#qr-small').src = qrDataUrl(joinHref, 4, 1);
$('#qr-big').src = qrDataUrl(joinHref, 12, 2);

async function loop() {
  for (;;) {
    const started = Date.now();
    try {
      live = await rpc('get_live', { p_code: code });
      update();
      const q = live?.question;
      if (q) {
        const res = await rpc('get_results', { p_question_id: q.id });
        if (live?.question?.id === q.id) drawResults(q, res);
      }
      setConn(true);
    } catch {
      setConn(false);
    }
    await sleep(Math.max(250, 1000 - (Date.now() - started)));
  }
}

function setConn(ok) {
  const el = $('#conn');
  el.className = `conn ${ok ? 'ok' : 'bad'}`;
  el.title = ok ? 'Live' : 'Reconnecting…';
}

function update() {
  if (!live) {
    if (built !== 'missing') {
      built = 'missing';
      main.innerHTML = `<div class="center"><h1>Poll “${esc(code)}” not found</h1><p class="muted">Check the poll code in the address.</p></div>`;
    }
    return;
  }
  $('#title').textContent = live.poll.title;
  document.title = `${live.poll.title} · presenter`;
  const q = live.question;
  $('#qnum').textContent = q ? `· ${q.number} of ${q.total}` : '';
  $('#closed').hidden = !q || q.is_open;
  $('#join-small').style.visibility = q ? 'visible' : 'hidden';

  const key = q ? `${q.id}|${q.kind}|${JSON.stringify(q.options)}|${q.prompt}` : 'join';
  if (key === built) return;
  built = key;
  lastResultsJson = '';
  if (!q) {
    $('#count').textContent = '';
    main.innerHTML = `
      <div class="join-screen">
        <h1>${esc(live.poll.title)}</h1>
        <img class="join-qr" src="${qrDataUrl(joinHref, 12, 2)}" alt="QR code to join">
        <p class="join-text">Scan, or go to <b>${esc(displayUrl(joinHref))}</b></p>
        <p class="muted">No sign-in needed. Your answers are anonymous.</p>
      </div>`;
    return;
  }
  main.innerHTML = `<h1 class="p-prompt">${esc(q.prompt)}</h1><div id="chart" class="chart kind-${q.kind}"></div><div id="veil" class="veil" hidden>Results hidden</div>`;
  const chart = $('#chart');
  if (q.kind === 'choice' || q.kind === 'rating') {
    let labels = q.options;
    let foot = '';
    if (q.kind === 'rating') {
      const { min, max, minLabel, maxLabel } = ratingRange(q.options);
      labels = [];
      for (let v = min; v <= max; v++) labels.push(String(v));
      foot = `<div class="rating-foot muted"><span>${esc(minLabel)}</span><span id="avg" class="avg"></span><span>${esc(maxLabel)}</span></div>`;
    }
    chart.innerHTML = `<div class="cols">${labels
      .map(
        (label, i) => `
        <div class="col">
          <div class="val"><b>0</b><span></span></div>
          <div class="bar-wrap"><div class="bar" style="background:${PALETTE[i % PALETTE.length]}"></div></div>
          <div class="lbl">${esc(label)}</div>
        </div>`,
      )
      .join('')}</div>${foot}`;
  }
  applyHidden();
}

function drawResults(q, res) {
  if (!res) return;
  const json = JSON.stringify(res);
  if (json === lastResultsJson) return;
  lastResultsJson = json;
  $('#count').textContent = `${res.total} ${res.total === 1 ? 'response' : 'responses'}`;

  if (res.kind === 'word') {
    drawCloud(res.words);
    return;
  }
  const counts = res.counts || [];
  const max = Math.max(1, ...counts);
  const sum = counts.reduce((a, b) => a + b, 0);
  document.querySelectorAll('#chart .col').forEach((col, i) => {
    const n = counts[i] || 0;
    col.querySelector('.bar').style.height = `${(n / max) * 100}%`;
    col.querySelector('.val b').textContent = n;
    col.querySelector('.val span').textContent = sum ? ` ${Math.round((n / sum) * 100)}%` : '';
  });
  const avg = $('#avg');
  if (avg) avg.textContent = res.average ? `Average ${Number(res.average).toFixed(1)}` : '';
}

function drawCloud(words) {
  const chart = $('#chart');
  if (!words.length) {
    chart.innerHTML = '<div class="center muted">Answers will appear here…</div>';
    return;
  }
  const maxN = words[0].n;
  // Centre-out ordering so the biggest words sit in the middle.
  const ordered = [];
  words.forEach((w, i) => (i % 2 ? ordered.push(w) : ordered.unshift(w)));
  chart.innerHTML = `<div class="cloud">${ordered
    .map((w) => {
      const size = 1.4 + 5.2 * Math.sqrt(w.n / maxN);
      const color = PALETTE[hash(w.w) % PALETTE.length];
      return `<span class="word" style="font-size:${size.toFixed(2)}vw;color:${color}" title="${w.n}" data-word="${esc(w.w)}">${esc(w.w)}</span>`;
    })
    .join('')}</div>`;
}

function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

function applyHidden() {
  const veil = $('#veil');
  const chart = $('#chart');
  if (veil) veil.hidden = !hidden;
  if (chart) chart.style.visibility = hidden ? 'hidden' : 'visible';
}

async function checkAdmin() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return;
  try {
    isAdmin = await rpc('is_admin');
  } catch {
    isAdmin = false;
  }
  if (isAdmin) $('#admin-keys').textContent = ' · → next · ← back · C open/close · J join screen · R results on phones';
}

async function questionsInOrder() {
  const { data: poll } = await sb.from('polls').select('id').eq('code', code).single();
  const { data, error } = await sb.from('questions').select('id').eq('poll_id', poll.id).order('position').order('created_at');
  if (error) throw error;
  return { pollId: poll.id, ids: data.map((r) => r.id) };
}

async function adminAction(key) {
  try {
    const { pollId, ids } = await questionsInOrder();
    const current = live?.question?.id;
    const idx = ids.indexOf(current);
    if (key === 'ArrowRight' || key === 'PageDown' || key === ' ') {
      const next = idx < 0 ? ids[0] : ids[idx + 1];
      if (!next) return toast('That was the last question.');
      await setActive(pollId, next);
    } else if (key === 'ArrowLeft' || key === 'PageUp') {
      if (idx <= 0) return toast('This is the first question.');
      await setActive(pollId, ids[idx - 1]);
    } else if (key === 'j') {
      await setActive(pollId, null);
    } else if (key === 'c' && current) {
      const { error } = await sb.from('questions').update({ is_open: !live.question.is_open }).eq('id', current);
      if (error) throw error;
      toast(live.question.is_open ? 'Voting closed' : 'Voting open');
    } else if (key === 'r') {
      const { error } = await sb.from('polls').update({ show_results_on_phones: !live.poll.show_results_on_phones }).eq('id', pollId);
      if (error) throw error;
      toast(live.poll.show_results_on_phones ? 'Results hidden on phones' : 'Results shown on phones');
    }
  } catch (e) {
    toast(`Couldn't update: ${e.message || e}`, 'error');
  }
}

async function setActive(pollId, questionId) {
  const { error } = await sb.from('polls').update({ active_question_id: questionId }).eq('id', pollId);
  if (error) throw error;
}

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  } else if (key === 'q') {
    $('#qr-overlay').hidden = !$('#qr-overlay').hidden;
  } else if (key === 'h') {
    hidden = !hidden;
    applyHidden();
  } else if (key === 'Escape') {
    $('#qr-overlay').hidden = true;
  } else if (isAdmin && ['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp', ' ', 'j', 'c', 'r'].includes(key)) {
    e.preventDefault();
    adminAction(key);
  }
});

$('#qr-overlay').addEventListener('click', () => ($('#qr-overlay').hidden = true));
$('#join-small').addEventListener('click', () => ($('#qr-overlay').hidden = false));

checkAdmin();
loop();
