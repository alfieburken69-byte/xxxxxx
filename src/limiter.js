const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rolimon's real ceiling is far lower than its docs imply — testing showed 429s
 * with `Retry-After: 20` at only ~45 req/min, and hammering it pins the pacing
 * high for a long time. So: conservative default, one shared pause when a 429
 * appears (not one per in-flight request), and a slow recovery.
 */
export function createRolimonsClient({ minIntervalMs = 1800, concurrency = 2 } = {}) {
  const headers = {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    accept: 'application/json',
    referer: 'https://www.rolimons.com/',
    origin: 'https://www.rolimons.com',
  };

  /** @type {{ url: string, resolve: Function, reject: Function }[]} */
  const queue = [];
  let inFlight = 0;
  let lastDispatchAt = 0;
  let pausedUntil = 0;
  let lastSlowDownAt = 0;
  let interval = minIntervalMs;
  let successStreak = 0;
  let timer = null;
  let throttles = 0;

  const MAX_INTERVAL = 8000;

  function slowDown() {
    // Concurrent requests all get 429 from the same burst. Only react once per
    // window, otherwise 4 in-flight failures multiply the interval by 4x at once
    // and it never recovers.
    if (Date.now() - lastSlowDownAt < 30000) return;

    lastSlowDownAt = Date.now();
    throttles += 1;
    successStreak = 0;
    interval = Math.min(Math.round(interval * 1.5), MAX_INTERVAL);
    console.warn(`[rolimons] throttled — pacing now ${interval}ms/request`);
  }

  function noteSuccess() {
    successStreak += 1;
    if (successStreak >= 10 && interval > minIntervalMs) {
      successStreak = 0;
      interval = Math.max(minIntervalMs, Math.round(interval * 0.85));
    }
  }

  async function fetchWithRetry(url) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let res;
      try {
        res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      } catch {
        await sleep(400 * (attempt + 1));
        continue;
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || 5;
        // One shared pause for the whole pool — this is a single shared budget.
        pausedUntil = Math.max(pausedUntil, Date.now() + Math.min(retryAfter, 20) * 1000);
        slowDown();
        await sleep(250);
        continue;
      }

      if (res.status >= 500) {
        await sleep(350 * (attempt + 1));
        continue;
      }

      noteSuccess();
      return res;
    }

    throw new Error(`Rolimons unreachable: ${url}`);
  }

  function dispatch() {
    if (timer) return;

    while (queue.length > 0 && inFlight < concurrency) {
      const wait = Math.max(lastDispatchAt + interval, pausedUntil) - Date.now();

      if (wait > 0) {
        timer = setTimeout(() => {
          timer = null;
          dispatch();
        }, wait);
        return;
      }

      const job = queue.shift();
      lastDispatchAt = Date.now();
      inFlight += 1;

      fetchWithRetry(job.url)
        .then(job.resolve, job.reject)
        .finally(() => {
          inFlight -= 1;
          dispatch();
        });
    }
  }

  function get(url) {
    return new Promise((resolve, reject) => {
      queue.push({ url, resolve, reject });
      dispatch();
    });
  }

  get.stats = () => ({ interval, inFlight, queued: queue.length, throttles, paused: pausedUntil > Date.now() });

  return get;
}
