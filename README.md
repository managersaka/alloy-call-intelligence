---
tags: [alloy, call-intelligence, project]
created: 2026-07-04
status: phase-1-scaffold
---

# Alloy Call Intelligence

Pipeline that pulls GHL call recordings/transcripts, classifies them (sales / member request / accountability), stores everything in a queryable database, extracts Q&A for an agent knowledgebase, and scores every sales call against the Director rubric with private coaching feedback and L10-ready team metrics.

## Repo layout

```
alloy-call-intelligence/
├── README.md                    ← this file
├── docs/
│   ├── Alloy_Communication_Response_Protocol_v2.md   ← channel templates + taxonomy
│   └── Alloy_Sales_Call_Evaluator_v2.md              ← rubric (source of truth; runtime copy in worker/prompts)
└── worker/
    ├── src/index.js             ← webhook server + poller + pipeline
    ├── src/ghl.js               ← GHL API client (PIT auth)
    ├── src/claude.js            ← Haiku classifier + Sonnet evaluator calls
    ├── src/db.js                ← node:sqlite storage layer
    ├── src/rollup.js            ← weekly L10 rollup (rolling 4w, min-n rule)
    ├── prompts/                 ← classifier.md, evaluator.md
    ├── sql/schema.sql           ← calls, qa_extractions, kb_entries, call_scores
    └── .env.example
```

## Deploy (droplet)

1. `git clone` into `/opt/alloy-call-intelligence` (or wherever your services live)
2. Node **>= 22.5** required (`node:sqlite` built-in; emits an "experimental" warning — harmless, pin your Node version)
3. Scoring runs through **Claude Code on subscription** by default (`CLAUDE_MODE=cli`): install Claude Code on the host and `claude login` once as the service user — no API key needed. `CLAUDE_MODE=api` + `ANTHROPIC_API_KEY` is the fallback (system prompts are cache_control'd). Calls under `MIN_CALL_SEC` (45s) are auto-classified `admin_other` without any Claude call.
4. `cd worker && cp .env.example .env` — fill in PITs per location (free, just auth) and the webhook secret. `.env` is gitignored; never commit it.
5. `npm install && npm start` (or a systemd unit / pm2)
6. GHL side, per location:
   - Settings → Phone System → Voice → enable **Call Transcription** (Voice Intelligence, $0.024/min) — *you said consent + settings are done; double-check transcription specifically is on, it's a separate toggle from recording*
   - Workflow: trigger **Call Status = completed** → **Custom Webhook** action → POST `https://<your-tunnel>/webhook/ghl-call` with header `x-webhook-secret: <same as .env>`. Map messageId, conversationId, contactId, contactName, locationId, direction, callDuration, assigned user.
7. Cron:
   - Nightly sweep: `15 2 * * * cd /opt/alloy-call-intelligence/worker && node src/index.js --poll`
   - Weekly rollup (Sun 9pm): `0 21 * * 0 cd /opt/alloy-call-intelligence/worker && node src/rollup.js`

## Verify before first run

- [x] GHL transcription endpoint path in `src/ghl.js` (`getTranscription`) — verified against marketplace docs 2026-07-04: `GET /conversations/locations/:locationId/messages/:messageId/transcription`; recording path also confirmed. Transcription returns sentence objects; normalized in `index.js` (`normalizeTranscript`).
- [ ] Webhook payload field names — depends on how the GHL workflow maps them; log one real payload and adjust
- [ ] Staff attribution: confirm GHL returns the answering user on inbound calls; if only userId, add a user-map to .env

## Measurement design (do not casually change)

- **Process over outcome.** `booked` is stored for trend analysis; it never feeds a score. Clarity (booked / named objection / dated follow-up) is the enforced standard.
- **QC and SPS never blend** in any average — different rubrics.
- **Rolling 4-week average** is the L10 scorecard number; weekly raw is caller-facing only.
- **Min-n = 5**: below that, the dashboard shows the count, not a score.
- **Baseline first**: 2 weeks of collection before the number goes on the L10; set goals from the observed baseline.
- **Monthly human spot-check** of 3–5 scored calls to catch rubric gaming and grader drift.
- **Rubric changes bump `rubric_version`** — trend lines are only comparable within a version.

## Phases

- [x] **Phase 0** — consent + recording settings (done per Prashant); enable transcription toggle; fix GHL messages scope re-auth
- [x] **Phase 1** — this scaffold: ingest → classify → score → store → rollup
- [ ] **Phase 2** — Q&A extraction into `qa_extractions` / `kb_entries`; expose `kb.search` on the MCP server; answer-variance + novel-question flags
- [ ] **Phase 3** — feedback delivery (private report to caller via email/SMS/Slack within minutes); Sheets push for L10 "Call Quality" tab
- [ ] **Phase 4** — backfill: import Feb–Jun Drive transcripts (`transcript_source='drive_backfill'`); embed Director-style challenge lines into evaluator Step 7

## Privacy

Raw transcripts contain health disclosures (injuries, surgeries, medications). The DB stays on the hardened droplet with restricted access. `kb_entries` stores canonical Q&A only — no personal details. Illinois all-party consent disclosure confirmed in place per Prashant (2026-07-04).
