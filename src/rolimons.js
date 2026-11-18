import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { createRolimonsClient } from './limiter.js';

const ITEM_CACHE_MS = 30 * 60 * 1000;
const GAME_CACHE_MS = 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createRolimons({ minIntervalMs, concurrency, proxyUrls }) {
  const get = createRolimonsClient({
    minIntervalMs,
    concurrency,
    proxyUrls,
    ProxyAgentClass: ProxyAgent,
    // undici's fetch understands `dispatcher`; native fetch ignores it.
    fetchImpl: undiciFetch,
    label: 'rolimons',
  });
  let items = { at: 0, assets: new Map() };
  let games = { at: 0, list: [] };

  async function getItemTable() {
    if (items.assets.size > 0 && Date.now() - items.at < ITEM_CACHE_MS) return items.assets;

    const res = await get('https://api.rolimons.com/items/v3/itemdetails');
    if (!res.ok) throw new Error(`itemdetails ${res.status}`);
    const json = await res.json();

    const assets = new Map();
    for (const [assetId, row] of Object.entries(json.assets || {})) {
      // row = [name, acronym, rap, value, default_value, demand, trend, projected, hyped, rare]
      assets.set(assetId, {
        name: row[0],
        acronym: row[1],
        rap: Number(row[2]) || 0,
        value: Number(row[3]) || 0,
      });
    }

    items = { at: Date.now(), assets };
    return assets;
  }

  /** Rolimon's tracked games, for /notify autocomplete. Cached for an hour. */
  async function getGameList() {
    if (games.list.length > 0 && Date.now() - games.at < GAME_CACHE_MS) return games.list;

    const res = await get('https://api.rolimons.com/games/v1/gamelist');
    if (!res.ok) throw new Error(`gamelist ${res.status}`);
    const json = await res.json();

    const list = [];
    for (const [placeId, row] of Object.entries(json.games || {})) {
      list.push({ placeId: Number(placeId), name: row[0], playing: Number(row[1]) || 0 });
    }

    list.sort((a, b) => b.playing - a.playing);
    games = { at: Date.now(), list };
    return list;
  }

  /** Newest trade ads first. Each ad: adId, createdAt (unix), userId, username. */
  async function getRecentAds() {
    const res = await get('https://api.rolimons.com/tradeads/v1/getrecentads');
    if (!res.ok) throw new Error(`getrecentads ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(`getrecentads rejected: ${json.message || 'unknown'}`);

    return (json.trade_ads || []).map((ad) => ({
      adId: ad[0],
      createdAt: ad[1],
      userId: ad[2],
      username: ad[3],
    }));
  }

  /**
   * Player inventories are the request that gets throttled hardest, and a single
   * 429 used to surface to /check as "Rolimons unreachable". Retry patiently
   * with backoff before giving up.
   */
  async function getPlayerValue(userId) {
    const itemTable = await getItemTable();

    let lastError = null;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) await sleep(2000 * attempt);

      let res;
      try {
        res = await get(`https://api.rolimons.com/players/v1/playerassets/${userId}`);
      } catch (err) {
        lastError = err;
        continue;
      }

      if (!res.ok) {
        lastError = new Error(`playerassets ${res.status}`);
        continue;
      }

      const json = await res.json();
      if (!json.success) return null;
      if (json.playerTerminated || json.playerPrivacyEnabled) return null;

      let rap = 0;
      let value = 0;
      let itemCount = 0;
      const owned = [];

      for (const [assetId, uaids] of Object.entries(json.playerAssets || {})) {
        const copies = Array.isArray(uaids) ? uaids.length : 1;
        itemCount += copies;
        const item = itemTable.get(assetId);
        if (!item) continue;
        if (item.rap > 0) rap += item.rap * copies;
        if (item.value > 0) {
          value += item.value * copies;
          owned.push({ assetId, name: item.name, value: item.value, copies });
        }
      }

      if (itemCount === 0) return null;

      // Most valuable first; only the top handful is ever rendered.
      owned.sort((a, b) => b.value - a.value);

      return {
        rap,
        value,
        itemCount,
        verified: Boolean(json.playerVerified),
        items: owned.slice(0, 10),
      };
    }

    throw lastError || new Error('Rolimons did not answer');
  }

  return { getRecentAds, getPlayerValue, getGameList, warmup: getItemTable, laneStats: get.stats };
}
