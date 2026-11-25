import * as discord        from "discord.js";
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

export function getReward(guildId, rewardId) {
  return getDB().prepare("SELECT * FROM role_reward_rules WHERE guild_id = ? AND reward_id = ?").get(guildId, rewardId) ?? null;
}

export function listRewards(guildId) {
  return getDB().prepare("SELECT * FROM role_reward_rules WHERE guild_id = ? ORDER BY created_at ASC").all(guildId);
}

export function createReward(guildId, patch = {}) {
  ensureGuild(guildId);
  if (!TRIGGERS.has(patch.triggerType)) {throw new Error(`Unknown reward trigger: ${patch.triggerType}`);}
  const rewardId = patch.rewardId ?? newId();
  getDB().prepare(`
    INSERT INTO role_reward_rules (
      guild_id, reward_id, trigger_type, platform, provider_account_id,
      metric, threshold, role_id, auto_remove, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    guildId, rewardId, patch.triggerType, patch.platform ?? null,
    patch.providerAccountId ?? null, patch.metric ?? null,
    patch.threshold ?? null, String(patch.roleId ?? ""),
    patch.autoRemove === false ? 0 : 1,
    patch.enabled === false ? 0 : 1
  );
  return getReward(guildId, rewardId);
}

export function updateReward(guildId, rewardId, patch = {}) {
  const current = getReward(guildId, rewardId);
  if (!current) {return null;}
  getDB().prepare(`
    UPDATE role_reward_rules
    SET trigger_type = ?, platform = ?, provider_account_id = ?, metric = ?,
        threshold = ?, role_id = ?, auto_remove = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = ? AND reward_id = ?
  `).run(
    TRIGGERS.has(patch.triggerType) ? patch.triggerType : current.trigger_type,
    Object.hasOwn(patch, "platform") ? patch.platform : current.platform,
    Object.hasOwn(patch, "providerAccountId") ? patch.providerAccountId : current.provider_account_id,
    Object.hasOwn(patch, "metric") ? patch.metric : current.metric,
    Object.hasOwn(patch, "threshold") ? patch.threshold : current.threshold,
    patch.roleId ?? current.role_id,
    Object.hasOwn(patch, "autoRemove") ? (patch.autoRemove ? 1 : 0) : current.auto_remove,
    Object.hasOwn(patch, "enabled") ? (patch.enabled ? 1 : 0) : current.enabled,
    guildId, rewardId
  );
  return getReward(guildId, rewardId);
}

export function deleteReward(guildId, rewardId) {
  const db = getDB();
  db.prepare("DELETE FROM role_reward_grants WHERE guild_id = ? AND reward_id = ?").run(guildId, rewardId);
  return db.prepare("DELETE FROM role_reward_rules WHERE guild_id = ? AND reward_id = ?").run(guildId, rewardId).changes > 0;
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

export async function applyRewardsForMetric(client, guildId, options = {}) {
  const config = featureSettings.getRoleRewardConfig(guildId);
  if (config.manualOnly) {return 0;}
  const {platform, accountId, metric, value} = options;
  let applied = 0;

  for (const reward of listRewards(guildId)) {
    if (!reward.enabled || reward.trigger_type !== metric) {continue;}
    if (reward.platform && reward.platform !== platform) {continue;}
    if (reward.provider_account_id && reward.provider_account_id !== String(accountId)) {continue;}
    if (reward.threshold !== null && Number(value) < Number(reward.threshold)) {continue;}

    const accounts = accountId
      ? [{userId:featureSettings ? getLinkedUserId(guildId, platform, accountId) : null}]
      : [];
    for (const account of accounts) {
      if (!account.userId) {continue;}
      if (await grantReward(client, guildId, reward, account.userId)) {applied++;}
    }

    if (reward.auto_remove) {
      const grants = getDB().prepare(
        "SELECT user_id FROM role_reward_grants WHERE guild_id = ? AND reward_id = ? AND auto_added = 1"
      ).all(guildId, reward.reward_id);
      for (const grant of grants) {
        if (reward.threshold !== null && Number(value) < Number(reward.threshold)) {
          await revokeReward(client, guildId, reward, grant.user_id);
        }
      }
    }
  }
  return applied;
}

function getLinkedUserId(guildId, platform, accountId) {
  const row = getDB().prepare(
    "SELECT user_id FROM account_links WHERE guild_id = ? AND platform = ? AND provider_account_id = ? LIMIT 1"
  ).get(guildId, platform, String(accountId));
  return row?.user_id ?? null;
}

export async function applyLiveRewards(client, guildId, options = {}) {
  const {platform, accountId, isLive, viewers} = options;
  let applied = 0;
  if (typeof isLive === "boolean") {
    applied += await applyRewardsForMetric(client, guildId, {platform, accountId, metric:"live", value:isLive ? 1 : 0});
  }
  if (Number.isFinite(Number(viewers))) {
    applied += await applyRewardsForMetric(client, guildId, {platform, accountId, metric:"viewers", value:viewers});
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

    for (const link of accountLinking.listGuildLinks(currentGuildId)) {
      const metrics = await counters.getSocialMetrics(currentGuildId, {
        platform:link.platform, accountId:link.provider_account_id, source:"linked"
      }).catch(() => ({}));
      for (const [metric, value] of Object.entries(metrics ?? {})) {
        applied += await applyRewardsForMetric(client, currentGuildId, {
          platform:link.platform, accountId:link.provider_account_id, metric, value
        });
      }
      if (typeof metrics.live === "boolean") {
        applied += await applyLiveRewards(client, currentGuildId, {
          platform:link.platform, accountId:link.provider_account_id,
          isLive:metrics.live, viewers:metrics.viewers
        });
      }
    }

    for (const subscription of notifications.getGuildSubscriptions(currentGuildId)) {
      const metrics = await counters.getSocialMetrics(currentGuildId, {
        platform:subscription.platform, accountId:subscription.channelId, source:"subscription"
      }).catch(() => ({}));
      for (const [metric, value] of Object.entries(metrics ?? {})) {
        applied += await applyRewardsForMetric(client, currentGuildId, {
          platform:subscription.platform, accountId:subscription.channelId, metric, value
        });
      }
      if (typeof metrics.live === "boolean") {
        applied += await applyLiveRewards(client, currentGuildId, {
          platform:subscription.platform, accountId:subscription.channelId,
          isLive:metrics.live, viewers:metrics.viewers
        });
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
