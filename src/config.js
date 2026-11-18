export const BUCKETS = [
  {
    id: '100-200k',
    label: '100k – 200k',
    min: 100_000,
    max: 200_000,
    channelId: '1572383197931638844',
    color: 0x8b98a5,
  },
  {
    id: '300-400k',
    label: '300k – 400k',
    min: 300_000,
    max: 400_000,
    channelId: '1572383259109625976',
    color: 0x3ba55d,
  },
  {
    id: '500-600k',
    label: '500k – 600k',
    min: 500_000,
    max: 600_000,
    channelId: '1572383272682651788',
    color: 0x17b8a6,
  },
  {
    id: '1m-2m',
    label: '1M – 2M',
    min: 1_000_000,
    max: 2_000_000,
    channelId: '1572383285341065236',
    color: 0x9b59b6,
  },
  {
    id: '5m-10m',
    label: '5M – 10M',
    min: 5_000_000,
    max: 10_000_000,
    channelId: '1572383299836580070',
    color: 0xe0a526,
  },
];

/**
 * Games whose players are never worth posting.
 *
 * Most trade-ad traffic comes from people parked in "Post Rolimon Trade Ads
 * While AFK" — they sit there on purpose, so they show up as in-game forever and
 * drown out people actually playing something. Matched against both the place ID
 * (stable, survives renames) and the name (lowercase substring).
 */
export const BLOCKED_GAMES = {
  placeIds: new Set([
    14090982817, // Post Rolimon Trade Ads While AFK
    85474607833668, // its alternate place behind the same universe
  ]),
  names: [
    'rolimon trade ads',
    'rolimons trade ads',
    'post rolimon',
    'afk trading',
    'trade ads while afk',
  ],
};

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Like num(), but an explicit 0 is a valid value (used for "no cooldown"). */
const num0 = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * Proxies, comma or newline separated. Accepts http(s):// and socks5:// forms,
 * with or without credentials:  http://user:pass@host:port
 */
const parseProxies = (raw) => {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

/** True when the player's current server should be skipped entirely. */
export function isBlockedGame(presence, game) {
  if (!presence) return false;

  if (BLOCKED_GAMES.placeIds.has(Number(presence.placeId))) return true;

  const texts = [game && game.name, presence.lastLocation]
    .filter(Boolean)
    .map((text) => String(text).toLowerCase());

  return texts.some((text) => BLOCKED_GAMES.names.some((needle) => text.includes(needle)));
}

export const config = {
  token: process.env.DISCORD_TOKEN || '',
  pollIntervalMs: num(process.env.POLL_INTERVAL_SECONDS, 45) * 1000,
  rolimonsMinIntervalMs: num(process.env.ROLIMONS_MIN_INTERVAL_MS, 500),
  rolimonsConcurrency: num(process.env.ROLIMONS_CONCURRENCY, 3),
  proxyUrls: parseProxies(process.env.ROLIMONS_PROXIES),
  // A rotating pool hands out a new IP per request, so per-IP limits don't apply
  // and 429s are worth retrying instead of pausing on.
  rotatingProxy: process.env.ROLIMONS_ROTATING_PROXY === '1',
  valueCacheMs: num(process.env.VALUE_CACHE_MINUTES, 120) * 60 * 1000,
  maxPricePerScan: num(process.env.MAX_PRICE_PER_SCAN, 40),

  // Poster pacing
  postIntervalMs: num(process.env.POST_INTERVAL_MS, 2000),
  queueLimit: num(process.env.QUEUE_LIMIT, 200),

  // Notifications
  notifyRepeatMs: num(process.env.NOTIFY_REPEAT_MINUTES, 60) * 60 * 1000,
  notifyMaxPerScan: num(process.env.NOTIFY_MAX_PER_SCAN, 10),

  postCooldownMs: num0(process.env.POST_COOLDOWN_MINUTES, 0) * 60 * 1000,
  topItems: Math.min(num(process.env.TOP_ITEMS, 5), 10),

  statusChannelId: process.env.STATUS_CHANNEL_ID || null,
  metric: ['both', 'rap', 'value'].includes(process.env.BUCKET_METRIC)
    ? process.env.BUCKET_METRIC
    : 'both',
  guildId: process.env.GUILD_ID || null,
  dryRun: process.argv.includes('--dry-run') || process.env.DRY_RUN === '1',
  stateFile: new URL('../data/state.json', import.meta.url),
};
