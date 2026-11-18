const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Request pool for api.rolimons.com.
 *
 * Each configured proxy is its own "lane" with an independent rate budget, so N
 * proxies means N × the sustainable request rate. Every lane spaces its own
 * dispatches by `minIntervalMs`; a 429 on one lane pauses only that lane.
 *
 * With no proxies set it falls back to a single direct lane.
 */
export function createRolimonsClient({
  minIntervalMs = 500,
  concurrency = 3,
  proxyUrls = [],
  ProxyAgentClass = null,
  fetchImpl = fetch,
  label = 'rolimons',
  rotating = false,
} = {}) {
  const headers = {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    accept: 'application/json',
    referer: 'https://www.rolimons.com/',
    origin: 'https://www.rolimons.com',
  };

  const lanes = (proxyUrls.length > 0 ? proxyUrls : [null]).map((url, index) => ({
    index,
    url,
    dispatcher: url && ProxyAgentClass ? new ProxyAgentClass(url) : undefined,
    // Per-lane pacing state
    interval: minIntervalMs,
    lastDispatchAt: 0,
    pausedUntil: 0,
    inFlight: 0,
    lastSlowDownAt: 0,
    successStreak: 0,
    throttles: 0,
    consecutive429: 0,
    penalised: false,
  }));

  const MAX_INTERVAL_MULTIPLIER = 16;
  const queue = [];
  let timer = null;

  // Consecutive 429s with no success in between. Crossing this means the lane is
  // in an actual penalty box, not just briefly busy.
  const PENALTY_AFTER = 3;
  const PENALTY_WAIT_MS = 60 * 1000;

  const maxInterval = (lane) => minIntervalMs * MAX_INTERVAL_MULTIPLIER;

  function slowDown(lane, retryAfter) {
    lane.consecutive429 += 1;

    /**
     * Rotating proxies hand out a new IP per request, so a 429 here came from an
     * IP we will never use again. Pausing the lane would throw away the whole
     * pool's capacity for one bad exit node — just retry and take the next IP.
     */
    if (rotating) {
      const now = Date.now();
      if (now - (lane.lastRotatingLog || 0) > 60000) {
        lane.lastRotatingLog = now;
        console.warn(
          `[${label}] hitting 429s through the rotating pool — the provider may be ` +
            `short on clean exit IPs, or concurrency is too high`,
        );
      }
      return;
    }

    if (lane.consecutive429 >= PENALTY_AFTER && !lane.penalised) {
      lane.penalised = true;
      lane.pausedUntil = Math.max(lane.pausedUntil, Date.now() + PENALTY_WAIT_MS);
      const where = lane.url ? `proxy ${lane.index + 1}` : 'direct connection';
      console.warn(
        `[${label}] ${where} is rate-limited by Rolimon's (retry-after ${retryAfter}s). ` +
          `Pausing it for ${PENALTY_WAIT_MS / 1000}s.` +
          (lane.url ? '' : ' Add ROLIMONS_PROXIES to .env to route around the block.'),
      );
      return;
    }

    // Several in-flight requests get 429 from the same burst; only react once per
    // window or the interval multiplies by the concurrency and never recovers.
    if (Date.now() - lane.lastSlowDownAt < 20000) return;
    lane.lastSlowDownAt = Date.now();
    lane.successStreak = 0;

    const next = Math.min(Math.round(lane.interval * 1.5), maxInterval(lane));
    if (next !== lane.interval) {
      lane.interval = next;
      console.warn(`[${label}] lane ${lane.index} throttled — pacing now ${lane.interval}ms`);
    }
  }

  function noteSuccess(lane) {
    lane.consecutive429 = 0;
    lane.penalised = false;
    lane.successStreak += 1;
    if (lane.successStreak >= 12 && lane.interval > minIntervalMs) {
      lane.successStreak = 0;
      lane.interval = Math.max(minIntervalMs, Math.round(lane.interval * 0.9));
    }
  }

  async function fetchWithRetry(url, lane) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (lane.penalised) throw new Error(`${label} rate-limited (lane paused)`);
      let res;
      try {
        res = await fetchImpl(url, {
          headers,
          signal: AbortSignal.timeout(20000),
          ...(lane.dispatcher ? { dispatcher: lane.dispatcher } : {}),
        });
      } catch {
        await sleep(400 * (attempt + 1));
        continue;
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || 5;
        lane.throttles += 1;
        // A rotating pool gets a new IP per attempt, so no point pausing on it.
        if (!rotating) {
          lane.pausedUntil = Math.max(
            lane.pausedUntil,
            Date.now() + Math.min(retryAfter, 20) * 1000,
          );
        }
        slowDown(lane, retryAfter);
        await sleep(rotating ? 50 : 250);
        continue;
      }

      if (res.status >= 500) {
        await sleep(350 * (attempt + 1));
        continue;
      }

      noteSuccess(lane);
      return res;
    }

    throw new Error(`${label} unreachable: ${url}`);
  }

  /** Pick the lane that can fire soonest, ignoring lanes already at capacity. */
  function pickLane() {
    let best = null;
    let bestAt = Infinity;

    for (const lane of lanes) {
      if (lane.inFlight >= concurrency) continue;

      const readyAt = Math.max(lane.lastDispatchAt + lane.interval, lane.pausedUntil);
      if (readyAt < bestAt) {
        best = lane;
        bestAt = readyAt;
      }
    }

    if (!best) return null;
    return { lane: best, readyAt: bestAt };
  }

  function dispatch() {
    if (timer) return;

    while (queue.length > 0) {
      const choice = pickLane();
      if (!choice) return; // every lane busy

      const wait = choice.readyAt - Date.now();
      if (wait > 0) {
        timer = setTimeout(() => {
          timer = null;
          dispatch();
        }, wait);
        return;
      }

      const job = queue.shift();
      const lane = choice.lane;
      lane.lastDispatchAt = Date.now();
      lane.inFlight += 1;

      fetchWithRetry(job.url, lane)
        .then(job.resolve, job.reject)
        .finally(() => {
          lane.inFlight -= 1;
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

  get.stats = () => ({
    lanes: lanes.map((lane) => ({
      index: lane.index,
      proxied: Boolean(lane.url),
      interval: lane.interval,
      inFlight: lane.inFlight,
      throttles: lane.throttles,
    })),
    queued: queue.length,
  });

  get.laneCount = () => lanes.length;

  return get;
}
