import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class Store {
  constructor(fileUrl) {
    this.file = fileURLToPath(fileUrl);
    this.data = { values: {}, posts: {}, notifications: [], notified: {} };
    this.dirty = false;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        values: parsed.values || {},
        posts: parsed.posts || {},
        notifications: parsed.notifications || [],
        notified: parsed.notified || {},
      };
    } catch {
      // First run, or the file was removed — start clean.
    }
  }

  save() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
      this.dirty = false;
    } catch (err) {
      console.error('[store] could not write state:', err.message);
    }
  }

  getValue(userId, maxAgeMs) {
    const entry = this.data.values[userId];
    if (!entry) return null;
    if (Date.now() - entry.at > maxAgeMs) return null;
    return entry;
  }

  setValue(userId, value) {
    this.data.values[userId] = { ...value, at: Date.now() };
    this.dirty = true;
  }

  isOnCooldown(userId, bucketId, cooldownMs) {
    const at = this.data.posts[`${userId}:${bucketId}`];
    return Boolean(at) && Date.now() - at < cooldownMs;
  }

  markPosted(userId, bucketId) {
    this.data.posts[`${userId}:${bucketId}`] = Date.now();
    this.dirty = true;
  }

  prune(cooldownMs) {
    const cutoff = Date.now() - Math.max(cooldownMs, 24 * 60 * 60 * 1000);
    let changed = false;

    for (const [key, at] of Object.entries(this.data.posts)) {
      if (at < cutoff) {
        delete this.data.posts[key];
        changed = true;
      }
    }
    for (const [key, entry] of Object.entries(this.data.values)) {
      if (entry.at < cutoff) {
        delete this.data.values[key];
        changed = true;
      }
    }
    for (const [key, at] of Object.entries(this.data.notified)) {
      if (at < cutoff) {
        delete this.data.notified[key];
        changed = true;
      }
    }

    if (changed) this.dirty = true;
  }

  /* ---------------------------------------------------------- notifications */

  listNotifications(guildId) {
    return this.data.notifications.filter((n) => !guildId || n.guildId === guildId);
  }

  addNotification({ guildId, channelId, ownerId, targetId, gameName, placeId }) {
    const existing = this.data.notifications.find(
      (n) => n.ownerId === ownerId && n.targetId === targetId && n.placeId === placeId,
    );
    if (existing) return { created: false, entry: existing };

    const entry = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      guildId,
      channelId,
      ownerId,
      targetId,
      gameName,
      placeId: placeId || null,
      createdAt: Date.now(),
    };

    this.data.notifications.push(entry);
    this.dirty = true;
    return { created: true, entry };
  }

  removeNotification(ownerId, id) {
    const before = this.data.notifications.length;
    this.data.notifications = this.data.notifications.filter(
      (n) => !(n.id === id && n.ownerId === ownerId),
    );
    const removed = this.data.notifications.length !== before;
    if (removed) this.dirty = true;
    return removed;
  }

  /** True when this subscription already fired for this player recently. */
  wasNotified(subId, playerId, repeatMs) {
    const at = this.data.notified[`${subId}:${playerId}`];
    return Boolean(at) && Date.now() - at < repeatMs;
  }

  markNotified(subId, playerId) {
    this.data.notified[`${subId}:${playerId}`] = Date.now();
    this.dirty = true;
  }
}
