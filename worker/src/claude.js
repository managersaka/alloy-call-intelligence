// Claude API calls: Haiku for classification, Sonnet for evaluation.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://api.anthropic.com/v1/messages';
const KEY = process.env.ANTHROPIC_API_KEY;

const CLASSIFIER_PROMPT = readFileSync(path.join(__dirname, '..', 'prompts', 'classifier.md'), 'utf8');
const EVALUATOR_PROMPT = readFileSync(path.join(__dirname, '..', 'prompts', 'evaluator.md'), 'utf8');

async function ask({ model, system, user, max_tokens }) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

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
    model: process.env.CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001',
    system: CLASSIFIER_PROMPT,
    user: `Transcript:\n\n${transcript.slice(0, 30000)}`,
    max_tokens: 500,
  });
  return extractJsonBlock(text).json;
}

export async function evaluateSalesCall(transcript, meta) {
  const text = await ask({
    model: process.env.EVALUATOR_MODEL || 'claude-sonnet-4-6',
    system: EVALUATOR_PROMPT,
    user: `Metadata: ${JSON.stringify(meta)}\n\nTranscript:\n\n${transcript.slice(0, 60000)}`,
    max_tokens: 4000,
  });
  const { json, end } = extractJsonBlock(text);
  // Everything after the JSON block is the human-readable report.
  const private_report = text.slice(end).replace(/^\s*```\s*/, '').trim();
  return { json, private_report };
}
