import * as discord        from "discord.js";
import * as guildLogger    from "./guildLogger.js";
import * as featureSettings from "./featureSettings.js";
import { getDB }           from "./storage.js";

function ensureGuild(guildId) {getDB().prepare("INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)").run(guildId);}

export function getNavigationMessage(guildId, messageId) {
  return getDB().prepare(
    "SELECT * FROM navigation_messages WHERE guild_id = ? AND message_id = ?"
  ).get(guildId, messageId) ?? null;
}

export function listNavigationMessages(guildId) {
  return getDB().prepare(
    "SELECT * FROM navigation_messages WHERE guild_id = ? ORDER BY created_at ASC"
  ).all(guildId);
}

export function updateNavigationMessageSettings(guildId, messageId, patch = {}) {
  const current = getNavigationMessage(guildId, messageId);
  if (!current) {return null;}
  getDB().prepare(`
    UPDATE navigation_messages
    SET title = ?, description = ?, auto_update = ?, updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = ? AND message_id = ?
  `).run(
    patch.title ?? current.title,
    Object.hasOwn(patch, "description") ? patch.description : current.description,
    Object.hasOwn(patch, "autoUpdate") ? (patch.autoUpdate ? 1 : 0) : current.auto_update,
    guildId, messageId
  );
  return getNavigationMessage(guildId, messageId);
}

export function setNavigationChannels(guild, messageId, channelIds = []) {
  const db = getDB();
  const entries = [];
  const categories = new Map();

  for (const channelId of [...new Set(channelIds.map(String))]) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased() || channel.isThread()) {continue;}
    const categoryId = channel.parentId ?? "none";
    categories.set(categoryId, channel.parent?.name ?? "Uncategorized");
    entries.push({channelId, categoryId, description:channel.topic ?? null});
  }

  db.transaction(() => {
    db.prepare("DELETE FROM navigation_channels WHERE guild_id = ? AND message_id = ?").run(guild.id, messageId);
    db.prepare("DELETE FROM navigation_categories WHERE guild_id = ? AND message_id = ?").run(guild.id, messageId);
    for (const [categoryId, name] of categories) {
      db.prepare(`
        INSERT INTO navigation_categories (guild_id, message_id, category_id, name, position)
        VALUES (?, ?, ?, ?, ?)
      `).run(guild.id, messageId, categoryId, name, [...categories.keys()].indexOf(categoryId));
    }
    for (const [index, entry] of entries.entries()) {
      db.prepare(`
        INSERT INTO navigation_channels (
          guild_id, message_id, channel_id, category_id, description_override, position
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(guild.id, messageId, entry.channelId, entry.categoryId, entry.description, index);
    }
  })();
  return entries.length;
}

export function setNavigationDescription(guildId, messageId, channelId, description) {
  return getDB().prepare(`
    UPDATE navigation_channels
    SET description_override = ?
    WHERE guild_id = ? AND message_id = ? AND channel_id = ?
  `).run(description ?? null, guildId, messageId, channelId).changes > 0;
}

export function buildNavigationEmbed(guild, messageId) {
  const message = getNavigationMessage(guild.id, messageId);
  if (!message) {return null;}
  const config = featureSettings.getNavigationConfig(guild.id);
  const db = getDB();
  const categories = db.prepare(
    "SELECT category_id, name FROM navigation_categories WHERE guild_id = ? AND message_id = ? ORDER BY position ASC"
  ).all(guild.id, messageId);
  const channels = db.prepare(
    "SELECT channel_id, category_id, description_override FROM navigation_channels WHERE guild_id = ? AND message_id = ? ORDER BY position ASC"
  ).all(guild.id, messageId);

  const embed = new discord.EmbedBuilder()
    .setTitle(message.title)
    .setDescription(message.description ?? "")
    .setColor(0x5865F2)
    .setTimestamp();

  for (const category of categories.length ? categories : [{category_id:"none", name:"Channels"}]) {
    const lines = channels
      .filter(row => row.category_id === category.category_id)
      .map(row => {
        const live = guild.channels.cache.get(row.channel_id);
        if (!live) {return null;}
        const description = row.description_override ?? (config.useTopics ? live.topic : null) ?? "";
        if (config.omitEmpty && !description) {return `• <#${row.channel_id}>`;}
        return `• <#${row.channel_id}>${description ? ` — ${description}` : ""}`;
      })
      .filter(Boolean);
    if (lines.length) {embed.addFields({name:category.name, value:lines.join("\n").slice(0, 1024), inline:false});}
  }
  return embed;
}

export function buildNavigationPayload(guild, messageId) {
  const embed = buildNavigationEmbed(guild, messageId);
  if (!embed) {return null;}
  return {embeds:[embed], allowedMentions:{parse:[]}};
}

export async function createNavigationMessage(guild, channelId, patch = {}) {
  ensureGuild(guild.id);
  const payloadChannel = await guild.channels.fetch(channelId).catch(() => null);
  if (!payloadChannel?.isTextBased()) {return null;}

  const message = await payloadChannel.send({
    content:"Loading navigation...",
    allowedMentions:{parse:[]}
  }).catch(() => null);
  if (!message) {return null;}

  getDB().prepare(`
    INSERT INTO navigation_messages (guild_id, message_id, channel_id, title, description, auto_update)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    guild.id, message.id, channelId,
    String(patch.title ?? "Server navigation").slice(0, 256),
    patch.description ?? null,
    patch.autoUpdate === false ? 0 : 1
  );

  const channels = patch.channelIds ?? [...guild.channels.cache.values()]
    .filter(channel => channel.isTextBased() && !channel.isThread())
    .map(channel => channel.id);
  setNavigationChannels(guild, message.id, channels);
  await message.edit(buildNavigationPayload(guild, message.id)).catch(() => {});

  guildLogger.logCategoryEvent(guild, "navigation", {
    title:"Navigation message created",
    description:`A navigation message was created in <#${channelId}>.`,
    fields:[{name:"Message", value:message.id, inline:true}]
  }).catch(() => {});
  return getNavigationMessage(guild.id, message.id);
}

export async function refreshNavigationMessage(client, guildId, messageId) {
  const record = getNavigationMessage(guildId, messageId);
  if (!record) {return false;}
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {return false;}
  const channel = await guild.channels.fetch(record.channel_id).catch(() => null);
  const message = await channel?.messages?.fetch(messageId).catch(() => null);
  if (!message) {return false;}
  await message.edit(buildNavigationPayload(guild, messageId)).catch(() => {});
  return true;
}

export async function refreshGuildNavigation(client, guildId) {
  const records = listNavigationMessages(guildId).filter(row => row.auto_update === 1);
  let updated = 0;
  for (const record of records) {if (await refreshNavigationMessage(client, guildId, record.message_id)) {updated++;}}
  return updated;
}

export async function handleChannelUpdate(client, channel) {
  if (!channel?.guild) {return 0;}
  return refreshGuildNavigation(client, channel.guild.id);
}

export async function deleteNavigationMessage(guild, messageId) {
  const record = getNavigationMessage(guild.id, messageId);
  if (!record) {return false;}
  const channel = await guild.channels.fetch(record.channel_id).catch(() => null);
  await channel?.messages?.fetch(messageId).then(message => message.delete().catch(() => {})).catch(() => {});
  const db = getDB();
  db.prepare("DELETE FROM navigation_channels WHERE guild_id = ? AND message_id = ?").run(guild.id, messageId);
  db.prepare("DELETE FROM navigation_categories WHERE guild_id = ? AND message_id = ?").run(guild.id, messageId);
  db.prepare("DELETE FROM navigation_messages WHERE guild_id = ? AND message_id = ?").run(guild.id, messageId);
  return true;
}
