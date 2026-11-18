import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

import { BUCKETS, config, isBlockedGame } from './config.js';
import { buildPayload, matchesBucket, renderPlain } from './format.js';
import { createRolimons } from './rolimons.js';
import { getAvatars, getPresence, getUniverseDetails, resolveUserId } from './roblox.js';
import { Store } from './store.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Permissions the bot needs in each bracket channel. */
const REQUIRED_PERMS = ['ViewChannel', 'SendMessages', 'EmbedLinks'];

/** Channels that failed with Missing Permissions, so we stop retrying them. */
const brokenChannels = new Set();

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
  proxyUrls: config.proxyUrls,
});

let client = null;
let scanning = false;
let shuttingDown = false;

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
 * One queue per bracket channel, each drained by its own independent loop:
 * every POST_INTERVAL_MS that channel sends its next queued player, forever.
 * A channel with nothing waiting just idles — it never blocks the others.
 */
class Poster {
  constructor() {
    this.queues = new Map(BUCKETS.map((bucket) => [bucket.id, []]));
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

    const queue = this.queues.get(item.bucketId);
    if (!queue) return false;

    if (queue.length >= config.queueLimit) {
      const dropped = queue.shift();
      this.pending.delete(this.key(dropped));
    }

    queue.push(item);
    this.pending.add(id);
    return true;
  }

  queueDepth() {
    return [...this.queues.values()].reduce((total, queue) => total + queue.length, 0);
  }

  depthFor(bucketId) {
    return (this.queues.get(bucketId) || []).length;
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

    if (brokenChannels.has(bucket.channelId)) {
      throw new Error(`skipped: no permission in #${bucket.id}`);
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

        // 50013 = Missing Permissions. Report exactly what's missing, once.
        if (err.code === 50013) {
          const perms = channel.permissionsFor(client.user);
          const missing = REQUIRED_PERMS.filter((perm) => !perms || !perms.has(perm));
          brokenChannels.add(bucket.channelId);
          console.error(
            `[perm] #${bucket.label} (${bucket.channelId}) denied. Missing: ${
              missing.length > 0 ? missing.join(', ') : 'all appear granted — check the bot role is not timed out'
            }. Skipping this channel until restart.`,
          );
          throw new Error('missing permissions');
        }

        throw err;
      }
    }

    throw new Error('Discord kept rate limiting the send');
  }

  clear() {
    for (const queue of this.queues.values()) queue.length = 0;
    this.pending.clear();
    return this;
  }

  /** One independent loop per channel — each sends every POST_INTERVAL_MS. */
  async loopFor(bucket) {
    const queue = this.queues.get(bucket.id);

    while (this.alive) {
      if (!this.enabled) {
        await sleep(500);
        continue;
      }

      const item = queue.shift();
      if (!item) {
        await sleep(200);
        continue;
      }

      this.pending.delete(this.key(item));

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

  startAll() {
    for (const bucket of BUCKETS) this.loopFor(bucket);
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

/**
 * Sequential scheduler: the next scan starts only after this one finishes, plus
 * the poll interval. Never overlaps, so the API budget is never split.
 */
async function scanLoop() {
  while (!shuttingDown) {
    const started = Date.now();
    await scan().catch((err) => console.error('[scan]', err.message));

    // If a scan ran long (throttling), give the API a breather rather than
    // immediately queueing another expensive pass.
    const elapsed = Date.now() - started;
    const wait = Math.max(config.pollIntervalMs, 5000);

    if (elapsed > config.pollIntervalMs) {
      console.log(`[scan] took ${Math.round(elapsed / 1000)}s — waiting ${Math.round(wait / 1000)}s before next`);
    }

    await sleep(wait);
  }
}

/**
 * DM everyone subscribed to a game that just showed up.
 * Matching is by place ID when the subscription has one, otherwise by
 * case-insensitive name substring.
 */
async function dispatchNotifications(built, games) {
  if (config.dryRun) return;

  const subs = store.listNotifications();
  if (subs.length === 0 || built.length === 0) return;

  const dmUsers = new Map();
  let fired = 0;

  for (const { candidate, payload } of built) {
    const game = games.get(candidate.presence.universeId);
    const gameName = (game && game.name) || candidate.presence.lastLocation || '';
    const placeId = Number(candidate.presence.placeId);

    for (const sub of subs) {
      if (fired >= config.notifyMaxPerScan) return;

      const matches = sub.placeId
        ? sub.placeId === placeId
        : gameName.toLowerCase().includes(String(sub.gameName).toLowerCase());

      if (!matches) continue;
      if (store.wasNotified(sub.id, candidate.userId, config.notifyRepeatMs)) continue;

      try {
        const user = dmUsers.get(sub.targetId) || (await client.users.fetch(sub.targetId));
        dmUsers.set(sub.targetId, user);

        await user.send({
          content: `**${candidate.player.username}** is in **${gameName}** right now.`,
          embeds: [toEmbed(payload)],
          components: toComponents(payload),
        });

        store.markNotified(sub.id, candidate.userId);
        fired += 1;
        console.log(`[notify] DM'd ${user.tag} about ${candidate.player.username} in ${gameName}`);
      } catch (err) {
        console.error(
          `[notify] could not DM ${sub.targetId} (they may have DMs off): ${err.message}`,
        );
        store.markNotified(sub.id, candidate.userId);
      }
    }
  }

  if (fired > 0) store.save();
}

async function scan() {
  // Strictly one scan at a time. A previous version fired a new scan on a timer
  // while one was still pricing, so two scans shared the API budget and kept
  // each other permanently throttled.
  if (scanning) return;

  scanning = true;
  const startedAt = Date.now();

  try {
    await rolimons.warmup().catch(() => {});

    const ads = await rolimons.getRecentAds();
    const newest = new Map();
    for (const ad of ads) {
      if (!newest.has(ad.userId)) newest.set(ad.userId, ad);
    }

    const presence = await getPresence([...newest.keys()]);
    const live = [...presence.entries()].filter(([, p]) => isJoinable(p));
    const inGame = live.filter(([, p]) => !isBlockedGame(p, null));
    const skipped = live.length - inGame.length;

    if (inGame.length === 0) {
      console.log(
        `[scan] ${ads.length} ads · 0 in game${skipped > 0 ? ` · ${skipped} in blocked games` : ''} · queue ${poster.queueDepth()}`,
      );
      return;
    }

    console.log(
      `[scan] ${ads.length} ads · ${inGame.length} in game${
        skipped > 0 ? ` (${skipped} blocked)` : ''
      } · pricing inventories…`,
    );

    const candidates = [];
    let onCooldown = 0;

    // Cache hits are free, so sort by "needs an API call" last: players already
    // known locally resolve instantly, and fresh lookups are capped per scan so
    // one pass can't consume the whole rate budget.
    const cachedFirst = [...inGame].sort((a, b) => {
      const aCached = store.getValue(a[0], config.valueCacheMs) ? 0 : 1;
      const bCached = store.getValue(b[0], config.valueCacheMs) ? 0 : 1;
      return aCached - bCached;
    });

    const entries = cachedFirst.slice(0, config.maxPricePerScan);
    const deferred = cachedFirst.length - entries.length;
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

    if (deferred > 0) {
      console.log(`[scan] ${deferred} player(s) deferred to the next scan (rate budget)`);
    }

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

    // Second pass now that real game names are known — catches renamed AFK farms
    // that the placeId / lastLocation check missed.
    const allowed = ready.filter(
      (c) => !isBlockedGame(c.presence, games.get(c.presence.universeId)),
    );
    const blocked = ready.length - allowed.length;

    let queued = 0;
    const built = [];

    for (const candidate of allowed) {
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
      built.push({ candidate, payload });
    }

    await dispatchNotifications(built, games).catch((err) =>
      console.error('[notify]', err.message),
    );

    console.log(
      `[scan] ${ads.length} ads · ${inGame.length} in game${
        skipped > 0 ? ` (${skipped} blocked)` : ''
      } · ${ready.length} matched${
        blocked > 0 ? ` (+${blocked} blocked)` : ''
      } · ${queued} queued · ${Math.round((Date.now() - startedAt) / 1000)}s`,
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
    await interaction.editReply(
      `Rolimon's is rate limiting me right now, so I couldn't read that inventory. Try again in a minute.\n` +
        `-# ${err.message}`,
    );
    return;
  }

  if (!value) {
    await interaction.editReply('That account is terminated, private, or owns no collectibles.');
    return;
  }

  const rap = value.rap.toLocaleString('en-US');
  const val = value.value.toLocaleString('en-US');

  const snapshot = await getPresence([userId]).catch(() => new Map());
  const state = snapshot.get(userId);

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
    await interaction.reply({ content: 'You need **Manage Server** to control the tracker.', flags: MessageFlags.Ephemeral });
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
    await interaction.reply({ content: 'You need **Manage Server** to control the tracker.', flags: MessageFlags.Ephemeral });
    return;
  }

  poster.enabled = false;

  await interaction.reply({
    content: `Paused. **${poster.queueDepth()}** post(s) waiting in the queue — they go out when you run \`/start\`.`,
  });
}

/* ------------------------------------------------------- /notify handlers */

/** Rank games for autocomplete: exact prefix first, then substring, then popularity. */
async function autocompleteGames(focused) {
  let list;
  try {
    list = await rolimons.getGameList();
  } catch {
    return [];
  }

  const query = focused.trim().toLowerCase();
  if (!query) return list.slice(0, 25).map(toChoice);

  const scored = [];
  for (const game of list) {
    const name = game.name.toLowerCase();
    let score = -1;

    if (name === query) score = 0;
    else if (name.startsWith(query)) score = 1;
    else if (name.includes(query)) score = 2;

    if (score >= 0) scored.push({ game, score });
  }

  scored.sort((a, b) => a.score - b.score || b.game.playing - a.game.playing);
  return scored.slice(0, 25).map(({ game }) => toChoice(game));
}

function toChoice(game) {
  return {
    name: `${game.name.slice(0, 90)} · ${game.playing.toLocaleString('en-US')} playing`,
    value: String(game.placeId),
  };
}

async function handleNotify(interaction) {
  const raw = interaction.options.getString('game', true).trim();
  const target = interaction.options.getUser('user', true);

  let gameName = raw;
  let placeId = null;

  if (/^\d+$/.test(raw)) {
    placeId = Number(raw);
    try {
      const list = await rolimons.getGameList();
      const found = list.find((g) => g.placeId === placeId);
      if (found) gameName = found.name;
    } catch {
      // Name is cosmetic; the place ID is what actually matches.
    }
  } else {
    try {
      const list = await rolimons.getGameList();
      const found = list.find((g) => g.name.toLowerCase() === raw.toLowerCase());
      if (found) {
        placeId = found.placeId;
        gameName = found.name;
      }
    } catch {
      // Fall back to matching on the typed name at scan time.
    }
  }

  const { created, entry } = store.addNotification({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    ownerId: interaction.user.id,
    targetId: target.id,
    gameName,
    placeId,
  });

  store.save();

  if (!created) {
    await interaction.reply({
      content: `You already have a notification for **${entry.gameName}** to ${target}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Ask for DMs up front so a closed-inbox failure isn't silent later.
  let dmNote = '';
  try {
    const dm = await target.createDM();
    await dm.send(
      `Notifications for **${gameName}** are now on. I'll message you here whenever someone with a bracket-worthy inventory is spotted in that game.`,
    );
  } catch {
    dmNote =
      `\n\n⚠️ I could not DM ${target} — they need **Allow direct messages from server members** enabled, or a shared server.`;
  }

  await interaction.reply({
    content:
      `Done. I'll DM ${target} whenever **${gameName}**${placeId ? ` (place ${placeId})` : ''} shows up.\n` +
      `Repeat window: **${config.notifyRepeatMs === 0 ? 'every sighting' : `${Math.round(config.notifyRepeatMs / 60000)} min`}**.` +
      `\nID: \`${entry.id}\`` +
      dmNote,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleNotifyList(interaction) {
  const subs = store.listNotifications(interaction.guildId).filter(
    (n) => n.ownerId === interaction.user.id || canControl(interaction),
  );

  if (subs.length === 0) {
    await interaction.reply({ content: 'No notifications set up yet. Use `/notify` to add one.', flags: MessageFlags.Ephemeral });
    return;
  }

  const lines = subs.map(
    (n) => `\`${n.id}\` · **${n.gameName}** → <@${n.targetId}>`,
  );
  await interaction.reply({
    content: `${lines.join('\n')}\n\nRemove one with \`/notify remove id:<id>\`.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleNotifyRemove(interaction) {
  const id = interaction.options.getString('id', true).trim();

  const accessible = store
    .listNotifications(interaction.guildId)
    .find((n) => n.id === id && (n.ownerId === interaction.user.id || canControl(interaction)));

  if (!accessible) {
    await interaction.reply({ content: `No notification \`${id}\` that you can remove.`, flags: MessageFlags.Ephemeral });
    return;
  }

  store.removeNotification(accessible.ownerId, id);
  store.save();

  await interaction.reply({ content: `Removed notification \`${id}\` (**${accessible.gameName}**).`, flags: MessageFlags.Ephemeral });
}

async function handleStats(interaction) {
  const perChannel = BUCKETS.map((b) => `#${b.id}: ${poster.depthFor(b.id)}`).join(' · ');
  const lines = [
    `Status: **${poster.enabled ? 'running' : 'paused'}**`,
    `Queue: **${poster.queueDepth()}** (${perChannel})`,
    `Sent this session: **${poster.sent}**`,
    `Cached players: **${Object.keys(store.data.values).length}**`,
    `Pacing: **1 per channel every ${config.postIntervalMs / 1000}s**`,
    `Cooldown: **${config.postCooldownMs === 0 ? 'none' : `${Math.round(config.postCooldownMs / 60000)} min`}**`,
    `Metric: **${config.metric}**`,
    `Poll: **${config.pollIntervalMs / 1000}s**`,
    `Notify subscriptions: **${store.listNotifications().length}**`,
  ];

  const lanes = rolimons.laneStats();
  const proxyCount = lanes.lanes.filter((l) => l.proxied).length;
  if (proxyCount > 0) {
    lines.push(
      `Proxies: **${proxyCount}** active` +
        ` (${lanes.lanes.map((l) => `${l.interval}ms`).join(' / ')})`,
    );
  }

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
    new SlashCommandBuilder()
      .setName('notify')
      .setDescription('DM someone when a chosen game shows up in the tracker')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Watch a game and DM a member when it appears')
          .addStringOption((option) =>
            option
              .setName('game')
              .setDescription('Start typing a game name, or paste a place ID')
              .setRequired(true)
              .setAutocomplete(true),
          )
          .addUserOption((option) =>
            option.setName('user').setDescription('Who to DM').setRequired(true),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('Show your notifications'))
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Delete a notification')
          .addStringOption((option) =>
            option.setName('id').setDescription('ID shown by /notify list').setRequired(true),
          ),
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
    poster.startAll();
    scanLoop();
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

    if (config.proxyUrls.length > 0) {
      const perLane = 60000 / config.rolimonsMinIntervalMs;
      console.log(
        `[proxy] ${config.proxyUrls.length} lane(s) — budget ~${Math.round(perLane * config.proxyUrls.length)} req/min ` +
          `(${Math.round(perLane)} per lane)`,
      );
    } else {
      console.log("[proxy] none configured — Rolimon's traffic comes from this server's IP");
    }

    let missing = 0;
    for (const bucket of BUCKETS) {
      const channel = await ready.channels.fetch(bucket.channelId).catch(() => null);

      if (!channel) {
        missing += 1;
        console.warn(`[warn] ${bucket.label}: channel ${bucket.channelId} not reachable`);
        continue;
      }

      const perms = channel.permissionsFor(ready.user);
      const lacking = REQUIRED_PERMS.filter((perm) => !perms || !perms.has(perm));

      if (lacking.length > 0) {
        missing += 1;
        brokenChannels.add(bucket.channelId);
        console.warn(`[warn] ${bucket.label} (${bucket.channelId}): missing ${lacking.join(', ')}`);
      }
    }

    if (missing > 0) {
      console.warn(
        `[warn] ${missing}/${BUCKETS.length} channels unusable — give the bot View Channel + Send Messages + Embed Links in them.`,
      );
    } else {
      console.log(`[bot] all ${BUCKETS.length} bracket channels ready`);
    }

    await registerCommands();

    console.log(
      `[poster] started · 1 per channel every ${config.postIntervalMs / 1000}s · ${BUCKETS.length} channels`,
    );

    poster.startAll();
    scanLoop();
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    // Autocomplete for /notify add game:
    if (interaction.isAutocomplete()) {
      const focused = interaction.options.getFocused(true);

      if (interaction.commandName === 'notify' && focused.name === 'game') {
        try {
          const choices = await autocompleteGames(String(focused.value || ''));
          await interaction.respond(choices);
        } catch {
          await interaction.respond([]).catch(() => {});
        }
      } else {
        await interaction.respond([]).catch(() => {});
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    try {
      if (interaction.commandName === 'check') await handleCheck(interaction);
      else if (interaction.commandName === 'start') await handleStart(interaction);
      else if (interaction.commandName === 'stop') await handleStop(interaction);
      else if (interaction.commandName === 'stats') await handleStats(interaction);
      else if (interaction.commandName === 'notify') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'add') await handleNotify(interaction);
        else if (sub === 'list') await handleNotifyList(interaction);
        else if (sub === 'remove') await handleNotifyRemove(interaction);
      }
    } catch (err) {
      console.error(`[command] ${interaction.commandName}: ${err.message}`);
      const reply = { content: `Something broke: ${err.message}`, flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.editReply(reply).catch(() => {});
      else await interaction.reply(reply).catch(() => {});
    }
  });

  const shutdown = () => {
    shuttingDown = true;
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
