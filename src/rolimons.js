import { createRolimonsClient } from './limiter.js';

const ITEM_CACHE_MS = 30 * 60 * 1000;

export function createRolimons({ minIntervalMs }) {
  const get = createRolimonsClient({ minIntervalMs });
  let items = { at: 0, assets: new Map() };

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

  async function getPlayerValue(userId) {
    const [assets, itemTable] = await Promise.all([
      get(`https://api.rolimons.com/players/v1/playerassets/${userId}`),
      getItemTable(),
    ]);

    if (!assets.ok) throw new Error(`playerassets ${assets.status}`);
    const json = await assets.json();
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

  return { getRecentAds, getPlayerValue, warmup: getItemTable };
}
