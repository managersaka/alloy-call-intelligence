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

const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL || (MODE === 'cli' ? 'haiku' : 'claude-haiku-4-5-20251001');
const EVALUATOR_MODEL = process.env.EVALUATOR_MODEL || (MODE === 'cli' ? 'sonnet' : 'claude-sonnet-4-6');

const CLASSIFIER_PROMPT = readFileSync(path.join(__dirname, '..', 'prompts', 'classifier.md'), 'utf8');
const EVALUATOR_PROMPT = readFileSync(path.join(__dirname, '..', 'prompts', 'evaluator.md'), 'utf8');

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
    const child = spawn('claude', ['-p', '--model', model, '--max-turns', '1'], {
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
      if (code !== 0) reject(new Error(`claude CLI exit ${code}: ${err.slice(0, 300)}`));
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
