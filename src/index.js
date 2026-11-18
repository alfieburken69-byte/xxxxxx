import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

import { BUCKETS, config } from './config.js';
import { buildPayload, matchesBucket, renderPlain } from './format.js';
import { createRolimons } from './rolimons.js';
import { getAvatars, getPresence, getUniverseDetails, resolveUserId } from './roblox.js';
import { Store } from './store.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bump when the cached player value shape changes, to force one refetch. */
const VALUE_SCHEMA = 2;

/**
 * presenceType 2 with a null placeId means the account hides its join details,
 * so there is no server to link to. Those are useless for this tracker.
 */
const isJoinable = (presence) =>
  Boolean(presence) &&
  presence.presenceType === 2 &&
  presence.placeId &&
  presence.gameId &&
  presence.universeId;

const store = new Store(config.stateFile);
const rolimons = createRolimons({
  minIntervalMs: config.rolimonsMinIntervalMs,
  concurrency: config.rolimonsConcurrency,
});

let client = null;
let scanning = false;
let scanStartedAt = 0;

/* ------------------------------------------------------------------ render */

function toEmbed(payload) {
  return new EmbedBuilder()
    .setColor(payload.color)
    .setAuthor(payload.author)
    .setTitle(payload.title)
    .setURL(payload.url)
    .addFields(payload.fields)
    .setFooter(payload.footer)
    .setTimestamp(new Date(payload.timestamp));
}

function toComponents(payload) {
  return [
    new ActionRowBuilder().addComponents(
      payload.buttons.map((button) =>
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(button.label).setURL(button.url),
      ),
    ),
  ];
}

/* ------------------------------------------------------------------ poster */

/**
 * Drains a per-bucket queue on a fixed rhythm: up to POSTS_PER_CHANNEL messages
 * out of one channel, POST_INTERVAL_MS apart, then it rotates to the next
 * channel and starts over. It never stops on its own — only /stop pauses it.
 */
/**
 * One global queue. Every POST_INTERVAL_MS it pops the next waiting player and
 * sends it to whichever channel that player's bracket belongs to. No channel
 * rotation, no per-channel batches — whatever it has, it sends, in order.
 */
class Poster {
  constructor() {
    this.queue = [];
    this.pending = new Set();
    this.enabled = true;
    this.alive = true;
    this.sent = 0;
  }

  key(item) {
    return `${item.userId}:${item.bucketId}`;
  }

  enqueue(item) {
    const id = this.key(item);
    if (this.pending.has(id)) return false;

    if (this.queue.length >= config.queueLimit) {
      const dropped = this.queue.shift();
      this.pending.delete(this.key(dropped));
    }

    this.queue.push(item);
    this.pending.add(id);
    return true;
  }

  queueDepth() {
    return this.queue.length;
  }

  async channel(bucket) {
    const cached = client.channels.cache.get(bucket.channelId);
    if (cached) return cached;
    return client.channels.fetch(bucket.channelId).catch(() => null);
  }

  async send(bucket, item) {
    if (config.dryRun) {
      console.log(`\n[dry] → #${bucket.id}\n${renderPlain(item.payload)}\n`);
      return;
    }

    const channel = await this.channel(bucket);
    if (!channel) throw new Error(`channel ${bucket.channelId} not reachable`);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await channel.send({
          embeds: [toEmbed(item.payload)],
          components: toComponents(item.payload),
        });
        return;
      } catch (err) {
        if (err.code === 429 || err.status === 429) {
          const wait = typeof err.retryAfter === 'number' ? Math.max(err.retryAfter, 1500) : 3000;
          await sleep(wait);
          continue;
        }
        throw err;
      }
    }

    throw new Error('Discord kept rate limiting the send');
  }

  clear() {
    this.queue.length = 0;
    this.pending.clear();
    return this;
  }

  async loop() {
    while (this.alive) {
      if (!this.enabled) {
        await sleep(500);
        continue;
      }

      const item = this.queue.shift();
      if (!item) {
        await sleep(500);
        continue;
      }

      this.pending.delete(this.key(item));

      const bucket = BUCKETS.find((b) => b.id === item.bucketId);
      if (!bucket) {
        await sleep(100);
        continue;
      }

      try {
        await this.send(bucket, item);
        store.markPosted(item.userId, item.bucketId);
        this.sent += 1;

        console.log(
          `[post] ${item.username} · ${bucket.label} · RAP ${item.payload.fields[0].value} · ${item.payload.title}`,
        );
      } catch (err) {
        console.error(`[post] ${item.username} failed: ${err.message}`);
      }

      store.save();
      await sleep(config.postIntervalMs);
    }
  }
}

const poster = new Poster();

/* ---------------------------------------------------------------- scanning */

async function loadValue(userId) {
  const cached = store.getValue(userId, config.valueCacheMs);
  // Entries written before the item list existed are re-fetched once.
  if (cached && cached.schema === VALUE_SCHEMA) return cached.itemCount > 0 ? cached : null;

  const fresh = await rolimons.getPlayerValue(userId);
  if (!fresh) {
    // Negative cache so an empty profile is not re-fetched every cycle.
    store.setValue(userId, { rap: 0, value: 0, itemCount: 0, schema: VALUE_SCHEMA });
    return null;
  }

  store.setValue(userId, { ...fresh, schema: VALUE_SCHEMA });
  return fresh;
}

const SCAN_TIMEOUT_MS = 5 * 60 * 1000;

async function scan() {
  if (scanning) {
    const stuckFor = Date.now() - scanStartedAt;
    if (stuckFor < SCAN_TIMEOUT_MS) {
      console.log(`[scan] previous scan still running (${Math.round(stuckFor / 1000)}s), skipping`);
      return;
    }
    // A scan has been wedged far too long — force it open again.
    console.warn(`[scan] previous scan wedged for ${Math.round(stuckFor / 1000)}s, resetting`);
  }

  scanning = true;
  scanStartedAt = Date.now();

  try {
    console.log('[scan] checking for new ads…');

    await rolimons.warmup().catch(() => {});

    const ads = await rolimons.getRecentAds();
    const newest = new Map();
    for (const ad of ads) {
      if (!newest.has(ad.userId)) newest.set(ad.userId, ad);
    }

    const presence = await getPresence([...newest.keys()]);
    const inGame = [...presence.entries()].filter(([, p]) => isJoinable(p));

    const candidates = [];
    let onCooldown = 0;

    // Load inventories in parallel. Sequentially this was ~40s per scan; the
    // limiter pool is what keeps it inside Rolimon's rate budget.
    const entries = [...inGame];
    const values = new Array(entries.length);
    let cursor = 0;

    await Promise.all(
      Array.from({ length: Math.min(6, entries.length) }, async () => {
        while (cursor < entries.length) {
          const index = cursor++;
          const [userId] = entries[index];
          values[index] = await loadValue(userId).catch(() => null);
        }
      }),
    );

    for (let i = 0; i < entries.length; i += 1) {
      const [userId, p] = entries[i];
      const value = values[i];
      if (!value) continue;

      for (const bucket of BUCKETS) {
        if (!matchesBucket(bucket, value, config.metric)) continue;
        if (store.isOnCooldown(userId, bucket.id, config.postCooldownMs)) {
          onCooldown += 1;
          continue;
        }
        candidates.push({ userId, player: newest.get(userId), presence: p, value, bucket });
      }
    }

    if (candidates.length === 0) {
      console.log(
        `[scan] ${ads.length} ads · ${inGame.length} in game · 0 matched · ${onCooldown} on cooldown · queue ${poster.queueDepth()} · ${poster.enabled ? 'running' : 'paused'}`,
      );
      return;
    }

    // The value lookup is slow, so confirm everyone is still in a game before
    // queueing. Ids missing from the new snapshot keep their earlier state.
    const livePresence = await getPresence(candidates.map((c) => c.userId));
    const ready = candidates
      .filter((c) => isJoinable(livePresence.get(c.userId) || c.presence))
      .map((c) => ({ ...c, presence: livePresence.get(c.userId) || c.presence }))
      .sort((a, b) => b.player.createdAt - a.player.createdAt);

    if (ready.length === 0) {
      console.log(`[scan] ${ads.length} ads · ${inGame.length} in game · ${candidates.length} matched · all left their games`);
      return;
    }

    const [games, avatars] = await Promise.all([
      getUniverseDetails(ready.map((c) => c.presence.universeId)),
      getAvatars(ready.map((c) => c.userId)),
    ]);

    let queued = 0;
    for (const candidate of ready) {
      const payload = buildPayload({
        player: candidate.player,
        value: candidate.value,
        presence: candidate.presence,
        game: games.get(candidate.presence.universeId),
        avatar: avatars.get(candidate.userId),
        bucket: candidate.bucket,
        adId: candidate.player.adId,
        topItems: config.topItems,
      });

      const accepted = poster.enqueue({
        userId: candidate.userId,
        username: candidate.player.username,
        bucketId: candidate.bucket.id,
        payload,
      });

      if (accepted) queued += 1;
    }

    console.log(
      `[scan] ${ads.length} ads · ${inGame.length} in game · ${ready.length} matched · ${queued} queued · queue ${poster.queueDepth()}`,
    );
  } catch (err) {
    console.error('[scan]', err.message);
  } finally {
    scanning = false;
    store.save();
  }
}

/* ---------------------------------------------------------------- commands */

function canControl(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

async function handleCheck(interaction) {
  await interaction.deferReply();

  const input = interaction.options.getString('player').trim();

  let userId;
  try {
    userId = await resolveUserId(input);
  } catch (err) {
    await interaction.editReply(`Roblox is not answering right now (${err.message}). Try again in a moment.`);
    return;
  }

  if (!userId) {
    await interaction.editReply(`Could not find a Roblox account called \`${input}\`.`);
    return;
  }

  let value;
  try {
    value = await loadValue(userId);
  } catch (err) {
    await interaction.editReply(`Could not read that inventory: ${err.message}`);
    return;
  }

  if (!value) {
    await interaction.editReply('That account is terminated, private, or owns no collectibles.');
    return;
  }

  const rap = value.rap.toLocaleString('en-US');
  const val = value.value.toLocaleString('en-US');

  const presence = await getPresence([userId]).catch(() => new Map());
  const state = presence.get(userId);

  if (!isJoinable(state)) {
    const reason =
      state && state.presenceType === 2
        ? 'In a game, but their join details are private.'
        : 'Not currently in a game.';
    await interaction.editReply(`**${input}** · RAP ${rap} · Value ${val}\n${reason}`);
    return;
  }

  const [games, avatars] = await Promise.all([
    getUniverseDetails([state.universeId]),
    getAvatars([userId]),
  ]);

  const matched = BUCKETS.find((bucket) => matchesBucket(bucket, value, config.metric));
  const bucket = matched || { id: 'none', label: 'No bracket', color: 0x2b2d31 };

  const payload = buildPayload({
    player: { userId, username: input },
    value,
    presence: state,
    game: games.get(state.universeId),
    avatar: avatars.get(userId),
    bucket,
    adId: 'manual',
    topItems: config.topItems,
  });

  await interaction.editReply({ embeds: [toEmbed(payload)], components: toComponents(payload) });
}

async function handleStart(interaction) {
  if (!canControl(interaction)) {
    await interaction.reply({ content: 'You need **Manage Server** to control the tracker.', ephemeral: true });
    return;
  }

  const wasPaused = !poster.enabled;
  poster.enabled = true;

  await interaction.reply({
    content: wasPaused
      ? `Resumed. **${poster.queueDepth()}** post(s) queued, sending one every ${config.postIntervalMs / 1000}s.`
      : `Already running. **${poster.queueDepth()}** post(s) queued.`,
  });
}

async function handleStop(interaction) {
  if (!canControl(interaction)) {
    await interaction.reply({ content: 'You need **Manage Server** to control the tracker.', ephemeral: true });
    return;
  }

  poster.enabled = false;

  await interaction.reply({
    content: `Paused. **${poster.queueDepth()}** post(s) waiting in the queue — they go out when you run \`/start\`.`,
  });
}

async function handleStats(interaction) {
  const lines = [
    `Status: **${poster.enabled ? 'running' : 'paused'}**`,
    `Queue: **${poster.queueDepth()}**`,
    `Sent this session: **${poster.sent}**`,
    `Cached players: **${Object.keys(store.data.values).length}**`,
    `Pacing: one post every **${config.postIntervalMs / 1000}s**`,
    `Cooldown: **${Math.round(config.postCooldownMs / 60000)} min**`,
    `Metric: **${config.metric}**`,
    `Poll: **${config.pollIntervalMs / 1000}s**`,
  ];
  await interaction.reply({ content: lines.join('\n') });
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('check')
      .setDescription('Look up a player and show their RAP, value, limiteds and current game')
      .addStringOption((option) =>
        option.setName('player').setDescription('Roblox username or user ID').setRequired(true),
      ),
    new SlashCommandBuilder().setName('start').setDescription('Resume automatic posting'),
    new SlashCommandBuilder().setName('stop').setDescription('Pause automatic posting'),
    new SlashCommandBuilder().setName('stats').setDescription('Show tracker statistics'),
  ].map((command) => command.toJSON());

  if (config.dryRun) return;

  // If GUILD_ID isn't configured, fall back to the first server the bot is in
  // so commands still appear instantly instead of waiting on global propagation.
  const guildId = config.guildId || client.guilds.cache.first()?.id;

  if (guildId) {
    await client.application.commands.set(commands, guildId);
    console.log(`[bot] slash commands registered to guild ${guildId}`);
  } else {
    await client.application.commands.set(commands);
    console.log('[bot] slash commands registered globally (can take up to an hour to appear)');
  }
}

/* -------------------------------------------------------------------- boot */

async function main() {
  if (config.dryRun) {
    console.log('[dry] no Discord connection, printing matches only\n');
    poster.loop();
    await scan();
    setInterval(scan, config.pollIntervalMs);
    return;
  }

  if (!config.token) {
    console.error('DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, async (ready) => {
    console.log(`[bot] logged in as ${ready.user.tag}`);

    if (ready.guilds.cache.size === 0) {
      console.error(
        '\n[!] The bot is not in any server yet, so it cannot see your channels.\n' +
          `    Invite it with:\n    https://discord.com/api/oauth2/authorize?client_id=${ready.user.id}` +
          '&permissions=19456&scope=bot%20applications.commands\n',
      );
      return;
    }

    console.log(
      `[bot] in ${ready.guilds.cache.size} server(s): ${[...ready.guilds.cache.values()].map((g) => g.name).join(', ')}`,
    );

    let missing = 0;
    for (const bucket of BUCKETS) {
      const channel = await ready.channels.fetch(bucket.channelId).catch(() => null);
      if (!channel) {
        missing += 1;
        console.warn(`[warn] ${bucket.label}: channel ${bucket.channelId} not reachable`);
      }
    }

    if (missing > 0) {
      console.warn(
        `[warn] ${missing}/${BUCKETS.length} channels unreachable — check View Channel + Send Messages + Embed Links.`,
      );
    } else {
      console.log(`[bot] all ${BUCKETS.length} bracket channels reachable`);
    }

    await registerCommands();

    console.log(
      `[poster] started · one post every ${config.postIntervalMs / 1000}s · routing to ${BUCKETS.length} channels`,
    );

    poster.loop();
    await scan();
    setInterval(scan, config.pollIntervalMs);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      if (interaction.commandName === 'check') await handleCheck(interaction);
      else if (interaction.commandName === 'start') await handleStart(interaction);
      else if (interaction.commandName === 'stop') await handleStop(interaction);
      else if (interaction.commandName === 'stats') await handleStats(interaction);
    } catch (err) {
      console.error(`[command] ${interaction.commandName}: ${err.message}`);
      const reply = { content: `Something broke: ${err.message}`, ephemeral: true };
      if (interaction.deferred || interaction.replied) await interaction.editReply(reply).catch(() => {});
      else await interaction.reply(reply).catch(() => {});
    }
  });

  const shutdown = () => {
    poster.alive = false;
    store.save();
    client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await client.login(config.token);
}

main();
