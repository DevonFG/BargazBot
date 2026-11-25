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
function ensureColumns() {
  const db = getDB();
  const cols = db.prepare("PRAGMA table_info(reaction_role_messages)").all().map(r => r.name);
  if (!cols.includes("content")) {db.exec("ALTER TABLE reaction_role_messages ADD COLUMN content TEXT");}
  if (!cols.includes("nickname")) {db.exec("ALTER TABLE reaction_role_messages ADD COLUMN nickname TEXT");}
}

function getMode(config, messageId) {
  const stored = config.modes?.[messageId];
  if (MODES.has(stored)) {return stored;}
  return config.toggleDefault === false ? "add" : "toggle";
}

export function getReactionRoleMessage(guildId, messageId) {
  ensureColumns();
  const row = getDB().prepare(
    "SELECT * FROM reaction_role_messages WHERE guild_id = ? AND message_id = ?"
  ).get(guildId, messageId);
  if (!row) {return null;}
  const config = featureSettings.getReactionRoleConfig(guildId);
  return {
    ...row,
    nickname: row.nickname ?? null,
    content: row.content ?? null,
    style:STYLES.has(row.style) ? row.style : "reactions",
    wrapCode:row.wrap_code === 1 && config.wrapCode !== false,
    mode:getMode(config, messageId)
  };
}

export function ensureReactionRoleMessage(guild, channelId, messageId, patch = {}) {
  ensureGuild(guild.id);
  ensureColumns();
  const style = STYLES.has(patch.style) ? patch.style : "reactions";
  getDB().prepare(`
    INSERT INTO reaction_role_messages (guild_id, message_id, channel_id, style, wrap_code, nickname, content)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, message_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      style = excluded.style,
      wrap_code = excluded.wrap_code,
      nickname = COALESCE(excluded.nickname, reaction_role_messages.nickname),
      content = COALESCE(excluded.content, reaction_role_messages.content),
      updated_at = CURRENT_TIMESTAMP
  `).run(guild.id, messageId, channelId, style, patch.wrapCode === false ? 0 : 1, patch.nickname ?? null, patch.content ?? null);
  if (patch.mode) {setReactionRoleMode(guild.id, messageId, patch.mode);}
  return getReactionRoleMessage(guild.id, messageId);
}

export function updateReactionRoleMessage(guildId, messageId, patch = {}) {
  ensureColumns();
  const current = getReactionRoleMessage(guildId, messageId);
  if (!current) {return null;}
  getDB().prepare(`
    UPDATE reaction_role_messages
    SET channel_id = ?, style = ?, wrap_code = ?, nickname = ?, content = ?, updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = ? AND message_id = ?
  `).run(
    patch.channelId ?? current.channel_id,
    STYLES.has(patch.style) ? patch.style : current.style,
    Object.hasOwn(patch, "wrapCode") ? (patch.wrapCode ? 1 : 0) : current.wrap_code,
    Object.hasOwn(patch, "nickname") ? patch.nickname : current.nickname,
    Object.hasOwn(patch, "content") ? patch.content : current.content,
    guildId, messageId
  );
  if (patch.mode) {setReactionRoleMode(guildId, messageId, patch.mode);}
  return getReactionRoleMessage(guildId, messageId);
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
    SELECT option_id, label, emoji, role_id, group_label, menu_kind, button_label, position
    FROM reaction_role_options
    WHERE guild_id = ? AND message_id = ?
    ORDER BY position ASC, rowid ASC
  `).all(guildId, messageId).map((row, index) => ({...row, position: Number(row.position ?? index)}));
}

export function addReactionRoleOption(guildId, messageId, option = {}) {
  const options = listReactionRoleOptions(guildId, messageId);
  const optionId = option.optionId ?? newId("opt");
  const position = Number.isFinite(Number(option.position)) ? Number(option.position) : options.length;
  getDB().prepare(`
    INSERT INTO reaction_role_options (guild_id, message_id, option_id, label, emoji, role_id, group_label, menu_kind, button_label, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    guildId, messageId, optionId,
    String(option.label ?? "Option").slice(0, 100),
    option.emoji ?? null,
    String(option.roleId ?? ""),
    option.groupLabel ? String(option.groupLabel).slice(0, 100) : null,
    option.menuKind ? String(option.menuKind).slice(0, 20) : null,
    option.buttonLabel ? String(option.buttonLabel).slice(0, 80) : null,
    position
  );
  return optionId;
}

export function updateReactionRoleOption(guildId, messageId, optionId, patch = {}) {
  const current = getDB().prepare(
    "SELECT * FROM reaction_role_options WHERE guild_id = ? AND message_id = ? AND option_id = ?"
  ).get(guildId, messageId, optionId);
  if (!current) {return null;}
  getDB().prepare(`
    UPDATE reaction_role_options
    SET label = ?, emoji = ?, role_id = ?, group_label = ?, menu_kind = ?, button_label = ?, position = ?
    WHERE guild_id = ? AND message_id = ? AND option_id = ?
  `).run(
    Object.hasOwn(patch, "label") ? String(patch.label ?? "").slice(0, 100) : current.label,
    Object.hasOwn(patch, "emoji") ? patch.emoji : current.emoji,
    Object.hasOwn(patch, "roleId") ? String(patch.roleId ?? "") : current.role_id,
    Object.hasOwn(patch, "groupLabel") ? (patch.groupLabel ? String(patch.groupLabel).slice(0, 100) : null) : current.group_label,
    Object.hasOwn(patch, "menuKind") ? (patch.menuKind ? String(patch.menuKind).slice(0, 20) : null) : current.menu_kind,
    Object.hasOwn(patch, "buttonLabel") ? (patch.buttonLabel ? String(patch.buttonLabel).slice(0, 80) : null) : current.button_label,
    Object.hasOwn(patch, "position") ? Number(patch.position ?? 0) : Number(current.position ?? 0),
    guildId, messageId, optionId
  );
  return getDB().prepare("SELECT * FROM reaction_role_options WHERE guild_id = ? AND message_id = ? AND option_id = ?").get(guildId, messageId, optionId);
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

function groupOptions(options, style) {
  const groups = new Map();
  for (const option of options) {
    const kind = option.menu_kind ?? (style === "dropdown" ? "dropdown" : style === "buttons" ? "button" : "reaction");
    const group = option.group_label ?? (kind === "dropdown" ? "Roles" : kind === "button" ? "Buttons" : "Reactions");
    const key = `${kind}::${group}`;
    if (!groups.has(key)) {groups.set(key, {kind, label:group, options:[]});}
    groups.get(key).options.push(option);
  }
  return [...groups.values()];
}

export function buildReactionRolePayload(guildId, messageId) {
  const message = getReactionRoleMessage(guildId, messageId);
  if (!message) {return null;}
  const options = listReactionRoleOptions(guildId, messageId);
  const body = message.content ?? (options.map((option, index) =>
    `${firstEmoji(option.emoji, String(index + 1))} ${option.label} → <@&${option.role_id}>`
  ).join("\n") || "No reaction-role options configured.");
  const components = [];
  const groups = groupOptions(options, message.style);

  for (const group of groups) {
    if (components.length >= 5) {break;}
    if (group.kind === "button") {
      for (let i = 0; i < group.options.length && components.length < 5; i += 5) {
        const row = new discord.ActionRowBuilder();
        for (const option of group.options.slice(i, i + 5)) {
          const button = new discord.ButtonBuilder()
            .setCustomId(`rr:${option.option_id}`)
            .setLabel(String(option.button_label ?? option.label ?? "Role").slice(0, 80))
            .setStyle(discord.ButtonStyle.Secondary);
          if (option.emoji) {button.setEmoji(option.emoji);}
          row.addComponents(button);
        }
        components.push(row);
      }
    } else if (group.kind === "dropdown") {
      for (let i = 0; i < group.options.length && components.length < 5; i += 25) {
        const slice = group.options.slice(i, i + 25);
        const select = new discord.StringSelectMenuBuilder()
          .setCustomId(`rr-select:${messageId}:${group.label}:${i}`)
          .setPlaceholder(String(group.label ?? "Choose a role").slice(0, 100))
          .setMinValues(0)
          .setMaxValues(Math.min(slice.length, 25))
          .addOptions(slice.map(option => ({
            label:String(option.label ?? "Option").slice(0, 100),
            value:option.option_id,
            ...(option.emoji ? {emoji:option.emoji} : {})
          })));
        components.push(new discord.ActionRowBuilder().addComponents(select));
      }
    }
  }

  const content = message.wrapCode && !message.content ? `\`\`\`\n${body}\n\`\`\`` : body;
  return {content:String(content).slice(0, 2000), allowedMentions:{parse:[]}, components};
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
  const add = removed ? false : mode !== "remove";
  const remove = removed || mode === "remove";
  if (add && !member.roles.cache.has(option.role_id)) {
    await member.roles.add(option.role_id, "BargazBot reaction role").catch(error => log.warn("Reaction role add failed:", guild.id, error));
  }
  if (remove && member.roles.cache.has(option.role_id)) {
    await member.roles.remove(option.role_id, "BargazBot reaction role").catch(error => log.warn("Reaction role remove failed:", guild.id, error));
  }
  guildLogger.logCategoryEvent(guild, "reaction-roles", {
    title:"Reaction role applied",
    description:`${member} used a reaction role.`,
    user:member.user,
    fields:[
      {name:"Option", value:String(option.label).slice(0, 1024), inline:true},
      {name:"Role", value:`<@&${option.role_id}>`, inline:true},
      {name:"Action", value:remove ? "Removed" : "Added", inline:true}
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
  if (!guild || !messageId) {return false;}

  await interaction.deferUpdate().catch(() => {});
  const message = getReactionRoleMessage(guild.id, messageId);
  const mode = message?.mode ?? "toggle";

  if (customId.startsWith("rr-select:")) {
    const values = new Set(interaction.values ?? []);
    const options = listReactionRoleOptions(guild.id, messageId).filter(o => (o.menu_kind ?? "dropdown") === "dropdown");
    for (const option of options) {
      const selected = values.has(option.option_id);
      await applyOption(interaction.client, guild, interaction.user.id, option, selected ? mode : "remove", !selected && mode !== "add");
    }
    return true;
  }

  const optionId = customId.slice(3);
  const option = getDB().prepare(
    "SELECT * FROM reaction_role_options WHERE guild_id = ? AND message_id = ? AND option_id = ?"
  ).get(guild.id, messageId, optionId);
  if (!option) {return false;}
  return applyOption(interaction.client, guild, interaction.user.id, option, mode);
}
