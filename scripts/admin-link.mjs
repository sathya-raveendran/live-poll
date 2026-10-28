// Backup admin sign-in: prints a one-time sign-in link and code without sending email.
// Run: node --env-file=.env.local scripts/admin-link.mjs [email] [redirect-url]
const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
const email = process.argv[2] || 'saraveen@microsoft.com';
const redirectTo = process.argv[3] || 'https://sathya-raveendran.github.io/live-poll/admin.html';

const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
  method: 'POST',
  headers: { apikey: SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'magiclink', email, redirect_to: redirectTo }),
});
const data = await res.json();
if (!res.ok) {
  console.error('Failed:', data.msg || data.message || JSON.stringify(data));
  process.exit(1);
}
const props = data.properties || data;
console.log(`Sign-in link (open once, expires in 1 hour):\n${props.action_link}\n`);
if (props.email_otp) console.log(`Or on the admin page choose "I already have a code" and type: ${props.email_otp}`);
