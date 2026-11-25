import * as discord        from "discord.js";
import * as guildLogger    from "./guildLogger.js";
import * as featureSettings from "./featureSettings.js";
import { getDB }           from "./storage.js";

const RULE_TYPES = new Set(["repetition", "emoji", "caps", "symbols", "links", "slowmode"]);
const recent = new Map();

function ensureGuild(guildId) {getDB().prepare("INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)").run(guildId);}
function newId(prefix = "rule") {return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;}
function parse(value, fallback) {try {return JSON.parse(value ?? "") ?? fallback;} catch {return fallback;}}

function getScope(guildId, ruleId) {
  const rows = getDB().prepare(
    "SELECT scope_type, target_id FROM automod_scope WHERE guild_id = ? AND rule_id = ?"
  ).all(guildId, ruleId);
  return {
    channelIds:rows.filter(row => row.scope_type === "channel").map(row => row.target_id),
    roleIds:rows.filter(row => row.scope_type === "ignored-role").map(row => row.target_id),
    userIds:rows.filter(row => row.scope_type === "ignored-user").map(row => row.target_id)
  };
}

export function getRule(guildId, ruleId) {
  const row = getDB().prepare("SELECT * FROM automod_rules WHERE guild_id = ? AND rule_id = ?").get(guildId, ruleId);
  if (!row) {return null;}
  return {...row, settings:parse(row.settings_json, {}), actions:parse(row.actions_json, {}), scope:getScope(guildId, ruleId)};
}

export function listRules(guildId) {
  return getDB().prepare("SELECT rule_id FROM automod_rules WHERE guild_id = ? ORDER BY created_at ASC")
    .all(guildId).map(row => getRule(guildId, row.rule_id));
}

export function setRuleScope(guildId, ruleId, scope = {}) {
  const db = getDB();
  db.prepare("DELETE FROM automod_scope WHERE guild_id = ? AND rule_id = ?").run(guildId, ruleId);
  const insert = db.prepare("INSERT OR IGNORE INTO automod_scope (guild_id, rule_id, scope_type, target_id) VALUES (?, ?, ?, ?)");
  for (const channelId of scope.channelIds ?? []) {insert.run(guildId, ruleId, "channel", String(channelId));}
  for (const roleId of scope.roleIds ?? []) {insert.run(guildId, ruleId, "ignored-role", String(roleId));}
  for (const userId of scope.userIds ?? []) {insert.run(guildId, ruleId, "ignored-user", String(userId));}
  return getScope(guildId, ruleId);
}

export function createRule(guildId, patch = {}) {
  ensureGuild(guildId);
  if (!RULE_TYPES.has(patch.type)) {throw new Error(`Unknown auto-mod rule type: ${patch.type}`);}
  const ruleId = patch.ruleId ?? newId();
  getDB().prepare(`
    INSERT INTO automod_rules (guild_id, rule_id, type, enabled, settings_json, actions_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(guildId, ruleId, patch.type, patch.enabled === false ? 0 : 1,
    JSON.stringify(patch.settings ?? {}), JSON.stringify(patch.actions ?? {}));
  if (patch.scope) {setRuleScope(guildId, ruleId, patch.scope);}
  return getRule(guildId, ruleId);
}

export function updateRule(guildId, ruleId, patch = {}) {
  const current = getRule(guildId, ruleId);
  if (!current) {return null;}
  getDB().prepare(`
    UPDATE automod_rules
    SET type = ?, enabled = ?, settings_json = ?, actions_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = ? AND rule_id = ?
  `).run(
    RULE_TYPES.has(patch.type) ? patch.type : current.type,
    Object.hasOwn(patch, "enabled") ? (patch.enabled ? 1 : 0) : current.enabled,
    JSON.stringify(patch.settings ?? current.settings),
    JSON.stringify(patch.actions ?? current.actions),
    guildId, ruleId
  );
  if (patch.scope) {setRuleScope(guildId, ruleId, patch.scope);}
  return getRule(guildId, ruleId);
}

export function deleteRule(guildId, ruleId) {
  const db = getDB();
  db.prepare("DELETE FROM automod_scope WHERE guild_id = ? AND rule_id = ?").run(guildId, ruleId);
  return db.prepare("DELETE FROM automod_rules WHERE guild_id = ? AND rule_id = ?").run(guildId, ruleId).changes > 0;
}

function isIgnored(message, rule, config) {
  if (config.ignoredUserIds?.includes(message.author.id) || rule.scope.userIds.includes(message.author.id)) {return true;}
  if (rule.scope.roleIds.some(roleId => message.member?.roles?.cache?.has(roleId))) {return true;}
  if (config.ignoredRoleIds?.some(roleId => message.member?.roles?.cache?.has(roleId))) {return true;}
  if (config.channelIds?.length && !config.channelIds.includes(message.channelId)) {return true;}
  if (rule.scope.channelIds.length && !rule.scope.channelIds.includes(message.channelId)) {return true;}
  return false;
}

function remember(message, ruleId) {
  const key = `${message.guildId}:${message.author.id}:${ruleId}`;
  const now = Date.now();
  const entries = (recent.get(key) ?? []).filter(entry => now - entry.at < 60000);
  entries.push({text:message.content.toLowerCase().replace(/\s+/g, " ").trim(), at:now});
  recent.set(key, entries);
  return entries;
}

function evaluateRule(rule, message) {
  const text = message.content ?? "";
  const settings = rule.settings ?? {};
  const entries = remember(message, rule.rule_id);

  if (rule.type === "repetition") {
    const count = settings.count ?? 3;
    const window = settings.windowMs ?? 10000;
    const recentText = entries.filter(entry => Date.now() - entry.at <= window);
    return recentText.filter(entry => entry.text === recentText.at(-1)?.text).length >= count;
  }
  if (rule.type === "slowmode") {
    const window = settings.windowMs ?? 5000;
    const count = settings.count ?? 2;
    return entries.filter(entry => Date.now() - entry.at <= window).length >= count;
  }
  if (rule.type === "emoji") {
    const emojis = text.match(/(\p{Extended_Pictographic}|\u200d|[\u{1F1E6}-\u{1F1FF}])/gu) ?? [];
    return emojis.length >= (settings.max ?? 5);
  }
  if (rule.type === "caps") {
    const letters = text.replace(/[^a-zA-Z]/g, "");
    if (letters.length < (settings.minLength ?? 10)) {return false;}
    const upper = (letters.match(/[A-Z]/g) ?? []).length / letters.length;
    return upper >= (settings.ratio ?? 0.7);
  }
  if (rule.type === "symbols") {
    if (text.length < 5) {return false;}
    const symbols = (text.match(/[^\p{L}\p{N}\s]/gu) ?? []).length / text.length;
    return symbols >= (settings.ratio ?? 0.5);
  }
  if (rule.type === "links") {
    return /https?:\/\/|discord\.gg\/|discord\.com\/invite\//i.test(text);
  }
  return false;
}

export function getWarnings(guildId, userId) {
  return getDB().prepare("SELECT * FROM automod_warnings WHERE guild_id = ? AND user_id = ?").get(guildId, userId) ?? null;
}

function addWarning(guildId, userId) {
  getDB().prepare(`
    INSERT INTO automod_warnings (guild_id, user_id, count, last_at)
    VALUES (?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      count = count + 1, last_at = CURRENT_TIMESTAMP
  `).run(guildId, userId);
  return getWarnings(guildId, userId);
}

export function clearWarnings(guildId, userId) {
  return getDB().prepare("DELETE FROM automod_warnings WHERE guild_id = ? AND user_id = ?").run(guildId, userId).changes > 0;
}

async function applyAction(client, message, rule, config) {
  const actions = {warn:true, delete:false, timeoutMs:0, kick:false, ban:false, ...(rule.actions ?? {})};
  const guild = message.guild;
  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
  const applied = [];

  if (actions.delete) {
    await message.delete().catch(() => {});
    applied.push("delete");
  }
  if (actions.warn) {
    const warning = addWarning(guild.id, message.author.id);
    const content = `You received an auto-mod warning in **${guild.name}** for: ${rule.type}. Total warnings: ${warning.count}.`;
    if (config.warnDm !== false) {await message.author.send(content).catch(() => {});}
    if (config.warnChannel !== false) {
      await message.channel.send({content, allowedMentions:{parse:["users"], users:[message.author.id]}}).catch(() => {});
    }
    applied.push("warn");
  }
  if (actions.timeoutMs > 0 && member) {
    await member.timeout(actions.timeoutMs, `BargazBot auto-mod: ${rule.type}`).catch(() => {});
    applied.push("timeout");
  }
  if (actions.kick && member) {
    await member.kick(`BargazBot auto-mod: ${rule.type}`).catch(() => {});
    applied.push("kick");
  }
  if (actions.ban && member) {
    await member.ban({reason:`BargazBot auto-mod: ${rule.type}`}).catch(() => {});
    applied.push("ban");
  }

  guildLogger.logModerationAction(guild, {
    title:"BargazBot auto-mod action",
    description:`${message.author} triggered an auto-mod rule.`,
    user:message.author,
    fields:[
      {name:"Rule", value:`${rule.rule_id} (${rule.type})`, inline:true},
      {name:"Actions", value:applied.join(", ") || "none", inline:true},
      {name:"Content", value:String(message.content ?? "").slice(0, 1024), inline:false}
    ]
  }).catch(() => {});
  return applied;
}

export async function checkMessage(client, message) {
  if (!message.guild || message.author.bot) {return 0;}
  if (!featureSettings.isFeatureEnabled(message.guild.id, "auto-mod")) {return 0;}
  const config = featureSettings.getAutoModConfig(message.guild.id);
  let handled = 0;
  for (const rule of listRules(message.guild.id).filter(row => row.enabled === 1)) {
    if (isIgnored(message, rule, config)) {continue;}
    if (!evaluateRule(rule, message)) {continue;}
    await applyAction(client, message, rule, config);
    handled++;
  }
  return handled;
}
