import * as discord       from "discord.js";
import * as log           from "./appLogger.js";
import * as guildLogger   from "./guildLogger.js";
import * as featureSettings from "./featureSettings.js";
import { getDB }          from "./storage.js";
import { firstEmoji }     from "./utils.js";

const MODES  = new Set(["toggle", "add", "remove"]);
const STYLES = new Set(["reactions", "buttons", "dropdown"]);

function ensureGuild(guildId) {getDB().prepare("INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)").run(guildId);}
function newId(prefix = "rr") {return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;}

function getMode(config, messageId) {
  const stored = config.modes?.[messageId];
  if (MODES.has(stored)) {return stored;}
  return config.toggleDefault === false ? "add" : "toggle";
}

export function getReactionRoleMessage(guildId, messageId) {
  const row = getDB().prepare(
    "SELECT guild_id, message_id, channel_id, style, wrap_code FROM reaction_role_messages WHERE guild_id = ? AND message_id = ?"
  ).get(guildId, messageId);
  if (!row) {return null;}
  const config = featureSettings.getReactionRoleConfig(guildId);
  return {
    ...row,
    style:STYLES.has(row.style) ? row.style : "reactions",
    wrapCode:row.wrap_code === 1 && config.wrapCode !== false,
    mode:getMode(config, messageId)
  };
}

export function ensureReactionRoleMessage(guild, channelId, messageId, patch = {}) {
  ensureGuild(guild.id);
  const style = STYLES.has(patch.style) ? patch.style : "reactions";
  getDB().prepare(`
    INSERT INTO reaction_role_messages (guild_id, message_id, channel_id, style, wrap_code)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, message_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      style = excluded.style,
      wrap_code = excluded.wrap_code,
      updated_at = CURRENT_TIMESTAMP
  `).run(guild.id, messageId, channelId, style, patch.wrapCode === false ? 0 : 1);
  if (patch.mode) {setReactionRoleMode(guild.id, messageId, patch.mode);}
  return getReactionRoleMessage(guild.id, messageId);
}

export function setReactionRoleStyle(guildId, messageId, style) {
  if (!STYLES.has(style)) {throw new Error(`Unknown reaction-role style: ${style}`);}
  getDB().prepare(
    "UPDATE reaction_role_messages SET style = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND message_id = ?"
  ).run(style, guildId, messageId);
  return style;
}

export function setReactionRoleMode(guildId, messageId, mode) {
  if (!MODES.has(mode)) {throw new Error(`Unknown reaction-role mode: ${mode}`);}
  const config = featureSettings.getReactionRoleConfig(guildId);
  featureSettings.updateReactionRoleConfig(guildId, {
    modes:{...(config.modes ?? {}), [messageId]:mode}
  });
  return mode;
}

export function setReactionRoleWrap(guildId, wrapCode) {
  const value = Boolean(wrapCode);
  featureSettings.updateReactionRoleConfig(guildId, {wrapCode:value});
  return value;
}

export function listReactionRoleOptions(guildId, messageId) {
  return getDB().prepare(`
    SELECT option_id, label, emoji, role_id
    FROM reaction_role_options
    WHERE guild_id = ? AND message_id = ?
    ORDER BY rowid ASC
  `).all(guildId, messageId);
}

export function addReactionRoleOption(guildId, messageId, option = {}) {
  const options = listReactionRoleOptions(guildId, messageId);
  if (options.length >= 20) {throw new Error("A reaction-role message supports at most 20 options.");}
  const optionId = newId("opt");
  getDB().prepare(`
    INSERT INTO reaction_role_options (guild_id, message_id, option_id, label, emoji, role_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(guildId, messageId, optionId, String(option.label ?? "Option").slice(0, 100), option.emoji ?? null, String(option.roleId ?? ""));
  return optionId;
}

export function removeReactionRoleOption(guildId, messageId, optionId) {
  return getDB().prepare(
    "DELETE FROM reaction_role_options WHERE guild_id = ? AND message_id = ? AND option_id = ?"
  ).run(guildId, messageId, optionId).changes > 0;
}

export function deleteReactionRoleMessage(guildId, messageId) {
  const db = getDB();
  db.prepare("DELETE FROM reaction_role_options WHERE guild_id = ? AND message_id = ?").run(guildId, messageId);
  return db.prepare("DELETE FROM reaction_role_messages WHERE guild_id = ? AND message_id = ?").run(guildId, messageId).changes > 0;
}

export function buildReactionRolePayload(guildId, messageId) {
  const message = getReactionRoleMessage(guildId, messageId);
  if (!message) {return null;}
  const options = listReactionRoleOptions(guildId, messageId);
  const lines = options.map((option, index) =>
    `${firstEmoji(option.emoji, String(index + 1))} ${option.label} → <@&${option.role_id}>`
  );
  const body = lines.join("\n") || "No reaction-role options configured.";
  const components = [];

  if (message.style === "buttons") {
    const buttons = options.slice(0, 5).map(option => {
      const button = new discord.ButtonBuilder()
        .setCustomId(`rr:${option.option_id}`)
        .setLabel(option.label.slice(0, 100))
        .setStyle(discord.ButtonStyle.Secondary);
      if (option.emoji) {button.setEmoji(option.emoji);}
      return button;
    });
    if (buttons.length) {components.push(new discord.ActionRowBuilder().addComponents(buttons));}
  } else if (message.style === "dropdown") {
    const select = new discord.StringSelectMenuBuilder()
      .setCustomId(`rr-select:${messageId}`)
      .setPlaceholder("Choose a role")
      .addOptions(options.slice(0, 25).map(option => ({
        label:option.label.slice(0, 100),
        value:option.option_id,
        ...(option.emoji ? {emoji:option.emoji} : {})
      })));
    if (options.length) {components.push(new discord.ActionRowBuilder().addComponents(select));}
  }

  return {
    content:message.wrapCode ? `\`\`\`\n${body}\n\`\`\`` : body,
    allowedMentions:{parse:[]},
    components
  };
}

function optionMatches(option, emoji) {
  const configured = String(option.emoji ?? "").trim();
  if (!configured) {return option.label.toLowerCase() === String(emoji.name ?? emoji).toLowerCase();}
  if (configured.startsWith("<")) {return configured === emoji.toString();}
  return configured === String(emoji.name ?? emoji);
}

async function applyOption(client, guild, userId, option, mode, removed = false) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) {return false;}

  const shouldAdd = removed ? false : mode !== "remove";
  const shouldRemove = removed || mode === "remove";
  if (shouldAdd && !member.roles.cache.has(option.role_id)) {
    await member.roles.add(option.role_id, "BargazBot reaction role").catch(error => log.warn("Reaction role add failed:", guild.id, error));
  }
  if (shouldRemove && member.roles.cache.has(option.role_id)) {
    await member.roles.remove(option.role_id, "BargazBot reaction role").catch(error => log.warn("Reaction role remove failed:", guild.id, error));
  }

  guildLogger.logCategoryEvent(guild, "reaction-roles", {
    title:"Reaction role applied",
    description:`${member} used a reaction role.`,
    user:member.user,
    fields:[
      {name:"Option", value:option.label.slice(0, 1024), inline:true},
      {name:"Role", value:`<@&${option.role_id}>`, inline:true},
      {name:"Action", value:removed ? "Removed" : shouldRemove ? "Removed" : "Added", inline:true}
    ]
  }).catch(() => {});
  return true;
}

export async function addMessageReactions(client, guildId, channelId, messageId) {
  const message = await client.channels.fetch(channelId).then(channel => channel?.messages?.fetch(messageId)).catch(() => null);
  if (!message) {return false;}
  for (const option of listReactionRoleOptions(guildId, messageId)) {
    if (option.emoji) {await message.react(option.emoji).catch(() => {});}
  }
  return true;
}

export async function handleReaction(client, reaction, removed = false) {
  const guild = reaction.message.guild;
  const messageId = reaction.message.id;
  const message = getReactionRoleMessage(guild?.id, messageId);
  if (!guild || !message) {return false;}

  const option = listReactionRoleOptions(guild.id, messageId).find(row => optionMatches(row, reaction.emoji));
  if (!option) {return false;}
  return applyOption(client, guild, reaction.user.id, option, message.mode, removed);
}

export async function handleComponent(interaction) {
  const customId = interaction.customId ?? "";
  if (!customId.startsWith("rr:") && !customId.startsWith("rr-select:")) {return false;}
  const guild = interaction.guild;
  const messageId = interaction.message?.id;
  const optionId = customId.startsWith("rr-select:")
    ? interaction.values?.[0]
    : customId.slice(3);
  if (!guild || !messageId || !optionId) {return false;}

  const option = getDB().prepare(
    "SELECT option_id, label, emoji, role_id FROM reaction_role_options WHERE guild_id = ? AND message_id = ? AND option_id = ?"
  ).get(guild.id, messageId, optionId);
  if (!option) {return false;}

  await interaction.deferUpdate().catch(() => {});
  const message = getReactionRoleMessage(guild.id, messageId);
  return applyOption(clientFromInteraction(interaction), guild, interaction.user.id, option, message?.mode ?? "toggle");
}

function clientFromInteraction(interaction) {return interaction.client;}
