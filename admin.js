import { sb, voteUrl, displayUrl, qrDataUrl, rpc, esc, $, ratingRange, PALETTE, toast } from './common.js';
import { DEFAULT_POLL } from './config.js';

const app = $('#app');
const state = { polls: [], poll: null, questions: [], editing: null, results: {}, liveTimer: null };

const KIND_LABEL = { choice: 'Multiple choice', rating: 'Rating', word: 'Word cloud' };

let bootedFor = null;

// Supabase recommends not calling other client methods inside this callback, so defer the work.
sb.auth.onAuthStateChange((event, session) => {
  if (!['SIGNED_IN', 'SIGNED_OUT', 'INITIAL_SESSION'].includes(event)) return;
  const who = session?.user?.id || 'anon';
  if (who === bootedFor) return;
  bootedFor = who;
  setTimeout(boot, 0);
});

async function boot() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return renderSignIn();
  if (location.hash.includes('access_token')) history.replaceState(null, '', location.pathname + location.search);
  $('#who').innerHTML = `${esc(data.session.user.email)} · <a href="#" id="signout">Sign out</a>`;
  $('#signout').onclick = async (e) => {
    e.preventDefault();
    await sb.auth.signOut();
  };
  let admin = false;
  try {
    admin = await rpc('is_admin');
  } catch {
    admin = false;
  }
  if (!admin) {
    app.innerHTML = `<div class="card center"><h2>Not an admin</h2><p class="muted">${esc(data.session.user.email)} isn't on the admin list for this poll app.</p></div>`;
    return;
  }
  await loadPolls();
}

function renderSignIn(sentTo) {
  $('#who').textContent = '';
  const email = sentTo || localStorage.getItem('live-poll-admin-email') || '';
  app.innerHTML = `
    <div class="card narrow">
      <h2>Sign in</h2>
      ${
        sentTo
          ? `<p>Enter the sign-in code sent to <b>${esc(sentTo)}</b>, or click the link in that email.</p>
             <form id="verify" class="stack">
               <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" required>
               <button class="primary">Sign in</button>
               <a href="#" id="back" class="small">Use a different email</a>
             </form>`
          : `<p class="muted">Admins only. We'll email you a sign-in code.</p>
             <form id="send" class="stack">
               <input id="email" type="email" autocomplete="email" value="${esc(email)}" placeholder="you@example.com" required>
               <button class="primary">Email me a code</button>
               <a href="#" id="have-code" class="small">I already have a code</a>
             </form>`
      }
    </div>`;
  if (sentTo) {
    $('#code').focus();
    $('#back').onclick = (e) => {
      e.preventDefault();
      renderSignIn();
    };
    $('#verify').onsubmit = async (e) => {
      e.preventDefault();
      const { error } = await sb.auth.verifyOtp({ email: sentTo, token: $('#code').value.trim(), type: 'email' });
      if (error) toast(error.message, 'error');
    };
  } else {
    $('#have-code').onclick = (e) => {
      e.preventDefault();
      const addr = $('#email').value.trim().toLowerCase();
      if (!addr) return toast('Enter your email first.', 'error');
      localStorage.setItem('live-poll-admin-email', addr);
      renderSignIn(addr);
    };
    $('#send').onsubmit = async (e) => {
      e.preventDefault();
      const addr = $('#email').value.trim().toLowerCase();
      localStorage.setItem('live-poll-admin-email', addr);
      const { error } = await sb.auth.signInWithOtp({
        email: addr,
        options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
      });
      if (error) return toast(error.message, 'error');
      renderSignIn(addr);
    };
  }
}

async function loadPolls(selectCode) {
  const { data, error } = await sb.from('polls').select('*').order('created_at');
  if (error) return toast(error.message, 'error');
  state.polls = data;
  const want = selectCode || new URLSearchParams(location.search).get('p') || state.poll?.code || DEFAULT_POLL;
  state.poll = data.find((p) => p.code === want) || data[0] || null;
  if (state.poll) {
    const url = new URL(location.href);
    url.searchParams.set('p', state.poll.code);
    history.replaceState(null, '', url);
  }
  await loadQuestions();
}

async function loadQuestions() {
  state.questions = [];
  if (state.poll) {
    const { data, error } = await sb.from('questions').select('*').eq('poll_id', state.poll.id).order('position').order('created_at');
    if (error) return toast(error.message, 'error');
    state.questions = data;
    const results = await Promise.all(data.map((q) => rpc('get_results', { p_question_id: q.id }).catch(() => null)));
    state.results = Object.fromEntries(data.map((q, i) => [q.id, results[i]]));
  }
  render();
  startLiveRefresh();
}

async function refreshPoll() {
  const { data } = await sb.from('polls').select('*').eq('id', state.poll.id).single();
  if (data) state.poll = data;
}

function render() {
  const poll = state.poll;
  const pollOptions = state.polls.map((p) => `<option value="${esc(p.code)}" ${p.id === poll?.id ? 'selected' : ''}>${esc(p.title)} (${esc(p.code)})</option>`).join('');
  if (!poll) {
    app.innerHTML = `<div class="card"><h2>No polls yet</h2>${newPollForm()}</div>`;
    bindNewPoll();
    return;
  }
  const audience = voteUrl(poll.code);
  const presenter = new URL(`present.html?p=${encodeURIComponent(poll.code)}`, location.href).href;
  app.innerHTML = `
    <section class="card poll-card">
      <div class="row between wrap">
        <label class="row gap">Poll <select id="poll-select">${pollOptions}</select></label>
        <button id="new-poll" class="ghost">+ New poll</button>
      </div>
      <div id="new-poll-box"></div>
      <div class="row gap wrap top">
        <img class="qr-mini" src="${qrDataUrl(audience, 5, 1)}" alt="QR code for audience link">
        <div class="stack grow">
          <label>Title <input id="poll-title" value="${esc(poll.title)}" maxlength="120"></label>
          <div>Audience link: <a href="${esc(audience)}" target="_blank" rel="noopener">${esc(displayUrl(audience))}</a> <button class="link" data-copy="${esc(audience)}">Copy</button></div>
          <div>Presenter screen: <a href="${esc(presenter)}" target="_blank" rel="noopener">${esc(displayUrl(presenter))}</a></div>
          <div class="row gap wrap">
            <label class="toggle"><input type="checkbox" id="show-phones" ${poll.show_results_on_phones ? 'checked' : ''}> Show results on phones after voting</label>
            <button id="join-screen" class="${poll.active_question_id ? '' : 'primary'}">${poll.active_question_id ? 'Show join screen' : 'Join screen is showing'}</button>
          </div>
        </div>
      </div>
    </section>
    <section>
      <div class="row between"><h2>Questions</h2><button id="add-q" class="primary">+ Add question</button></div>
      <div id="questions">${state.questions.map((q, i) => (state.editing === q.id ? editor(q) : questionCard(q, i))).join('')}</div>
      ${state.editing === 'new' ? editor(null) : ''}
      ${state.questions.length ? '' : '<p class="muted">No questions yet.</p>'}
    </section>`;
  bindPoll();
}

function questionCard(q, i) {
  const live = state.poll.active_question_id === q.id;
  const res = state.results[q.id];
  const total = res?.total ?? 0;
  let detail = '';
  if (q.kind === 'choice') detail = q.options.map((o, j) => `<span class="chip" style="border-color:${PALETTE[j % PALETTE.length]}">${esc(o)}${res ? ` · ${res.counts[j] ?? 0}` : ''}</span>`).join(' ');
  if (q.kind === 'rating') {
    const r = ratingRange(q.options);
    detail = `<span class="muted">${r.min}–${r.max}${r.minLabel ? ` · ${esc(r.minLabel)} → ${esc(r.maxLabel)}` : ''}${res?.average ? ` · average ${res.average}` : ''}</span>`;
  }
  if (q.kind === 'word' && res?.words?.length) {
    detail = `<div class="chips">${res.words
      .slice(0, 40)
      .map((w) => `<span class="chip">${esc(w.w)} <b>${w.n}</b> <button class="link danger" data-hide="${esc(w.w)}" data-q="${q.id}" title="Hide this answer">✕</button></span>`)
      .join('')}</div>`;
  }
  return `
    <div class="card q-card ${live ? 'live' : ''}" data-id="${q.id}">
      <div class="row between wrap">
        <div class="row gap"><span class="qnum">${i + 1}</span><span class="badge">${KIND_LABEL[q.kind]}</span>
          ${live ? '<span class="badge live-badge">● Live</span>' : ''}
          ${q.is_open ? '' : '<span class="badge">Closed</span>'}
          <span class="muted small">${total} ${q.kind === 'word' ? 'people answered' : total === 1 ? 'response' : 'responses'}</span></div>
        <div class="row gap wrap actions">
          ${live ? '' : `<button class="primary" data-act="live">Go live</button>`}
          <button data-act="toggle">${q.is_open ? 'Close voting' : 'Open voting'}</button>
          <button data-act="edit">Edit</button>
          <button data-act="up" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button data-act="down" ${i === state.questions.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          <button data-act="reset" class="danger">Reset votes</button>
          <button data-act="delete" class="danger">Delete</button>
        </div>
      </div>
      <h3>${esc(q.prompt)}</h3>
      <div>${detail}</div>
    </div>`;
}

function editor(q) {
  const kind = q?.kind || 'choice';
  const r = ratingRange(q?.kind === 'rating' ? q.options : {});
  return `
    <form class="card editor stack" data-id="${q?.id || 'new'}">
      <h3>${q ? 'Edit question' : 'New question'}</h3>
      <label>Type
        <select name="kind">
          ${Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </label>
      <label>Question <textarea name="prompt" maxlength="300" rows="2" required>${esc(q?.prompt || '')}</textarea></label>
      <label class="for-choice">Options, one per line (2 to 8)
        <textarea name="options" rows="5">${q?.kind === 'choice' ? esc(q.options.join('\n')) : ''}</textarea></label>
      <div class="for-rating row gap wrap">
        <label>From <input name="min" type="number" value="${r.min}" min="0" max="10"></label>
        <label>To <input name="max" type="number" value="${r.max}" min="1" max="10"></label>
        <label class="grow">Low label <input name="min_label" value="${esc(r.minLabel)}" maxlength="40"></label>
        <label class="grow">High label <input name="max_label" value="${esc(r.maxLabel)}" maxlength="40"></label>
      </div>
      <p class="for-word muted small">People can send up to 3 short answers (30 characters each). You can hide answers from the cloud.</p>
      <div class="row gap"><button class="primary">Save</button><button type="button" data-act="cancel">Cancel</button></div>
    </form>`;
}

function syncEditorKind(form) {
  const kind = form.elements.kind.value;
  form.querySelectorAll('.for-choice, .for-rating, .for-word').forEach((el) => {
    el.hidden = !el.classList.contains(`for-${kind}`);
  });
}

function newPollForm() {
  return `<form id="new-poll-form" class="row gap wrap top">
    <label>Code <input name="code" pattern="[a-z0-9-]{2,32}" placeholder="rt53" required title="2-32 lowercase letters, digits, or dashes"></label>
    <label class="grow">Title <input name="title" maxlength="120" required></label>
    <button class="primary">Create poll</button></form>`;
}

function bindNewPoll() {
  const form = $('#new-poll-form');
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const code = form.elements.code.value.trim().toLowerCase();
    const { error } = await sb.from('polls').insert({ code, title: form.elements.title.value.trim() });
    if (error) return toast(error.message, 'error');
    await loadPolls(code);
  };
}

function bindPoll() {
  $('#poll-select').onchange = (e) => loadPolls(e.target.value);
  $('#new-poll').onclick = () => {
    $('#new-poll-box').innerHTML = newPollForm();
    bindNewPoll();
  };
  $('#poll-title').onchange = async (e) => {
    const { error } = await sb.from('polls').update({ title: e.target.value.trim() }).eq('id', state.poll.id);
    if (error) return toast(error.message, 'error');
    toast('Title saved');
    await loadPolls(state.poll.code);
  };
  $('#show-phones').onchange = async (e) => {
    const { error } = await sb.from('polls').update({ show_results_on_phones: e.target.checked }).eq('id', state.poll.id);
    if (error) toast(error.message, 'error');
    await refreshPoll();
  };
  $('#join-screen').onclick = () => setActive(null);
  $('#add-q').onclick = () => {
    state.editing = 'new';
    render();
    $('form.editor textarea[name=prompt]')?.focus();
  };
  app.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Link copied'));
  });
  app.querySelectorAll('form.editor').forEach((form) => {
    syncEditorKind(form);
    form.elements.kind.onchange = () => syncEditorKind(form);
    form.querySelector('[data-act=cancel]').onclick = () => {
      state.editing = null;
      render();
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      saveQuestion(form);
    };
  });
  app.querySelectorAll('.q-card [data-act]').forEach((b) => {
    b.onclick = () => questionAction(b.closest('.q-card').dataset.id, b.dataset.act);
  });
  app.querySelectorAll('[data-hide]').forEach((b) => {
    b.onclick = () => hideWord(b.dataset.q, b.dataset.hide);
  });
}

async function saveQuestion(form) {
  const kind = form.elements.kind.value;
  const prompt = form.elements.prompt.value.trim();
  let options = [];
  if (kind === 'choice') {
    options = form.elements.options.value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (options.length < 2 || options.length > 8) return toast('Add between 2 and 8 options.', 'error');
  } else if (kind === 'rating') {
    const min = parseInt(form.elements.min.value, 10);
    const max = parseInt(form.elements.max.value, 10);
    if (!(min >= 0 && max <= 10 && max > min)) return toast('Rating range must be within 0–10, with To greater than From.', 'error');
    options = { min, max, min_label: form.elements.min_label.value.trim(), max_label: form.elements.max_label.value.trim() };
  }
  const id = form.dataset.id;
  const row = { kind, prompt, options };
  let error;
  if (id === 'new') {
    const position = state.questions.reduce((m, q) => Math.max(m, q.position), 0) + 10;
    ({ error } = await sb.from('questions').insert({ ...row, poll_id: state.poll.id, position }));
  } else {
    const old = state.questions.find((q) => q.id === id);
    if (old.kind !== kind && state.results[id]?.total) {
      if (!confirm('Changing the type clears this question’s votes. Continue?')) return;
      await sb.from('votes').delete().eq('question_id', id);
    }
    ({ error } = await sb.from('questions').update(row).eq('id', id));
  }
  if (error) return toast(error.message, 'error');
  state.editing = null;
  await loadQuestions();
}

async function questionAction(id, act) {
  const q = state.questions.find((x) => x.id === id);
  const idx = state.questions.indexOf(q);
  let error;
  if (act === 'live') {
    return setActive(id);
  } else if (act === 'toggle') {
    ({ error } = await sb.from('questions').update({ is_open: !q.is_open }).eq('id', id));
  } else if (act === 'edit') {
    state.editing = id;
    return render();
  } else if (act === 'up' || act === 'down') {
    const other = state.questions[act === 'up' ? idx - 1 : idx + 1];
    const ordered = state.questions.map((x, i) => ({ id: x.id, position: (i + 1) * 10 }));
    const a = ordered[idx];
    const b = ordered.find((x) => x.id === other.id);
    [a.position, b.position] = [b.position, a.position];
    for (const row of ordered) {
      const res = await sb.from('questions').update({ position: row.position }).eq('id', row.id);
      if (res.error) error = res.error;
    }
  } else if (act === 'reset') {
    if (!confirm(`Delete all votes for “${q.prompt}”?`)) return;
    ({ error } = await sb.from('votes').delete().eq('question_id', id));
  } else if (act === 'delete') {
    if (!confirm(`Delete the question “${q.prompt}” and its votes?`)) return;
    ({ error } = await sb.from('questions').delete().eq('id', id));
  }
  if (error) return toast(error.message, 'error');
  await refreshPoll();
  await loadQuestions();
}

async function setActive(questionId) {
  const { error } = await sb.from('polls').update({ active_question_id: questionId }).eq('id', state.poll.id);
  if (error) return toast(error.message, 'error');
  if (questionId) await sb.from('questions').update({ is_open: true }).eq('id', questionId).eq('is_open', false);
  await refreshPoll();
  await loadQuestions();
  toast(questionId ? 'Question is live' : 'Showing the join screen');
}

async function hideWord(questionId, word) {
  const pattern = word.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { error } = await sb.from('votes').update({ hidden: true }).eq('question_id', questionId).ilike('word', pattern);
  if (error) return toast(error.message, 'error');
  toast(`Hidden “${word}”`);
  await loadQuestions();
}

function startLiveRefresh() {
  clearInterval(state.liveTimer);
  state.liveTimer = setInterval(async () => {
    if (document.visibilityState !== 'visible' || state.editing || !state.poll?.active_question_id) return;
    const id = state.poll.active_question_id;
    const res = await rpc('get_results', { p_question_id: id }).catch(() => null);
    if (!res || JSON.stringify(res) === JSON.stringify(state.results[id])) return;
    state.results[id] = res;
    const card = app.querySelector(`.q-card[data-id="${id}"]`);
    const idx = state.questions.findIndex((q) => q.id === id);
    if (card && idx >= 0) {
      card.outerHTML = questionCard(state.questions[idx], idx);
      bindPoll();
    }
  }, 2000);
}
