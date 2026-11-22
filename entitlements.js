import * as log from "./appLogger.js";
import { getDB } from "./storage.js";

const PLATFORM_COLUMNS = {
  youtube: "youtube_limit",
  twitch:  "twitch_limit",
  kick:    "kick_limit"
};
const SUBSCRIPTION_TABLES = {
  youtube: "guild_youtube_subs",
  twitch:  "guild_twitch_subs",
  kick:    "guild_kick_subs"
};
const PLATFORMS = Object.keys(PLATFORM_COLUMNS);

function normalizePlatform(platform) {
  const key = String(platform ?? "").trim().toLowerCase();
  if (!PLATFORM_COLUMNS[key]) {throw new Error(`Unknown entitlement platform: ${platform}`);}
  return key;
}

function getPlatformColumn(platform)    {return PLATFORM_COLUMNS[normalizePlatform(platform)];}
function getSubscriptionTable(platform) {return SUBSCRIPTION_TABLES[normalizePlatform(platform)];}

/*
=====================================================
Local Safety Tables
=====================================================
*/

function dmScopeId(userId) {
  return `dm-${userId}`;
}

export function ensureDmEntitlementScope(userId) {
  const scopeId = dmScopeId(userId);
  getDB().prepare(`
    INSERT INTO guilds (guild_id, guild_name, owner_id, created_at, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO NOTHING
  `).run(scopeId, "BargazBot DM", String(userId));
  return scopeId;
}

export function autoAllocateDmEntitlements(userId) {
  const scopeId = ensureDmEntitlementScope(userId);
  const lines = [];

  for (const platform of PLATFORMS) {
    const available = getAvailableAllocation(userId, platform, scopeId);
    if (!available.allowed) {continue;}

    const result = setAllocation(
      userId,
      scopeId,
      platform,
      available.unlimited ? null : available.amount
    );
    if (!result.success) {continue;}

    lines.push(`Full remaining **${platform[0].toUpperCase() + platform.slice(1)}** capacity allocated.`);
  }

  return {
    scopeId,
    message: lines.length
      ? lines.join("\n")
      : "No remaining entitlement capacity was available to allocate."
  };
}

export function removeDmEntitlements(userId) {
  const scopeId = dmScopeId(userId);
  for (const platform of PLATFORMS) {
    removeAllocation(userId, scopeId, platform);
  }
  return {scopeId};
}

function ensureAutoAllocationState() {
  const db = getDB();
  db.exec(`
    CREATE TABLE IF NOT EXISTS entitlement_auto_allocations (
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, guild_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
    )
  `);

  const autoColumns = db.prepare("PRAGMA table_info(entitlement_auto_allocations)").all().map(column => column.name);
  if (!autoColumns.includes("user_id") && autoColumns.includes("installer_user_id")) {
    db.exec(`
      CREATE TABLE entitlement_auto_allocations_migrated (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, guild_id),
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
        FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
      );
      INSERT INTO entitlement_auto_allocations_migrated (user_id, guild_id, created_at)
      SELECT a.installer_user_id, a.guild_id, a.created_at
      FROM entitlement_auto_allocations a
      WHERE EXISTS (SELECT 1 FROM users u WHERE u.user_id = a.installer_user_id)
        AND EXISTS (SELECT 1 FROM guilds g WHERE g.guild_id = a.guild_id);
      DROP TABLE entitlement_auto_allocations;
      ALTER TABLE entitlement_auto_allocations_migrated RENAME TO entitlement_auto_allocations;
    `);
  }

  const columns = db.prepare("PRAGMA table_info(entitlement_allocations)").all().map(column => column.name);
  if (!columns.includes("auto_allocated")) {
    db.exec("ALTER TABLE entitlement_allocations ADD COLUMN auto_allocated INTEGER NOT NULL DEFAULT 0");
  }
}

function hasAutoAllocation(userId, guildId) {
  ensureAutoAllocationState();
  return Boolean(getDB().prepare(
    "SELECT 1 FROM entitlement_auto_allocations WHERE user_id = ? AND guild_id = ?"
  ).get(userId, guildId));
}

function markAutoAllocation(userId, guildId) {
  ensureAutoAllocationState();
  getDB().prepare(`
    INSERT INTO entitlement_auto_allocations (user_id, guild_id, created_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, guild_id) DO NOTHING
  `).run(userId, guildId);
}

/*
=====================================================
Data Deletion Suppression
=====================================================
*/

// Data deletions keep a user id for 24 hours so it is not immediately re-collected
export function isDataSuppressed(userId) {
  const row = getDB().prepare(`
    SELECT expires_at
    FROM data_deletions
    WHERE user_id = ?
  `).get(userId);

  return Boolean(row) && Number(row.expires_at) > Date.now();
}

// Starts the 24 hour window during which a user id is ignored
export function suppressUserData(userId, hours = 24) {
  getDB().prepare(`
    INSERT INTO data_deletions (user_id, expires_at, created_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET expires_at = excluded.expires_at
  `).run(userId, Date.now() + hours * 3600000);
  log.info("BargazBot user data suppression started:", userId, hours);
}

/*
=====================================================
User and Member Records
=====================================================
*/

export function ensureUser(user) {
  if (!user?.id) {return;}
  if (isDataSuppressed(user.id)) {return;}
  const db = getDB();
  db.prepare(`
    INSERT INTO users (user_id, created_at, updated_at)
    VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
  `).run(user.id);
  db.prepare(`
    INSERT INTO user_entitlements (
      user_id, youtube_limit, twitch_limit, kick_limit, created_at, updated_at
    )
    VALUES (?, NULL, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO NOTHING
  `).run(user.id);
}

// Records that a user is currently in a server with BargazBot
export function ensureGuildMember(guildId, userId, joinedAt = null) {
  if (!guildId || !userId) {return;}
  if (isDataSuppressed(userId)) {return;}
  const joined = joinedAt ? new Date(joinedAt).toISOString() : null;

  getDB().prepare(`
    INSERT INTO guild_members (
      guild_id, user_id, joined_at, created_at, updated_at
    )
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      joined_at = COALESCE(excluded.joined_at, guild_members.joined_at),
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, userId, joined);
}

export function removeGuildMember(guildId, userId) {
  getDB().prepare(`
    DELETE FROM guild_members
    WHERE guild_id = ? AND user_id = ?
  `).run(guildId, userId);
}

/*
=====================================================
Entitlements
=====================================================
*/

export function getUserEntitlements(userId) {
  return (
    getDB().prepare(`
      SELECT user_id, youtube_limit, twitch_limit, kick_limit, created_at, updated_at
      FROM user_entitlements
      WHERE user_id = ?
    `).get(userId) ?? null
  );
}

export function getUserEntitlement(userId, platform) {
  const key         = normalizePlatform(platform);
  const column      = PLATFORM_COLUMNS[key];
  const entitlement = getUserEntitlements(userId);
  if (!entitlement) {return {exists: false, unlimited: false, limit: 0};}
  const value = entitlement[column];
  if (value === null) {return {exists: true, unlimited: true, limit: null};}
  return {exists: true, unlimited: false, limit: Number(value)};
}

export function getUserAllocation(userId, guildId) {
  return (
    getDB().prepare(`
      SELECT user_id, guild_id, youtube_limit, twitch_limit, kick_limit,
             created_at, updated_at
      FROM entitlement_allocations
      WHERE user_id = ? AND guild_id = ?
    `).get(userId, guildId) ?? null
  );
}

export function getAllocatedTotal(userId, platform, excludeGuildId = null) {
  const column = getPlatformColumn(platform);
  const db     = getDB();
  const rows   = excludeGuildId
    ? db.prepare(`
        SELECT ${column} AS allocation
        FROM entitlement_allocations
        WHERE user_id = ? AND guild_id != ?
      `).all(userId, excludeGuildId)
    : db.prepare(`
        SELECT ${column} AS allocation
        FROM entitlement_allocations
        WHERE user_id = ?
      `).all(userId);
  let total = 0;
  for (const row of rows) {
    if (row.allocation === null) {return null;}
    total += Number(row.allocation);
  }
  return total;
}

export function getAvailableAllocation(userId, platform, excludeGuildId = null) {
  const key         = normalizePlatform(platform);
  const entitlement = getUserEntitlement(userId, key);
  if (!entitlement.exists) {return {allowed: false, reason: "no-entitlement", amount: 0};}
  if (entitlement.unlimited) {return {allowed: true, unlimited: true, amount: null};}
  const elsewhere = getAllocatedTotal(userId, key, excludeGuildId);
  if (elsewhere === null) {return {allowed: false, reason: "allocation-conflict", amount: 0};}
  const amount = Math.max(0, entitlement.limit - elsewhere);
  return {allowed: amount > 0, unlimited: false, amount};
}

export function setAllocation(userId, guildId, platform, amount) {
  const key         = normalizePlatform(platform);
  const entitlement = getUserEntitlement(userId, key);
  if (!entitlement.exists) {return {success: false, reason: "no-entitlement"};}
  const unlimitedAllocation = amount === null;
  if (unlimitedAllocation && !entitlement.unlimited)                            {return {success: false, reason: "not-unlimited"};}
  if (!unlimitedAllocation && (!Number.isInteger(amount) || amount < 0))        {return {success: false, reason: "invalid-amount"};}
  const allocatedElsewhere = getAllocatedTotal(userId, key, guildId);
  if (!entitlement.unlimited && allocatedElsewhere === null)                    {return {success: false, reason: "allocation-conflict"};}
  if (!entitlement.unlimited && (allocatedElsewhere + amount > entitlement.limit)) {
    return {success: false, reason: "exceeds-entitlement", available: entitlement.limit - allocatedElsewhere};
  }

  const db = getDB();
  db.prepare(`
    INSERT INTO entitlement_allocations (
      user_id, guild_id, youtube_limit, twitch_limit, kick_limit, created_at, updated_at
    )
    VALUES (?, ?, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, guild_id) DO NOTHING
  `).run(userId, guildId);
  db.prepare(`
    UPDATE entitlement_allocations
    SET ${PLATFORM_COLUMNS[key]} = ?, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND guild_id = ?
  `).run(amount, userId, guildId);

  log.info("BargazBot entitlement allocation saved:", userId, guildId, key, unlimitedAllocation ? "unlimited" : amount);
  return {success: true, unlimited: unlimitedAllocation, amount};
}

// Removes one platform allocation contributed by a user to a server
export function removeAllocation(userId, guildId, platform) {
  const column = getPlatformColumn(platform);
  const result = getDB().prepare(`
    UPDATE entitlement_allocations
    SET ${column} = 0, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND guild_id = ?
  `).run(userId, guildId);
  if (result.changes > 0) {log.info("BargazBot entitlement allocation removed:", userId, guildId, normalizePlatform(platform));}
  return result.changes > 0;
}

// Removes all entitlement allocations contributed by a user to one server
export function removeGuildAllocations(userId, guildId) {
  const result = getDB().prepare(`
    DELETE FROM entitlement_allocations
    WHERE user_id = ? AND guild_id = ?
  `).run(userId, guildId);
  if (result.changes > 0) {log.info("BargazBot all entitlement allocations removed from server:", userId, guildId);}
  return result.changes > 0;
}

/*
=====================================================
Guild Capacity
=====================================================
*/

export function getGuildCapacity(guildId, platform) {
  const column = getPlatformColumn(platform);
  const rows   = getDB().prepare(`
    SELECT ${column} AS allocation
    FROM entitlement_allocations
    WHERE guild_id = ?
  `).all(guildId);
  let capacity = 0;
  for (const row of rows) {
    if (row.allocation === null) {return {unlimited: true, limit: null};}
    capacity += Number(row.allocation);
  }
  return {unlimited: false, limit: capacity};
}

export function getGuildUsage(guildId, platform) {
  const table = getSubscriptionTable(platform);
  const row   = getDB().prepare(`
    SELECT COUNT(*) AS count
    FROM ${table}
    WHERE guild_id = ?
  `).get(guildId);
  return Number(row?.count ?? 0);
}

export function canAddSubscription(guildId, platform) {
  const capacity = getGuildCapacity(guildId, platform);
  const usage    = getGuildUsage(guildId, platform);
  if (capacity.unlimited) {return {allowed: true, unlimited: true, usage, limit: null};}
  return {allowed: usage < capacity.limit, unlimited: false, usage, limit: capacity.limit};
}

export function getAllocationSummary(userId, guildId) {
  return {
    allocation:   getUserAllocation(userId, guildId),
    entitlements: getUserEntitlements(userId)
  };
}

/*
=====================================================
Join-Time Auto Allocation
=====================================================
*/

// Gives the detected installer their full remaining capacity once, during setup only.
// Existing manual allocations are never overwritten.
// guildId = String, Discord server ID
// installerId = String, Discord user ID
export function autoAllocateInstaller(guildId, installerId) {
  if (!guildId || !installerId) {return {ran: false, reason: "missing-id"};}
  if (isDataSuppressed(installerId)) {return {ran: false, reason: "suppressed"};}
  ensureAutoAllocationState();
  if (hasAutoAllocation(installerId, guildId)) {return {ran: false, reason: "already-run"};}

  const existing = getUserAllocation(installerId, guildId);
  if (existing) {
    markAutoAllocation(installerId, guildId);
    log.info("BargazBot installer auto-allocation skipped; manual allocation exists:", guildId, installerId);
    return {ran: false, reason: "allocation-exists"};
  }

  const results = {};
  let allocated = 0;

  for (const platform of PLATFORMS) {
    const available = getAvailableAllocation(installerId, platform, guildId);
    if (!available.allowed) {results[platform] = {success: false, reason: available.reason}; continue;}
    const result = setAllocation(installerId, guildId, platform, available.amount);
    results[platform] = result;
    if (result.success) {allocated++;}
  }

  markAutoAllocation(installerId, guildId);
  if (allocated > 0) {
    getDB().prepare(`
      UPDATE entitlement_allocations
      SET auto_allocated = 1, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND guild_id = ?
    `).run(installerId, guildId);
  }
  log.info("BargazBot installer auto-allocation completed:", guildId, installerId, allocated, results);
  return {ran: true, allocated, results};
}

export function hasInstallerAutoAllocation(guildId, installerId) {
  if (!guildId || !installerId) {return false;}
  ensureAutoAllocationState();
  return hasAutoAllocation(installerId, guildId);
}

export function clearInstallerAutoAllocation(guildId, installerId) {
  if (!guildId || !installerId) {return false;}
  ensureAutoAllocationState();
  return getDB().prepare(
    "DELETE FROM entitlement_auto_allocations WHERE user_id = ? AND guild_id = ?"
  ).run(installerId, guildId).changes > 0;
}
