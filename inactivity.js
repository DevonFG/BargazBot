import * as log from "./appLogger.js";
import * as featureSettings from "./featureSettings.js";
import { getDB } from "./storage.js";
import { trackInterval, clearTrackedTimer, trackBackgroundTask } from "./lifecycle.js";
import { randomUUID } from "node:crypto";

const CHECK_INTERVAL_MS = 60000;
const RULE_TYPES = new Set(["channel", "guild"]);

let client = null;
let monitorHandle = null;
let checking = false;

function ensureInactivityTables() {
  const db = getDB();
  const ruleColumns = db.prepare("PRAGMA table_info(inactivity_rules)").all().map(column => column.name);
  if (!ruleColumns.includes("scope")) {
    db.exec("ALTER TABLE inactivity_rules ADD COLUMN scope TEXT NOT NULL DEFAULT 'channel'");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS inactivity_state (
      guild_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      last_activity_at INTEGER,
      last_activity INTEGER,
      last_notified_at INTEGER,
      last_notified INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, target_type, target_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
    )
  `);
}

function toBoolean(value) {
  return value === true || value === 1 || value === "1";
}

function parseJsonList(value, fallback = []) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeTargets(channelIds) {
  return [...new Set((channelIds ?? []).map(String).filter(Boolean))].slice(0, 25);
}

function formatRule(row) {
  if (!row) {return null;}
  return {
    ruleId: row.rule_id,
    guildId: row.guild_id,
    name: row.name,
    scope: row.scope === "guild" ? "guild" : "channel",
    durationMinutes: Math.max(1, Number(row.idle_minutes ?? row.timeout_minutes ?? 60) || 60),
    idleMinutes: Math.max(1, Number(row.idle_minutes ?? 60) || 60),
    timeoutMinutes: Math.max(1, Number(row.timeout_minutes ?? 60) || 60),
    message: row.message ?? "",
    destinationChannelId: row.destination_channel_id ?? null,
    includeBotMessages: toBoolean(row.include_bot_messages),
    enabled: toBoolean(row.enabled),
    channels: parseJsonList(row.channels),
    guildIds: parseJsonList(row.guild_ids)
  };
}

function getState(guildId, ruleId) {
  const row = getDB().prepare(
    "SELECT last_activity_at, last_activity, last_notified_at, last_notified FROM inactivity_state WHERE guild_id = ? AND target_type = 'rule' AND target_id = ?"
  ).get(guildId, ruleId);
  if (!row) {return {lastActivityAt:null, lastNotifiedAt:null};}
  const activity = Number(row.last_activity_at ?? row.last_activity ?? 0) || null;
  const notified = Number(row.last_notified_at ?? row.last_notified ?? 0) || null;
  return {lastActivityAt:activity, lastNotifiedAt:notified};
}

function saveState(guildId, ruleId, {lastActivityAt, lastNotifiedAt}) {
  const now = Date.now();
  const activity = Number(lastActivityAt) || now;
  const notified = lastNotifiedAt ? Number(lastNotifiedAt) : null;
  getDB().prepare(`
    INSERT INTO inactivity_state (
      guild_id, target_type, target_id, last_activity_at, last_activity,
      last_notified_at, last_notified, created_at, updated_at
    )
    VALUES (?, 'rule', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id, target_type, target_id) DO UPDATE SET
      last_activity_at = excluded.last_activity_at,
      last_activity = excluded.last_activity,
      last_notified_at = excluded.last_notified_at,
      last_notified = excluded.last_notified,
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, ruleId, activity, activity, notified, notified);
}

function clearState(guildId, ruleId) {
  getDB().prepare(
    "DELETE FROM inactivity_state WHERE guild_id = ? AND target_type = 'rule' AND target_id = ?"
  ).run(guildId, ruleId);
}

function getTargets(guildId, ruleId) {
  return getDB().prepare(
    "SELECT channel_id, target_id FROM inactivity_targets WHERE guild_id = ? AND rule_id = ? ORDER BY created_at, target_id"
  ).all(guildId, ruleId).map(row => row.channel_id ?? row.target_id).filter(Boolean);
}

export function getRules(guildId) {
  ensureInactivityTables();
  return getDB().prepare(
    "SELECT * FROM inactivity_rules WHERE guild_id = ? ORDER BY created_at, rule_id"
  ).all(guildId).map(row => ({...formatRule(row), targets:getTargets(guildId, row.rule_id)}));
}

export function getRule(guildId, ruleId) {
  ensureInactivityTables();
  const row = getDB().prepare(
    "SELECT * FROM inactivity_rules WHERE guild_id = ? AND rule_id = ?"
  ).get(guildId, ruleId);
  return row ? {...formatRule(row), targets:getTargets(guildId, ruleId)} : null;
}

export function createRule(guildId, data = {}) {
  ensureInactivityTables();
  const scope = RULE_TYPES.has(data.scope) ? data.scope : "channel";
  const duration = Math.max(1, Number(data.durationMinutes ?? data.idleMinutes ?? data.thresholdMinutes ?? 60) || 60);
  const timeout = Math.max(1, Number(data.timeoutMinutes ?? duration) || duration);
  const ruleId = randomUUID();
  const targets = normalizeTargets(data.targets ?? []);
  const message = String(data.message || "This channel has been inactive for {duration}.");

  getDB().prepare(`
    INSERT INTO inactivity_rules (
      guild_id, rule_id, name, scope, message, idle_minutes, timeout_minutes,
      destination_channel_id, include_bot_messages, enabled, channels, guild_ids,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    guildId,
    ruleId,
    String(data.name || "Inactivity rule"),
    scope,
    message,
    duration,
    timeout,
    data.destinationChannelId ?? data.destination_channel_id ?? null,
    toBoolean(data.includeBotMessages ?? data.include_bots) ? 1 : 0,
    data.enabled === false ? 0 : 1,
    JSON.stringify(targets),
    JSON.stringify(scope === "guild" ? [guildId] : [])
  );
  setTargets(guildId, ruleId, targets, scope);
  log.info("BargazBot inactivity rule created:", guildId, ruleId, scope);
  return getRule(guildId, ruleId);
}

export function updateRule(guildId, ruleId, data = {}) {
  ensureInactivityTables();
  const existing = getRule(guildId, ruleId);
  if (!existing) {return null;}

  const scope = data.scope !== undefined && RULE_TYPES.has(data.scope) ? data.scope : existing.scope;
  const duration = data.durationMinutes !== undefined || data.idleMinutes !== undefined || data.thresholdMinutes !== undefined
    ? Math.max(1, Number(data.durationMinutes ?? data.idleMinutes ?? data.thresholdMinutes ?? 60) || 60)
    : existing.durationMinutes;
  const timeout = data.timeoutMinutes !== undefined
    ? Math.max(1, Number(data.timeoutMinutes) || duration)
    : existing.timeoutMinutes;
  const name = data.name !== undefined ? String(data.name) : existing.name;
  const message = data.message !== undefined ? String(data.message) : existing.message;
  const destination = data.destinationChannelId !== undefined
    ? data.destinationChannelId
    : (data.destination_channel_id !== undefined ? data.destination_channel_id : existing.destinationChannelId);
  const includeBots = data.includeBotMessages !== undefined
    ? data.includeBotMessages
    : (data.includeBots !== undefined ? data.includeBots : existing.includeBotMessages);
  const enabled = data.enabled !== undefined ? data.enabled : existing.enabled;

  getDB().prepare(`
    UPDATE inactivity_rules
    SET name = ?, scope = ?, message = ?, idle_minutes = ?, timeout_minutes = ?,
        destination_channel_id = ?, include_bot_messages = ?, enabled = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = ? AND rule_id = ?
  `).run(
    name,
    scope,
    message,
    duration,
    timeout,
    destination ?? null,
    toBoolean(includeBots) ? 1 : 0,
    toBoolean(enabled) ? 1 : 0,
    guildId,
    ruleId
  );
  clearState(guildId, ruleId);

  if (data.targets !== undefined) {setTargets(guildId, ruleId, data.targets, scope);}
  else if (scope !== existing.scope) {setTargets(guildId, ruleId, existing.targets, scope);}

  log.info("BargazBot inactivity rule updated:", guildId, ruleId);
  return getRule(guildId, ruleId);
}

export function deleteRule(guildId, ruleId) {
  ensureInactivityTables();
  const db = getDB();
  const result = db.transaction(() => {
    clearState(guildId, ruleId);
    return db.prepare("DELETE FROM inactivity_rules WHERE guild_id = ? AND rule_id = ?").run(guildId, ruleId);
  })();
  if (result.changes > 0) {log.info("BargazBot inactivity rule deleted:", guildId, ruleId);}
  return result.changes > 0;
}

export function setTargets(guildId, ruleId, channelIds = [], scope = null) {
  ensureInactivityTables();
  const rule = getRule(guildId, ruleId);
  if (!rule) {return [];}
  const targets = normalizeTargets(channelIds);
  const effectiveScope = RULE_TYPES.has(scope) ? scope : rule.scope;
  const targetType = effectiveScope === "guild" ? "guild" : "channel";
  const db = getDB();

  db.transaction(() => {
    db.prepare("DELETE FROM inactivity_targets WHERE guild_id = ? AND rule_id = ?").run(guildId, ruleId);
    const insert = db.prepare(`
      INSERT INTO inactivity_targets (
        guild_id, rule_id, target_type, target_id, channel_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    for (const channelId of targets) {insert.run(guildId, ruleId, targetType, channelId, channelId);}
    db.prepare(`
      UPDATE inactivity_rules
      SET scope = ?, channels = ?, guild_ids = ?, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND rule_id = ?
    `).run(effectiveScope, JSON.stringify(targets), JSON.stringify(effectiveScope === "guild" ? [guildId] : []), guildId, ruleId);
  })();
  clearState(guildId, ruleId);
  log.info("BargazBot inactivity rule targets saved:", guildId, ruleId, targets.length);
  return targets;
}

function ruleChannels(rule) {
  return rule.targets ?? [];
}

async function lastActivityInChannel(channel, includeBots) {
  const messages = await channel.messages.fetch({limit:50}).catch(() => null);
  if (!messages || messages.size === 0) {return 0;}
  for (const message of messages.values()) {
    if (!includeBots && message.author.bot) {continue;}
    return message.createdTimestamp;
  }
  return 0;
}

function formatMessage(template, channel, durationMinutes) {
  const hours = Math.floor(durationMinutes / 60);
  const duration = durationMinutes >= 60
    ? `${hours} hour${hours === 1 ? "" : "s"}`
    : `${durationMinutes} minute${durationMinutes === 1 ? "" : "s"}`;
  return String(template || "This channel has been inactive for {duration}.")
    .replaceAll("{channel}", `<#${channel.id}>`)
    .replaceAll("{duration}", duration)
    .replaceAll("{minutes}", String(durationMinutes));
}

async function checkRule(guild, rule) {
  if (!rule.enabled) {return;}
  const channels = ruleChannels(rule);
  if (channels.length === 0) {return;}

  const state = getState(guild.id, rule.ruleId);
  const now = Date.now();
  const thresholdMs = rule.durationMinutes * 60000;
  let anyActive = false;
  let lastChannel = null;

  for (const channelId of channels) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || channel.isThread() || channel.guild?.id !== guild.id) {continue;}
    lastChannel = channel;
    try {
      const lastAt = await lastActivityInChannel(channel, rule.includeBotMessages);
      if (lastAt && now - lastAt < thresholdMs) {anyActive = true;}
    } catch (error) {
      log.warn("BargazBot inactivity could not read channel history:", guild.id, channelId, error.message ?? error);
      anyActive = true;
    }
  }

  if (!lastChannel) {return;}

  if (anyActive) {
    saveState(guild.id, rule.ruleId, {lastActivityAt:now, lastNotifiedAt:state.lastNotifiedAt});
    return;
  }
  if (state.lastNotifiedAt) {return;}

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
      content: formatMessage(rule.message, lastChannel, rule.durationMinutes),
      allowedMentions: {parse: []}
    });
    saveState(guild.id, rule.ruleId, {lastActivityAt:now, lastNotifiedAt:Date.now()});
    log.info("BargazBot inactivity notice posted:", guild.id, rule.ruleId, destination.id);
  } catch (error) {
    log.error("BargazBot inactivity notice failed:", guild.id, rule.ruleId, error);
  }
}

async function runInactivityCheck() {
  if (checking || !client) {return;}
  checking = true;
  try {
    for (const guild of client.guilds.cache.values()) {
      if (!featureSettings.isFeatureEnabled(guild.id, "inactivity")) {continue;}
      for (const rule of getRules(guild.id).filter(rule => rule.enabled)) {
        await checkRule(guild, rule);
      }
    }
  } catch (error) {
    log.error("BargazBot inactivity monitor cycle failed:", error);
  } finally {
    checking = false;
  }
}

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
