const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * api.rolimons.com allows roughly 45 requests per minute and answers 429 with a
 * Retry-After header once you exceed it. Every call funnels through a single
 * queue so the whole process shares one rate budget.
 */
export function createRolimonsClient({ minIntervalMs = 1300 } = {}) {
  const headers = {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    accept: 'application/json',
    referer: 'https://www.rolimons.com/',
    origin: 'https://www.rolimons.com',
  };

  let chain = Promise.resolve();
  let lastRequestAt = 0;

  async function run(url) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const wait = lastRequestAt + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();

      let res;
      try {
        // Hard timeout: without this a stalled connection hangs the caller
        // forever, which used to freeze the whole scan loop.
        res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      } catch {
        // Dropped connection, DNS blip or timeout — back off and try again.
        await sleep(800 * (attempt + 1));
        continue;
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || 20;
        await sleep((retryAfter + 1) * 1000);
        continue;
      }

      if (res.status >= 500) {
        await sleep(700 * (attempt + 1));
        continue;
      }

      return res;
    }

    throw new Error(`Rolimons unreachable: ${url}`);
  }

  return function get(url) {
    const request = chain.then(() => run(url));
    chain = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  };
}
