/**
 * The smallest server that can drive the demo: a plan, a time endpoint, and two
 * static files. No dependencies — `node server.mjs` and open two windows.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', 'dist', 'index.js');

const { planFrom } = await import(dist).catch(() => {
  console.error('\n  dist/ not built yet — run `npm run build` first.\n');
  process.exit(1);
});

/**
 * One plan for every window that connects, built once at boot. Short positions
 * so a lap is visible in a few seconds.
 */
const CYCLE = [4, 3, 5];
const plan = planFrom({
  durations: CYCLE,
  serverNowMs: Date.now(),
  startLeadSeconds: 2,
  groupId: 'demo',
});

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
};

const file = async (res, path, type) => {
  try {
    send(res, 200, await readFile(path), type);
  } catch {
    send(res, 404, 'not found', 'text/plain');
  }
};

createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];

  if (url === '/time') {
    // Both edges stamped — this is what lets a client subtract the server's own
    // processing time instead of charging it to the network. See docs/clock.md.
    const serverReceivedAtMs = Date.now();
    return send(res, 200, JSON.stringify({ serverReceivedAtMs, serverSentAtMs: Date.now() }));
  }

  if (url === '/plan') {
    // `serverTimeMs` is stamped per response so a client with no measured clock
    // yet still has a usable fallback offset.
    return send(res, 200, JSON.stringify({ ...plan, serverTimeMs: Date.now() }));
  }

  if (url === '/lib.js') return file(res, dist, 'text/javascript');
  if (url === '/' || url === '/index.html') {
    return file(res, join(here, 'index.html'), 'text/html; charset=utf-8');
  }
  return send(res, 404, 'not found', 'text/plain');
}).listen(8080, () => {
  console.log(`
  playback-sync demo → http://localhost:8080

  Open it in TWO windows, side by side.
  Cycle: ${CYCLE.join('s + ')}s = ${CYCLE.reduce((a, b) => a + b, 0)}s

  Then press "Skew my clock" in one of them.
`);
});
