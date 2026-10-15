# Haptags Hub

The operations back office for Haptags LLP: leads, clients, projects, quotations, GST invoices,
payments, retainers, support and a client portal. It runs alongside the marketing site at
haptags.com, which stays as it is.

| Area | What it does |
|---|---|
| Dashboard | Money collected per month, outstanding and overdue, MRR, pipeline by stage, win rate, and the day's to-do list (new leads, follow-ups, overdue invoices, payments to verify, support, projects due, retainer upsells). |
| Leads | Every enquiry from the website API, the hosted `/start` form, WhatsApp, calls and referrals. Repeat enquiries merge into the open lead. Stages, follow-up dates, owner, and a call/WhatsApp/meeting log. One click creates the client and a quote. |
| Quotations | Numbered per financial year. Shared by link or WhatsApp, and the client accepts online, which marks the lead won. Converts to an invoice. |
| Invoices | GST tax invoices: CGST+SGST within Karnataka, IGST for other states, none when there's no GSTIN. Numbers are gap-free per FY (`HT/26-27/0001`), assigned on issue. Issued invoices can only be voided. Amount in words, print to PDF. |
| Payments | Razorpay (UPI/cards/net-banking) with signature checks and a webhook. A UPI QR with the amount pre-filled (no fees). Bank transfer. Clients can report a UTR, and the team confirms it. Partial payments and TDS are supported. Receipts are emailed. |
| Retainers | Monthly, quarterly, half-yearly or yearly plans that raise and email their own invoices. MRR tracking. A list of completed projects with no plan, to upsell. |
| Automation (hourly) | Marks invoices overdue, bills retainers, expires old quotes, and sends payment reminders 3 days before the due date, on the due date, then 3, 7, 14 and 30 days after. |
| Client portal | Projects with milestones, updates and files, invoices with Pay now, quotations to approve, and support tickets. Each client sees only their own data. |
| Team | Owner, admin and staff roles. Invites by email or a copyable link. Email log. |
| Chat | Public and private channels, 1:1 and group chats, files up to 8 MB (paste, drag or attach), @mentions, edit and delete, typing and online indicators, unread badges. **Call** starts a video call with everyone in the conversation and rings their tabs. |
| Meetings | Schedule with team members and outside guests. Invitations are emailed with a calendar invite (Gmail/Outlook Yes/No buttons, 10-minute alert). **Meet now** opens an instant room. Join links can be shared on WhatsApp. RSVP, edit, and cancel with notice. |
| Video room | Runs in the browser at `/meet/<link>`. Camera and mic check before joining, screen sharing, raise hand, reactions, in-call chat, and speaking indicators. Guests wait in a lobby until a team member admits them. Hosts can mute or remove people, or end the meeting for everyone. |
| Calendar | A month view of your meetings, project deadlines and lead follow-ups (yours or the whole team's). Click a day to schedule. |
| Announcements | Owners and admins post, with options to pin, mark important and email the team. They show on everyone's dashboard until read, and admins can see who has read each one. |

Notifications arrive live in any open Hub tab (toasts and badges), and as desktop notifications
when the tab is in the background.

### How the real-time parts work

- Browsers long-poll `/api/rt/poll`. This works through Hostinger's proxy, where WebSockets
  often don't. Events stay in memory for a few minutes, and the database stays the source of
  truth, so after a restart tabs reconnect and reload anything they missed.
- Video is peer-to-peer WebRTC: every participant connects to every other one, and the server
  only relays the connection handshake. That suits calls of up to about 6–8 people with video
  (more with cameras off).
- The real-time state lives in one Node process. Run the app as a single instance.
- STUN servers (Cloudflare and Google) let most networks connect directly. A few corporate and
  mobile networks block that. For those, add a TURN relay with `TURN_URL`, `TURN_USERNAME` and
  `TURN_CREDENTIAL`, for example a self-hosted coturn or a hosted provider.

## Run locally

```bash
npm install
npm run seed-demo      # optional demo data (SQLite only)
npm run dev            # http://localhost:3000
npm test               # end-to-end flows
```

Demo sign-ins: `demo@haptags.local` (owner), `staff@haptags.local` (staff) and `client@haptags.local`,
all with the password `demo-password-123`. To try a call, open a meeting in one browser and its
link in a private window.

Without `DB_HOST` the app uses SQLite at `data/hub.sqlite`. With `DB_HOST` it uses MySQL. Migrations
run automatically on start.

## Deploy (Hostinger Node.js)

1. Create a website for `hub.haptags.com` and a MySQL database for it.
2. Upload this folder as a zip, without `node_modules` or `data`. Use app type Express,
   entry file `server.js` and Node 22.
3. Set the environment variables from `.env.example`. The essentials are `NODE_ENV`, `BASE_URL`,
   `SESSION_SECRET`, `DB_*`, and `ADMIN_*` for the first run.
4. Sign in, change the password under **My account**, and fill in **Settings**: GSTIN, bank, UPI ID
   and terms.

## Connect the haptags.com enquiry form

The live site's `/api/lead` handler can forward each enquiry server-to-server. Keep the key on the
server; it is under Settings → Integrations.

```php
// After the lead is saved in /api/lead:
$ch = curl_init('https://hub.haptags.com/api/v1/leads');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_TIMEOUT => 5,
  CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . getenv('HUB_LEAD_KEY')],
  CURLOPT_POSTFIELDS => json_encode([
    'name' => $name, 'email' => $email, 'phone' => $phone, 'company' => $company,
    'service' => $service, 'budget' => $budget, 'timeline' => $timeline,
    'message' => $message, 'source' => 'website', 'source_detail' => $kind,
  ]),
]);
curl_exec($ch);
curl_close($ch);
```

The field names match the existing form (`service`, `budget` and `timeline` values included). The
API answers `201` for a new lead and `200` with `duplicate: true` when the enquiry merged into an
open lead.

## Razorpay

1. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`. A **Pay online** button then appears on unpaid
   invoices.
2. Under Webhooks, add `https://hub.haptags.com/webhooks/razorpay` with the event `payment.captured`.
   Use the same secret as `RAZORPAY_WEBHOOK_SECRET`. The webhook records payments even if the
   client closes the browser, and it never double-counts.

## Code map

```
server.js                 start: migrate → owner bootstrap → listen → scheduler
src/app.js                security headers, sessions, layouts, routing
src/migrations/           schema (money in paise, dates as YYYY-MM-DD)
src/lib/billing.js        numbering, GST, invoice status, payments, quote/retainer → invoice
src/lib/automation.js     hourly jobs (overdue, retainers, reminders, quote expiry)
src/lib/leads.js          enquiry validation, de-duplication, notifications
src/routes/public.js      /start, lead API, shareable invoice/quote pages, Razorpay
src/routes/admin/*        team back office
src/routes/portal.js      client portal
src/views/                EJS templates (partials/document.ejs = invoice/quote layout)
test/flows.test.js        end-to-end tests
```
