// Test preload for main.test.ts, which runs `node --import <this> tools/review/runner.mjs` so that main() runs offline.
// Every fetch is answered from the routes of the JSON fixture IA_REVIEW_MAIN_FIXTURE names and recorded, in order, in its
// log. A route is keyed by method, origin and path, a trailing `*` standing for one last segment; an array answers once
// per element. A request with no route left is answered with status 599. Timers run on a virtual clock: a delay moves
// the clock and the callback runs at once, so the caller's 15-minute review deadline passes without waiting for it.
import { appendFileSync, readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(process.env.IA_REVIEW_MAIN_FIXTURE ?? '', 'utf8'));
const routes = new Map(Object.entries(fixture.routes));
let skew = 0;
const now = Date.now.bind(Date),
  timer = globalThis.setTimeout;
Date.now = () => now() + skew;
globalThis.setTimeout = (callback, delay = 0, ...args) => {
  skew += Number(delay) || 0;
  return timer(callback, 0, ...args);
};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input)),
    method = init.method ?? 'GET';
  appendFileSync(
    fixture.log,
    `${JSON.stringify({
      method,
      url: url.href,
      authorization: init.headers?.authorization ?? null,
      redirect: init.redirect ?? null,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    })}\n`,
  );
  const key = `${method} ${url.origin}${url.pathname}`;
  const route = routes.get(key) ?? routes.get(key.replace(/[^/]+$/, '*'));
  const reply = Array.isArray(route) ? route.shift() : route;
  return new Response(JSON.stringify(reply ? (reply.body ?? {}) : { error: 'No fixture route' }), {
    status: reply ? (reply.status ?? 200) : 599,
    headers: { 'content-type': 'application/json' },
  });
};
