import * as discord from "discord.js";
import {createLogger} from "bargaz/logging.js";
import * as log from "./appLogger.js";
import * as featureSettings from "./featureSettings.js";
import * as channelManager from "./channelManager.js";
import {getDB} from "./storage.js";
import {trackBotCallback, trackBackgroundTask} from "./lifecycle.js";

const logging = createLogger({
  EmbedBuilder: discord.EmbedBuilder,
  getDB,
  getChannel: channelManager.getChannel
});

let client = null;
let messageHandler = null;

/*
=====================================================
Storage
=====================================================
*/

function ensureAutopublishTables() {
  const db = getDB();
  db.exec(`
    CREATE TABLE IF NOT EXISTS autopublish_settings (
      guild_id TEXT PRIMARY KEY,
      all_enabled INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS autopublish_channels (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, channel_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
    )
  `);
  const settingsColumns = db.prepare("PRAGMA table_info(autopublish_settings)").all().map(column => column.name);
  if (!settingsColumns.includes("all_enabled")) {
    db.exec("ALTER TABLE autopublish_settings ADD COLUMN all_enabled INTEGER NOT NULL DEFAULT 0");
  }
  const channelColumns = db.prepare("PRAGMA table_info(autopublish_channels)").all().map(column => column.name);
  if (!channelColumns.includes("enabled")) {
    db.exec("ALTER TABLE autopublish_channels ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
  }
}

function toBoolean(value) {
  return value === true || value === 1 || value === "1";
}

/*
=====================================================
Config API
=====================================================
*/

export function getAutopublishSettings(guildId) {
  ensureAutopublishTables();
  const row = getDB().prepare(
    "SELECT * FROM autopublish_settings WHERE guild_id = ?"
  ).get(guildId);
  return {
    guildId,
    allEnabled: row ? toBoolean(row.all_enabled) : false
  };
}

export function setAutopublishAll(guildId, enabled = true) {
  ensureAutopublishTables();
  getDB().prepare(`
    INSERT INTO autopublish_settings (guild_id, all_enabled, created_at, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO UPDATE SET all_enabled = excluded.all_enabled, updated_at = CURRENT_TIMESTAMP
  `).run(guildId, enabled ? 1 : 0);
  log.info("BargazBot autopublish all-channels mode changed:", guildId, Boolean(enabled));
  return getAutopublishSettings(guildId);
}

export function getAutopublishChannels(guildId) {
  ensureAutopublishTables();
  return getDB().prepare(`
    SELECT channel_id, enabled
    FROM autopublish_channels
    WHERE guild_id = ?
    ORDER BY channel_id
  `).all(guildId).map(row => ({channelId: row.channel_id, enabled: toBoolean(row.enabled)}));
}

export function setAutopublishChannel(guildId, channelId, enabled = true) {
  ensureAutopublishTables();
  getDB().prepare(`
    INSERT INTO autopublish_channels (guild_id, channel_id, enabled, created_at, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id, channel_id) DO UPDATE SET enabled = excluded.enabled, updated_at = CURRENT_TIMESTAMP
  `).run(guildId, channelId, enabled ? 1 : 0);
  log.info("BargazBot autopublish channel changed:", guildId, channelId, Boolean(enabled));
  return getAutopublishChannels(guildId);
}

export function removeAutopublishChannel(guildId, channelId) {
  ensureAutopublishTables();
  const result = getDB().prepare(
    "DELETE FROM autopublish_channels WHERE guild_id = ? AND channel_id = ?"
  ).run(guildId, channelId);
  if (result.changes > 0) {log.info("BargazBot autopublish channel removed:", guildId, channelId);}
  return result.changes > 0;
}

export function clearAutopublish(guildId) {
  ensureAutopublishTables();
  const db = getDB();
  db.prepare("DELETE FROM autopublish_channels WHERE guild_id = ?").run(guildId);
  db.prepare("DELETE FROM autopublish_settings WHERE guild_id = ?").run(guildId);
  log.info("BargazBot autopublish configuration cleared:", guildId);
}

export function listAutopublish(guildId) {
  const settings = getAutopublishSettings(guildId);
  return {
    allEnabled: settings.allEnabled,
    channels: getAutopublishChannels(guildId).filter(channel => channel.enabled).map(channel => channel.channelId)
  };
}

export function shouldAutopublish(guildId, channelId) {
  const config = listAutopublish(guildId);
  return config.allEnabled || config.channels.includes(channelId);
}

// Aliases in case the command router uses shorter names
export const getChannels = getAutopublishChannels;
export const setChannel = setAutopublishChannel;
export const removeChannel = removeAutopublishChannel;
export const setAll = setAutopublishAll;
export const getSettings = getAutopublishSettings;
export const list = listAutopublish;

/*
=====================================================
Publishing
=====================================================
*/

function isAnnouncementChannel(channel) {
  return Boolean(
    channel &&
    channel.type === discord.ChannelType.GuildAnnouncement &&
    channel.isTextBased() &&
    !channel.isThread()
  );
}

export async function publishMessage(message, guildId) {
  const resolvedGuildId = guildId ?? message?.guildId ?? message?.guild?.id;
  if (!message || !resolvedGuildId) {
    return {success: false, reason: "missing-message"};
  }
  if (message.author?.bot || message.system) {
    return {success: false, reason: "bot-message"};
  }
  if (!isAnnouncementChannel(message.channel)) {
    return {success: false, reason: "not-announcement-channel"};
  }
  if (message.flags?.has?.(discord.MessageFlags.Crossposted)) {
    return {success: false, reason: "already-published"};
  }

  if (!message.crosspostable) {
    log.warn("BargazBot autopublish skipped — bot needs View Channel, Send Messages, and Manage Messages:", resolvedGuildId, message.channelId, message.id);
    return {success:false, reason:"not-crosspostable"};
  }

  try {
    await message.crosspost();
    log.info("BargazBot autopublish succeeded:", resolvedGuildId, message.channelId, message.id);
    await logging.logAutomaticAction(message.guild, {
      title: "BargazBot Message Published",
      description: `A message was auto published in <#${message.channelId}>.`,
      fields: [
        {name: "Message", value: message.id},
        {name: "Author", value: message.author?.tag ?? message.author?.id ?? "Unknown"}
      ]
    }).catch(error => log.warn("BargazBot autopublish success log failed:", error.message ?? error));
    return {success: true};
  } catch (error) {
    log.error("BargazBot autopublish failed:", resolvedGuildId, message.channelId, message.id, error);
    await logging.logGuildError(message.guild, {
      title: "BargazBot Auto Publish Failed",
      description: `BargazBot could not publish a message in <#${message.channelId}>.`,
      fields: [{name: "Error", value: String(error?.message ?? error).slice(0, 1000)}]
    }).catch(logError => log.warn("BargazBot autopublish error log failed:", logError.message ?? logError));
    return {success: false, reason: "publish-failed", error};
  }
}

export async function publishAll(client, guildId) {
  const result = {published: 0, failed: 0};
  let guild = null;

  try {
    guild = await client.guilds.fetch(guildId);
    await guild.channels.fetch();
    const config = listAutopublish(guildId);
    const channels = config.allEnabled
      ? [...guild.channels.cache.values()].filter(channel => isAnnouncementChannel(channel))
      : config.channels
        .map(channelId => guild.channels.cache.get(channelId))
        .filter(channel => isAnnouncementChannel(channel));

    for (const channel of channels) {
      let messages;
      try {
        messages = await channel.messages.fetch({limit: 50});
      } catch (error) {
        log.warn("BargazBot autopublish channel fetch failed:", guildId, channel.id, error.message ?? error);
        result.failed++;
        continue;
      }

      for (const message of messages.values()) {
        if (message.author?.bot || message.system || message.crosspostable === false) {continue;}
        const outcome = await publishMessage(message, guildId);
        if (outcome.success) {result.published++;} else {result.failed++;}
      }
    }
  } catch (error) {
    log.error("BargazBot autopublish all failed:", guildId, error);
    await logging.logGuildError(guild, {
      title: "BargazBot Auto Publish All Failed",
      description: "BargazBot could not run auto publish for this server.",
      fields: [{name: "Error", value: String(error?.message ?? error).slice(0, 1000)}]
    }).catch(logError => log.warn("BargazBot autopublish error log failed:", logError.message ?? logError));
    result.failed++;
  }

  return result;
}

async function handleMessageCreate(message) {
  if (!client || !message.guild || message.author?.bot || message.system) {return;}
  if (!isAnnouncementChannel(message.channel)) {return;}
  if (!featureSettings.isFeatureEnabled(message.guild.id, "autopublish")) {return;}
  if (!shouldAutopublish(message.guild.id, message.channelId)) {return;}
  log.info("BargazBot autopublish event:", message.guild.id, message.channelId, message.id);
  await publishMessage(message, message.guild.id);
}

/*
=====================================================
Service Lifecycle
=====================================================
*/

export function startAutoPublish(discordClient) {
  if (messageHandler) {return;}
  client = discordClient;
  ensureAutopublishTables();
  messageHandler = trackBotCallback(handleMessageCreate);
  client.on("messageCreate", messageHandler);
  log.info("BargazBot autopublish started.");
}

export function stopAutoPublish() {
  if (messageHandler && client) {client.off("messageCreate", messageHandler);}
  messageHandler = null;
  client = null;
  log.info("BargazBot autopublish stopped.");
}
