// Scoring engine: Haiku for classification, Sonnet for evaluation.
// Two modes (CLAUDE_MODE):
//   'cli' (default) — spawn `claude -p` headless; usage bills to the Claude
//     subscription of whoever is logged in on this host (`claude login` once).
//   'api'           — Anthropic API with ANTHROPIC_API_KEY; system prompts are
//     cache_control'd so repeat calls only pay ~10% for the rubric tokens.
// Designed to stay pluggable for a future harness/AOS migration: prompts are
// files, the transport is this module, the DB is the system of record.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://api.anthropic.com/v1/messages';
const KEY = process.env.ANTHROPIC_API_KEY;
const MODE = process.env.CLAUDE_MODE || 'cli';
const CLI_TIMEOUT_MS = Number(process.env.CLI_TIMEOUT_MS || 180_000);
// `claude -p --max-turns N` exits NON-ZERO with "Error: Reached max turns (N)" on
// STDOUT (not stderr) when a response needs more than N turns. CLI 2.1.212 counts a
// structured JSON-plus-written-report evaluator response as ~3–4 turns, so the old
// hard-coded `1` failed ~90% of scores after the 2026-07-17 CLI upgrade (2.1.201 →
// 2.1.212). There are no tools in `-p` scoring mode, so nothing can run away — the
// only bound that matters is CLI_TIMEOUT_MS. Keep headroom above the observed need.
const CLI_MAX_TURNS = Number(process.env.CLI_MAX_TURNS || 8);

const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL || (MODE === 'cli' ? 'haiku' : 'claude-haiku-4-5-20251001');
const EVALUATOR_MODEL = process.env.EVALUATOR_MODEL || (MODE === 'cli' ? 'sonnet' : 'claude-sonnet-4-6');

const CLASSIFIER_PROMPT = readFileSync(path.join(__dirname, '..', 'prompts', 'classifier.md'), 'utf8');
const EVALUATOR_PROMPT = readFileSync(path.join(__dirname, '..', 'prompts', 'evaluator.md'), 'utf8');
const QA_PROMPT = readFileSync(path.join(__dirname, '..', 'prompts', 'qa-extractor.md'), 'utf8');
const SPS_PROMPT = readFileSync(path.join(__dirname, '..', 'prompts', 'sps-analyzer.md'), 'utf8');
const ACCT_PROMPT = readFileSync(path.join(__dirname, '..', 'prompts', 'accountability-analyzer.md'), 'utf8');

async function askApi({ model, system, user, max_tokens }) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function askCli({ model, system, user }) {
  return new Promise((resolve, reject) => {
    // Strip ANTHROPIC_API_KEY: if the child CLI sees it, it silently bills the
    // API instead of the subscription — the whole point of cli mode.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const child = spawn('claude', ['-p', '--model', model, '--max-turns', String(CLI_MAX_TURNS)], {
      env,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude CLI timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`claude CLI spawn failed (is Claude Code installed + logged in?): ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // The CLI writes some failures (e.g. "Error: Reached max turns") to STDOUT,
      // not stderr — so surface both, or a non-zero exit reads as an empty error.
      if (code !== 0) reject(new Error(`claude CLI exit ${code}: ${(err || out).trim().slice(0, 300)}`));
      else resolve(out);
    });
    child.stdin.write(`${system}\n\n---\n\n${user}`);
    child.stdin.end();
  });
}

const ask = MODE === 'cli' ? askCli : askApi;

// Find the first balanced {...} block in raw model output (tolerates fences/prose).
// Returns the parsed object plus the index just past the block, so callers can
// slice the trailing prose (the human-readable report) out of the same response.
function extractJsonBlock(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON found in model output');
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      return { json: JSON.parse(text.slice(start, i + 1)), end: i + 1 };
    }
  }
  throw new Error('Unbalanced JSON in model output');
}

export async function classifyCall(transcript) {
  const text = await ask({
    model: CLASSIFIER_MODEL,
    system: CLASSIFIER_PROMPT,
    user: `Transcript:\n\n${transcript.slice(0, 30000)}`,
    max_tokens: 500,
  });
  return extractJsonBlock(text).json;
}

export async function extractQa(transcript) {
  const text = await ask({
    model: CLASSIFIER_MODEL,
    system: QA_PROMPT,
    user: `Transcript:\n\n${transcript.slice(0, 30000)}`,
    max_tokens: 1500,
  });
  return extractJsonBlock(text).json;
}

// Plaud intake: the director opens each recording by declaring the session type
// and member name ("this is an SPS with Jane Doe"). Extract that declaration.
export async function extractPlaudIntro(openingText) {
  const text = await ask({
    model: CLASSIFIER_MODEL,
    system: `You read the OPENING of an in-studio recording transcript from Alloy Personal Training. The staff member is supposed to declare what the session is, who it is with, and ideally which studio (e.g. "this is an SPS with Jane Doe at Schaumburg"). Respond with ONLY JSON, no fences:
{"declared_type": "sps | accountability | other | null", "member_name": "First Last or null", "director_name": "name if the staff member identifies themselves, else null", "location": "Schaumburg | Lincolnshire | null"}
SPS = Starting Point Session (also "starting point", "assessment", "consult"). Only report a location that is actually stated or unambiguous from the opening. If nothing is declared, infer nothing — return nulls.`,
    user: `Opening of transcript:\n\n${openingText.slice(0, 2500)}`,
    max_tokens: 200,
  });
  return extractJsonBlock(text).json;
}

// Accountability sessions (phone check-ins + in-person Deep Dives) — acct-1.0.
export async function evaluateAccountability(transcript, meta) {
  const text = await ask({
    model: EVALUATOR_MODEL,
    system: ACCT_PROMPT,
    user: `Metadata: ${JSON.stringify(meta)}\n\nTranscript:\n\n${transcript.slice(0, 120000)}`,
    max_tokens: 6000,
  });
  const { json, end } = extractJsonBlock(text);
  const private_report = text.slice(end).replace(/^\s*```\s*/, '').trim();
  return { json, private_report };
}

// In-person SPS recordings (Otter/Plaud) — Prashant's dedicated rubric (sps-1.0).
export async function evaluateSps(transcript, meta) {
  const text = await ask({
    model: EVALUATOR_MODEL,
    system: SPS_PROMPT,
    user: `Metadata: ${JSON.stringify(meta)}\n\nTranscript:\n\n${transcript.slice(0, 120000)}`,
    max_tokens: 8000,
  });
  const { json, end } = extractJsonBlock(text);
  const private_report = text.slice(end).replace(/^\s*```\s*/, '').trim();
  return { json, private_report };
}

// Prime lead-responder (SHADOW MODE) — drafts an SMS reply to an inbound lead
// message from the studio knowledgebase. Prompt + KB are read lazily so the
// rest of the pipeline never depends on their presence.
export async function draftLeadReply(meta, conversation) {
  const system =
    readFileSync(path.join(__dirname, '..', 'prompts', 'prime-lead-responder.md'), 'utf8') +
    '\n\n# KNOWLEDGEBASE (the ONLY source of facts)\n\n' +
    readFileSync(path.join(__dirname, '..', 'data', 'prime-kb.md'), 'utf8');
  const text = await ask({
    model: EVALUATOR_MODEL,
    system,
    user: `Metadata: ${JSON.stringify(meta)}\n\nConversation so far (oldest first, ends with the message to answer):\n\n${conversation.slice(-24000)}`,
    max_tokens: 800,
  });
  return extractJsonBlock(text).json;
}

export async function evaluateSalesCall(transcript, meta) {
  const text = await ask({
    model: EVALUATOR_MODEL,
    system: EVALUATOR_PROMPT,
    user: `Metadata: ${JSON.stringify(meta)}\n\nTranscript:\n\n${transcript.slice(0, 60000)}`,
    max_tokens: 4000,
  });
  const { json, end } = extractJsonBlock(text);
  // Everything after the JSON block is the human-readable report.
  const private_report = text.slice(end).replace(/^\s*```\s*/, '').trim();
  return { json, private_report };
}
