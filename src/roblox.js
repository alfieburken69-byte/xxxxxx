const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_ATTEMPTS = 4;

/**
 * Roblox endpoints drop connections fairly often. Unhandled, `fetch` throws a
 * bare "fetch failed" and takes the caller down with it — which is exactly what
 * used to kill /check. Everything goes through here so a blip is retried.
 */
async function request(url, options = {}, attempt = 0) {
  let res;

  try {
    res = await fetch(url, {
      ...options,
      headers: { 'user-agent': UA, ...(options.headers || {}) },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    if (attempt < MAX_ATTEMPTS) {
      await sleep(500 * (attempt + 1));
      return request(url, options, attempt + 1);
    }
    throw new Error('Roblox did not respond (network error)');
  }

  if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
    const retryAfter = Number(res.headers.get('retry-after')) || 2;
    await sleep((retryAfter + 0.5) * 1000);
    return request(url, options, attempt + 1);
  }

  return res;
}

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

async function fetchPresenceBatch(ids) {
  try {
    const res = await request('https://presence.roblox.com/v1/presence/users', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://www.roblox.com',
        referer: 'https://www.roblox.com/',
      },
      body: JSON.stringify({ userIds: ids }),
    });

    if (!res.ok) return null;

    const json = await res.json();
    const out = new Map();

    for (const p of json.userPresences || []) {
      out.set(p.userId, {
        presenceType: p.userPresenceType,
        placeId: p.placeId,
        gameId: p.gameId,
        universeId: p.universeId,
        lastLocation: p.lastLocation,
      });
    }

    return out;
  } catch {
    return null;
  }
}

/**
 * userId -> { presenceType, placeId, gameId, universeId, lastLocation }
 *
 * The endpoint occasionally answers 200 with an empty userPresences array, which
 * is indistinguishable from "went offline". Missing ids are retried and the
 * results merged, so a flaky response never silently drops a live player.
 */
export async function getPresence(userIds) {
  const presence = new Map();
  const unique = [...new Set(userIds)];
  let pending = unique;

  for (let attempt = 0; attempt < MAX_ATTEMPTS && pending.length > 0; attempt += 1) {
    if (attempt > 0) await sleep(600 * attempt);
    const still = [];

    for (const ids of chunk(pending, 50)) {
      const batch = await fetchPresenceBatch(ids);
      if (!batch) {
        still.push(...ids);
        continue;
      }

      for (const [id, state] of batch) presence.set(id, state);
      for (const id of ids) if (!batch.has(id)) still.push(id);
    }

    pending = still;
  }

  return presence;
}

/** universeId -> { name, playing, creator } */
export async function getUniverseDetails(universeIds) {
  const games = new Map();
  const unique = [...new Set(universeIds.filter(Boolean))];

  for (const ids of chunk(unique, 50)) {
    try {
      const res = await request(`https://games.roblox.com/v1/games?universeIds=${ids.join(',')}`);
      if (!res.ok) continue;

      const json = await res.json();
      for (const game of json.data || []) {
        if (!game.id) continue;
        games.set(game.id, {
          name: game.name,
          playing: game.playing,
          creator: game.creator ? game.creator.name : null,
        });
      }
    } catch {
      // Skip this batch; callers fall back to the presence location string.
    }
  }

  return games;
}

/** userId -> avatar headshot url */
export async function getAvatars(userIds) {
  const avatars = new Map();
  const unique = [...new Set(userIds)];

  for (const ids of chunk(unique, 100)) {
    try {
      const url =
        'https://thumbnails.roblox.com/v1/users/avatar-headshot' +
        `?userIds=${ids.join(',')}&size=150x150&format=Png&isCircular=false`;
      const res = await request(url);
      if (!res.ok) continue;

      const json = await res.json();
      for (const thumb of json.data || []) {
        if (thumb.state === 'Completed' && thumb.imageUrl) avatars.set(thumb.targetId, thumb.imageUrl);
      }
    } catch {
      // Avatars are cosmetic; carry on without one.
    }
  }

  return avatars;
}

export async function resolveUserId(input) {
  const trimmed = input.trim();

  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const res = await request('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usernames: [trimmed], excludeBannedUsers: false }),
  });

  if (!res.ok) return null;

  const json = await res.json();
  return json.data && json.data[0] ? json.data[0].id : null;
}

export function buildJoinUrl(presence) {
  return `https://www.roblox.com/games/start?placeId=${presence.placeId}&gameInstanceId=${presence.gameId}`;
}
