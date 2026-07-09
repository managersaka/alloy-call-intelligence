// Login health monitor — the subscription CLI login on the droplet expires
// periodically, silently breaking all scoring. This runs on a cron; if the
// `claude` CLI is logged out (or otherwise not responding), it emails an alert
// via the bridge so re-login happens fast instead of after a silent backlog.
// Dedupes: only alerts once per lapse (a marker file), clears when healthy.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { bridge, bridgeEnabled } from '../src/bridge.js';

const MARKER = '/tmp/aci-login-alerted';
const ALERT_TO = process.env.HEALTH_ALERT_EMAIL || process.env.REPORT_FALLBACK_EMAIL;

function cliHealthy() {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const child = spawn('claude', ['-p', '--model', 'haiku', '--max-turns', '1'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, why: 'timeout' }); }, 45_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, why: `spawn: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const blob = (out + err).toLowerCase();
      if (blob.includes('not logged in') || blob.includes('/login')) resolve({ ok: false, why: 'not logged in' });
      else if (code !== 0) resolve({ ok: false, why: `exit ${code}: ${err.slice(0, 120)}` });
      else resolve({ ok: true });
    });
    child.stdin.write('reply with the single word OK');
    child.stdin.end();
  });
}

const health = await cliHealthy();
if (health.ok) {
  if (existsSync(MARKER)) {
    rmSync(MARKER);
    console.log('login recovered');
    if (bridgeEnabled() && ALERT_TO) {
      await bridge('report', { to: ALERT_TO, subject: '✅ Alloy Call Intelligence — scoring login recovered',
        text: 'The Claude subscription login on the call-intelligence droplet is working again. Any calls that piled up while it was down will score on the next poll.' }).catch(() => {});
    }
  } else {
    console.log('healthy');
  }
} else {
  console.error('CLI unhealthy:', health.why);
  if (!existsSync(MARKER)) {
    writeFileSync(MARKER, new Date().toISOString());
    if (bridgeEnabled() && ALERT_TO) {
      await bridge('report', { to: ALERT_TO, subject: '⚠️ Alloy Call Intelligence — scoring is DOWN (login expired)',
        text: [
          `The Claude subscription login on the call-intelligence droplet is not working (${health.why}).`,
          'While it is down, no calls or sessions get scored — they queue and retry automatically once it is fixed.',
          '',
          'TO FIX (about 30 seconds):',
          '  1. ssh -i ~/.ssh/str_do root@164.90.141.17',
          '  2. claude login',
          '  3. open the URL it prints, approve, paste the code back',
          '',
          'You will get a "recovered" email once it is healthy again. Backlog scores on the next 10-minute poll.',
        ].join('\n') }).catch((e) => console.error('alert email failed:', e.message));
      console.log('alert emailed to', ALERT_TO);
    }
  } else {
    console.log('already alerted; staying quiet');
  }
  process.exit(1);
}
