const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * api.rolimons.com throttles by request rate, not by connection. A strict
 * one-at-a-time queue wastes most of that budget waiting on network latency, so
 * this runs a small pool instead: up to `concurrency` requests in flight, with
 * `minIntervalMs` spacing between dispatches to stay under the rate cap.
 */
export function createRolimonsClient({ minIntervalMs = 300, concurrency = 6 } = {}) {
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
  let timer = null;

  async function fetchWithRetry(url) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      let res;
      try {
        // Hard timeout: without this a stalled connection hangs the caller
        // forever, which used to freeze the whole scan loop.
        res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      } catch {
        await sleep(400 * (attempt + 1));
        continue;
      }

      if (res.status === 429) {
        // Back off the whole pool, not just this request, so we stop hammering.
        const retryAfter = Number(res.headers.get('retry-after')) || 5;
        pausedUntil = Date.now() + Math.min(retryAfter, 15) * 1000;
        await sleep(500);
        continue;
      }

      if (res.status >= 500) {
        await sleep(350 * (attempt + 1));
        continue;
      }

      return res;
    }

    throw new Error(`Rolimons unreachable: ${url}`);
  }

  function dispatch() {
    if (timer) return;

    while (queue.length > 0 && inFlight < concurrency) {
      const wait = Math.max(lastDispatchAt + minIntervalMs, pausedUntil) - Date.now();

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

  return function get(url) {
    return new Promise((resolve, reject) => {
      queue.push({ url, resolve, reject });
      dispatch();
    });
  };
}
