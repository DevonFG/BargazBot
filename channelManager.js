import * as discord from "discord.js";
import * as log from "./appLogger.js";
import { getDB } from "./storage.js";

/*
=====================================================
Channel Purposes
=====================================================
*/

const CHANNEL_COLUMNS = {
  notifications: "announcement_channel_id",
  welcome:       "welcome_channel_id",
  goodbye:       "goodbye_channel_id",
  logs:          "logs_channel_id",
  updates:       "updates_channel_id",
  status:        "status_channel_id",
  alerts:        "alerts_channel_id",
  tickets:       "tickets_channel_id",
  "bot-detection": "bot_detection_channel_id"
};

const CHANNEL_COLUMN_NAMES = Object.values(CHANNEL_COLUMNS);
const BARGAZ_CHANNEL_NAME  = "bargaz";

function getChannelColumn(purpose) {
  const column = CHANNEL_COLUMNS[purpose];
  if (!column) {throw new Error(`Unknown BargazBot channel purpose: ${purpose}`);}
  return column;
}

function isUsableTextChannel(channel) {
  return Boolean(
    channel &&
    channel.isTextBased() &&
    !channel.isThread()
  );
}

export async function ensureLogChannel(guild) {
  const existing = await getChannel(guild, "logs");
  if (existing) {return existing;}
  const created = await guild.channels.create({
    name: "bargaz-logs",
    type: discord.ChannelType.GuildText,
    reason: "BargazBot log channel setup",
    permissionOverwrites: [
      {id: guild.roles.everyone.id, deny: [discord.PermissionFlagsBits.ViewChannel]},
      {id: guild.client.user.id, allow: [
        discord.PermissionFlagsBits.ViewChannel,
        discord.PermissionFlagsBits.SendMessages,
        discord.PermissionFlagsBits.EmbedLinks,
        discord.PermissionFlagsBits.ReadMessageHistory
      ]}
    ]
  });
  setChannel(guild.id, "logs", created.id);
  return created;
}

/*
=====================================================
Local Safety Tables
=====================================================
*/

function tableExists(name) {
  return Boolean(getDB().prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name));
}

function ensurePrivacyTable() {
  const db = getDB();
  db.exec(`
    CREATE TABLE IF NOT EXISTS privacy_channels (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      notice_sent_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    )
  `);
  const columns = db.prepare("PRAGMA table_info(privacy_channels)").all().map(column => column.name);
  if (!columns.includes("notice_sent_at")) {
    db.exec("ALTER TABLE privacy_channels ADD COLUMN notice_sent_at DATETIME");
  }
}

function ensureUserRecord(userId) {
  getDB().prepare(`
    INSERT INTO users (user_id, created_at, updated_at)
    VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO NOTHING
  `).run(userId);
}

/*
=====================================================
Setup Message
=====================================================
*/

function buildSetupEmbed() {
  return new discord.EmbedBuilder()
    .setTitle("BargazBot Setup")
    .setDescription(
      "Thanks for adding BargazBot to your server!\n\n" +
      "This channel has been created as the default location for BargazBot's features."
    )
    .addFields(
      {
        name: "Currently using this channel",
        value:
          "• Creator Notifications\n" +
          "• BargazBot Updates\n" +
          "• BargazBot Status\n" +
          "• Server Logs\n" +
          "• Welcome Messages\n" +
          "• Goodbye Messages"
      },
      {
        name: "Channel customization",
        value:
          "Use `/features-config` to change channels, features, response types, and the welcome message.\n" +
          "Run `/help` if you need help navigating BargazBot's commands!"
      }
    )
    .setTimestamp();
}

function buildStorageNoticeContent(userId) {
  return (
    `<@${userId}> BargazBot has started storing information about this server and its members.\n\n` +
    "You can view or delete what BargazBot stores with `/data view` in a DM or a text channel. " +
    "This is usually your publicly visible user ID and data BargazBot created while you used it."
  );
}

/*
=====================================================
Guild Database Records
=====================================================
*/

function ensureGuildRecord(guild) {
  getDB().prepare(`
    INSERT INTO guilds (
      guild_id, guild_name, owner_id, created_at, updated_at
    )
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO UPDATE SET
      guild_name = excluded.guild_name,
      owner_id = excluded.owner_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(guild.id, guild.name, guild.ownerId);
}

function ensureGuildSettingsRecord(guildId) {
  getDB().prepare(`
    INSERT INTO guild_settings (guild_id, created_at, updated_at)
    VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO NOTHING
  `).run(guildId);
}

export function ensureGuildData(guild) {
  ensureGuildRecord(guild);
  ensureGuildSettingsRecord(guild.id);
  ensurePrivacyTable();
}

/*
=====================================================
Configuration State
=====================================================
*/

export function hasGuildConfiguration(guildId) {
  const db = getDB();
  const settings = db.prepare(`
    SELECT ${CHANNEL_COLUMN_NAMES.join(", ")}
    FROM guild_settings
    WHERE guild_id = ?
  `).get(guildId);

  if (!settings) {return false;}
  if (CHANNEL_COLUMN_NAMES.some(column => Boolean(settings[column]))) {return true;}

  for (const table of ["guild_feature_settings", "guild_features", "feature_settings"]) {
    if (!tableExists(table)) {continue;}
    if (db.prepare(`SELECT 1 FROM ${table} WHERE guild_id = ? LIMIT 1`).get(guildId)) {return true;}
  }
  return false;
}

/*
=====================================================
Channel Assignments
=====================================================
*/

function saveDefaultChannelAssignments(guildId, channelId) {
  getDB().prepare(`
    INSERT INTO guild_settings (
      guild_id, announcement_channel_id, welcome_channel_id, goodbye_channel_id,
      logs_channel_id, updates_channel_id, status_channel_id, tickets_channel_id,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO UPDATE SET
      announcement_channel_id = excluded.announcement_channel_id,
      welcome_channel_id = excluded.welcome_channel_id,
      goodbye_channel_id = excluded.goodbye_channel_id,
      logs_channel_id = excluded.logs_channel_id,
      updates_channel_id = excluded.updates_channel_id,
      status_channel_id = excluded.status_channel_id,
      tickets_channel_id = excluded.tickets_channel_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, channelId, channelId, channelId, channelId, channelId, channelId, channelId);
}

export function setChannel(guildId, purpose, channelId) {
  const column = getChannelColumn(purpose);
  try {
    const result = getDB().prepare(`
      UPDATE guild_settings
      SET ${column} = ?, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ?
    `).run(channelId, guildId);

    if (result.changes === 0) {
      throw new Error(`Cannot change ${purpose} channel: guild ${guildId} has no guild_settings record.`);
    }
    log.info("BargazBot channel assignment saved:", guildId, purpose, channelId ?? "cleared");
  } catch (error) {
    log.error("BargazBot channel assignment failed:", guildId, purpose, error);
    throw error;
  }
}

export function clearChannel(guildId, purpose) {
  setChannel(guildId, purpose, null);
}

export function resetGuildChannels(guildId) {
  try {
    const assignments = Object.fromEntries(CHANNEL_COLUMN_NAMES.map(column => [column, null]));
    const columns = CHANNEL_COLUMN_NAMES.map(column => `${column} = ?`).join(", ");
    const result = getDB().prepare(`
      UPDATE guild_settings
      SET ${columns}, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ?
    `).run(...CHANNEL_COLUMN_NAMES.map(() => null), guildId);

    log.info("BargazBot guild channels cleared:", guildId, result.changes);
    return assignments;
  } catch (error) {
    log.error("BargazBot guild channel reset failed:", guildId, error);
    throw error;
  }
}

export function getChannelAssignments(guildId) {
  return (
    getDB().prepare(`
      SELECT ${CHANNEL_COLUMN_NAMES.join(", ")}
      FROM guild_settings
      WHERE guild_id = ?
    `).get(guildId) ??
    null
  );
}

/*
=====================================================
Get Configured Channel
=====================================================
*/

export async function getChannel(guild, purpose) {
  const column = getChannelColumn(purpose);
  const settings = getDB().prepare(`
    SELECT ${column}
    FROM guild_settings
    WHERE guild_id = ?
  `).get(guild.id);

  const channelId = settings?.[column];
  if (!channelId) {return null;}

  const channel =
    guild.channels.cache.get(channelId) ??
    await guild.channels.fetch(channelId).catch(() => null);

  if (!isUsableTextChannel(channel)) {return null;}
  return channel;
}

/*
=====================================================
Find or Create #bargaz
=====================================================
*/

async function fetchChannel(guild, channelId) {
  if (!channelId) {return null;}
  return (
    guild.channels.cache.get(channelId) ??
    await guild.channels.fetch(channelId).catch(() => null)
  );
}

export async function findBargazChannel(guild) {
  const assignments = getChannelAssignments(guild.id) ?? {};
  const checked = new Set();

  for (const column of CHANNEL_COLUMN_NAMES) {
    const channelId = assignments[column];
    if (!channelId || checked.has(channelId)) {continue;}
    checked.add(channelId);

    const channel = await fetchChannel(guild, channelId);
    if (channel?.name === BARGAZ_CHANNEL_NAME && isUsableTextChannel(channel)) {return channel;}
  }

  const named = guild.channels.cache.find(channel =>
    channel.name === BARGAZ_CHANNEL_NAME &&
    isUsableTextChannel(channel)
  );
  return named ?? null;
}

async function createBargazChannel(guild, reason) {
  return guild.channels.create({
    name: BARGAZ_CHANNEL_NAME,
    type: discord.ChannelType.GuildText,
    reason
  });
}

/*
=====================================================
Initial Guild Setup
=====================================================
*/

export async function ensureBargazChannel(guild) {
  let channel = await findBargazChannel(guild);
  if (!channel) {channel = await createBargazChannel(guild, "BargazBot feature setup");}
  if (!hasGuildConfiguration(guild.id)) {saveDefaultChannelAssignments(guild.id, channel.id);}
  return channel;
}

export async function setupGuild(guild, options = {}) {
  const force = Boolean(options.force);
  ensureGuildData(guild);

  if (!force && hasGuildConfiguration(guild.id)) {
    log.info("BargazBot setup skipped; server already configured:", guild.id);
    return {channel: await findBargazChannel(guild), created: false, skipped: true};
  }

  let channel = await findBargazChannel(guild);
  let created = false;

  if (!channel) {
    channel = await createBargazChannel(guild, "Initial BargazBot server setup");
    created = true;
  }

  saveDefaultChannelAssignments(guild.id, channel.id);
  await channel.send({embeds: [buildSetupEmbed()], allowedMentions: {parse: []}});

  log.info("BargazBot setup completed:", guild.id, channel.id, created ? "created" : "reused");
  return {channel, created, skipped: false};
}

/*
=====================================================
Ensure Feature Channel
=====================================================
*/

export async function ensureChannel(guild, purpose) {
  ensureGuildData(guild);

  const existing = await getChannel(guild, purpose);
  if (existing) {return existing;}

  const bargaz = await findBargazChannel(guild);
  if (bargaz) {
    setChannel(guild.id, purpose, bargaz.id);
    return bargaz;
  }

  const created = await createBargazChannel(guild, `Creating BargazBot ${purpose} channel`);
  setChannel(guild.id, purpose, created.id);
  log.info("BargazBot created #bargaz for a missing feature channel:", guild.id, purpose, created.id);
  return created;
}

export async function ensureNamedChannel(guild, purpose, name, options = {}) {
  ensureGuildData(guild);

  const existing = await getChannel(guild, purpose);
  if (existing) {return existing;}

  const wanted = String(name ?? `bargaz-${purpose}`)
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase()
    .slice(0, 100);

  const named = guild.channels.cache.find(channel =>
    channel.name === wanted &&
    (options.type === undefined || channel.type === options.type)
  );
  if (named && isUsableTextChannel(named)) {
    setChannel(guild.id, purpose, named.id);
    return named;
  }

  const payload = {
    name:wanted,
    type:options.type ?? discord.ChannelType.GuildText,
    reason:options.reason ?? `BargazBot ${purpose} channel`,
    permissionOverwrites:options.permissionOverwrites ?? []
  };
  if (options.topic)  {payload.topic = options.topic;}
  if (options.parent) {payload.parent = options.parent;}

  const created = await guild.channels.create(payload);
  setChannel(guild.id, purpose, created.id);
  log.info("BargazBot created managed channel:", guild.id, purpose, created.id);
  return created;
}

export async function deleteManagedChannel(guild, purpose, reason = "BargazBot managed channel removed") {
  const channel = await getChannel(guild, purpose);
  if (!channel) {return false;}

  try {
    await channel.delete(reason);
  } catch (error) {
    log.warn("BargazBot managed channel delete failed:", guild.id, purpose, error);
    return false;
  }

  clearChannel(guild.id, purpose);
  log.info("BargazBot managed channel removed:", guild.id, purpose, channel.id);
  return true;
}

/*
=====================================================
Private Per-User Storage Notice Channels
=====================================================
*/

export function getPrivacyChannelRecord(guildId, userId) {
  ensurePrivacyTable();
  return (
    getDB().prepare(`
      SELECT guild_id, user_id, channel_id, notice_sent_at, created_at, updated_at
      FROM privacy_channels
      WHERE guild_id = ? AND user_id = ?
    `).get(guildId, userId) ??
    null
  );
}

export function getPrivacyChannelRecords(guildId) {
  ensurePrivacyTable();
  return getDB().prepare(`
    SELECT guild_id, user_id, channel_id, notice_sent_at, created_at, updated_at
    FROM privacy_channels
    WHERE guild_id = ?
  `).all(guildId);
}

function savePrivacyChannel(guildId, userId, channelId) {
  ensurePrivacyTable();
  ensureUserRecord(userId);
  getDB().prepare(`
    INSERT INTO privacy_channels (
      guild_id, user_id, channel_id, created_at, updated_at
    )
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, userId, channelId);
}

function markPrivacyNoticeSent(guildId, userId) {
  getDB().prepare(`
    UPDATE privacy_channels
    SET notice_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = ? AND user_id = ?
  `).run(guildId, userId);
}

async function findPrivacyChannel(guild, userId) {
  const record = getPrivacyChannelRecord(guild.id, userId);
  const stored = await fetchChannel(guild, record?.channel_id);
  if (isUsableTextChannel(stored)) {return stored;}

  const named = guild.channels.cache.find(channel =>
    channel.name === `bargaz-storage-${userId}` &&
    isUsableTextChannel(channel)
  );
  if (named) {
    savePrivacyChannel(guild.id, userId, named.id);
    return named;
  }
  return null;
}

async function lockPrivacyChannel(guild, channel, userId) {
  const botId = guild.client.user?.id ?? null;
  await channel.permissionOverwrites.edit(guild.roles.everyone, {ViewChannel: false});
  await channel.permissionOverwrites.edit(userId, {
    ViewChannel: true,
    ReadMessageHistory: true,
    SendMessages: false,
    AddReactions: false
  });
  if (botId) {
    await channel.permissionOverwrites.edit(botId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      ManageChannels: true
    });
  }
}

export async function ensurePrivacyChannel(guild, userId) {
  ensureGuildData(guild);

  const existing = await findPrivacyChannel(guild, userId);
  if (existing) {return existing;}

  const channel = await guild.channels.create({
    name: `bargaz-storage-${userId}`,
    type: discord.ChannelType.GuildText,
    reason: "BargazBot private storage notice",
    permissionOverwrites: [
      {id: guild.roles.everyone.id, deny: [discord.PermissionFlagsBits.ViewChannel]},
      {id: userId, allow: [discord.PermissionFlagsBits.ViewChannel, discord.PermissionFlagsBits.ReadMessageHistory], deny: [discord.PermissionFlagsBits.SendMessages]}
    ]
  });
  await lockPrivacyChannel(guild, channel, userId);
  savePrivacyChannel(guild.id, userId, channel.id);
  log.info("BargazBot privacy channel created:", guild.id, userId, channel.id);
  return channel;
}

export async function sendStorageNotice(guild, userId, options = {}) {
  if (!guild.members.me?.permissions?.has(discord.PermissionFlagsBits.ManageChannels)) {return false;}
  const force = Boolean(options.force);
  const record = getPrivacyChannelRecord(guild.id, userId);
  if (!force && record?.notice_sent_at) {return false;}

  try {
    const channel = await ensurePrivacyChannel(guild, userId);
    await channel.send({
      content: buildStorageNoticeContent(userId),
      allowedMentions: {parse: ["users"], users: [userId]}
    });
    markPrivacyNoticeSent(guild.id, userId);
    log.info("BargazBot storage notice sent:", guild.id, userId, channel.id);
    return true;
  } catch (error) {
    log.error("BargazBot storage notice failed:", guild.id, userId, error);
    return false;
  }
}

export async function deletePrivacyChannel(guild, userId) {
  ensurePrivacyTable();
  const record = getPrivacyChannelRecord(guild.id, userId);
  if (!record) {return false;}

  const channel = await fetchChannel(guild, record.channel_id);
  if (channel) {
    await channel.delete("BargazBot private storage notice removed").catch(error =>
      log.warn("BargazBot privacy channel delete failed:", guild.id, userId, error)
    );
  }
  getDB().prepare("DELETE FROM privacy_channels WHERE guild_id = ? AND user_id = ?").run(guild.id, userId);
  log.info("BargazBot privacy channel removed:", guild.id, userId);
  return true;
}

export async function deleteAllPrivacyChannels(guild) {
  ensurePrivacyTable();
  const records = getPrivacyChannelRecords(guild.id);
  for (const record of records) {await deletePrivacyChannel(guild, record.user_id);}
  return records.length;
}

export async function deleteUserPrivacyChannels(client, userId) {
  ensurePrivacyTable();
  const records = getDB().prepare("SELECT guild_id FROM privacy_channels WHERE user_id = ?").all(userId);
  let removed = 0;

  for (const record of records) {
    const guild = await client.guilds.fetch(record.guild_id).catch(() => null);
    if (guild && await deletePrivacyChannel(guild, userId)) {removed++;}
  }
  return removed;
}
