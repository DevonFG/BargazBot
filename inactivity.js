import * as discord from "discord.js";
import * as log from "./appLogger.js";
import * as featureSettings from "./featureSettings.js";
import { getDB } from "./storage.js";
import { trackInterval, clearTrackedTimer, trackBackgroundTask } from "./lifecycle.js";

const CHECK_INTERVAL_MS = 60000;
const RULE_TYPES = new Set(["channel", "guild"]);

let client = null;
let monitorHandle = null;
let checking = false;

/*
=====================================================
Storage
=====================================================
*/

function ensureInactivityTables() {
  const db = getDB();
  db.exec(`
    CREATE TABLE IF NOT EXISTS inactivity_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'channel',
      channel_id TEXT,
      destination_channel_id TEXT,
      threshold_minutes INTEGER NOT NULL DEFAULT 60,
      message TEXT NOT NULL DEFAULT 'This channel has been inactive for {duration}.',
      include_bots INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_activity_at DATETIME,
      notified INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS inactivity_targets (
      rule_id INTEGER NOT NULL,
      channel_id TEXT NOT NULL,
      PRIMARY KEY (rule_id, channel_id),
      FOREIGN KEY (rule_id) REFERENCES inactivity_rules(id) ON DELETE CASCADE
    )
  `);
  const ruleColumns = db.prepare("PRAGMA table_info(inactivity_rules)").all().map(column => column.name);
  const additions = {
    scope: "TEXT NOT NULL DEFAULT 'channel'",
    channel_id: "TEXT",
    destination_channel_id: "TEXT",
    threshold_minutes: "INTEGER NOT NULL DEFAULT 60",
    message: "TEXT NOT NULL DEFAULT 'This channel has been inactive for {duration}.'",
    include_bots: "INTEGER NOT NULL DEFAULT 0",
    enabled: "INTEGER NOT NULL DEFAULT 1",
    last_activity_at: "DATETIME",
    notified: "INTEGER NOT NULL DEFAULT 0"
  };
  for (const [column, definition] of Object.entries(additions)) {
    if (!ruleColumns.includes(column)) {
      db.exec(`ALTER TABLE inactivity_rules ADD COLUMN ${column} ${definition}`);
    }
  }
}

function toBoolean(value) {
  return value === true || value === 1 || value === "1";
}

function formatRule(row) {
  if (!row) {return null;}
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    name: row.name,
    scope: row.scope ?? "channel",
    channelId: row.channel_id ?? null,
    destinationChannelId: row.destination_channel_id ?? null,
    thresholdMinutes: Number(row.threshold_minutes ?? 60),
    message: row.message ?? "",
    includeBots: toBoolean(row.include_bots),
    enabled: toBoolean(row.enabled),
    lastActivityAt: row.last_activity_at ?? null,
    notified: toBoolean(row.notified)
  };
}

function getTargets(ruleId) {
  return getDB().prepare(
    "SELECT channel_id FROM inactivity_targets WHERE rule_id = ?"
  ).all(ruleId).map(row => row.channel_id);
}

/*
=====================================================
Public Rule API
=====================================================
*/

export function getRules(guildId) {
  ensureInactivityTables();
  const rows = getDB().prepare(
    "SELECT * FROM inactivity_rules WHERE guild_id = ? ORDER BY id"
  ).all(guildId);
  return rows.map(row => ({...formatRule(row), targets: getTargets(row.id)}));
}

export function getRule(guildId, ruleId) {
  ensureInactivityTables();
  const row = getDB().prepare(
    "SELECT * FROM inactivity_rules WHERE guild_id = ? AND id = ?"
  ).get(guildId, ruleId);
  return row ? {...formatRule(row), targets: getTargets(row.id)} : null;
}

export function createRule(guildId, data = {}) {
  ensureInactivityTables();
  const scope = RULE_TYPES.has(data.scope) ? data.scope : "channel";
  const threshold = Math.max(1, Number(data.thresholdMinutes ?? data.threshold_minutes) || 60);
  const message = String(data.message || "This channel has been inactive for {duration}.");
  const result = getDB().prepare(`
    INSERT INTO inactivity_rules (
      guild_id, name, scope, channel_id, destination_channel_id,
      threshold_minutes, message, include_bots, enabled, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    guildId,
    String(data.name || "Inactivity rule"),
    scope,
    data.channelId ?? data.channel_id ?? null,
    data.destinationChannelId ?? data.destination_channel_id ?? null,
    threshold,
    message,
    toBoolean(data.includeBots ?? data.include_bots) ? 1 : 0,
    data.enabled === false ? 0 : 1
  );
  const ruleId = Number(result.lastInsertRowid);
  setTargets(guildId, ruleId, data.targets ?? []);
  log.info("BargazBot inactivity rule created:", guildId, ruleId, scope);
  return getRule(guildId, ruleId);
}

export function updateRule(guildId, ruleId, data = {}) {
  ensureInactivityTables();
  const existing = getRule(guildId, ruleId);
  if (!existing) {return null;}

  const scope        = data.scope !== undefined && RULE_TYPES.has(data.scope) ? data.scope : existing.scope;
  const name         = data.name !== undefined ? String(data.name) : existing.name;
  const channelId    = data.channelId !== undefined ? data.channelId : (data.channel_id !== undefined ? data.channel_id : existing.channelId);
  const destination  = data.destinationChannelId !== undefined ? data.destinationChannelId : (data.destination_channel_id !== undefined ? data.destination_channel_id : existing.destinationChannelId);
  const threshold    = data.thresholdMinutes !== undefined || data.threshold_minutes !== undefined
    ? Math.max(1, Number(data.thresholdMinutes ?? data.threshold_minutes) || 60)
    : existing.thresholdMinutes;
  const message      = data.message !== undefined ? String(data.message) : existing.message;
  const includeBots  = data.includeBots !== undefined ? data.includeBots : (data.include_bots !== undefined ? data.include_bots : existing.includeBots);
  const enabled      = data.enabled !== undefined ? data.enabled : existing.enabled;

  getDB().prepare(`
    UPDATE inactivity_rules
    SET name = ?, scope = ?, channel_id = ?, destination_channel_id = ?,
        threshold_minutes = ?, message = ?, include_bots = ?, enabled = ?,
        notified = 0, updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = ? AND id = ?
  `).run(
    name,
    scope,
    channelId ?? null,
    destination ?? null,
    threshold,
    message,
    toBoolean(includeBots) ? 1 : 0,
    toBoolean(enabled) ? 1 : 0,
    guildId,
    ruleId
  );

  if (data.targets !== undefined) {setTargets(guildId, ruleId, data.targets);}
  log.info("BargazBot inactivity rule updated:", guildId, ruleId);
  return getRule(guildId, ruleId);
}

export function deleteRule(guildId, ruleId) {
  ensureInactivityTables();
  const result = getDB().prepare(
    "DELETE FROM inactivity_rules WHERE guild_id = ? AND id = ?"
  ).run(guildId, ruleId);
  if (result.changes > 0) {log.info("BargazBot inactivity rule deleted:", guildId, ruleId);}
  return result.changes > 0;
}

export function setTargets(guildId, ruleId, channelIds = []) {
  ensureInactivityTables();
  const rule = getRule(guildId, ruleId);
  if (!rule) {return [];}
  const db = getDB();
  db.prepare("DELETE FROM inactivity_targets WHERE rule_id = ?").run(ruleId);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO inactivity_targets (rule_id, channel_id) VALUES (?, ?)"
  );
  const targets = [...new Set((channelIds ?? []).map(String).filter(Boolean))].slice(0, 25);
  for (const channelId of targets) {insert.run(ruleId, channelId);}
  log.info("BargazBot inactivity rule targets saved:", guildId, ruleId, targets.length);
  return targets;
}

/*
=====================================================
Inactivity Check
=====================================================
*/

function ruleChannels(rule) {
  if (rule.scope === "guild") {return rule.targets ?? [];}
  if (rule.channelId) {return [rule.channelId, ...(rule.targets ?? [])];}
  return rule.targets ?? [];
}

async function lastActivityInChannel(channel, includeBots) {
  const messages = await channel.messages.fetch({limit: 50}).catch(() => null);
  if (!messages || messages.size === 0) {return 0;}
  for (const message of messages.values()) {
    if (!includeBots && message.author.bot) {continue;}
    return message.createdTimestamp;
  }
  return 0;
}

function formatMessage(template, channel, thresholdMinutes) {
  const duration = thresholdMinutes >= 60
    ? `${Math.floor(thresholdMinutes / 60)} hour${Math.floor(thresholdMinutes / 60) === 1 ? "" : "s"}`
    : `${thresholdMinutes} minute${thresholdMinutes === 1 ? "" : "s"}`;
  return String(template || "This channel has been inactive for {duration}.")
    .replaceAll("{channel}", `<#${channel.id}>`)
    .replaceAll("{duration}", duration)
    .replaceAll("{minutes}", String(thresholdMinutes));
}

async function checkRule(guild, rule) {
  if (!rule.enabled) {return;}

  const channels = ruleChannels(rule);
  if (channels.length === 0) {return;}

  const now = Date.now();
  const thresholdMs = rule.thresholdMinutes * 60000;
  let anyActive = false;
  let lastChannel = null;

  for (const channelId of channels) {
    let channel;
    try {
      channel = await client.channels.fetch(channelId).catch(() => null);
    } catch (error) {
      log.warn("BargazBot inactivity could not fetch channel:", guild.id, channelId, error.message ?? error);
      continue;
    }
    if (
      !channel?.isTextBased() ||
      channel.isThread() ||
      channel.guild?.id !== guild.id
    ) {
      continue;
    }
    lastChannel = channel;
    try {
      const lastAt = await lastActivityInChannel(channel, rule.includeBots);
      if (lastAt && now - lastAt < thresholdMs) {anyActive = true;}
    } catch (error) {
      log.warn("BargazBot inactivity could not read channel history:", guild.id, channelId, error.message ?? error);
      anyActive = true;
    }
  }

  if (!lastChannel) {return;}

  const db = getDB();
  if (anyActive) {
    db.prepare(`
      UPDATE inactivity_rules
      SET last_activity_at = CURRENT_TIMESTAMP, notified = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(rule.id);
    return;
  }

  if (rule.notified) {return;}
  let destination = lastChannel;
  if (rule.destinationChannelId) {
    const configured = await client.channels.fetch(rule.destinationChannelId).catch(() => null);
    if (configured?.isTextBased() && !configured.isThread() && configured.guild?.id === guild.id) {
      destination = configured;
    } else {
      log.warn("BargazBot inactivity destination unavailable; using monitored channel:", guild.id, rule.destinationChannelId);
    }
  }

  try {
    await destination.send({
      content: formatMessage(rule.message, lastChannel, rule.thresholdMinutes),
      allowedMentions: {parse: []}
    });
    db.prepare(`
      UPDATE inactivity_rules
      SET notified = 1, last_activity_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(rule.id);
    log.info("BargazBot inactivity notice posted:", guild.id, rule.id, destination.id);
  } catch (error) {
    log.error("BargazBot inactivity notice failed:", guild.id, rule.id, error);
  }
}

async function runInactivityCheck() {
  if (checking || !client) {return;}
  checking = true;
  try {
    for (const guild of client.guilds.cache.values()) {
      if (!featureSettings.isFeatureEnabled(guild.id, "inactivity")) {continue;}
      const rules = getRules(guild.id).filter(rule => rule.enabled);
      if (rules.length === 0) {continue;}
      for (const rule of rules) {
        await checkRule(guild, rule);
      }
    }
  } catch (error) {
    log.error("BargazBot inactivity monitor cycle failed:", error);
  } finally {
    checking = false;
  }
}

/*
=====================================================
Service Lifecycle
=====================================================
*/

export function startInactivityMonitor(discordClient) {
  if (monitorHandle) {return;}
  client = discordClient;
  ensureInactivityTables();
  monitorHandle = trackInterval(() => trackBackgroundTask(runInactivityCheck(), "inactivity check"), CHECK_INTERVAL_MS, "inactivity monitor");
  trackBackgroundTask(runInactivityCheck(), "initial inactivity check");
  log.info("BargazBot inactivity monitor started.");
}

export function stopInactivityMonitor() {
  if (!monitorHandle) {return;}
  clearTrackedTimer(monitorHandle);
  monitorHandle = null;
  client = null;
  log.info("BargazBot inactivity monitor stopped.");
}