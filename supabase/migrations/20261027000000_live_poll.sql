-- Live poll schema: audience votes anonymously through RPCs; only allow-listed admins edit polls.

create table public.admins (
  email text primary key check (email = lower(email))
);

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.admins
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create table public.polls (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9-]{2,32}$'),
  title text not null check (length(title) between 1 and 120),
  active_question_id uuid,
  show_results_on_phones boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.questions (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls(id) on delete cascade,
  position int not null default 0,
  kind text not null check (kind in ('choice', 'word', 'rating')),
  prompt text not null check (length(prompt) between 1 and 300),
  -- choice: ["A", "B", ...]; rating: {"min":1,"max":5,"min_label":"","max_label":""}; word: []
  options jsonb not null default '[]'::jsonb,
  is_open boolean not null default true,
  created_at timestamptz not null default now()
);
create index questions_poll_idx on public.questions (poll_id, position);

alter table public.polls
  add constraint polls_active_question_fk
  foreign key (active_question_id) references public.questions(id) on delete set null;

create table public.votes (
  id bigint generated always as identity primary key,
  question_id uuid not null references public.questions(id) on delete cascade,
  voter_id uuid not null,
  choice smallint,
  rating smallint,
  word text,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index votes_question_idx on public.votes (question_id);
create unique index votes_one_answer_per_voter on public.votes (question_id, voter_id) where word is null;
create unique index votes_unique_word_per_voter on public.votes (question_id, voter_id, lower(word)) where word is not null;

-- Row-level security: anonymous users have no direct table access; admins manage everything.
alter table public.admins enable row level security;
alter table public.polls enable row level security;
alter table public.questions enable row level security;
alter table public.votes enable row level security;

revoke all on public.admins, public.polls, public.questions, public.votes from anon;
grant select, insert, update, delete on public.polls, public.questions, public.votes to authenticated;

create policy polls_admin_all on public.polls for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy questions_admin_all on public.questions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy votes_admin_all on public.votes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Public: the poll's current state, polled by phones and the presenter screen.
create or replace function public.get_live(p_code text)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'poll', jsonb_build_object(
      'code', p.code,
      'title', p.title,
      'show_results_on_phones', p.show_results_on_phones
    ),
    'question', case when q.id is null then null else jsonb_build_object(
      'id', q.id,
      'kind', q.kind,
      'prompt', q.prompt,
      'options', q.options,
      'is_open', q.is_open,
      'number', (select count(*) from public.questions q2
                 where q2.poll_id = p.id and (q2.position, q2.created_at) <= (q.position, q.created_at)),
      'total', (select count(*) from public.questions q3 where q3.poll_id = p.id)
    ) end
  )
  from public.polls p
  left join public.questions q on q.id = p.active_question_id
  where p.code = lower(p_code);
$$;

-- Public: submit or change a vote on the active, open question.
create or replace function public.submit_vote(
  p_question_id uuid,
  p_voter_id uuid,
  p_choice int default null,
  p_rating int default null,
  p_word text default null
)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  q public.questions;
  v_word text;
  v_count int;
begin
  select q0.* into q
  from public.questions q0
  join public.polls p on p.active_question_id = q0.id
  where q0.id = p_question_id;

  if q.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_active');
  end if;
  if not q.is_open then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;

  if q.kind = 'choice' then
    if p_choice is null or p_choice < 0 or p_choice >= jsonb_array_length(q.options) then
      return jsonb_build_object('ok', false, 'error', 'invalid_choice');
    end if;
    insert into public.votes (question_id, voter_id, choice)
    values (q.id, p_voter_id, p_choice)
    on conflict (question_id, voter_id) where word is null
    do update set choice = excluded.choice, updated_at = now();

  elsif q.kind = 'rating' then
    if p_rating is null
       or p_rating < coalesce((q.options ->> 'min')::int, 1)
       or p_rating > coalesce((q.options ->> 'max')::int, 5) then
      return jsonb_build_object('ok', false, 'error', 'invalid_rating');
    end if;
    insert into public.votes (question_id, voter_id, rating)
    values (q.id, p_voter_id, p_rating)
    on conflict (question_id, voter_id) where word is null
    do update set rating = excluded.rating, updated_at = now();

  else
    v_word := btrim(regexp_replace(coalesce(p_word, ''), '\s+', ' ', 'g'));
    if length(v_word) < 1 or length(v_word) > 30 then
      return jsonb_build_object('ok', false, 'error', 'invalid_word');
    end if;
    select count(*) into v_count from public.votes
    where question_id = q.id and voter_id = p_voter_id and word is not null;
    if v_count >= 3 then
      return jsonb_build_object('ok', false, 'error', 'word_limit');
    end if;
    insert into public.votes (question_id, voter_id, word)
    values (q.id, p_voter_id, v_word)
    on conflict do nothing;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- Public: aggregate results only; individual votes are never exposed.
create or replace function public.get_results(p_question_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  q public.questions;
  v_min int;
  v_max int;
begin
  select * into q from public.questions where id = p_question_id;
  if q.id is null then
    return null;
  end if;

  if q.kind = 'choice' then
    return jsonb_build_object(
      'kind', 'choice',
      'total', (select count(*) from public.votes where question_id = q.id),
      'counts', (
        select coalesce(jsonb_agg(coalesce(c.n, 0) order by i.idx), '[]'::jsonb)
        from generate_series(0, jsonb_array_length(q.options) - 1) as i(idx)
        left join (
          select choice, count(*) as n from public.votes
          where question_id = q.id group by choice
        ) c on c.choice = i.idx
      )
    );
  elsif q.kind = 'rating' then
    v_min := coalesce((q.options ->> 'min')::int, 1);
    v_max := coalesce((q.options ->> 'max')::int, 5);
    return jsonb_build_object(
      'kind', 'rating',
      'min', v_min,
      'max', v_max,
      'total', (select count(*) from public.votes where question_id = q.id),
      'average', (select round(avg(rating)::numeric, 2) from public.votes where question_id = q.id),
      'counts', (
        select jsonb_agg(coalesce(c.n, 0) order by i.val)
        from generate_series(v_min, v_max) as i(val)
        left join (
          select rating, count(*) as n from public.votes
          where question_id = q.id group by rating
        ) c on c.rating = i.val
      )
    );
  else
    return jsonb_build_object(
      'kind', 'word',
      'total', (select count(distinct voter_id) from public.votes where question_id = q.id),
      'words', (
        select coalesce(jsonb_agg(jsonb_build_object('w', w, 'n', n) order by n desc, w), '[]'::jsonb)
        from (
          select lower(word) as w, count(*) as n from public.votes
          where question_id = q.id and not hidden
          group by lower(word)
          order by count(*) desc, lower(word)
          limit 80
        ) t
      )
    );
  end if;
end;
$$;

revoke execute on function public.get_live(text), public.submit_vote(uuid, uuid, int, int, text),
  public.get_results(uuid), public.is_admin() from public;
grant execute on function public.get_live(text), public.submit_vote(uuid, uuid, int, int, text),
  public.get_results(uuid) to anon, authenticated;
grant execute on function public.is_admin() to authenticated;
