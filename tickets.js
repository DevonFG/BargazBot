import * as discord        from "discord.js";
import * as guildLogger    from "./guildLogger.js";
import * as channelManager from "./channelManager.js";
import * as featureSettings from "./featureSettings.js";
import { getDB }           from "./storage.js";
import { renderTemplate }  from "./utils.js";

function ensureGuild(guildId) {getDB().prepare("INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)").run(guildId);}
function newId(prefix = "ticket") {return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;}
function cleanName(value) {return String(value ?? "ticket").replace(/[^a-zA-Z0-9 _-]/g, "-").slice(0, 100);}

export function getPanel(guildId, panelId) {
  return getDB().prepare(
    "SELECT * FROM ticket_panels WHERE guild_id = ? AND panel_id = ?"
  ).get(guildId, panelId) ?? null;
}

export function listPanels(guildId) {
  return getDB().prepare(
    "SELECT * FROM ticket_panels WHERE guild_id = ? ORDER BY created_at ASC"
  ).all(guildId);
}

export async function createPanel(guild, options = {}) {
  ensureGuild(guild.id);
  const panelId = options.panelId ?? newId("panel");
  const channel = await channelManager.getChannel(guild, "tickets") ?? await channelManager.ensureChannel(guild, "tickets");
  getDB().prepare(`
    INSERT INTO ticket_panels (guild_id, panel_id, channel_id, title, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(guild.id, panelId, channel.id, String(options.title ?? "Support tickets").slice(0, 256), options.description ?? null);

  const payload = buildPanelPayload(guild.id, panelId);
  const message = await channel.send(payload).catch(() => null);
  if (message) {
    getDB().prepare("UPDATE ticket_panels SET message_id = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND panel_id = ?")
      .run(message.id, guild.id, panelId);
  }
  return getPanel(guild.id, panelId);
}

export async function updatePanel(guild, panelId, patch = {}) {
  const current = getPanel(guild.id, panelId);
  if (!current) {return null;}
  const title = patch.title ?? current.title;
  const description = Object.hasOwn(patch, "description") ? patch.description : current.description;
  getDB().prepare("UPDATE ticket_panels SET title = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND panel_id = ?")
    .run(title, description, guild.id, panelId);
  await refreshPanel(guild, panelId);
  return getPanel(guild.id, panelId);
}

export async function deletePanel(guild, panelId) {
  const panel = getPanel(guild.id, panelId);
  if (!panel) {return false;}
  const db = getDB();
  db.transaction(() => {
    const types = db.prepare("SELECT type_id FROM ticket_types WHERE guild_id = ? AND panel_id = ?").all(guild.id, panelId);
    for (const type of types) {db.prepare("DELETE FROM ticket_access WHERE guild_id = ? AND panel_id = ? AND type_id = ?").run(guild.id, panelId, type.type_id);}
    db.prepare("DELETE FROM ticket_types WHERE guild_id = ? AND panel_id = ?").run(guild.id, panelId);
    db.prepare("DELETE FROM ticket_panels WHERE guild_id = ? AND panel_id = ?").run(guild.id, panelId);
  })();
  if (panel.message_id) {
    const channel = await guild.channels.fetch(panel.channel_id).catch(() => null);
    await channel?.messages?.fetch(panel.message_id).then(message => message.delete().catch(() => {})).catch(() => {});
  }
  return true;
}

export function listTicketTypes(guildId, panelId) {
  return getDB().prepare(
    "SELECT * FROM ticket_types WHERE guild_id = ? AND panel_id = ? ORDER BY position ASC, created_at ASC"
  ).all(guildId, panelId);
}

export function getTicketType(guildId, panelId, typeId) {
  return getDB().prepare(
    "SELECT * FROM ticket_types WHERE guild_id = ? AND panel_id = ? AND type_id = ?"
  ).get(guildId, panelId, typeId) ?? null;
}

export function addTicketType(guildId, panelId, patch = {}) {
  ensureGuild(guildId);
  const config = featureSettings.getTicketConfig(guildId);
  const typeId = patch.typeId ?? newId("type");
  getDB().prepare(`
    INSERT INTO ticket_types (
      guild_id, panel_id, type_id, name, description, name_template,
      container_type, category_id, emoji, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    guildId, panelId, typeId,
    String(patch.name ?? "Ticket").slice(0, 100),
    patch.description ?? null,
    patch.nameTemplate ?? config.nameTemplate ?? "{user}-{count}",
    ["thread", "channel"].includes(patch.containerType) ? patch.containerType : config.defaultContainer ?? "thread",
    patch.categoryId ?? null,
    patch.emoji ?? null,
    Number(patch.position ?? 0)
  );
  return getTicketType(guildId, panelId, typeId);
}

export function deleteTicketType(guildId, panelId, typeId) {
  const db = getDB();
  db.prepare("DELETE FROM ticket_access WHERE guild_id = ? AND panel_id = ? AND type_id = ?").run(guildId, panelId, typeId);
  return db.prepare("DELETE FROM ticket_types WHERE guild_id = ? AND panel_id = ? AND type_id = ?").run(guildId, panelId, typeId).changes > 0;
}

export function setTicketAccess(guildId, panelId, typeId, patch = {}) {
  getDB().prepare(`
    INSERT INTO ticket_access (guild_id, panel_id, type_id, action, target_type, target_id, group_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, panel_id, type_id, action, target_type, target_id) DO UPDATE SET
      group_id = excluded.group_id
  `).run(
    guildId, panelId, typeId,
    String(patch.action ?? "view"),
    String(patch.targetType ?? "role"),
    String(patch.targetId ?? ""),
    patch.groupId ?? null
  );
  return true;
}

export function listTicketAccess(guildId, panelId, typeId) {
  return getDB().prepare(
    "SELECT * FROM ticket_access WHERE guild_id = ? AND panel_id = ? AND type_id = ?"
  ).all(guildId, panelId, typeId);
}

export function buildPanelPayload(guildId, panelId) {
  const panel = getPanel(guildId, panelId);
  if (!panel) {return null;}
  const types = listTicketTypes(guildId, panelId);
  const embed = new discord.EmbedBuilder()
    .setTitle(panel.title)
    .setDescription(panel.description ?? "Open a ticket by choosing a ticket type.")
    .setColor(0x5865F2)
    .setTimestamp();

  if (!types.length) {
    return {
      embeds:[embed],
      components:[new discord.ActionRowBuilder().addComponents(
        new discord.ButtonBuilder().setCustomId("ticket:none").setLabel("No ticket types").setDisabled(true).setStyle(discord.ButtonStyle.Secondary)
      )],
      allowedMentions:{parse:[]}
    };
  }

  const select = new discord.StringSelectMenuBuilder()
    .setCustomId(`ticket:type:${panelId}`)
    .setPlaceholder("Choose a ticket type")
    .addOptions(types.slice(0, 25).map(type => ({
      label:type.name.slice(0, 100),
      value:type.type_id,
      description:type.description?.slice(0, 100),
      ...(type.emoji ? {emoji:type.emoji} : {})
    })));

  return {embeds:[embed], components:[new discord.ActionRowBuilder().addComponents(select)], allowedMentions:{parse:[]}};
}

export async function refreshPanel(guild, panelId) {
  const panel = getPanel(guild.id, panelId);
  if (!panel?.message_id) {return false;}
  const channel = await guild.channels.fetch(panel.channel_id).catch(() => null);
  const message = await channel?.messages?.fetch(panel.message_id).catch(() => null);
  if (!message) {return false;}
  await message.edit(buildPanelPayload(guild.id, panelId)).catch(() => {});
  return true;
}

function ticketPermissions(action) {
  if (action === "manage") {return {ViewChannel:true, SendMessages:true, ReadMessageHistory:true, ManageMessages:true};}
  if (action === "hide")   {return {ViewChannel:false, SendMessages:false};}
  return {ViewChannel:true, SendMessages:true, ReadMessageHistory:true};
}

export async function openTicket(client, interaction, panelId, typeId) {
  const guild = interaction.guild;
  const panel = getPanel(guild.id, panelId);
  const type = getTicketType(guild.id, panelId, typeId);
  if (!panel || !type) {return {success:false, reason:"not-found"};}

  const count = getDB().prepare(
    "SELECT COUNT(*) AS count FROM tickets WHERE guild_id = ? AND panel_id = ? AND type_id = ?"
  ).get(guild.id, panelId, typeId).count;
  const name = cleanName(renderTemplate(type.name_template ?? "{user}-{count}", {
    user:interaction.user.username,
    count:count + 1,
    type:type.name,
    guild:guild.name,
    date:new Date().toISOString().slice(0, 10)
  }));

  let channel;
  if (type.container_type === "thread") {
    const parent = await guild.channels.fetch(panel.channel_id).catch(() => null);
    if (!parent?.isTextBased()) {return {success:false, reason:"parent-unavailable"};}
    channel = await parent.threads.create({name, reason:"BargazBot ticket", autoArchiveDuration:1440}).catch(() => null);
  } else {
    channel = await guild.channels.create({
      name,
      type:discord.ChannelType.GuildText,
      parent:type.category_id ?? undefined,
      reason:"BargazBot ticket"
    }).catch(() => null);
  }
  if (!channel) {return {success:false, reason:"channel-create-failed"};}

  await channel.permissionOverwrites.edit(interaction.user.id, {
    ViewChannel:true, SendMessages:true, ReadMessageHistory:true
  }).catch(() => {});
  for (const access of listTicketAccess(guild.id, panelId, typeId)) {
    await channel.permissionOverwrites.edit(access.target_id, ticketPermissions(access.action)).catch(() => {});
  }

  const ticketId = newId("tkt");
  getDB().prepare(`
    INSERT INTO tickets (guild_id, ticket_id, panel_id, type_id, channel_id, owner_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(guild.id, ticketId, panelId, typeId, channel.id, interaction.user.id);

  await channel.send({
    content:`${interaction.user} opened a **${type.name}** ticket. Use the close button when done.`,
    components:[new discord.ActionRowBuilder().addComponents(
      new discord.ButtonBuilder().setCustomId(`ticket:close:${ticketId}`).setLabel("Close ticket").setStyle(discord.ButtonStyle.Danger)
    )],
    allowedMentions:{parse:["users"], users:[interaction.user.id]}
  }).catch(() => {});

  guildLogger.logTicketEvent(guild, {
    ticketId, channelId:channel.id, panelId,
    title:"Ticket opened",
    description:`${interaction.user} opened a ${type.name} ticket.`,
    user:interaction.user
  }).catch(() => {});
  return {success:true, ticketId, channel};
}

export async function closeTicket(client, guild, ticketId, actorId = null) {
  const ticket = getDB().prepare(
    "SELECT * FROM tickets WHERE guild_id = ? AND ticket_id = ?"
  ).get(guild.id, ticketId);
  if (!ticket || ticket.status === "closed") {return {success:false, reason:"not-open"};}

  const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
  const messages = await channel?.messages?.fetch({limit:100}).catch(() => null);
  const transcript = messages
    ? [...messages.values()].reverse().map(message =>
        `[${message.createdAt.toISOString()}] ${message.author.tag}: ${message.content ?? ""}`
      ).join("\n")
    : "";

  const logChannel = await channelManager.getChannel(guild, "logs");
  if (logChannel) {
    await logChannel.send({
      content:`Ticket transcript \`${ticketId}\`${actorId ? ` closed by <@${actorId}>` : ""}.`,
      files:[{name:`transcript-${ticketId}.txt`, attachment:Buffer.from(transcript || "No messages.", "utf8")}],
      allowedMentions:{parse:[]}
    }).catch(() => {});
  }

  if (channel?.isThread()) {
    await channel.setArchived(true, "BargazBot ticket closed").catch(() => {});
  } else if (channel) {
    await channel.delete("BargazBot ticket closed").catch(() => {});
  }

  getDB().prepare(
    "UPDATE tickets SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND ticket_id = ?"
  ).run(guild.id, ticketId);

  guildLogger.logTicketEvent(guild, {
    ticketId, channelId:ticket.channel_id, panelId:ticket.panel_id,
    title:"Ticket closed",
    description:`A ticket was closed${actorId ? ` by <@${actorId}>` : ""}.`,
    user:actorId ? {id:actorId} : null
  }).catch(() => {});
  return {success:true};
}

export function getTicket(guildId, ticketId) {
  return getDB().prepare("SELECT * FROM tickets WHERE guild_id = ? AND ticket_id = ?").get(guildId, ticketId) ?? null;
}

export async function handleComponent(interaction) {
  const customId = interaction.customId ?? "";
  if (!customId.startsWith("ticket:")) {return false;}
  if (!interaction.guild) {return false;}

  if (customId === "ticket:none") {
    await interaction.reply({content:"This panel has no ticket types yet.", flags:discord.MessageFlags.Ephemeral}).catch(() => {});
    return true;
  }

  await interaction.deferReply({flags:discord.MessageFlags.Ephemeral});
  const parts = customId.split(":");

  if (parts[1] === "type") {
    const result = await openTicket(interaction.client, interaction, parts[2], interaction.values?.[0]);
    await interaction.editReply({content:result.success
      ? `Ticket opened in ${result.channel}.`
      : `Could not open the ticket (${result.reason}).`});
    return true;
  }

  if (parts[1] === "open") {
    const result = await openTicket(interaction.client, interaction, parts[2], parts[3]);
    await interaction.editReply({content:result.success
      ? `Ticket opened in ${result.channel}.`
      : `Could not open the ticket (${result.reason}).`});
    return true;
  }

  if (parts[1] === "close") {
    const result = await closeTicket(interaction.client, interaction.guild, parts[2], interaction.user.id);
    await interaction.editReply({content:result.success ? "Ticket closed." : "That ticket is already closed."});
    return true;
  }
  return false;
}
