// Phase 4b: distill the Director-style challenge-line bank from the historical
// evaluation docs (SPS Evals + sales call evals) and write it to
// prompts/challenge-lines.md for embedding into evaluator Step 7.
import 'dotenv/config';
import { bridge } from '../src/bridge.js';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const EVAL_FOLDERS = [
  '1Aogys3Jc2xB2t5AND3UIzbq02oZVDX0Q', // SPS Evaluations (Schaumburg)
  '1QnKExvXgrhEqkOKGC7BTzDAbHkOGpVvJ', // Call Recordings Evaluations (Schaumburg, mixed)
];

let docsMeta = [];
for (const id of EVAL_FOLDERS) {
  const { items } = await bridge('listFolder', { folderId: id });
  docsMeta = docsMeta.concat(items.filter((i) =>
    i.mimeType === 'application/vnd.google-apps.document' && !/accountability/i.test(i.name)));
}
console.log(`sales-related eval docs: ${docsMeta.length}`);

let corpus = '';
for (let i = 0; i < docsMeta.length; i += 10) {
  const { docs } = await bridge('getDocs', { ids: docsMeta.slice(i, i + 10).map((d) => d.id) });
  for (const d of docs) {
    if (d.error || !d.text) continue;
    corpus += `\n\n===== EVAL: ${d.name} =====\n${d.text.slice(0, 7000)}`;
  }
  console.log(`fetched ${Math.min(i + 10, docsMeta.length)}/${docsMeta.length} (${Math.round(corpus.length / 1024)}KB)`);
}

const system = `You are distilling a "Director-style challenge line bank" from ${docsMeta.length} historical sales-call evaluations written for Alloy Personal Training (small group personal training, max 6, SPS = Starting Point Session with InBody + movement screen + A/B close).

From the recurring coaching feedback and rewritten lines across these evaluations, extract the LINE BANK: the actual phrases and reframes the evaluator repeatedly pushes callers to say. Output ONLY a markdown section with these categories (3-6 lines each, each line quotable as-is on a call):

### Returning to the Why
### Surfacing the real objection
### Identity-level motivation
### Financial qualification (QC)
### Value anchoring before price (SPS)
### A/B close upgrades
### Deferral -> dated follow-up conversions
### Challenging avoidance ("punch in the chest" lines)

Rules: keep the evaluator's actual voice and phrasing where it recurs; prefer lines that appeared (or were prescribed) in multiple evals; no commentary, no preamble — just the categories and lines.`;

console.log('distilling via claude (sonnet)...');
const out = await new Promise((resolve, reject) => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const child = spawn('claude', ['-p', '--model', 'sonnet', '--max-turns', '1'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let o = '';
  let e = '';
  const t = setTimeout(() => { child.kill(); reject(new Error('claude timeout')); }, 600_000);
  child.stdout.on('data', (d) => (o += d));
  child.stderr.on('data', (d) => (e += d));
  child.on('close', (c) => { clearTimeout(t); c === 0 ? resolve(o) : reject(new Error(`claude exit ${c}: ${e.slice(0, 300)}`)); });
  child.stdin.write(`${system}\n\n---\n\nTHE EVALUATIONS:\n${corpus}`);
  child.stdin.end();
});

writeFileSync(new URL('../prompts/challenge-lines.md', import.meta.url), out.trim() + '\n');
console.log(`LINE BANK WRITTEN: prompts/challenge-lines.md (${out.length} chars)`);
