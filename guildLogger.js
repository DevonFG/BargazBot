import * as discord from "discord.js";

import * as log from "./appLogger.js";
import * as featureSettings from "./featureSettings.js";
import { getDB } from "./storage.js";

/*
=====================================================
Categories
=====================================================
*/

export const LOG_CATEGORIES = {
  "autopublish":     {name: "Autopublish",       defaultEnabled: true},
  "counter":         {name: "Counters",          defaultEnabled: true},
  "data":            {name: "Data access",       defaultEnabled: true},
  "notifications":   {name: "Notifications",     defaultEnabled: true},
  "features-config": {name: "Feature config",    defaultEnabled: true},
  "inactivity":      {name: "Inactivity",        defaultEnabled: true},
  "leave-join":      {name: "Joins and leaves",  defaultEnabled: true},
  "logging-config":  {name: "Logging config",    defaultEnabled: true},
  "permissions":     {name: "Permissions",       defaultEnabled: true},
  "set-timezone":    {name: "Timezone",          defaultEnabled: true},
  "tests":           {name: "Tests",             defaultEnabled: true},
  "timers":          {name: "Timers",            defaultEnabled: true},
  "commands":        {name: "Commands",          defaultEnabled: true},
  "moderation":      {name: "Moderation",        defaultEnabled: true},
  "reaction-roles":  {name: "Reaction roles",    defaultEnabled: true},
  "verification":    {name: "Verification",      defaultEnabled: true},
  "tickets":         {name: "Tickets",           defaultEnabled: true},
  "navigation":      {name: "Navigation",        defaultEnabled: true},
  "role-rewards":    {name: "Role rewards",      defaultEnabled: true},
  "account-linking": {name: "Account linking",   defaultEnabled: true}
};

// These cannot be switched off while the logs feature is enabled.
const FORCED_CATEGORIES = new Set([
  "data", "permissions", "features-config", "logging-config"
]);

const COMMAND_LOG_TTL_MS = 30 * 60 * 1000;
const commandSessions = new Map();
const repairingChannels = new Set();

function getCategoryDefinition(category) {
  const definition = LOG_CATEGORIES[category];
  if (!definition) {throw new Error(`Unknown BargazBot log category: ${category}`);}
  return definition;
}

/*
=====================================================
Settings
=====================================================
*/

export function isCategoryForced(guildId, category) {
  return FORCED_CATEGORIES.has(category) &&
    featureSettings.isFeatureEnabled(guildId, "logs");
}

export function isCategoryEnabled(guildId, category) {
  getCategoryDefinition(category);
  if (isCategoryForced(guildId, category)) {return true;}
  const row = getDB().prepare(
    "SELECT enabled FROM guild_log_settings WHERE guild_id = ? AND category = ?"
  ).get(guildId, category);
  return row ? row.enabled === 1 : LOG_CATEGORIES[category].defaultEnabled;
}

export function getLogSettings(guildId) {
  const overrides = new Map(getDB().prepare(
    "SELECT category, enabled FROM guild_log_settings WHERE guild_id = ?"
  ).all(guildId).map(row => [row.category, row.enabled === 1]));
  const settings = {};

  for (const [category, definition] of Object.entries(LOG_CATEGORIES)) {
    settings[category] = {
      name:        definition.name,
      enabled:     isCategoryEnabled(guildId, category),
      forced:      isCategoryForced(guildId, category),
      isOverride:  overrides.has(category)
    };
  }
  return settings;
}

export function setCategoryEnabled(guildId, category, enabled, actorId = null) {
  getCategoryDefinition(category);
  const value = Boolean(enabled);
  getDB().prepare(`
    INSERT INTO guild_log_settings (guild_id, category, enabled, created_at, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id, category) DO UPDATE SET
      enabled = excluded.enabled,
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, category, value ? 1 : 0);

  // Never attribute a logging-config entry with the phrase "logged this message".
  logEvent(guildId, {
    category: "logging-config",
    title: "Logging category changed",
    description: `A logging category setting was changed${actorId ? ` by <@${actorId}>` : ""}.`,
    fields: [
      {name: "Category", value: LOG_CATEGORIES[category].name, inline: true},
      {name: "Setting",  value: value ? "On" : "Off",         inline: true}
    ]
  }).catch(() => {});

  return value;
}

// Applies a value only to categories that are currently on.
export function toggleAllEnabled(guildId, enabled, actorId = null) {
  const value = Boolean(enabled);
  const targets = Object.keys(LOG_CATEGORIES).filter(category =>
    isCategoryEnabled(guildId, category) && !isCategoryForced(guildId, category)
  );
  for (const category of targets) {setCategoryEnabled(guildId, category, value, actorId);}
  return targets;
}

// Applies a value to every category, except ones forced on by the logs feature.
export function toggleAllCategories(guildId, enabled, actorId = null) {
  const value = Boolean(enabled);
  const targets = Object.keys(LOG_CATEGORIES).filter(category =>
    !isCategoryForced(guildId, category)
  );
  for (const category of targets) {setCategoryEnabled(guildId, category, value, actorId);}
  return targets;
}

export function resetLogSettings(guildId, actorId = null) {
  getDB().prepare("DELETE FROM guild_log_settings WHERE guild_id = ?").run(guildId);
  logEvent(guildId, {
    category: "logging-config",
    title: "Logging settings reset",
    description: `Logging categories were restored to defaults${actorId ? ` by <@${actorId}>` : ""}.`
  }).catch(() => {});
}

/*
=====================================================
Log channel handling
=====================================================
*/

export function getConfiguredLogChannel(guild) {
  const row = getDB().prepare(
    "SELECT logs_channel_id FROM guild_settings WHERE guild_id = ?"
  ).get(guild.id);
  if (!row?.logs_channel_id) {return null;}

  return (
    guild.channels.cache.get(row.logs_channel_id) ??
    null
  );
}

async function fetchConfiguredLogChannel(guild) {
  const row = getDB().prepare(
    "SELECT logs_channel_id FROM guild_settings WHERE guild_id = ?"
  ).get(guild.id);
  if (!row?.logs_channel_id) {return null;}

  const cached = guild.channels.cache.get(row.logs_channel_id);
  if (cached) {return cached;}
  return await guild.channels.fetch(row.logs_channel_id).catch(() => null);
}

async function ensureReplacementLogChannel(guild) {
  if (repairingChannels.has(guild.id)) {return null;}
  repairingChannels.add(guild.id);
  try {
    const channel = await guild.channels.create({
      name: "bargaz-logs",
      type: discord.ChannelType.GuildText,
      reason: "BargazBot log channel replacement",
      permissionOverwrites: [
        {id: guild.roles.everyone.id, deny: [discord.PermissionFlagsBits.ViewChannel]},
        {id: guild.client.user.id, allow: [
          discord.PermissionFlagsBits.ViewChannel,
          discord.PermissionFlagsBits.SendMessages,
          discord.PermissionFlagsBits.EmbedLinks,
          discord.PermissionFlagsBits.ReadMessageHistory,
          discord.PermissionFlagsBits.ManageChannels
        ]}
      ]
    });
    getDB().prepare(`
      UPDATE guild_settings
      SET logs_channel_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ?
    `).run(channel.id, guild.id);
    log.warn("BargazBot created a replacement log channel:", guild.id, channel.id);
    return channel;
  } catch (error) {
    log.error("BargazBot could not create a replacement log channel:", guild.id, error);
    return null;
  } finally {
    repairingChannels.delete(guild.id);
  }
}

function isChannelFailure(error) {
  const code = error?.code;
  return code === 10008 || code === 10003 || code === 50013 || code === 50001 || code === 404;
}

/*
=====================================================
Embed building
=====================================================
*/

function truncate(value, limit = 1024) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function sanitize(category, description) {
  const text = String(description ?? "");
  if (category === "logging-config") {
    return text.replace(/logged this message/gi, "recorded this change");
  }
  return text;
}

function buildEmbed(payload) {
  const definition = getCategoryDefinition(payload.category);
  const embed = new discord.EmbedBuilder()
    .setTitle(truncate(payload.title ?? "BargazBot event", 256))
    .setDescription(truncate(sanitize(payload.category, payload.description ?? ""), 4096))
    .setFooter({text: `BargazBot • ${definition.name}`})
    .setTimestamp(payload.timestamp ?? new Date());

  if (payload.color !== undefined) {embed.setColor(payload.color);}

  if (payload.user) {
    embed.setAuthor({
      name: payload.user.globalName ?? payload.user.username ?? payload.user.tag ?? "Unknown user",
      iconURL: payload.user.displayAvatarURL?.() ?? undefined
    });
  }

  const fields = (payload.fields ?? [])
    .filter(field => field && field.name && field.value !== undefined && field.value !== null)
    .map(field => ({name: truncate(field.name, 256), value: truncate(field.value), inline: Boolean(field.inline)}));
  if (fields.length > 0) {embed.addFields(fields.slice(0, 25));}
  return embed;
}

/*
=====================================================
Sending
=====================================================
*/

async function sendWithRepair(guild, embed, options = {}) {
  let channel = await fetchConfiguredLogChannel(guild);
  // No configured channel means no log and no channel creation.
  if (!channel?.isTextBased()) {return null;}

  try {
    return await channel.send({embeds: [embed], allowedMentions: {parse: []}});
  } catch (error) {
    if (!isChannelFailure(error)) {
      log.error("BargazBot guild log send failed:", guild.id, error);
      return null;
    }
    log.warn("BargazBot log channel is unusable; replacing it:", guild.id, error.code ?? error);
  }

  channel = await ensureReplacementLogChannel(guild);
  if (!channel) {return null;}
  try {
    return await channel.send({embeds: [embed], allowedMentions: {parse: []}});
  } catch (error) {
    log.error("BargazBot replacement log channel send failed:", guild.id, error);
    return null;
  }
}

// guild may be a Guild object or a guild id string.
async function logEvent(guildOrId, payload) {
  const guild = typeof guildOrId === "string"
    ? (globalThis.__bargazClient?.guilds?.cache?.get(guildOrId) ?? null)
    : guildOrId;

  if (!guild) {return false;}
  if (!isCategoryEnabled(guild.id, payload.category)) {return false;}

  try {
    const message = await sendWithRepair(guild, buildEmbed(payload), payload);
    return Boolean(message);
  } catch (error) {
    log.error("BargazBot guild log failed:", guild.id, payload.category, error);
    return false;
  }
}

// Every failure path can call this; it never throws and always reaches appLogger.
export async function logFailure(guildOrId, payload = {}) {
  const {category = "errors", error = null, ...rest} = payload;
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error ?? "");
  log.error("BargazBot failure:", rest.title ?? "Failure", detail);

  const guild = typeof guildOrId === "string"
    ? (globalThis.__bargazClient?.guilds?.cache?.get(guildOrId) ?? null)
    : guildOrId;
  if (!guild) {return false;}

  return logEvent(guild, {
    category,
    title:    rest.title ?? "BargazBot error",
    description: rest.description ?? "An operation failed.",
    user:     rest.user ?? null,
    fields: [
      ...(rest.fields ?? []),
      ...(detail ? [{name: "Error", value: detail.slice(0, 1000), inline: false}] : [])
    ]
  });
}

/*
=====================================================
Command log sessions (one message, edited as the trail grows)
=====================================================
*/

function commandKey(interaction) {
  return `${interaction.guildId}:${interaction.id}`;
}

function trailLabel(interaction) {
  if (interaction.isModalSubmit?.()) {
    return `Modal \`${interaction.customId}\``;
  }
  if (interaction.isAnySelectMenu?.()) {
    const values = interaction.values ?? [];
    return `Select \`${interaction.customId}\` → ${values.map(value => `\`${value}\``).join(", ") || "none"}`;
  }
  if (interaction.isButton?.()) {
    return `Button \`${interaction.customId}\``;
  }
  return `${interaction.type ?? "Interaction"} \`${interaction.customId ?? ""}\``.trim();
}

function buildCommandEmbed(session) {
  const embed = new discord.EmbedBuilder()
    .setTitle("BargazBot command")
    .setDescription(`<@${session.userId}> used a BargazBot command.`)
    .addFields(
      {name: "Command",   value: `\`${session.command}\``, inline: true},
      {name: "User",      value: `<@${session.userId}> (\`${session.userId}\`)`, inline: true},
      {name: "Bot",       value: session.botName ?? "BargazBot", inline: true},
      {name: "Channel",   value: session.channelId ? `<#${session.channelId}>` : "Unknown", inline: true},
      {name: "Timestamp", value: `<t:${Math.floor(session.startedAt / 1000)}:F>`, inline: true},
      {name: "Result",    value: session.result ?? "In progress", inline: true}
    )
    .setFooter({text: "BargazBot • Commands"})
    .setTimestamp(new Date(session.startedAt));

  if (session.trail.length > 0) {
    embed.addFields({
      name: "Interaction trail",
      value: session.trail.map((step, index) => `${index + 1}. ${step}`).join("\n").slice(0, 1024)
    });
  }
  return embed;
}

function pruneSessions() {
  const now = Date.now();
  for (const [key, session] of commandSessions) {
    if (now - session.startedAt > COMMAND_LOG_TTL_MS) {commandSessions.delete(key);}
  }
}

export async function beginCommandLog(interaction, initialStep = null) {
  if (!interaction.guild || !isCategoryEnabled(interaction.guild.id, "commands")) {return false;}
  pruneSessions();

  const key = commandKey(interaction);
  const session = {
    userId:      interaction.user.id,
    command:     `/${interaction.commandName}`,
    channelId:   interaction.channelId,
    botName:     interaction.client?.user?.tag ?? "BargazBot",
    startedAt:   Date.now(),
    trail:       initialStep ? [initialStep] : [],
    result:      "In progress",
    messageId:   null,
    channelRef:  null
  };
  commandSessions.set(key, session);

  const message = await sendWithRepair(interaction.guild, buildCommandEmbed(session));
  if (message) {
    session.messageId  = message.id;
    session.channelRef = message.channel;
  }
  return Boolean(message);
}

export async function appendCommandTrail(interaction, step = null) {
  const session = commandSessions.get(commandKey(interaction));
  if (!session) {return false;}
  const label = step ?? trailLabel(interaction);
  if (label) {session.trail.push(String(label).slice(0, 300));}
  return editCommandLog(interaction);
}

export async function finishCommandLog(interaction, result = "Completed") {
  const session = commandSessions.get(commandKey(interaction));
  if (!session) {return false;}
  session.result = result;
  const ok = await editCommandLog(interaction);
  setTimeout(() => commandSessions.delete(commandKey(interaction)), 60_000).unref?.();
  return ok;
}

async function editCommandLog(interaction) {
  const session = commandSessions.get(commandKey(interaction));
  if (!session?.messageId || !session.channelRef) {return false;}
  try {
    await session.channelRef.messages.edit(session.messageId, {
      embeds: [buildCommandEmbed(session)],
      allowedMentions: {parse: []}
    });
    return true;
  } catch (error) {
    if (isChannelFailure(error)) {
      commandSessions.delete(commandKey(interaction));
      await ensureReplacementLogChannel(interaction.guild).catch(() => null);
    } else {
      log.error("BargazBot command log edit failed:", interaction.guildId, error);
    }
    return false;
  }
}

/*
=====================================================
Other bots' public slash-command responses
=====================================================
*/

export async function logExternalCommand(message) {
  if (!message.guild || !message.author?.bot) {return false;}
  const interaction = message.interaction;
  if (!interaction || interaction.type !== discord.InteractionType.ApplicationCommand) {return false;}

  // Ephemeral responses never produce a visible message, so there is nothing to log.
  return logEvent(message.guild, {
    category: "commands",
    title: "Other bot command response",
    description: `${message.author} responded to a slash command.`,
    user: interaction.user ?? message.author,
    fields: [
      {name: "Command",  value: `/${interaction.commandName ?? "unknown"}`, inline: true},
      {name: "Bot",      value: message.author.tag ?? message.author.username, inline: true},
      {name: "Channel",  value: `<#${message.channelId}>`, inline: true},
      {name: "Timestamp", value: `<t:${Math.floor(message.createdTimestamp / 1000)}:F>`, inline: true},
      {name: "User",     value: interaction.user ? `<@${interaction.user.id}>` : "Unknown", inline: true}
    ]
  });
}

export function setClient(client) {globalThis.__bargazClient = client;}
