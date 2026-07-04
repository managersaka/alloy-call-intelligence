// Seed kb_entries from the Communication Response Protocol v2 templates.
// Idempotent (INSERT OR IGNORE on taxonomy_id). Status stays 'draft' where the
// protocol has [VERIFY] items; flip to 'approved' as Prashant signs them off.
import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.env.DB_PATH || './data/calls.db');

const E = [
  ['G1.pricing', 'How much does it cost?', 'Depends on frequency — most do 2-3x/week, coach-led small group (max 6). Sessions as low as $X/session billed every 4 weeks (2x/week ≈ $Y/month). No initiation fee, no long-term contract. First session complimentary. [VERIFY rate card]', 'Give all three framings unprompted: per session, per month, billing structure. Anchor vs 1-on-1 ($100-120/session). Bridge to complimentary first session.', '1.3 / 1.4'],
  ['G1.how_it_works', 'Do you have classes / how does it work?', 'Small group personal training — max 6 per session, always coach-led. Every workout customized (movement screen day 1), with group energy and price point. You pick set days/times. First session complimentary.', 'Not classes with 30 people, not solo 1-on-1 pricing. Never more than 6, coach-led, everything modified to you. Pick consistent slots like a class; the workout is personal training.', '1.5 / 1.6'],
  ['G1.schedule_hours', 'What times do you have?', 'Sessions run 6-11am and 4-7pm+ Mon-Fri [VERIFY weekend]. Pick consistent slots, most do 2-3x/week, flexibility when life happens.', 'Convert class-schedule thinking to slot terms.', '1.7'],
  ['G1.location', 'Where are you located?', 'LINC: Milwaukee Ave just south of Aptakisic — near the FedEx, by Advanced Dermatology. SCH: [VERIFY landmark script]. Always follow with the address text.', 'Landmarks first, then "I will text you the address."', '1.8'],
  ['G1.first_session_length', 'How long is the first session?', 'About an hour — goals talk, InBody scan, movement screen. Complimentary.', null, 'G1 Tier 2 #5'],
  ['G1.ad_offer', 'I saw your 30-day thing on Facebook?', 'Confirm the offer plainly; first step is the starting point session, then the promo applies. [VERIFY current offer terms]', 'Never sound surprised by your own ad. Convert to booking same call.', '1.9'],
  ['G1.injury_fit', 'Can I do this with my injury?', 'You are exactly who we work with. Movement screen + health history day 1; coaches modify every exercise around injuries, every session.', null, '1.10'],
  ['G1.travel_deferral', 'Call me when I am back from my trip', 'No problem — when are you back? Capture the date out loud, log it in GHL as a task, follow up that day.', 'Never accept an undated deferral.', '1.11'],
  ['G1.couples_partner', 'Can my spouse/partner train with me?', 'Absolutely — same session slots work great. Book starting point sessions back-to-back or together.', null, '1.12'],
  ['G2.which_gym', 'Which gym is this? (no recall)', 'Re-introduce in sentence one: "Alloy Personal Training — the small group personal training studio in {Location}. You inquired with us a while back."', 'Never open with "just following up."', '2.1 / 2.2'],
  ['G2.price_parking', 'I will call you when my budget allows', '"Totally understand. Can I check back in 30/60 days?" — log the date; promo launch replaces the check-in.', null, '2.5'],
  ['G3.reschedule', 'Can I move my session?', 'Release the slot, offer two options this week, note the 24-hr window status.', null, '3.1'],
  ['G3.absence', 'I am sick / traveling', 'Mark them out, no guilt. On return, build a catch-up plan so sessions do not expire. Ease-back note to coaches.', null, '3.2'],
  ['G3.session_package', 'How many sessions do I have left?', 'State counts + expiry dates and propose a booking plan to use them all.', 'Proactive rule: 3+ unused with <3 weeks to expiry → send unprompted. Expired sessions are the quietest churn.', '3.4'],
  ['G3.pause', 'Can I pause my membership?', 'Never process from a one-line text — 5-min call first. Explore lower frequency instead. ESCALATE to owner/manager: #1 churn precursor. [VERIFY pause policy]', null, '3.5'],
  ['G3.inbody_scheduling', 'When should I do my InBody?', '10 min before next session. No food ~2 hrs before, normal hydration, same time of day as last scan.', null, '3.7'],
  ['G3.inbody_accuracy', 'How accurate is the InBody?', 'No scan is perfect, but same machine + same conditions means the TREND is real — that is why we compare every 4-6 weeks, not obsess over one number.', null, '3.8'],
  ['G3.nutrition_habits', 'How much protein/water? MyFitnessPal?', 'Protein ≈ 1g per lb of fat-free mass; water ≈ half body weight in oz. Track one typical day in MFP before next check-in.', null, '3.9'],
  ['G3.app_access', 'My workouts are not showing in the app', 'Check Workouts → {Program}, force-close and reopen. If unassigned, assign now; screenshot if still broken.', null, '3.10'],
  ['G3.billing', 'When am I charged?', 'Bills every 4 weeks — state current cycle, next charge amount and date. Discrepancies dug into same day.', null, '3.11'],
  ['G3.guest_referral', 'Can I bring a friend?', 'Guest first session free (movement screen, InBody, full workout), same group as the member. Referral reward [VERIFY terms].', null, '3.13'],
  ['G4.cancellation', 'I want to cancel', '28 days notice; state final billing date and train-through date; use remaining sessions. One honest save question (pause/lower frequency), then done, no hard feelings. ESCALATE.', null, '4.1'],
  ['G4.rejoin_rate', 'Do I keep my old rate if I come back?', 'Warm, zero guilt. Fresh InBody + movement re-screen. State rejoin-rate policy plainly [VERIFY]. Book the return session on the call.', null, '4.4'],
  ['G4.records_request', 'Can I get my InBody history?', 'Of course — it is your data. Export full history to their email same day.', null, '4.5'],
];

const stmt = db.prepare(`
  INSERT OR IGNORE INTO kb_entries (taxonomy_id, canonical_question, approved_answer_text, approved_answer_voice, protocol_section, status)
  VALUES (?, ?, ?, ?, ?, 'draft')`);
let added = 0;
for (const [id, q, text, voice, section] of E) added += stmt.run(id, q, text, voice, section).changes;
console.log(`kb_entries seeded: ${added} added (${E.length} total in seed), status=draft pending [VERIFY] sign-offs`);
