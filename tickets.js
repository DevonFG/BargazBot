import * as discord        from "discord.js";
import * as channelManager from "./channelManager.js";
import * as guildLogger    from "./guildLogger.js";
import * as log            from "./appLogger.js";
import { getDB }           from "./storage.js";
import { renderTemplate, firstEmoji, clip } from "./utils.js";
import { randomUUID }      from "crypto";

const newId = prefix => `${prefix}-${randomUUID().slice(0, 8)}`;
const cleanName = value => String(value ?? "ticket").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "ticket";
const parse = (value, fallback = {}) => {try {return JSON.parse(value || "");} catch {return fallback;}};
const arr = value => Array.isArray(value) ? value : [];
const snowflakes = value => [...new Set(arr(value).map(v => String(v ?? "").trim()).filter(Boolean))];

export function defaultPanelConfig() {
  return {
    close: {exportLogs:true, deleteChannel:true, move:false, moveCategoryId:null},
    defaults: {
      containerType:null, viewRoles:[], viewUsers:[], pingRoles:[], pingUsers:[],
      openMessageEnabled:false, openMessage:"", closeRule:"all", exportRule:"all", deleteRule:"all",
      closeRoles:[], exportRoles:[], deleteRoles:[], namingSuffix:"number"
    }
  };
}

export function defaultOptionConfig() {
  return {
    namingSuffix:"number",
    viewRoles:[], viewUsers:[], pingRoles:[], pingUsers:[],
    openMessageEnabled:false, openMessage:"",
    closeRule:"all", exportRule:"all", deleteRule:"all",
    closeRoles:[], exportRoles:[], deleteRoles:[],
    surveyEnabled:false, survey:[]
  };
}

function mergeConfig(defaults, raw) {
  const src = raw && typeof raw === "object" ? raw : parse(raw, {});
  return {
    ...defaults,
    ...src,
    close: {...defaults.close, ...(src.close ?? {})},
    defaults: {...defaults.defaults, ...(src.defaults ?? {})}
  };
}

function normalizePanel(row) {
  if (!row) {return null;}
  return {...row, config: mergeConfig(defaultPanelConfig(), row.config_json)};
}
function normalizeOption(row) {
  if (!row) {return null;}
  const base = defaultOptionConfig();
  const src = row.config_json && typeof row.config_json === "object" ? row.config_json : parse(row.config_json, {});
  return {...row, config:{...base, ...src}};
}

export function getPanel(guildId, panelId) {
  return normalizePanel(getDB().prepare("SELECT * FROM ticket_panels WHERE guild_id = ? AND panel_id = ?").get(guildId, panelId) ?? null);
}
export function listPanels(guildId) {
  return getDB().prepare("SELECT * FROM ticket_panels WHERE guild_id = ? AND message_id IS NOT NULL AND message_id != '' ORDER BY created_at ASC").all(guildId).map(normalizePanel);
}
export function listTicketTypes(guildId, panelId) {
  return getDB().prepare("SELECT * FROM ticket_types WHERE guild_id = ? AND panel_id = ? ORDER BY position ASC, created_at ASC").all(guildId, panelId).map(normalizeOption);
}
export function getTicketType(guildId, panelId, typeId) {
  return normalizeOption(getDB().prepare("SELECT * FROM ticket_types WHERE guild_id = ? AND panel_id = ? AND type_id = ?").get(guildId, panelId, typeId) ?? null);
}

export async function createPanel(guild, options = {}) {
  const panelId = options.panelId ?? newId("panel");
  const channelId = options.channelId ?? null;
  const channel = channelId ? (guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null)) : null;
  if (!channel?.isTextBased?.() || channel.isThread?.()) {throw new Error("Choose a channel where I can post the ticket panel.");}
  const config = mergeConfig(defaultPanelConfig(), options.config ?? {});
  getDB().prepare(`
    INSERT INTO ticket_panels (guild_id, panel_id, channel_id, title, description, config_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(guild.id, panelId, channel.id, String(options.title ?? "Support tickets").slice(0, 256), options.description ?? null, JSON.stringify(config));
  const payload = buildPanelPayload(guild.id, panelId);
  let message;
  try {message = await channel.send(payload);}
  catch (error) {getDB().prepare("DELETE FROM ticket_panels WHERE guild_id = ? AND panel_id = ?").run(guild.id, panelId); throw error;}
  getDB().prepare("UPDATE ticket_panels SET message_id = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND panel_id = ?").run(message.id, guild.id, panelId);
  return getPanel(guild.id, panelId);
}

export async function updatePanel(guild, panelId, patch = {}) {
  const current = getPanel(guild.id, panelId);
  if (!current) {return null;}
  const title = patch.title ?? current.title;
  const description = Object.hasOwn(patch, "description") ? patch.description : current.description;
  const config = Object.hasOwn(patch, "config") ? mergeConfig(defaultPanelConfig(), patch.config) : current.config;
  let channelId = current.channel_id;
  let messageId = current.message_id;

  if (Object.hasOwn(patch, "channelId") && patch.channelId && patch.channelId !== current.channel_id) {
    const nextChannel = guild.channels.cache.get(patch.channelId) ?? await guild.channels.fetch(patch.channelId).catch(() => null);
    if (!nextChannel?.isTextBased?.() || nextChannel.isThread?.()) {throw new Error("Choose a channel where I can post the ticket panel.");}
    getDB().prepare("UPDATE ticket_panels SET channel_id = ?, title = ?, description = ?, config_json = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND panel_id = ?")
      .run(nextChannel.id, title, description, JSON.stringify(config), guild.id, panelId);
    const payload = buildPanelPayload(guild.id, panelId);
    const nextMessage = await nextChannel.send(payload);
    if (current.message_id) {
      const oldChannel = guild.channels.cache.get(current.channel_id) ?? await guild.channels.fetch(current.channel_id).catch(() => null);
      const oldMessage = await oldChannel?.messages?.fetch(current.message_id).catch(() => null);
      await oldMessage?.delete().catch(() => {});
    }
    channelId = nextChannel.id; messageId = nextMessage.id;
    getDB().prepare("UPDATE ticket_panels SET channel_id = ?, message_id = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND panel_id = ?").run(channelId, messageId, guild.id, panelId);
    return getPanel(guild.id, panelId);
  }

  getDB().prepare("UPDATE ticket_panels SET channel_id = ?, message_id = ?, title = ?, description = ?, config_json = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND panel_id = ?")
    .run(channelId, messageId, title, description, JSON.stringify(config), guild.id, panelId);
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

export function addTicketType(guildId, panelId, patch = {}) {
  const typeId = patch.typeId ?? newId("type");
  const config = {...defaultOptionConfig(), ...(patch.config ?? {})};
  config.viewRoles = snowflakes(config.viewRoles); config.viewUsers = snowflakes(config.viewUsers);
  config.pingRoles = snowflakes(config.pingRoles); config.pingUsers = snowflakes(config.pingUsers);
  config.closeRoles = snowflakes(config.closeRoles); config.exportRoles = snowflakes(config.exportRoles); config.deleteRoles = snowflakes(config.deleteRoles);
  config.survey = arr(config.survey).slice(0, 25);
  getDB().prepare(`
    INSERT INTO ticket_types (guild_id, panel_id, type_id, name, description, name_template, container_type, category_id, emoji, position, config_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    guildId, panelId, typeId, String(patch.name ?? "Support").slice(0, 100), patch.description ?? null,
    String(patch.nameTemplate ?? "{user}-{count}").slice(0, 100), patch.containerType === "channel" ? "channel" : "thread",
    patch.categoryId ?? null, patch.emoji ?? null, Number(patch.position ?? 0) || 0, JSON.stringify(config)
  );
  return getTicketType(guildId, panelId, typeId);
}

export function updateTicketType(guildId, panelId, typeId, patch = {}) {
  const current = getTicketType(guildId, panelId, typeId);
  if (!current) {return null;}
  const config = Object.hasOwn(patch, "config") ? {...defaultOptionConfig(), ...patch.config} : current.config;
  config.viewRoles = snowflakes(config.viewRoles); config.viewUsers = snowflakes(config.viewUsers);
  config.pingRoles = snowflakes(config.pingRoles); config.pingUsers = snowflakes(config.pingUsers);
  config.closeRoles = snowflakes(config.closeRoles); config.exportRoles = snowflakes(config.exportRoles); config.deleteRoles = snowflakes(config.deleteRoles);
  config.survey = arr(config.survey).slice(0, 25);
  getDB().prepare(`
    UPDATE ticket_types SET name = ?, description = ?, name_template = ?, container_type = ?, category_id = ?, emoji = ?, position = ?, config_json = ?
    WHERE guild_id = ? AND panel_id = ? AND type_id = ?
  `).run(
    String(patch.name ?? current.name).slice(0, 100),
    Object.hasOwn(patch, "description") ? patch.description : current.description,
    String(patch.nameTemplate ?? current.name_template).slice(0, 100),
    (patch.containerType ?? current.container_type) === "channel" ? "channel" : "thread",
    Object.hasOwn(patch, "categoryId") ? patch.categoryId : current.category_id,
    Object.hasOwn(patch, "emoji") ? patch.emoji : current.emoji,
    Object.hasOwn(patch, "position") ? (Number(patch.position) || 0) : current.position,
    JSON.stringify(config), guildId, panelId, typeId
  );
  return getTicketType(guildId, panelId, typeId);
}

export function deleteTicketType(guildId, panelId, typeId) {
  getDB().prepare("DELETE FROM ticket_access WHERE guild_id = ? AND panel_id = ? AND type_id = ?").run(guildId, panelId, typeId);
  getDB().prepare("DELETE FROM ticket_form_questions WHERE guild_id = ? AND panel_id = ? AND type_id = ?").run(guildId, panelId, typeId);
  getDB().prepare("DELETE FROM ticket_form_routes WHERE guild_id = ? AND panel_id = ? AND type_id = ?").run(guildId, panelId, typeId);
  return getDB().prepare("DELETE FROM ticket_types WHERE guild_id = ? AND panel_id = ? AND type_id = ?").run(guildId, panelId, typeId).changes > 0;
}

export function setTicketAccess(guildId, panelId, typeId, patch = {}) {
  const db = getDB();
  db.prepare("DELETE FROM ticket_access WHERE guild_id = ? AND panel_id = ? AND type_id = ?").run(guildId, panelId, typeId);
  const insert = db.prepare("INSERT OR IGNORE INTO ticket_access (guild_id, panel_id, type_id, action, target_type, target_id, group_id) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const action of ["view","add","manage","hide"]) {
    for (const roleId of patch[`${action}RoleIds`] ?? []) {insert.run(guildId, panelId, typeId, action, "role", String(roleId), null);}
    for (const userId of patch[`${action}UserIds`] ?? []) {insert.run(guildId, panelId, typeId, action, "user", String(userId), null);}
  }
  return listTicketAccess(guildId, panelId, typeId);
}
export function listTicketAccess(guildId, panelId, typeId) {
  return getDB().prepare("SELECT * FROM ticket_access WHERE guild_id = ? AND panel_id = ? AND type_id = ? ORDER BY action, target_type, target_id").all(guildId, panelId, typeId);
}

export function listTicketFormQuestions(guildId, panelId, typeId) {
  return getDB().prepare("SELECT * FROM ticket_form_questions WHERE guild_id = ? AND panel_id = ? AND type_id = ? ORDER BY position ASC, created_at ASC").all(guildId, panelId, typeId);
}
export function addTicketFormQuestion(guildId, panelId, typeId, patch = {}) {
  const questionId = patch.questionId ?? newId("q");
  getDB().prepare(`
    INSERT INTO ticket_form_questions (guild_id, panel_id, type_id, question_id, position, label, placeholder, kind, required)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, panelId, typeId, questionId, Number(patch.position ?? 0) || 0, String(patch.label ?? "Question").slice(0, 45), patch.placeholder ?? null, patch.kind ?? "short", patch.required === false ? 0 : 1);
  return listTicketFormQuestions(guildId, panelId, typeId).find(q => q.question_id === questionId) ?? null;
}
export function deleteTicketFormQuestion(guildId, panelId, typeId, questionId) {
  return getDB().prepare("DELETE FROM ticket_form_questions WHERE guild_id = ? AND panel_id = ? AND type_id = ? AND question_id = ?").run(guildId, panelId, typeId, questionId).changes > 0;
}
export function clearTicketFormQuestions(guildId, panelId, typeId) {
  return getDB().prepare("DELETE FROM ticket_form_questions WHERE guild_id = ? AND panel_id = ? AND type_id = ?").run(guildId, panelId, typeId).changes;
}
export function listTicketFormRoutes(guildId, panelId, typeId) {
  return getDB().prepare("SELECT * FROM ticket_form_routes WHERE guild_id = ? AND panel_id = ? AND type_id = ? ORDER BY position ASC, created_at ASC").all(guildId, panelId, typeId);
}
export function addTicketFormRoute(guildId, panelId, typeId, patch = {}) {
  const routeId = patch.routeId ?? newId("route");
  getDB().prepare(`
    INSERT INTO ticket_form_routes (guild_id, panel_id, type_id, route_id, position, conditions_json, target_kind, target_channel_id, target_category_id, thread_name_template)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(guildId, panelId, typeId, routeId, Number(patch.position ?? 0) || 0, JSON.stringify(patch.conditions ?? []), patch.targetKind ?? "default", patch.targetChannelId ?? null, patch.targetCategoryId ?? null, patch.threadNameTemplate ?? null);
  return listTicketFormRoutes(guildId, panelId, typeId).find(r => r.route_id === routeId) ?? null;
}
export function deleteTicketFormRoute(guildId, panelId, typeId, routeId) {
  return getDB().prepare("DELETE FROM ticket_form_routes WHERE guild_id = ? AND panel_id = ? AND type_id = ? AND route_id = ?").run(guildId, panelId, typeId, routeId).changes > 0;
}
export function saveTicketFormAnswers(guildId, ticketId, answers = []) {
  const db = getDB();
  db.prepare("DELETE FROM ticket_form_answers WHERE guild_id = ? AND ticket_id = ?").run(guildId, ticketId);
  const insert = db.prepare("INSERT INTO ticket_form_answers (guild_id, ticket_id, question_id, question_label, answer, position) VALUES (?, ?, ?, ?, ?, ?)");
  answers.forEach((a, i) => insert.run(guildId, ticketId, String(a.questionId ?? i), String(a.label ?? "Question").slice(0, 45), a.answer ?? null, i));
}
export function listTicketFormAnswers(guildId, ticketId) {
  return getDB().prepare("SELECT * FROM ticket_form_answers WHERE guild_id = ? AND ticket_id = ? ORDER BY position ASC").all(guildId, ticketId);
}
export function evaluateTicketFormRoute(guildId, panelId, typeId, answers = []) {
  const routes = listTicketFormRoutes(guildId, panelId, typeId);
  const byQ = new Map(answers.map(a => [a.questionId, String(a.answer ?? "").trim().toLowerCase()]));
  for (const route of routes) {
    const conditions = parse(route.conditions_json, []);
    const ok = conditions.length && conditions.every(c => {
      const actual = byQ.get(c.questionId) ?? "";
      const expected = String(c.value ?? "").trim().toLowerCase();
      if (c.op === "contains") {return actual.includes(expected);}
      if (c.op === "yes") {return ["yes","y","true","1"].includes(actual);}
      if (c.op === "no") {return ["no","n","false","0"].includes(actual);}
      return actual === expected;
    });
    if (ok) {return route;}
  }
  return null;
}

function namingSuffix(suffix, count, user, ticketId) {
  const n = String(count).padStart(4, "0");
  if (suffix === "ticket") {return `-ticket${n}`;}
  if (suffix === "user") {return `-${cleanName(user?.username ?? "user")}-${n}`;}
  if (suffix === "none") {return "";}
  return `-${n}`;
}

export function buildPanelPayload(guildId, panelId) {
  const panel = getPanel(guildId, panelId);
  if (!panel) {return null;}
  const types = listTicketTypes(guildId, panelId);
  const embed = new discord.EmbedBuilder()
    .setTitle(panel.title)
    .setDescription(panel.description ?? "Open a ticket by choosing an option.")
    .setColor(0x5865F2)
    .setTimestamp();
  if (!types.length) {
    return {embeds:[embed], components:[new discord.ActionRowBuilder().addComponents(
      new discord.ButtonBuilder().setCustomId("ticket:none").setLabel("No options").setDisabled(true).setStyle(discord.ButtonStyle.Secondary)
    )], allowedMentions:{parse:[]}};
  }
  if (types.length === 1) {
    const type = types[0];
    const button = new discord.ButtonBuilder()
      .setCustomId(`ticket:open:${panelId}:${type.type_id}`)
      .setLabel(String(type.name ?? "Open ticket").slice(0, 80))
      .setStyle(discord.ButtonStyle.Primary);
    if (type.emoji) {button.setEmoji(firstEmoji(type.emoji));}
    return {embeds:[embed], components:[new discord.ActionRowBuilder().addComponents(button)], allowedMentions:{parse:[]}};
  }
  const select = new discord.StringSelectMenuBuilder()
    .setCustomId(`ticket:type:${panelId}`)
    .setPlaceholder("Choose an option")
    .addOptions(types.slice(0, 25).map(type => ({
      label:type.name.slice(0, 100),
      value:type.type_id,
      description:(type.description ?? "Open this ticket option").slice(0, 100),
      ...(type.emoji ? {emoji:firstEmoji(type.emoji)} : {})
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

function memberCanUseRule(member, rule, roleIds, ownerId) {
  if (rule === "all") {return true;}
  if (rule === "owner") {return member.id === ownerId;}
  if (rule === "support") {return member.permissions?.has?.(discord.PermissionFlagsBits.ManageChannels) || roleIds.some(id => member.roles?.cache?.has?.(id));}
  return roleIds.some(id => member.roles?.cache?.has?.(id)) || member.permissions?.has?.(discord.PermissionFlagsBits.Administrator);
}

export function canCloseTicket(member, ticket, type) {
  const cfg = type?.config ?? defaultOptionConfig();
  return memberCanUseRule(member, cfg.closeRule ?? "all", cfg.closeRoles ?? [], ticket.owner_id);
}
export function canExportTicket(member, ticket, type) {
  const cfg = type?.config ?? defaultOptionConfig();
  return memberCanUseRule(member, cfg.exportRule ?? "all", cfg.exportRoles ?? [], ticket.owner_id);
}
export function canDeleteTicket(member, ticket, type) {
  const cfg = type?.config ?? defaultOptionConfig();
  return memberCanUseRule(member, cfg.deleteRule ?? "support", cfg.deleteRoles ?? [], ticket.owner_id);
}

function buildOpenMessage(type, ticket, user) {
  const cfg = type?.config ?? defaultOptionConfig();
  const pingIds = [...snowflakes(cfg.pingRoles).map(id => `<@&${id}>`), ...snowflakes(cfg.pingUsers).map(id => `<@${id}>`)];
  const content = [pingIds.join(" "), cfg.openMessageEnabled ? cfg.openMessage : ""].filter(Boolean).join("\n").slice(0, 2000);
  const embed = new discord.EmbedBuilder()
    .setTitle(`Ticket: ${type.name}`)
    .setDescription(cfg.openMessageEnabled && cfg.openMessage ? cfg.openMessage.slice(0, 4000) : `Ticket opened by ${user}.`)
    .setColor(0x5865F2)
    .setTimestamp();
  const row = new discord.ActionRowBuilder().addComponents(
    new discord.ButtonBuilder().setCustomId(`ticket:close:${ticket.ticket_id}`).setLabel("Close").setStyle(discord.ButtonStyle.Danger),
    new discord.ButtonBuilder().setCustomId(`ticket:export:${ticket.ticket_id}`).setLabel("Export").setStyle(discord.ButtonStyle.Secondary),
    new discord.ButtonBuilder().setCustomId(`ticket:delete:${ticket.ticket_id}`).setLabel("Delete").setStyle(discord.ButtonStyle.Secondary)
  );
  return {content: content || undefined, embeds:[embed], components:[row], allowedMentions:{roles:snowflakes(cfg.pingRoles), users:snowflakes(cfg.pingUsers).concat([user.id])}};
}

export async function openTicket(client, interaction, panelId, typeId, form = {}) {
  const guild = interaction.guild;
  const panel = getPanel(guild.id, panelId);
  const type = getTicketType(guild.id, panelId, typeId);
  if (!panel || !type) {return {success:false, reason:"not-found"};}
  const cfg = type.config ?? defaultOptionConfig();
  const count = getDB().prepare("SELECT COUNT(*) AS count FROM tickets WHERE guild_id = ? AND panel_id = ? AND type_id = ?").get(guild.id, panelId, typeId).count;
  const base = renderTemplate(type.name_template ?? "{user}-{count}", {user:interaction.user.username, count:count + 1, type:type.name, guild:guild.name, date:new Date().toISOString().slice(0,10)});
  const suffix = namingSuffix(cfg.namingSuffix ?? "number", count + 1, interaction.user, null);
  const name = cleanName(base.endsWith(suffix) ? base : `${base}${suffix}`);
  let channel;
  const route = form.route;
  const access = listTicketAccess(guild.id, panelId, typeId);
  const overwrites = [{id:guild.roles.everyone.id, deny:[discord.PermissionFlagsBits.ViewChannel]}];
  const viewIds = [...new Set([...snowflakes(cfg.viewRoles), ...snowflakes(cfg.viewUsers), ...access.filter(a => a.action === "view" || a.action === "add" || a.action === "manage").map(a => a.target_id)])];
  for (const id of viewIds) {overwrites.push({id, allow:[discord.PermissionFlagsBits.ViewChannel, discord.PermissionFlagsBits.SendMessages, discord.PermissionFlagsBits.ReadMessageHistory]});}
  overwrites.push({id:interaction.user.id, allow:[discord.PermissionFlagsBits.ViewChannel, discord.PermissionFlagsBits.SendMessages, discord.PermissionFlagsBits.ReadMessageHistory]});
  for (const a of access.filter(a => a.action === "manage")) {overwrites.push({id:a.target_id, allow:[discord.PermissionFlagsBits.ViewChannel, discord.PermissionFlagsBits.SendMessages, discord.PermissionFlagsBits.ReadMessageHistory, discord.PermissionFlagsBits.ManageMessages]});}
  for (const a of access.filter(a => a.action === "hide")) {overwrites.push({id:a.target_id, deny:[discord.PermissionFlagsBits.ViewChannel, discord.PermissionFlagsBits.SendMessages]});}

  if (type.container_type === "thread") {
    const parent = route?.target_channel_id ? await guild.channels.fetch(route.target_channel_id).catch(() => null) : await guild.channels.fetch(panel.channel_id).catch(() => null);
    if (!parent?.isTextBased()) {return {success:false, reason:"parent-unavailable"};}
    channel = await parent.threads.create({name, type:discord.ChannelType.PrivateThread, invitable:false, reason:"BargazBot ticket", autoArchiveDuration:1440}).catch(() => null);
  } else {
    const categoryId = route?.target_category_id ?? type.category_id ?? panel.config?.defaults?.categoryId ?? null;
    const typeCfg = typeof type.config_json === "string" ? (() => {try {return JSON.parse(type.config_json);} catch {return {};}})() : (type.config ?? type.config_json ?? {});
    channel = await guild.channels.create({
      name,
      type:discord.ChannelType.GuildText,
      parent:type.category_id ?? typeCfg.categoryId ?? categoryId ?? undefined,
      permissionOverwrites: overwrites,
      reason:"BargazBot ticket"
    }).catch(() => null);
  }
  if (!channel) {return {success:false, reason:"create-failed"};}
  if (type.container_type === "thread") {
    await channel.members.add(interaction.user.id).catch(() => {});
    for (const id of viewIds) {await channel.members.add(id).catch(() => {});}
  }

  const ticketId = newId("ticket");
  getDB().prepare("INSERT INTO tickets (guild_id, ticket_id, panel_id, type_id, channel_id, owner_id, status) VALUES (?, ?, ?, ?, ?, ?, 'open')")
    .run(guild.id, ticketId, panelId, typeId, channel.id, interaction.user.id);
  if (form.answers?.length) {saveTicketFormAnswers(guild.id, ticketId, form.answers);}
  const ticket = getTicket(guild.id, ticketId);
  await channel.send(buildOpenMessage(type, ticket, interaction.user)).catch(() => {});
  if (form.answers?.length) {
    const fields = form.answers.slice(0, 25).map(a => ({name:String(a.label ?? "Question").slice(0, 256), value:String(a.answer ?? "—").slice(0, 1024) || "—"}));
    await channel.send({embeds:[new discord.EmbedBuilder().setTitle("Ticket form answers").setColor(0x5865F2).addFields(fields)], allowedMentions:{parse:[]}}).catch(() => {});
  }
  return {success:true, channel, ticketId};
}

function buildTranscript(ticket, answers) {
  const lines = [`Ticket ${ticket.ticket_id}`, `Panel: ${ticket.panel_id}`, `Option: ${ticket.type_id}`, `Owner: ${ticket.owner_id}`, `Opened: ${ticket.created_at}`, `Closed: ${ticket.closed_at ?? new Date().toISOString()}`, ""];
  if (answers.length) {
    lines.push("Form answers:");
    for (const a of answers) {lines.push(`- ${a.question_label}: ${a.answer ?? ""}`);}
    lines.push("");
  }
  return lines.join("\n");
}

export async function closeTicket(client, guild, ticketId, actorId = null) {
  const ticket = getTicket(guild.id, ticketId);
  if (!ticket || ticket.status !== "open") {return {success:false, reason:"not-found"};}
  const panel = getPanel(guild.id, ticket.panel_id);
  const type = getTicketType(guild.id, ticket.panel_id, ticket.type_id);
  const cfg = panel?.config?.close ?? defaultPanelConfig().close;
  const answers = listTicketFormAnswers(guild.id, ticketId);
  getDB().prepare("UPDATE tickets SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND ticket_id = ?").run(guild.id, ticketId);

  const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
  const transcript = buildTranscript({...ticket, closed_at:new Date().toISOString()}, answers);
  const exportChannel = panel?.config?.defaults?.exportChannelId ? await guild.channels.fetch(panel.config.defaults.exportChannelId).catch(() => null) : await channelManager.getChannel(guild, "logs");

  if (cfg.exportLogs && exportChannel?.isTextBased?.()) {
    await exportChannel.send({
      embeds:[new discord.EmbedBuilder().setTitle("Ticket closed").setColor(0xED4245)
        .addFields(
          {name:"Ticket", value:ticket.ticket_id, inline:true},
          {name:"Option", value:type?.name ?? ticket.type_id, inline:true},
          {name:"Owner", value:`<@${ticket.owner_id}>`, inline:true},
          {name:"Closed by", value:actorId ? `<@${actorId}>` : "Unknown", inline:true}
        ).setTimestamp()],
      files:[new discord.AttachmentBuilder(Buffer.from(transcript, "utf8"), {name:`${ticket.ticket_id}.txt`})],
      allowedMentions:{parse:[]}
    }).catch(() => {});
  }

  if (cfg.move && cfg.moveCategoryId && channel?.edit) {
    await channel.edit({parent:cfg.moveCategoryId, reason:"BargazBot ticket closed"}).catch(error => log.warn("Ticket move failed:", guild.id, ticketId, error?.message ?? error));
  }
  if (cfg.deleteChannel && channel?.delete) {
    await channel.delete("BargazBot ticket closed").catch(error => log.warn("Ticket delete failed:", guild.id, ticketId, error?.message ?? error));
  } else if (channel?.isTextBased?.()) {
    await channel.send({content:`Ticket closed by ${actorId ? `<@${actorId}>` : "a staff member"}.`, allowedMentions:{parse:[]}}).catch(() => {});
  }
  return {success:true};
}

export function getTicket(guildId, ticketId) {
  return getDB().prepare("SELECT * FROM tickets WHERE guild_id = ? AND ticket_id = ?").get(guildId, ticketId) ?? null;
}

// Simple in-memory form drafts for ticket panel user flow.
const ticketFormDrafts = new Map();
const draftKey = (g,u,p,t) => `${g}:${u}:${p}:${t}`;
const getDraft = (g,u,p,t) => {const d=ticketFormDrafts.get(draftKey(g,u,p,t)); if(!d||d.expiresAt<Date.now()){ticketFormDrafts.delete(draftKey(g,u,p,t)); return null;} return d;};
const setDraft = d => ticketFormDrafts.set(draftKey(d.guildId,d.userId,d.panelId,d.typeId), d);

function buildTicketFormModal(panelId, typeId, questions, startIndex) {
  const slice = questions.slice(startIndex, startIndex + 5);
  const modal = new discord.ModalBuilder().setCustomId(`ticket:form:${panelId}:${typeId}:${startIndex}`).setTitle("Ticket form");
  for (const q of slice) {
    modal.addComponents(new discord.ActionRowBuilder().addComponents(
      new discord.TextInputBuilder().setCustomId(`q:${q.question_id}`).setLabel(clip(q.label,45)).setStyle(q.kind === "paragraph" ? discord.TextInputStyle.Paragraph : discord.TextInputStyle.Short).setRequired(q.required !== 0).setMaxLength(1000).setPlaceholder(q.placeholder ? clip(q.placeholder,100) : "Answer")
    ));
  }
  return {modal, count:slice.length};
}

async function startTicketForm(interaction, panelId, typeId) {
  const questions = listTicketFormQuestions(interaction.guild.id, panelId, typeId);
  if (!questions.length) {return {started:false};}
  const draft = {guildId:interaction.guild.id, panelId, typeId, userId:interaction.user.id, answers:[], index:0, expiresAt:Date.now()+14*60*1000};
  setDraft(draft);
  const {modal} = buildTicketFormModal(panelId, typeId, questions, 0);
  await interaction.showModal(modal);
  return {started:true};
}

export async function handleComponent(interaction) {
  const customId = interaction.customId ?? "";
  if (!customId.startsWith("ticket:")) {return false;}
  if (!interaction.guild) {return false;}

  if (customId === "ticket:none") {
    await interaction.reply({content:"This panel has no options yet. A server admin needs to add an option in /ticket.", flags:discord.MessageFlags.Ephemeral}).catch(() => {});
    return true;
  }

  if (interaction.isModalSubmit() && customId.startsWith("ticket:form:")) {
    const [, , panelId, typeId, startRaw] = customId.split(":");
    const startIndex = Number(startRaw || 0);
    const questions = listTicketFormQuestions(interaction.guild.id, panelId, typeId);
    const slice = questions.slice(startIndex, startIndex + 5);
    const draft = getDraft(interaction.guild.id, interaction.user.id, panelId, typeId) ?? {guildId:interaction.guild.id, panelId, typeId, userId:interaction.user.id, answers:[], index:0, expiresAt:Date.now()+14*60*1000};
    for (const q of slice) {
      const value = interaction.fields.getTextInputValue(`q:${q.question_id}`);
      draft.answers = draft.answers.filter(a => a.questionId !== q.question_id);
      draft.answers.push({questionId:q.question_id, label:q.label, answer:value});
    }
    draft.index = startIndex + slice.length; draft.expiresAt = Date.now()+14*60*1000; setDraft(draft);
    if (draft.index < questions.length) {
      const {modal} = buildTicketFormModal(panelId, typeId, questions, draft.index);
      await interaction.showModal(modal);
      return true;
    }
    await interaction.deferReply({flags:discord.MessageFlags.Ephemeral});
    ticketFormDrafts.delete(draftKey(interaction.guild.id, interaction.user.id, panelId, typeId));
    const route = evaluateTicketFormRoute(interaction.guild.id, panelId, typeId, draft.answers);
    const result = await openTicket(interaction.client, interaction, panelId, typeId, {answers:draft.answers, route});
    await interaction.editReply({content:result.success ? `Ticket opened in ${result.channel}.` : `Could not open the ticket (${result.reason}).`});
    return true;
  }

  const parts = customId.split(":");
  if ((parts[1] === "type" || parts[1] === "open") && (interaction.isStringSelectMenu?.() || interaction.isButton?.())) {
    const panelId = parts[2];
    const typeId = parts[1] === "type" ? interaction.values?.[0] : parts[3];
    const questions = listTicketFormQuestions(interaction.guild.id, panelId, typeId);
    if (questions.length) {
      const form = await startTicketForm(interaction, panelId, typeId);
      if (form.started) {return true;}
    }
  }

  if (!["type","open","close","export","delete"].includes(parts[1])) {return false;}
  await interaction.deferReply({flags:discord.MessageFlags.Ephemeral});
  if (parts[1] === "type") {
    const result = await openTicket(interaction.client, interaction, parts[2], interaction.values?.[0]);
    await interaction.editReply({content:result.success ? `Ticket opened in ${result.channel}.` : `Could not open the ticket (${result.reason}).`});
    return true;
  }
  if (parts[1] === "open") {
    const result = await openTicket(interaction.client, interaction, parts[2], parts[3]);
    await interaction.editReply({content:result.success ? `Ticket opened in ${result.channel}.` : `Could not open the ticket (${result.reason}).`});
    return true;
  }
  const ticket = getTicket(interaction.guild.id, parts[2]);
  const type = ticket ? getTicketType(interaction.guild.id, ticket.panel_id, ticket.type_id) : null;
  if (!ticket || !type) {await interaction.editReply({content:"Ticket not found."}); return true;}
  const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {await interaction.editReply({content:"Could not verify your permissions."}); return true;}

  if (parts[1] === "export") {
    if (!canExportTicket(member, ticket, type)) {await interaction.editReply({content:"You do not have permission to export this ticket."}); return true;}
    const answers = listTicketFormAnswers(interaction.guild.id, ticket.ticket_id);
    const transcript = buildTranscript({...ticket, closed_at: ticket.closed_at ?? new Date().toISOString()}, answers);
    const file = new discord.AttachmentBuilder(Buffer.from(transcript, "utf8"), {name:`${ticket.ticket_id}.txt`});
    const panel = getPanel(interaction.guild.id, ticket.panel_id);
    const exportChannel = panel?.config?.defaults?.exportChannelId
      ? await interaction.guild.channels.fetch(panel.config.defaults.exportChannelId).catch(() => null)
      : await channelManager.getChannel(interaction.guild, "logs");
    if (exportChannel?.isTextBased?.()) {
      await exportChannel.send({
        embeds:[new discord.EmbedBuilder().setTitle("Ticket exported").setColor(0x5865F2)
          .addFields(
            {name:"Ticket", value:ticket.ticket_id, inline:true},
            {name:"Option", value:type?.name ?? ticket.type_id, inline:true},
            {name:"Owner", value:`<@${ticket.owner_id}>`, inline:true},
            {name:"Exported by", value:`<@${interaction.user.id}>`, inline:true}
          ).setTimestamp()],
        files:[new discord.AttachmentBuilder(Buffer.from(transcript, "utf8"), {name:`${ticket.ticket_id}.txt`})],
        allowedMentions:{parse:[]}
      }).catch(() => {});
    }
    await interaction.editReply({content:"Ticket transcript exported.", files:[file]}).catch(() => {});
    return true;
  }

  if (parts[1] === "delete") {
    if (!canDeleteTicket(member, ticket, type)) {await interaction.editReply({content:"You do not have permission to delete this ticket."}); return true;}
    if (ticket.status === "open") {
      const result = await closeTicket(interaction.client, interaction.guild, ticket.ticket_id, interaction.user.id);
      await interaction.editReply({content:result.success ? "Ticket closed and deleted (per close config)." : "Could not close the ticket."}).catch(() => {});
      return true;
    }
    const channel = await interaction.guild.channels.fetch(ticket.channel_id).catch(() => null);
    if (channel?.delete) {await channel.delete("BargazBot ticket deleted").catch(() => {});}
    await interaction.editReply({content:"Ticket deleted."}).catch(() => {});
    return true;
  }

  if (parts[1] === "close") {
    if (!canCloseTicket(member, ticket, type)) {await interaction.editReply({content:"You do not have permission to close this ticket."}); return true;}
    const result = await closeTicket(interaction.client, interaction.guild, parts[2], interaction.user.id);
    await interaction.editReply({content:result.success ? "Ticket closed." : "That ticket is already closed."}).catch(() => {});
    return true;
  }
  return false;
}
