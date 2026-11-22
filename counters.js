import * as discord from "discord.js";
import * as log from "./appLogger.js";
import {getDB} from "./storage.js";
import {trackInterval, trackTimeout, trackBackgroundTask, clearTrackedTimer} from "./lifecycle.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const COUNTER_TYPES = new Set(["accounts", "bots", "members", "role"]);
const TYPE_NAMES = {accounts:"Accounts", bots:"Bots", members:"Members"};

let client = null;
let checkHandle = null;

function ensureCounterTables() {
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS guild_counters (
      guild_id TEXT NOT NULL,
      counter_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      type TEXT NOT NULL,
      role_id TEXT,
      label TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, counter_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
    )
  `);
}

function rowToCounter(row) {
  if (!row) {return null;}
  return {
    guildId:    row.guild_id,
    counterId:  row.counter_id,
    channelId:  row.channel_id,
    type:       row.type,
    roleId:     row.role_id ?? null,
    label:      row.label ?? null,
    enabled:    row.enabled === 1 || row.enabled === true
  };
}

/*
=====================================================
Configuration
=====================================================
*/

export function getCounters(guildId) {
  ensureCounterTables();
  return getDB().prepare(
    "SELECT * FROM guild_counters WHERE guild_id = ? ORDER BY created_at, counter_id"
  ).all(guildId).map(rowToCounter);
}

export function getCounter(guildId, counterId) {
  ensureCounterTables();
  return rowToCounter(getDB().prepare(
    "SELECT * FROM guild_counters WHERE guild_id = ? AND counter_id = ?"
  ).get(guildId, counterId));
}

export async function createCounter(guild, data = {}) {
  ensureCounterTables();
  const type = COUNTER_TYPES.has(data.type) ? data.type : "members";
  if (type === "role" && !data.roleId) {throw new Error("Choose a role for a role counter.");}
  const existing = getCounters(guild.id);
  if (existing.length >= 25) {throw new Error("This server already has 25 counters.");}

  const counterId = `c_${Date.now().toString(36)}`;
  const draft = {
    guildId:guild.id,
    counterId,
    channelId:null,
    type,
    roleId:type === "role" ? String(data.roleId) : null,
    label:data.label ? String(data.label).trim().slice(0, 100) : null,
    enabled:true
  };

  await guild.members.fetch().catch(() => {});
  const channel = await createCounterChannel(guild, draft);
  await lockChannel(channel, guild);

  try {
    getDB().prepare("INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)").run(String(guild.id));
    getDB().prepare(`
      INSERT INTO guild_counters (guild_id, counter_id, channel_id, type, role_id, label, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(guild.id, counterId, channel.id, draft.type, draft.roleId, draft.label);
  } catch (error) {
    await channel.delete().catch(() => {});
    throw error;
  }

  log.info("BargazBot counter created:", guild.id, counterId, type);
  return getCounter(guild.id, counterId);
}

export function updateCounter(guildId, counterId, patch = {}) {
  ensureCounterTables();
  if (!getCounter(guildId, counterId)) {return null;}
  if (Object.hasOwn(patch, "type") && !COUNTER_TYPES.has(patch.type)) {
    throw new Error("Unknown counter type.");
  }
  const sets = [];
  const values = [];
  if (Object.hasOwn(patch, "channelId")) {sets.push("channel_id = ?"); values.push(patch.channelId ?? null);}
  if (Object.hasOwn(patch, "type"))     {sets.push("type = ?"); values.push(patch.type);}
  if (Object.hasOwn(patch, "roleId"))   {sets.push("role_id = ?"); values.push(patch.roleId ?? null);}
  if (Object.hasOwn(patch, "label"))    {sets.push("label = ?"); values.push(patch.label ? String(patch.label).trim().slice(0, 100) : null);}
  if (Object.hasOwn(patch, "enabled"))  {sets.push("enabled = ?"); values.push(patch.enabled ? 1 : 0);}
  if (!sets.length) {return getCounter(guildId, counterId);}
  sets.push("updated_at = CURRENT_TIMESTAMP");
  getDB().prepare(
    `UPDATE guild_counters SET ${sets.join(", ")} WHERE guild_id = ? AND counter_id = ?`
  ).run(...values, guildId, counterId);
  return getCounter(guildId, counterId);
}

export async function deleteCounter(guild, counterId) {
  ensureCounterTables();
  const counter = getCounter(guild.id, counterId);
  if (!counter) {return false;}
  const channel =
    guild.channels.cache.get(counter.channelId) ??
    await guild.channels.fetch(counter.channelId).catch(() => null);
  if (channel) {
    await channel.delete(`BargazBot counter removed ${guild.id}`).catch(error =>
      log.warn("BargazBot counter channel delete failed:", guild.id, counter.channelId, error)
    );
  }
  const deleted = getDB().prepare(
    "DELETE FROM guild_counters WHERE guild_id = ? AND counter_id = ?"
  ).run(guild.id, counterId).changes > 0;
  if (deleted) {log.info("BargazBot counter deleted:", guild.id, counterId);}
  return deleted;
}

/*
=====================================================
Counting and channel updates
=====================================================
*/

export function defaultLabel(counter, guild) {
  if (counter.type === "role") {
    const role = guild?.roles?.cache?.get(counter.roleId);
    return role ? `@${role.name}` : "Role";
  }
  return TYPE_NAMES[counter.type] ?? counter.type;
}

export function countCounter(counter, guild) {
  const members = [...guild.members.cache.values()];
  if (counter.type === "accounts") {return members.length;}
  if (counter.type === "bots")     {return members.filter(member => member.user.bot).length;}
  if (counter.type === "members")  {return members.filter(member => !member.user.bot).length;}
  if (counter.type === "role") {
    return members.filter(member => !member.user.bot && member.roles.cache.has(counter.roleId)).length;
  }
  return 0;
}

export function counterChannelName(counter, guild) {
  const label = counter.label || defaultLabel(counter, guild);
  return `${label}: ${countCounter(counter, guild)}`.replace(/[\r\n]+/g, " ").slice(0, 100);
}

async function createCounterChannel(guild, counter) {
  return guild.channels.create({
    name:   counterChannelName(counter, guild),
    type:   discord.ChannelType.GuildVoice,
    reason: `BargazBot counter ${guild.id}`
  });
}

async function lockChannel(channel, guild) {
  const everyone = guild.roles.everyone;
  const overwrites = await channel.permissionOverwrites.fetch().catch(() => channel.permissionOverwrites.cache);
  const publicOverwrite = overwrites.get(everyone.id);
  if (!publicOverwrite || !publicOverwrite.deny.has(discord.PermissionFlagsBits.Connect)) {
    await channel.permissionOverwrites.edit(everyone,
      {ViewChannel:true, Connect:false},
      {reason:"BargazBot counter channel"}
    );
  }
}

export async function refreshGuildCounters(guildOrId) {
  const cached = typeof guildOrId === "string" ? client?.guilds.cache.get(guildOrId) : null;
  const guild = typeof guildOrId === "string"
    ? (cached ?? await client?.guilds.fetch(guildOrId).catch(() => null))
    : guildOrId;
  if (!guild) {return;}
  ensureCounterTables();

  for (const counter of getCounters(guild.id).filter(item => item.enabled)) {
    const channel =
      guild.channels.cache.get(counter.channelId) ??
      await guild.channels.fetch(counter.channelId).catch(() => null);
    if (!channel || channel.type !== discord.ChannelType.GuildVoice) {continue;}
    try {
      await lockChannel(channel, guild);
      const name = counterChannelName(counter, guild);
      if (channel.name !== name) {await channel.setName(name, `BargazBot counter ${guild.id}`);}
    } catch (error) {
      log.warn("BargazBot counter update failed:", guild.id, counter.counterId, error);
    }
  }
}

export const updateGuildCounters = refreshGuildCounters;

/*
=====================================================
Service Lifecycle
=====================================================
*/

async function runCounterCheck() {
  if (!client) {return;}
  for (const guild of client.guilds.cache.values()) {
    await refreshGuildCounters(guild);
  }
}

export function startCounters(discordClient) {
  if (checkHandle) {return;}
  client = discordClient;
  ensureCounterTables();
  checkHandle = trackInterval(() => trackBackgroundTask(runCounterCheck(), "counter check"), CHECK_INTERVAL_MS, "counter monitor");
  trackTimeout(() => trackBackgroundTask(runCounterCheck(), "initial counter check"), 10000, "initial counter check");
  log.info("BargazBot counters started.");
}

export function stopCounters() {
  if (checkHandle) {clearTrackedTimer(checkHandle); checkHandle = null;}
  client = null;
  log.info("BargazBot counters stopped.");
}
