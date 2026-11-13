import {getDB} from "./storage.js";
import {isShutdownRequested} from "bargaz/shutdownCoordinator.js";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const CHANNEL_TABLES = {
  youtube: {channels: "youtube_channels", subscriptions: "guild_youtube_subs"},
  twitch:  {channels: "twitch_channels",  subscriptions: "guild_twitch_subs"},
  kick:    {channels: "kick_channels",    subscriptions: "guild_kick_subs"}
};

let cleanupTimer = null;


// Removes channels that no server subscribes to. Catalogue rows follow by cascade.
function removeUnmonitoredChannels(db) {
  const removed = {};

  for (const [platform, tables] of Object.entries(CHANNEL_TABLES)) {
    removed[platform] = db.prepare(`
      DELETE FROM ${tables.channels}
      WHERE channel_id NOT IN (
        SELECT channel_id
        FROM ${tables.subscriptions}
      )
    `).run().changes;
  }

  return removed;
}

// Removes servers the bot is no longer in. Every guild-scoped table follows by cascade.
function removeMissingGuilds(db, guildIds) {
  if (guildIds.length === 0) {return 0;}
  const placeholders = guildIds.map(() => "?").join(", ");

  return db.prepare(`
    DELETE FROM guilds
    WHERE guild_id NOT IN (${placeholders})
  `).run(...guildIds).changes;
}

// Removes memberships for people who left while the bot was offline.
// memberLists only holds servers whose member fetch succeeded.
function removeMissingMembers(db, memberLists) {
  let removed = 0;

  for (const [guildId, memberIds] of memberLists) {
    const rows = db.prepare(`
      SELECT user_id
      FROM guild_members
      WHERE guild_id = ?
    `).all(guildId);

    for (const row of rows) {
      if (memberIds.has(row.user_id)) {continue;}

      removed += db.prepare(`
        DELETE FROM guild_members
        WHERE guild_id = ?
          AND user_id = ?
      `).run(guildId, row.user_id).changes;
    }
  }

  return removed;
}

// Removes people in no server with the bot, with no allocation and no paid access.
function removeUnattachedUsers(db) {
  return db.prepare(`
    DELETE FROM users
    WHERE (paid_until IS NULL OR paid_until <= CURRENT_TIMESTAMP)
      AND user_id NOT IN (SELECT user_id FROM guild_members)
      AND user_id NOT IN (SELECT user_id FROM entitlement_allocations)
  `).run().changes;
}

// Permission rows target user ids without a foreign key, so they need their own pass.
function removeDanglingUserPermissions(db) {
  return db.prepare(`
    DELETE FROM guild_permissions
    WHERE permission_type = 'user'
      AND target_id NOT IN (SELECT user_id FROM users)
  `).run().changes;
}

function removeExpiredSuppressions(db) {
  return db.prepare(`
    DELETE FROM data_deletions
    WHERE expires_at <= ?
  `).run(Date.now()).changes;
}


// Runs one cleanup pass. Destructive user steps only run with a complete member list.
export async function runDataCleanup(client, {memberLists = null, membershipComplete = false} = {}) {
  if (isShutdownRequested()) {return null;}

  const db = getDB();
  const results = {};
  const guildIds = client.isReady() ? [...client.guilds.cache.keys()] : [];

  db.transaction(() => {
    if (guildIds.length > 0) {
      results.guilds = removeMissingGuilds(db, guildIds);
    }

    results.channels = removeUnmonitoredChannels(db);
    results.suppressions = removeExpiredSuppressions(db);

    if (membershipComplete && memberLists) {
      results.members = removeMissingMembers(db, memberLists);
      results.users = removeUnattachedUsers(db);
      results.permissions = removeDanglingUserPermissions(db);
    }
  })();

  console.log("BargazBot data cleanup:", JSON.stringify(results));

  return results;
}

export function startDataCleanup(client, options = {}) {
  if (cleanupTimer) {return cleanupTimer;}

  void runDataCleanup(client, options).catch(error => console.error("BargazBot data cleanup failed:", error));

  cleanupTimer = setInterval(() => {
    void runDataCleanup(client).catch(error => console.error("BargazBot data cleanup failed:", error));
  }, CLEANUP_INTERVAL_MS);

  return cleanupTimer;
}

export function stopDataCleanup() {
  if (!cleanupTimer) {return;}

  clearInterval(cleanupTimer);
  cleanupTimer = null;
}
