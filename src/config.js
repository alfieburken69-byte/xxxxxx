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

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  token: process.env.DISCORD_TOKEN || '',
  pollIntervalMs: num(process.env.POLL_INTERVAL_SECONDS, 120) * 1000,
  rolimonsMinIntervalMs: num(process.env.ROLIMONS_MIN_INTERVAL_MS, 1300),
  valueCacheMs: num(process.env.VALUE_CACHE_MINUTES, 60) * 60 * 1000,

  // Poster pacing
  postsPerChannel: num(process.env.POSTS_PER_CHANNEL, 5),
  postIntervalMs: num(process.env.POST_INTERVAL_MS, 2000),
  queueLimit: num(process.env.QUEUE_LIMIT, 60),

  postCooldownMs: num(process.env.POST_COOLDOWN_MINUTES, 90) * 60 * 1000,
  topItems: Math.min(num(process.env.TOP_ITEMS, 5), 10),

  statusChannelId: process.env.STATUS_CHANNEL_ID || null,
  metric: ['both', 'rap', 'value'].includes(process.env.BUCKET_METRIC)
    ? process.env.BUCKET_METRIC
    : 'both',
  guildId: process.env.GUILD_ID || null,
  dryRun: process.argv.includes('--dry-run') || process.env.DRY_RUN === '1',
  stateFile: new URL('../data/state.json', import.meta.url),
};
