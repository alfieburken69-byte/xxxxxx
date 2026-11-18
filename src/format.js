const commas = new Intl.NumberFormat('en-US');

export function formatNumber(value) {
  return commas.format(Math.round(value));
}

export function matchesBucket(bucket, { rap, value }, metric) {
  const inRap = rap >= bucket.min && rap <= bucket.max;
  const inValue = value >= bucket.min && value <= bucket.max;
  if (metric === 'rap') return inRap;
  if (metric === 'value') return inValue;
  return inRap || inValue;
}

const ITEM_URL = (assetId) => `https://www.rolimons.com/item/${assetId}`;

/** Item names occasionally contain markdown characters that would break a link. */
const cleanName = (name) => String(name || 'Unknown item').replace(/[[\]]/g, '').trim();

function buildItemField(value, limit) {
  const items = (value.items || []).slice(0, limit);
  if (items.length === 0) return null;

  // 1024-char hard limit per field value; drop lines rather than get rejected.
  const lines = [];
  let used = 0;
  for (const item of items) {
    const copies = item.copies > 1 ? ` ×${item.copies}` : '';
    const line = `[${cleanName(item.name)}](${ITEM_URL(item.assetId)})${copies} — ${formatNumber(item.value)}`;
    if (used + line.length + 1 > 1000) break;
    lines.push(line);
    used += line.length + 1;
  }

  if (lines.length === 0) return null;

  return {
    name: `${lines.length === 1 ? 'Top limited' : `Top ${lines.length} limiteds`} · ${formatNumber(value.itemCount)} owned`,
    value: lines.join('\n'),
    inline: false,
  };
}

/**
 * Plain object so the same content can be rendered to Discord or printed
 * during a dry run.
 */
export function buildPayload({ player, value, presence, game, avatar, bucket, adId, topItems = 5 }) {
  const profileUrl = `https://www.roblox.com/users/${player.userId}/profile`;
  const rolimonsUrl = `https://www.rolimons.com/player/${player.userId}`;
  const joinUrl =
    `https://www.roblox.com/games/start?placeId=${presence.placeId}` +
    `&gameInstanceId=${presence.gameId}`;
  const gameUrl = `https://www.roblox.com/games/${presence.placeId}/`;

  const gameName = (game && game.name) || presence.lastLocation || 'a Roblox game';

  const fields = [
    { name: 'RAP', value: formatNumber(value.rap), inline: true },
    { name: 'Value', value: formatNumber(value.value), inline: true },
    { name: 'Bracket', value: bucket.label, inline: true },
  ];

  const itemField = buildItemField(value, topItems);
  if (itemField) fields.push(itemField);

  return {
    color: bucket.color,
    author: { name: player.username, iconURL: avatar || undefined, url: profileUrl },
    title: gameName,
    url: joinUrl,
    fields,
    footer: { text: `Rolimon's trade ad #${adId}` },
    timestamp: new Date().toISOString(),
    buttons: [
      { label: 'Profile', url: profileUrl },
      { label: "Rolimon's", url: rolimonsUrl },
      { label: 'Join server', url: joinUrl },
      { label: 'Game page', url: gameUrl },
    ],
  };
}

export function renderPlain(payload) {
  const lines = [
    payload.author.name,
    `  Playing : ${payload.title}`,
    `  RAP     : ${payload.fields[0].value}`,
    `  Value   : ${payload.fields[1].value}`,
    `  Bracket : ${payload.fields[2].value}`,
  ];

  const itemField = payload.fields[3];
  if (itemField) {
    lines.push(`  ${itemField.name}:`);
    for (const row of itemField.value.split('\n')) {
      lines.push(`    ${row.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')}`);
    }
  }

  lines.push(`  Profile : ${payload.author.url}`);
  lines.push(`  Join    : ${payload.url}`);
  return lines.join('\n');
}
