import * as discord        from "discord.js";
import * as log            from "./appLogger.js";
import * as guildLogger    from "./guildLogger.js";
import * as accountLinking from "./accountLinking.js";
import * as notifications  from "./notifications.js";
import * as featureSettings from "./featureSettings.js";
import * as twitch         from "./twitch.js";
import * as kick           from "./kick.js";
import * as apiLimits      from "./apiLimits.js";
import {getDB}             from "./storage.js";
import {trackInterval, trackTimeout, trackBackgroundTask, clearTrackedTimer} from "./lifecycle.js";

const CHECK_INTERVAL_MS       = 24 * 60 * 60 * 1000;
const SOCIAL_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const PLATFORMS = new Set(["youtube", "twitch", "kick"]);
const SOURCES   = new Set(["guild", "subscription", "linked"]);
const SOCIAL_METRICS = new Set(["followers", "subscribers", "live", "viewers", "videos", "clips", "views"]);
const COUNTER_TYPES = new Set(["accounts", "bots", "members", "role", ...SOCIAL_METRICS]);
const TYPE_NAMES = {
  accounts:"Accounts", bots:"Bots", members:"Members",
  followers:"Followers/Subscribers", subscribers:"Subscribers/Members", live:"Live status",
  viewers:"Viewers", videos:"Videos", clips:"Clips", views:"Views"
};

let client = null;
let checkHandle = null;
let socialHandle = null;

function ensureCounterTables() {
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS guild_counters (
      guild_id TEXT NOT NULL,
      counter_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      type TEXT NOT NULL,
      role_id TEXT,
      label TEXT,
      metric TEXT,
      source TEXT NOT NULL DEFAULT 'guild',
      platform TEXT,
      creator_id TEXT,
      refresh_enabled INTEGER NOT NULL DEFAULT 1,
      last_value TEXT,
      last_refreshed_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, counter_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
    )
  `);
}

function rowToCounter(row) {
  if (!row) {return null;}
  return {
    guildId:row.guild_id,
    counterId:row.counter_id,
    channelId:row.channel_id,
    type:row.type,
    roleId:row.role_id ?? null,
    label:row.label ?? null,
    metric:row.metric ?? (SOCIAL_METRICS.has(row.type) ? row.type : null),
    source:row.source ?? "guild",
    platform:row.platform ?? null,
    creatorId:row.creator_id ?? null,
    refreshEnabled:row.refresh_enabled !== 0,
    lastValue:row.last_value ?? null,
    lastRefreshedAt:row.last_refreshed_at ?? null,
    enabled:row.enabled === 1 || row.enabled === true
  };
}

/*
=====================================================
Configuration
=====================================================
*/

export function getCounters(guildId) {
  ensureCounterTables();
  return getDB().prepare(
    "SELECT * FROM guild_counters WHERE guild_id = ? ORDER BY created_at, counter_id"
  ).all(guildId).map(rowToCounter);
}

export function getCounter(guildId, counterId) {
  ensureCounterTables();
  return rowToCounter(getDB().prepare(
    "SELECT * FROM guild_counters WHERE guild_id = ? AND counter_id = ?"
  ).get(guildId, counterId));
}

export function getCounterTypeNames() {return {...TYPE_NAMES};}
export function isSocialCounterType(type) {return SOCIAL_METRICS.has(type);}

export async function createCounter(guild, data = {}) {
  ensureCounterTables();
  const type = COUNTER_TYPES.has(data.type) ? data.type : "members";
  const social = isSocialCounterType(type);
  if (type === "role" && !data.roleId) {throw new Error("Choose a role for a role counter.");}
  if (social && !PLATFORMS.has(String(data.platform ?? "").toLowerCase())) {
    throw new Error("Choose YouTube, Twitch, or Kick for a social counter.");
  }
  if (social && data.source === "linked" && !data.creatorId) {
    throw new Error("Choose a linked account for this counter.");
  }
  const existing = getCounters(guild.id);
  if (existing.length >= 25) {throw new Error("This server already has 25 counters.");}

  const counterId = `c_${Date.now().toString(36)}`;
  const draft = {
    guildId:guild.id,
    counterId,
    channelId:null,
    type,
    roleId:type === "role" ? String(data.roleId) : null,
    label:data.label ? String(data.label).trim().slice(0, 100) : null,
    metric:social ? type : null,
    source:social ? (SOURCES.has(data.source) && data.source !== "guild" ? data.source : "subscription") : "guild",
    platform:social ? String(data.platform).toLowerCase() : null,
    creatorId:social ? String(data.creatorId ?? "") || null : null,
    refreshEnabled:data.refreshEnabled !== false,
    lastValue:null,
    enabled:true
  };

  await guild.members.fetch().catch(() => {});
  const channel = await createCounterChannel(guild, draft);
  await lockChannel(channel, guild);

  try {
    getDB().prepare("INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)").run(String(guild.id));
    getDB().prepare(`
      INSERT INTO guild_counters (
        guild_id, counter_id, channel_id, type, role_id, label,
        metric, source, platform, creator_id, refresh_enabled,
        enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      guild.id, counterId, channel.id, draft.type, draft.roleId, draft.label,
      draft.metric, draft.source, draft.platform, draft.creatorId,
      draft.refreshEnabled ? 1 : 0
    );
  } catch (error) {
    await channel.delete().catch(() => {});
    throw error;
  }

  log.info("BargazBot counter created:", guild.id, counterId, type);
  return getCounter(guild.id, counterId);
}

export function updateCounter(guildId, counterId, patch = {}) {
  ensureCounterTables();
  const current = getCounter(guildId, counterId);
  if (!current) {return null;}
  if (Object.hasOwn(patch, "type") && !COUNTER_TYPES.has(patch.type)) {
    throw new Error("Unknown counter type.");
  }
  const social = isSocialCounterType(Object.hasOwn(patch, "type") ? patch.type : current.type);
  if (social && Object.hasOwn(patch, "platform") && !PLATFORMS.has(String(patch.platform ?? "").toLowerCase())) {
    throw new Error("Unknown counter platform.");
  }
  if (social && Object.hasOwn(patch, "source") && !["subscription", "linked"].includes(patch.source)) {
    throw new Error("Social counters must use a subscription or linked account.");
  }

  const sets = [];
  const values = [];
  const put = (column, value) => {sets.push(`${column} = ?`); values.push(value);};
  if (Object.hasOwn(patch, "channelId"))     {put("channel_id", patch.channelId ?? null);}
  if (Object.hasOwn(patch, "type"))          {put("type", patch.type);}
  if (Object.hasOwn(patch, "roleId"))        {put("role_id", patch.roleId ?? null);}
  if (Object.hasOwn(patch, "label"))         {put("label", patch.label ? String(patch.label).trim().slice(0, 100) : null);}
  if (Object.hasOwn(patch, "enabled"))       {put("enabled", patch.enabled ? 1 : 0);}
  if (Object.hasOwn(patch, "source"))        {put("source", patch.source);}
  if (Object.hasOwn(patch, "platform"))      {put("platform", patch.platform ? String(patch.platform).toLowerCase() : null);}
  if (Object.hasOwn(patch, "creatorId"))     {put("creator_id", patch.creatorId ? String(patch.creatorId) : null);}
  if (Object.hasOwn(patch, "refreshEnabled")){put("refresh_enabled", patch.refreshEnabled ? 1 : 0);}
  if (Object.hasOwn(patch, "metric"))        {put("metric", patch.metric);}
  else if (Object.hasOwn(patch, "type") && social) {put("metric", patch.type);}
  if (!sets.length) {return current;}

  sets.push("updated_at = CURRENT_TIMESTAMP");
  getDB().prepare(
    `UPDATE guild_counters SET ${sets.join(", ")} WHERE guild_id = ? AND counter_id = ?`
  ).run(...values, guildId, counterId);
  return getCounter(guildId, counterId);
}

export async function deleteCounter(guild, counterId) {
  ensureCounterTables();
  const counter = getCounter(guild.id, counterId);
  if (!counter) {return false;}
  const channel =
    guild.channels.cache.get(counter.channelId) ??
    await guild.channels.fetch(counter.channelId).catch(() => null);
  if (channel) {
    await channel.delete(`BargazBot counter removed ${guild.id}`).catch(error =>
      log.warn("BargazBot counter channel delete failed:", guild.id, counter.channelId, error)
    );
  }
  const deleted = getDB().prepare(
    "DELETE FROM guild_counters WHERE guild_id = ? AND counter_id = ?"
  ).run(guild.id, counterId).changes > 0;
  if (deleted) {log.info("BargazBot counter deleted:", guild.id, counterId);}
  return deleted;
}

/*
=====================================================
Counting and channel updates
=====================================================
*/

function formatCounterValue(counter, value) {
  if (counter.type === "live" || counter.metric === "live") {
    return Number(value) > 0 ? "Live" : "Offline";
  }
  const number = Number(value);
  return Number.isFinite(number) && value !== null && value !== ""
    ? number.toLocaleString("en-US")
    : String(value ?? "—");
}

export function defaultLabel(counter, guild) {
  if (counter.type === "role") {
    const role = guild?.roles?.cache?.get(counter.roleId);
    return role ? `@${role.name}` : "Role";
  }
  return TYPE_NAMES[counter.metric ?? counter.type] ?? counter.type;
}

export function countCounter(counter, guild) {
  if (isSocialCounterType(counter.type)) {
    const value = counter.lastValue;
    const number = Number(value);
    return Number.isFinite(number) && value !== null ? number : value ?? "—";
  }
  const members = [...guild.members.cache.values()];
  if (counter.type === "accounts") {return members.length;}
  if (counter.type === "bots")     {return members.filter(member => member.user.bot).length;}
  if (counter.type === "members")  {return members.filter(member => !member.user.bot).length;}
  if (counter.type === "role") {
    return members.filter(member => !member.user.bot && member.roles.cache.has(counter.roleId)).length;
  }
  return 0;
}

export function counterChannelName(counter, guild) {
  const label = counter.label || defaultLabel(counter, guild);
  return `${label} ${formatCounterValue(counter, countCounter(counter, guild))}`.replace(/[\r\n]+/g, " ").slice(0, 100);
}

async function createCounterChannel(guild, counter) {
  return guild.channels.create({
    name:   counterChannelName(counter, guild),
    type:   discord.ChannelType.GuildVoice,
    reason: `BargazBot counter ${guild.id}`
  });
}

async function lockChannel(channel, guild) {
  const everyone = guild.roles.everyone;
  const overwrites = await channel.permissionOverwrites.fetch().catch(() => channel.permissionOverwrites.cache);
  const publicOverwrite = overwrites.get(everyone.id);
  if (!publicOverwrite || !publicOverwrite.deny.has(discord.PermissionFlagsBits.Connect)) {
    await channel.permissionOverwrites.edit(everyone,
      {ViewChannel:true, Connect:false},
      {reason:"BargazBot counter channel"}
    );
  }
}

async function fetchJson(url, options = {}, meta = {}) {
  const provider = meta.provider;
  const kind = meta.kind ?? "any";
  if (provider) {
    const limit = apiLimits.limitDetails(provider, kind);
    if (limit.limited) {
      const err = new Error(apiLimits.formatLimitMessage(provider, limit));
      err.code = "API_LIMITED";
      throw err;
    }
  }

  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const resetHeader = Number(response.headers.get("ratelimit-reset"));
      const remaining = response.headers.get("ratelimit-remaining");
      const bodyText = await response.text().catch(() => "");
      let body = null;
      try {body = JSON.parse(bodyText);} catch {}

      if (provider && meta.reportLimit !== false && [401,403,429].includes(response.status)) {
        const ytReasons = (body?.error?.errors ?? []).map(e => String(e.reason ?? "").toLowerCase());
        const quotaReason = ytReasons.find(r => ["quotaexceeded","dailylimitexceeded","userratelimitexceeded","ratelimitexceeded"].includes(r));
        const isLimit = response.status === 429 || quotaReason || /quota|rate limit|dailylimit/i.test(bodyText);
        const isAuth = provider === "kick" && [401,403].includes(response.status) && !isLimit;
        if (isLimit || isAuth) {
          await apiLimits.recordLimitHit(provider, {
            kind,
            status: response.status,
            reason: quotaReason || body?.error?.message || bodyText.slice(0, 160) || `HTTP ${response.status}`,
            retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
            resetAt: Number.isFinite(resetHeader) ? resetHeader * 1000 : undefined,
            remaining: remaining == null ? undefined : Number(remaining)
          });
        }
      }

      const err = new Error(`HTTP ${response.status}`);
      err.status = response.status;
      err.body = bodyText;
      throw err;
    }

    if (provider && apiLimits.isLimited(provider, kind)) {
      await apiLimits.recordLimitRecovery(provider, kind);
    }
    return await response.json();
  } catch (error) {
    if (error.code !== "API_LIMITED") {
      log.warn("BargazBot social metric request failed:", error?.message ?? error);
    }
    throw error;
  }
}

async function youtubeMetrics(channelId, token = null) {
  const apiKey = token ? null : process.env.YOUTUBE_API_KEY;
  if (!apiKey && !token) {return {};}
  const headers = token ? {authorization:`Bearer ${token}`} : {};
  const base = (extra, values) => `https://www.googleapis.com/youtube/v3/${extra}?${new URLSearchParams({
    ...values, ...(apiKey ? {key:apiKey} : {})
  })}`;

  const channelData = await fetchJson(base("channels", {part:"statistics", id:channelId}), {headers}, {provider:"youtube", kind:"quota"});
  const stats = channelData?.items?.[0]?.statistics ?? {};
  const subscribers = Number(stats.subscriberCount ?? 0);
  const result = {
    followers:subscribers,
    subscribers,
    videos:Number(stats.videoCount ?? 0),
    views:Number(stats.viewCount ?? 0),
    live:false,
    viewers:0
  };

  if (!apiLimits.isLimited("youtube", "search")) {
    const liveData = await fetchJson(base("search", {
      part:"snippet", channelId, eventType:"live", type:"video", maxResults:"1"
    }), {headers}, {provider:"youtube", kind:"search"});
    const videoId = liveData?.items?.[0]?.id?.videoId;
    if (videoId) {
      result.live = true;
      const video = await fetchJson(base("videos", {part:"liveStreamingDetails", id:videoId}), {headers}, {provider:"youtube", kind:"quota"});
      result.viewers = Number(video?.items?.[0]?.liveStreamingDetails?.concurrentViewers ?? 0);
    }
  }
  return result;
}

async function twitchMetrics(channelId) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) {return {};}
  const token = await twitch.getAccessToken().catch(() => null);
  if (!token) {return {};}
  const headers = {"Client-ID":clientId, authorization:`Bearer ${token}`};
  const id = encodeURIComponent(channelId);
  const userData = await fetchJson(`https://api.twitch.tv/helix/users?id=${id}`, {headers}, {provider:"twitch"});
  const followData = await fetchJson(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${id}&first=1`, {headers}, {provider:"twitch"});
  const streamData = await fetchJson(`https://api.twitch.tv/helix/streams?user_id=${id}`, {headers}, {provider:"twitch"});
  const user = userData?.data?.[0] ?? {};
  const stream = streamData?.data?.[0] ?? null;
  return {
    followers:Number(followData?.total ?? 0),
    subscribers:0,
    views:Number(user.view_count ?? 0),
    videos:0,
    clips:0,
    live:Boolean(stream),
    viewers:Number(stream?.viewer_count ?? 0)
  };
}

async function kickMetrics(channelId, token = null) {
  const access = token ?? await kick.getAccessToken().catch(() => null);
  const headers = access ? {authorization:`Bearer ${access}`} : {};
  const id = encodeURIComponent(channelId);

  const fetchBySlug = async () => {
    const row = getDB().prepare("SELECT channel_handle, channel_name FROM kick_channels WHERE channel_id = ?").get(String(channelId));
    const slug = String(row?.channel_handle ?? row?.channel_name ?? "").replace(/^@/, "").trim();
    if (!slug) {throw new Error("Kick channel slug not found for metric lookup.");}
    const appAccess = await kick.getAccessToken().catch(() => null);
    const appHeaders = appAccess ? {authorization:`Bearer ${appAccess}`} : {};
    const data = await fetchJson(`https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`, {headers:appHeaders}, {provider:"kick"});
    const channel = data?.data?.[0] ?? {};
    return {
      followers:0,
      subscribers:Number(channel.active_subscribers_count ?? 0),
      views:0,
      videos:0,
      clips:0,
      live:Boolean(channel.stream?.is_live ?? false),
      viewers:Number(channel.stream?.viewer_count ?? 0)
    };
  };

  if (!token) {return fetchBySlug();}

  try {
    const userData = await fetchJson(`https://api.kick.com/public/v1/users?id=${id}`, {headers}, {provider:"kick", reportLimit:false});
    const channelData = await fetchJson(`https://api.kick.com/public/v1/channels?user_id=${id}`, {headers}, {provider:"kick", reportLimit:false});
    const user = userData?.data?.[0] ?? {};
    const channel = channelData?.data?.[0] ?? {};
    return {
      followers:Number(user.followers_count ?? user.followerCount ?? 0),
      subscribers:Number(channel.active_subscribers_count ?? 0),
      views:Number(user.view_count ?? 0),
      videos:0,
      clips:0,
      live:Boolean(channel.stream?.is_live ?? user.is_live ?? false),
      viewers:Number(channel.stream?.viewer_count ?? 0)
    };
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {return fetchBySlug();}
    throw error;
  }
}

const METRIC_CACHE_TTL_MS = 5 * 60 * 1000;
const metricCache = new Map();

function metricCacheKey(guildId, platform, accountId, source) {
  return `${guildId}:${platform}:${accountId}:${source}`;
}

export async function getSocialMetrics(guildOrId, options = {}) {
  const guild = typeof guildOrId === "string"
    ? (client?.guilds?.cache?.get(guildOrId) ?? null)
    : guildOrId;
  const guildId = typeof guildOrId === "string" ? guildOrId : guildOrId?.id;
  const platform = String(options.platform ?? "").toLowerCase();
  const defaults = {followers:0, subscribers:0, live:false, viewers:0, videos:0, clips:0, views:0};
  if (!guildId || !PLATFORMS.has(platform)) {return defaults;}

  const accountId = String(options.accountId ?? "");
  const source = options.source === "linked" ? "linked" : "subscription";
  let token = null;

  if (source === "linked") {
    const link = accountLinking.listGuildLinks(guildId).find(row => row.provider_account_id === accountId) ??
      (options.userId ? accountLinking.getLinkedAccount(guildId, options.userId, platform) : null);
    if (link) {
      token = await accountLinking.getValidAccessToken(guildId, link.user_id, platform).catch(() => null);
    }
  }

  const cacheKey = metricCacheKey(guildId, platform, accountId, source);
  const cached = metricCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {return cached.value;}

  try {
    let values = {};
    if (platform === "youtube")  {values = await youtubeMetrics(accountId, token);}
    else if (platform === "twitch") {values = await twitchMetrics(accountId);}
    else {values = await kickMetrics(accountId, token);}
    const merged = {...defaults, ...values};
    metricCache.set(cacheKey, {expires: Date.now() + METRIC_CACHE_TTL_MS, value: merged});
    return merged;
  } catch (error) {
    if (cached?.value) {return cached.value;}
    if (error?.code !== "API_LIMITED" && guild) {
      await guildLogger.logFailureSafe(guild, {
        category:"data",
        title:"Social metric refresh failed",
        description:"A social metric refresh failed. Counters may be stale until the next successful refresh.",
        error
      }).catch(() => {});
    }
    if (error?.code !== "API_LIMITED") {
      log.warn("BargazBot social metrics failed:", platform, accountId, error?.message ?? error);
    }
    return defaults;
  }
}

export async function getSocialMetric(guildOrId, options = {}) {
  const metrics = await getSocialMetrics(guildOrId, options);
  return metrics[options.metric ?? "followers"] ?? 0;
}

async function resolveCounterValue(counter, guild) {
  if (!isSocialCounterType(counter.type)) {return countCounter(counter, guild);}
  const metrics = await getSocialMetrics(guild, {
    platform:counter.platform,
    accountId:counter.creatorId,
    source:counter.source === "linked" ? "linked" : "subscription",
    userId:counter.creatorId
  });
  const value = metrics[counter.metric ?? counter.type] ?? 0;
  getDB().prepare(`
    UPDATE guild_counters
    SET last_value = ?, last_refreshed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = ? AND counter_id = ?
  `).run(String(value), guild.id, counter.counterId);
  return value;
}

async function resolvedCounterName(counter, guild) {
  const label = counter.label || defaultLabel(counter, guild);
  const value = await resolveCounterValue(counter, guild);
  return `${label} ${formatCounterValue(counter, value)}`.replace(/[\r\n]+/g, " ").slice(0, 100);
}

function resolveGuild(guildOrId) {
  if (typeof guildOrId !== "string") {return guildOrId;}
  return client?.guilds.cache.get(guildOrId) ?? client?.guilds.fetch(guildOrId).catch(() => null) ?? null;
}

async function refreshOneCounter(counter, guild) {
  const channel =
    guild.channels.cache.get(counter.channelId) ??
    await guild.channels.fetch(counter.channelId).catch(() => null);
  if (!channel || channel.type !== discord.ChannelType.GuildVoice) {return false;}
  try {
    await lockChannel(channel, guild);
    const name = await resolvedCounterName(counter, guild);
    if (channel.name !== name) {await channel.setName(name, `BargazBot counter ${guild.id}`);}
    return true;
  } catch (error) {
    guildLogger.logFailureSafe(guild, {
      category:"counter",
      title:"Counter update failed",
      description:`Could not update counter ${counter.counterId}.`,
      fields:[{name:"Counter", value:counter.counterId, inline:true}],
      error
    }).catch(() => {});
    return false;
  }
}

export async function refreshGuildCounters(guildOrId) {
  const guild = await resolveGuild(guildOrId);
  if (!guild) {return 0;}
  ensureCounterTables();
  let updated = 0;
  for (const counter of getCounters(guild.id).filter(item => item.enabled)) {
    if (await refreshOneCounter(counter, guild)) {updated++;}
  }
  return updated;
}

export async function refreshSocialCounters(guildOrId) {
  const guild = await resolveGuild(guildOrId);
  if (!guild) {return 0;}
  ensureCounterTables();
  const config = featureSettings.getSocialCounterConfig(guild.id);
  if (config.refreshEnabled === false) {return 0;}
  let updated = 0;
  for (const counter of getCounters(guild.id).filter(item => item.enabled && isSocialCounterType(item.type) && item.refreshEnabled)) {
    if (await refreshOneCounter(counter, guild)) {updated++;}
  }
  return updated;
}

export async function manualRefreshCounter(discordClient, guildId, counterId) {
  const counter = getCounter(guildId, counterId);
  if (!counter) {return {success:false, reason:"not-found"};}
  const guild = discordClient?.guilds?.cache?.get(guildId) ??
    await discordClient?.guilds?.fetch(guildId).catch(() => null);
  if (!guild) {return {success:false, reason:"guild-unavailable"};}
  const ok = await refreshOneCounter(counter, guild);
  return ok
    ? {success:true, value:getCounter(guildId, counterId)?.lastValue}
    : {success:false, reason:"update-failed"};
}

export const updateGuildCounters = refreshGuildCounters;

/*
=====================================================
Service Lifecycle
=====================================================
*/

async function runCounterCheck() {
  if (!client) {return;}
  for (const guild of client.guilds.cache.values()) {
    await refreshGuildCounters(guild);
  }
}

async function runSocialCounterCheck() {
  if (!client) {return;}
  for (const guild of client.guilds.cache.values()) {
    await refreshSocialCounters(guild);
  }
}

export function startCounters(discordClient) {
  if (checkHandle) {return;}
  client = discordClient;
  ensureCounterTables();
  checkHandle = trackInterval(() => trackBackgroundTask(runCounterCheck(), "counter check"), CHECK_INTERVAL_MS, "counter monitor");
  socialHandle = trackInterval(() => trackBackgroundTask(runSocialCounterCheck(), "social counter check"), SOCIAL_CHECK_INTERVAL_MS, "social counter monitor");
  trackTimeout(() => trackBackgroundTask(runCounterCheck(), "initial counter check"), 10000, "initial counter check");
  trackTimeout(() => trackBackgroundTask(runSocialCounterCheck(), "initial social counter check"), 15000, "initial social counter check");
  log.info("BargazBot counters started.");
}

export function stopCounters() {
  if (checkHandle)   {clearTrackedTimer(checkHandle); checkHandle = null;}
  if (socialHandle)  {clearTrackedTimer(socialHandle); socialHandle = null;}
  client = null;
  log.info("BargazBot counters stopped.");
}
