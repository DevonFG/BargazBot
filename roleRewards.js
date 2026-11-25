import * as log            from "./appLogger.js";
import * as guildLogger    from "./guildLogger.js";
import * as accountLinking from "./accountLinking.js";
import * as notifications  from "./notifications.js";
import * as counters       from "./counters.js";
import * as featureSettings from "./featureSettings.js";
import { getDB }           from "./storage.js";

const TRIGGERS = new Set([
  "follow", "subscribe", "membership", "live", "viewers", "videos", "views",
  "discord-role", "discord-message", "manual",
  "streamlabs", "streamelements", "patreon", "kofi"
]);

const WEBHOOK_TRIGGERS = {
  streamlabs:["follow", "subscribe"],
  streamelements:["follow", "subscribe"],
  patreon:["membership"],
  kofi:["manual"]
};

function newId(prefix = "reward") {return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;}
function guildFrom(client, guildId) {return client?.guilds?.cache?.get(guildId) ?? null;}
function ensureGuild(guildId) {getDB().prepare("INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)").run(guildId);}
function parseJson(value, fallback) {try {const v = JSON.parse(value ?? ""); return v ?? fallback;} catch {return fallback;}}

function legacyCondition(row = {}) {
  return {
    type:"condition",
    kind: row.trigger_type ?? row.triggerType ?? "manual",
    platform: row.platform ?? null,
    providerAccountId: row.provider_account_id ?? row.providerAccountId ?? null,
    metric: row.metric ?? null,
    threshold: row.threshold ?? null,
    roleId: row.discord_role_id ?? row.discordRoleId ?? null
  };
}

export function normalizeConditions(input, fallbackRow = null) {
  let value = input;
  if (typeof value === "string") {value = parseJson(value, []);}
  if (Array.isArray(value)) {
    if (value.length === 0) {return fallbackRow ? [{op:"AND", children:[legacyCondition(fallbackRow)]}] : [];}
    if (value[0]?.op || value[0]?.children) {return value;}
    return [{op:"AND", children:value}];
  }
  if (value && typeof value === "object") {
    if (value.op || value.children) {return [value];}
    if (value.type === "condition" || value.kind) {return [{op:"AND", children:[value]}];}
  }
  return fallbackRow ? [{op:"AND", children:[legacyCondition(fallbackRow)]}] : [];
}

function rewardRow(row) {
  if (!row) {return null;}
  const conditions = normalizeConditions(row.conditions_json, row);
  const first = conditions[0]?.children?.[0] ?? legacyCondition(row);
  return {
    ...row,
    conditions_json: JSON.stringify(conditions),
    conditions,
    trigger_type: first.kind ?? row.trigger_type,
    platform: first.platform ?? row.platform ?? null,
    provider_account_id: first.providerAccountId ?? row.provider_account_id ?? null,
    metric: first.metric ?? row.metric ?? null,
    threshold: first.threshold ?? row.threshold ?? null
  };
}

export function getReward(guildId, rewardId) {
  return rewardRow(getDB().prepare("SELECT * FROM role_reward_rules WHERE guild_id = ? AND reward_id = ?").get(guildId, rewardId));
}

export function listRewards(guildId) {
  return getDB().prepare("SELECT * FROM role_reward_rules WHERE guild_id = ? ORDER BY created_at ASC").all(guildId).map(rewardRow);
}

export function createReward(guildId, patch = {}) {
  ensureGuild(guildId);
  const conditions = normalizeConditions(patch.conditions ?? patch.conditions_json, patch);
  const first = conditions[0]?.children?.[0] ?? legacyCondition(patch);
  const triggerType = patch.triggerType ?? first.kind ?? "manual";
  if (!TRIGGERS.has(triggerType)) {throw new Error(`Unknown reward trigger: ${triggerType}`);}
  const rewardId = patch.rewardId ?? newId();
  getDB().prepare(`
    INSERT INTO role_reward_rules (
      guild_id, reward_id, name, trigger_type, platform, provider_account_id,
      metric, threshold, role_id, auto_remove, enabled, conditions_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    guildId, rewardId, patch.name ?? null, triggerType, first.platform ?? patch.platform ?? null,
    first.providerAccountId ?? patch.providerAccountId ?? null, first.metric ?? patch.metric ?? null,
    first.threshold ?? patch.threshold ?? null, String(patch.roleId ?? ""),
    patch.autoRemove === false ? 0 : 1, patch.enabled === false ? 0 : 1, JSON.stringify(conditions)
  );
  return getReward(guildId, rewardId);
}

export function updateReward(guildId, rewardId, patch = {}) {
  const current = getReward(guildId, rewardId);
  if (!current) {return null;}
  const conditions = Object.hasOwn(patch, "conditions") || Object.hasOwn(patch, "conditions_json")
    ? normalizeConditions(patch.conditions ?? patch.conditions_json, {...current, ...patch})
    : normalizeConditions(current.conditions_json, current);
  const first = conditions[0]?.children?.[0] ?? legacyCondition({...current, ...patch});
  const triggerType = patch.triggerType ?? first.kind ?? current.trigger_type;
  getDB().prepare(`
    UPDATE role_reward_rules
    SET name = ?, trigger_type = ?, platform = ?, provider_account_id = ?, metric = ?,
        threshold = ?, role_id = ?, auto_remove = ?, enabled = ?, conditions_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = ? AND reward_id = ?
  `).run(
    Object.hasOwn(patch, "name") ? patch.name : current.name,
    TRIGGERS.has(triggerType) ? triggerType : current.trigger_type,
    first.platform ?? (Object.hasOwn(patch, "platform") ? patch.platform : current.platform),
    first.providerAccountId ?? (Object.hasOwn(patch, "providerAccountId") ? patch.providerAccountId : current.provider_account_id),
    first.metric ?? (Object.hasOwn(patch, "metric") ? patch.metric : current.metric),
    first.threshold ?? (Object.hasOwn(patch, "threshold") ? patch.threshold : current.threshold),
    patch.roleId ?? current.role_id,
    Object.hasOwn(patch, "autoRemove") ? (patch.autoRemove ? 1 : 0) : current.auto_remove,
    Object.hasOwn(patch, "enabled") ? (patch.enabled ? 1 : 0) : current.enabled,
    JSON.stringify(conditions),
    guildId, rewardId
  );
  return getReward(guildId, rewardId);
}

export function deleteReward(guildId, rewardId, guild = null) {
  const db = getDB();
  const reward = getReward(guildId, rewardId);
  db.prepare("DELETE FROM role_reward_grants WHERE guild_id = ? AND reward_id = ?").run(guildId, rewardId);
  const deleted = db.prepare("DELETE FROM role_reward_rules WHERE guild_id = ? AND reward_id = ?").run(guildId, rewardId).changes > 0;
  if (deleted && guild) {
    guildLogger.logCategoryEvent(guild, "role-rewards", {
      title:"Role reward deleted",
      description:"A role reward rule was deleted.",
      fields:[
        {name:"Reward", value:String(rewardId), inline:true},
        {name:"Role", value:reward?.role_id ? `<@&${reward.role_id}>` : "Unknown", inline:true}
      ]
    }).catch(() => {});
  }
  return deleted;
}

export async function grantReward(client, guildId, reward, userId, options = {}) {
  const config = featureSettings.getRoleRewardConfig(guildId);
  if (config.manualOnly && !options.manual) {return false;}
  const guild = guildFrom(client, guildId);
  if (!guild || !reward?.enabled) {return false;}
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) {return false;}
  if (member.roles.cache.has(reward.role_id)) {return false;}

  await member.roles.add(reward.role_id, `BargazBot reward: ${reward.trigger_type}`).catch(error =>
    log.warn("Role reward add failed:", guildId, reward.reward_id, error)
  );
  getDB().prepare(`
    INSERT INTO role_reward_grants (guild_id, reward_id, user_id, auto_added, granted_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id, reward_id, user_id) DO UPDATE SET
      auto_added = excluded.auto_added,
      granted_at = CURRENT_TIMESTAMP
  `).run(guildId, reward.reward_id, userId, options.manual ? 0 : 1);

  guildLogger.logCategoryEvent(guild, "role-rewards", {
    title:"Role reward granted",
    description:`${member.user} received a role reward.`,
    user:member.user,
    fields:[
      {name:"Reward", value:reward.reward_id, inline:true},
      {name:"Trigger", value:reward.trigger_type, inline:true},
      {name:"Role", value:`<@&${reward.role_id}>`, inline:true}
    ]
  }).catch(() => {});
  return true;
}

export async function revokeReward(client, guildId, reward, userId, options = {}) {
  if (!reward?.auto_remove && !options.force) {return false;}
  const grant = getDB().prepare(
    "SELECT * FROM role_reward_grants WHERE guild_id = ? AND reward_id = ? AND user_id = ?"
  ).get(guildId, reward.reward_id, userId);
  if (!grant || (grant.auto_added !== 1 && !options.force)) {return false;}

  const guild = guildFrom(client, guildId);
  const member = await guild?.members?.fetch(userId).catch(() => null);
  if (member) {await member.roles.remove(reward.role_id, "BargazBot reward revoked").catch(() => {});}
  getDB().prepare("DELETE FROM role_reward_grants WHERE guild_id = ? AND reward_id = ? AND user_id = ?")
    .run(guildId, reward.reward_id, userId);

  if (guild) {
    guildLogger.logCategoryEvent(guild, "role-rewards", {
      title:"Role reward removed",
      description:`A role reward was removed from <@${userId}>.`,
      fields:[{name:"Reward", value:reward.reward_id, inline:true}]
    }).catch(() => {});
  }
  return true;
}

function getLinkedUserId(guildId, platform, accountId) {
  const row = getDB().prepare(
    "SELECT user_id FROM account_links WHERE guild_id = ? AND platform = ? AND provider_account_id = ? LIMIT 1"
  ).get(guildId, platform, String(accountId));
  return row?.user_id ?? null;
}

function getMetricValue(metrics, condition) {
  const metric = condition.metric ?? condition.kind;
  if (metric === "live") {return metrics?.live ? 1 : 0;}
  return Number(metrics?.[metric] ?? 0);
}

async function evaluateLeaf(condition, context) {
  const kind = condition.kind ?? condition.type;
  if (kind === "manual") {return Boolean(context.manual);}
  if (kind === "discord-role") {return Boolean(context.member?.roles?.cache?.has(String(condition.roleId ?? condition.discordRoleId ?? ""))); }
  if (kind === "discord-message") {return Boolean(context.discordEvent?.type === "message");}
  if (WEBHOOK_TRIGGERS[kind]) {return Boolean(context.webhookProvider === kind);}
  if (["follow","subscribe","membership","live","viewers","videos","views","clips","followers","subscribers"].includes(kind)) {
    const platform = condition.platform ?? context.platform ?? null;
    const accountId = condition.providerAccountId ?? context.accountId ?? null;
    if (platform && context.platform && platform !== context.platform) {return false;}
    if (accountId && context.accountId && String(accountId) !== String(context.accountId)) {return false;}
    const metrics = context.metrics ?? await counters.getSocialMetrics(context.guildId, {
      platform, accountId, source: context.source ?? "subscription", userId: context.userId
    }).catch(() => ({}));
    const value = getMetricValue(metrics, {...condition, metric: condition.metric ?? kind});
    if (condition.threshold === null || condition.threshold === undefined || condition.threshold === "") {return Number(value) > 0 || Boolean(value);}
    return Number(value) >= Number(condition.threshold);
  }
  return false;
}

async function evaluateNode(node, context) {
  if (!node) {return false;}
  if (Array.isArray(node)) {return evaluateNode({op:"AND", children:node}, context);}
  if (node.op || node.children) {
    const op = String(node.op ?? "AND").toUpperCase();
    const children = Array.isArray(node.children) ? node.children : [];
    if (children.length === 0) {return true;}
    if (op === "OR") {
      for (const child of children) {if (await evaluateNode(child, context)) {return true;}}
      return false;
    }
    for (const child of children) {if (!(await evaluateNode(child, context))) {return false;}}
    return true;
  }
  if (node.type === "condition" || node.kind) {return evaluateLeaf(node, context);}
  return false;
}

export async function evaluateReward(reward, context) {
  const conditions = normalizeConditions(reward.conditions_json ?? reward.conditions, reward);
  return evaluateNode({op:"AND", children:conditions}, context);
}

async function rewardUsersForContext(reward, context) {
  if (context.userId) {return [String(context.userId)];}
  const ids = new Set();
  for (const group of normalizeConditions(reward.conditions_json ?? reward.conditions, reward)) {
    for (const child of group.children ?? []) {
      if (child.kind === "discord-role" && context.guild) {
        const roleId = String(child.roleId ?? child.discordRoleId ?? "");
        const role = roleId ? context.guild.roles.cache.get(roleId) : null;
        if (role) {for (const member of role.members.values()) {ids.add(member.id);}}
      }
      if (["follow","subscribe","membership","live","viewers","videos","views","clips","followers","subscribers"].includes(child.kind)) {
        const platform = child.platform ?? context.platform;
        const accountId = child.providerAccountId ?? context.accountId;
        if (platform && accountId) {
          const userId = getLinkedUserId(context.guildId, platform, accountId);
          if (userId) {ids.add(userId);}
        }
      }
    }
  }
  return [...ids];
}

async function applyRewardToContext(client, guildId, reward, context) {
  const config = featureSettings.getRoleRewardConfig(guildId);
  if (config.manualOnly && !context.manual) {return 0;}
  const guild = guildFrom(client, guildId) ?? context.guild ?? null;
  const ctx = {...context, guildId, guild};
  const users = await rewardUsersForContext(reward, ctx);
  let applied = 0;
  for (const userId of users) {
    const ok = await evaluateReward(reward, {...ctx, userId});
    if (ok) {
      if (await grantReward(client, guildId, reward, userId, {manual: Boolean(context.manual)})) {applied++;}
    } else if (reward.auto_remove) {
      await revokeReward(client, guildId, reward, userId);
    }
  }
  return applied;
}

export async function applyRewardsForMetric(client, guildId, options = {}) {
  const config = featureSettings.getRoleRewardConfig(guildId);
  if (config.manualOnly) {return 0;}
  const {platform, accountId, metric, value} = options;
  let applied = 0;
  for (const reward of listRewards(guildId)) {
    if (!reward.enabled) {continue;}
    applied += await applyRewardToContext(client, guildId, reward, {
      guildId, platform, accountId, metric, value,
      metrics: {[metric]: value}, source: options.source ?? "subscription"
    });
  }
  return applied;
}

export async function applyLiveRewards(client, guildId, options = {}) {
  const {platform, accountId, isLive, viewers} = options;
  let applied = 0;
  if (typeof isLive === "boolean") {
    applied += await applyRewardsForMetric(client, guildId, {platform, accountId, metric:"live", value:isLive ? 1 : 0, source:options.source});
  }
  if (Number.isFinite(Number(viewers))) {
    applied += await applyRewardsForMetric(client, guildId, {platform, accountId, metric:"viewers", value:viewers, source:options.source});
  }
  return applied;
}

export async function recheckRewards(client, guildId = null) {
  const guildIds = guildId
    ? [guildId]
    : [...new Set(getDB().prepare("SELECT DISTINCT guild_id FROM role_reward_rules").all().map(row => row.guild_id))];
  let applied = 0;

  for (const currentGuildId of guildIds) {
    const config = featureSettings.getRoleRewardConfig(currentGuildId);
    if (!config.recheckEnabled || config.manualOnly) {continue;}
    const guild = guildFrom(client, currentGuildId) ?? await client.guilds.fetch(currentGuildId).catch(() => null);
    const rewards = listRewards(currentGuildId).filter(r => r.enabled);
    const contexts = [];
    for (const link of accountLinking.listGuildLinks(currentGuildId)) {
      const metrics = await counters.getSocialMetrics(currentGuildId, {
        platform:link.platform, accountId:link.provider_account_id, source:"linked", userId:link.user_id
      }).catch(() => ({}));
      contexts.push({guildId:currentGuildId, guild, platform:link.platform, accountId:link.provider_account_id, userId:link.user_id, metrics, source:"linked"});
    }
    for (const subscription of notifications.getGuildSubscriptions(currentGuildId)) {
      const metrics = await counters.getSocialMetrics(currentGuildId, {
        platform:subscription.platform, accountId:subscription.channelId, source:"subscription"
      }).catch(() => ({}));
      contexts.push({guildId:currentGuildId, guild, platform:subscription.platform, accountId:subscription.channelId, metrics, source:"subscription"});
    }
    for (const reward of rewards) {
      for (const context of contexts) {
        applied += await applyRewardToContext(client, currentGuildId, reward, context);
      }
    }
  }
  return applied;
}

export async function handleWebhookEvent(client, provider, payload = {}) {
  const triggers = WEBHOOK_TRIGGERS[provider] ?? [];
  if (!triggers.length) {return 0;}
  const accountId = String(
    payload.providerAccountId ?? payload.accountId ?? payload.data?.accountId ??
    payload.event?.data?.online_user_id ?? payload.data?.creator_id ?? ""
  );
  const discordUserId = String(
    payload.discordUserId ?? payload.user?.discordId ?? payload.message?.user_id ?? ""
  );
  let applied = 0;

  for (const guildId of [...new Set(getDB().prepare("SELECT DISTINCT guild_id FROM role_reward_rules").all().map(row => row.guild_id))]) {
    const config = featureSettings.getRoleRewardConfig(guildId);
    if (config.manualOnly) {continue;}
    for (const reward of listRewards(guildId)) {
      if (!reward.enabled || !triggers.includes(reward.trigger_type)) {continue;}
      if (reward.provider_account_id && reward.provider_account_id !== accountId) {continue;}
      const userId = discordUserId ||
        (accountId ? getLinkedUserId(guildId, reward.platform ?? provider, accountId) : null);
      if (!userId) {continue;}
      if (await grantReward(client, guildId, reward, userId)) {applied++;}
    }
  }
  return applied;
}

export async function handleDiscordEvent(client, event = {}) {
  const trigger = event.type === "role" ? "discord-role" : event.type === "message" ? "discord-message" : null;
  if (!trigger || !event.guildId || !event.userId) {return 0;}
  let applied = 0;
  for (const reward of listRewards(event.guildId)) {
    if (!reward.enabled || reward.trigger_type !== trigger) {continue;}
    if (await grantReward(client, event.guildId, reward, event.userId)) {applied++;}
  }
  return applied;
}
