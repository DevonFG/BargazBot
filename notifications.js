import * as discord        from "discord.js";
import * as channelManager from "./channelManager.js";
import * as youtube        from "./youtube.js";
import * as twitch         from "./twitch.js";
import * as kick           from "./kick.js";
import * as entitlements   from "./entitlements.js";

import { getDB, getNotificationDedupeHours } from "./storage.js";

const PLATFORM_COLORS       =  {youtube: 0xFF0000,  twitch: 0x9146FF, kick: 0x53FC18};
const PLATFORM_NAMES        =  {youtube: "YouTube", twitch: "Twitch", kick: "Kick"};
const PLATFORM_EMOJIS       =  {youtube: "🔴",      twitch: "🟣",    kick: "🟢"};
const PLATFORM_KEYS         =  ["youtube", "twitch", "kick"];
const DEFAULT_REFRESH_LIMIT = 2;
const REFRESH_WINDOW_MS     = 6 * 60 * 60 * 1000;
const MAX_MESSAGE_MENTIONS  = 5;

function toSqlTimestamp(timestamp) {return new Date(timestamp).toISOString().replace("T", " ").slice(0, 19);}
function normalizePlatform(platform) {const value = String(platform ?? "").trim().toLowerCase(); if (!PLATFORM_KEYS.includes(value)) { throw new Error(`Unknown notification platform: ${platform}`);} return value;}
function getPlatformModule(platform) {switch (normalizePlatform(platform)) {case "youtube":return youtube; case "twitch": return twitch; case "kick":   return kick;}}
function getSubscriptionTable(platform) {switch (normalizePlatform(platform)) {case "youtube":return "guild_youtube_subs"; case "twitch": return "guild_twitch_subs"; case "kick":   return "guild_kick_subs";}}
function getChannelTable(platform) {switch (normalizePlatform(platform)) {case "youtube":return "youtube_channels"; case "twitch":return "twitch_channels"; case "kick":return "kick_channels";}}

export function getPlatformName(platform) {return PLATFORM_NAMES[normalizePlatform(platform)];}
export function getPlatformInfo(platform) {const key = normalizePlatform(platform); return {key, name: PLATFORM_NAMES[key], color: PLATFORM_COLORS[key], emoji: PLATFORM_EMOJIS[key]};}

function getContentTypeName(content) {switch (content.contentType) {
  case "video":return "Video"; case "short":return "Short"; case "stream":return "Livestream";
  case "premiere":return "Premiere"; case "post":return "Community Post"; default:return "Content";
}}
function buildNotificationEmbed(content) {
  const platformName = PLATFORM_NAMES[content.platform] ?? content.platform;
  const platformEmoji = PLATFORM_EMOJIS[content.platform] ?? "";
  const embed =
    new discord.EmbedBuilder()
      .setColor(PLATFORM_COLORS[content.platform] ?? 0x5865F2)
      .setTitle(content.isEnded ? `~~${content.title}~~` : content.title)
      .setURL(content.url)
      .setAuthor({name: `${content.channelName} • ${platformName}`})
      .addFields({name: "Channel", value: content.channelHandle ? `${content.channelName} (${content.channelHandle})` : content.channelName, inline: true}, {name: "Type", value: getContentTypeName(content), inline: true});
  if (content.isLive) {embed.addFields({name: "Status", value: "🔴 LIVE NOW", inline: true});} 
  else if (content.isScheduled) {embed.addFields({name: "Status", value: "Scheduled", inline: true});} 
  else if (content.isEnded) {embed.addFields({name: "Status", value: "Stream ended", inline: true});}
  if (content.platform === "twitch" && content.gameName) {embed.addFields({name: "Category", value: content.gameName, inline: true});}
  if (content.scheduledStartTime) {
    const timestamp = Math.floor(new Date(content.scheduledStartTime).getTime() / 1000);
    if (Number.isFinite(timestamp)) {embed.addFields({name: "Scheduled Start", value: `<t:${timestamp}:F>\n` + `<t:${timestamp}:R>`, inline: false});}
  }
  if (content.thumbnail) {embed.setImage(content.thumbnail);}
  embed.setFooter({text: `${platformEmoji} ${platformName}`}).setTimestamp();
  return embed;
}

export function buildDefaultMessage(content) {
  const platformName = PLATFORM_NAMES[content.platform] ?? content.platform;
  if (content.isEnded) {return (`${content.channelName}'s stream on ` + `${platformName} has ended.`);}
  if (content.isLive) {return (`${content.channelName} is now live on ` + `${platformName}!`);}
  if (content.isScheduled) {return (`${content.channelName} has scheduled new ` + `${getContentTypeName(content).toLowerCase()} content on ` + `${platformName}!`);}
  return (`${content.channelName} posted new ` + `${getContentTypeName(content).toLowerCase()} content on ` + `${platformName}!`);
}

function buildMessageContent(content, subscription, options, isEdit = false) {
  const active = subscription?.resolvedConfig ?? options ?? {};
  const creatorName =
    subscription?.nickname ||
    content.channelName ||
    "Creator";

  let text =
    active.customMessage ||
    subscription?.customMessage ||
    buildDefaultMessage(content);

  text = String(text)
    .replaceAll("{creator}", creatorName)
    .replaceAll("{platform}", PLATFORM_NAMES[content.platform] ?? content.platform)
    .replaceAll("{title}", content.title ?? "");

  const mentions = [
    ...(active.mentionRoles ?? []).map(id => `<@&${id}>`),
    ...(active.mentionUsers ?? []).map(id => `<@${id}>`)
  ].join(" ");

  if (mentions) {
    text = `${mentions} ${text}`;
  }

  if (isEdit && active.showCreatorOnEdit) {
    text = `${text}\n\n*Updated by ${creatorName}*`;
  }

  return text;
}

function getNotificationEventType(content, changes = {}) {
  if (changes.ended) {return "live";}
  if (changes.wentLive || content.isLive) {return "live";}
  if (content.isScheduled) {return "scheduled";}
  switch (content.contentType) {
    case "video":return "video"; case "short":return "short"; case "premiere":return "premiere";
    case "post":return "post"; case "stream":return "live"; default:return "content";
  }
}

function getTrackingContentId(content) {return content.platform === "kick" ? String(content.channelId) : String(content.id);}

function parseMentionIds(value) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    if (!Array.isArray(parsed)) {return [];}
    return parsed
      .map(id => String(id))
      .filter(id => /^\d{17,20}$/.test(id))
      .slice(0, MAX_MESSAGE_MENTIONS);
  } catch {
    return [];
  }
}

function cleanMentionIds(value) {
  return (Array.isArray(value) ? value : [])
    .map(id => String(id))
    .filter(id => /^\d{17,20}$/.test(id))
    .slice(0, MAX_MESSAGE_MENTIONS);
}


export function getNotificationMessageOptions(guildId, platform, channelId) {
  const row = getDB().prepare(`
    SELECT
      mention_roles,
      mention_users,
      show_creator_on_edit
    FROM notification_message_options
    WHERE guild_id = ?
      AND platform = ?
      AND channel_id = ?
  `).get(
    guildId,
    normalizePlatform(platform),
    String(channelId)
  );

  return {
    mentionRoles: parseMentionIds(row?.mention_roles),
    mentionUsers: parseMentionIds(row?.mention_users),
    showCreatorOnEdit: Boolean(row?.show_creator_on_edit)
  };
}


export function setNotificationMessageOptions(guildId, platform, channelId, options = {}) {
  const mentionRoles = cleanMentionIds(options.mentionRoles);
  const mentionUsers = cleanMentionIds(options.mentionUsers);
  const showCreatorOnEdit = options.showCreatorOnEdit ? 1 : 0;

  getDB().prepare(`
    INSERT INTO notification_message_options (
      guild_id,
      platform,
      channel_id,
      mention_roles,
      mention_users,
      show_creator_on_edit,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)

    ON CONFLICT(guild_id, platform, channel_id) DO UPDATE SET
      mention_roles = excluded.mention_roles,
      mention_users = excluded.mention_users,
      show_creator_on_edit = excluded.show_creator_on_edit,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    guildId,
    normalizePlatform(platform),
    String(channelId),
    JSON.stringify(mentionRoles),
    JSON.stringify(mentionUsers),
    showCreatorOnEdit
  );

  return {
    mentionRoles,
    mentionUsers,
    showCreatorOnEdit: Boolean(showCreatorOnEdit)
  };
}

const NOTIFICATION_CONFIG_SCOPES = ["default", "platform", "creator", "group"];

export function emptyNotificationConfig() {
  return {
    customMessage: null,
    mentionRoles: [],
    mentionUsers: [],
    showCreatorOnEdit: false
  };
}

function configRowToObject(row) {
  if (!row) {return null;}
  return {
    customMessage: row.custom_message ?? null,
    mentionRoles: parseMentionIds(row.mention_roles),
    mentionUsers: parseMentionIds(row.mention_users),
    showCreatorOnEdit: Boolean(row.show_creator_on_edit)
  };
}

export function getNotificationConfig(guildId, scope, scopeKey = "") {
  const cleanScope = NOTIFICATION_CONFIG_SCOPES.includes(scope) ? scope : "default";
  const key = String(scopeKey ?? "");

  if (cleanScope === "group") {
    const group = findGroup(guildId, key);
    if (!group) {return null;}
    return {
      customMessage: group.customMessage,
      mentionRoles: group.mentionRoles,
      mentionUsers: group.mentionUsers,
      showCreatorOnEdit: group.showCreatorOnEdit
    };
  }

  return configRowToObject(getDB().prepare(`
    SELECT custom_message, mention_roles, mention_users, show_creator_on_edit
    FROM notification_configs
    WHERE guild_id = ? AND scope = ? AND scope_key = ?
  `).get(guildId, cleanScope, key));
}

export function setNotificationConfig(guildId, scope, scopeKey = "", patch = {}) {
  const cleanScope = NOTIFICATION_CONFIG_SCOPES.includes(scope) ? scope : "default";
  const key = String(scopeKey ?? "");
  const current = getNotificationConfig(guildId, cleanScope, key) ?? emptyNotificationConfig();

  const next = {
    customMessage: Object.hasOwn(patch, "customMessage")
      ? (patch.customMessage ? String(patch.customMessage).slice(0, 2000) : null)
      : current.customMessage,
    mentionRoles: Object.hasOwn(patch, "mentionRoles")
      ? cleanMentionIds(patch.mentionRoles)
      : current.mentionRoles,
    mentionUsers: Object.hasOwn(patch, "mentionUsers")
      ? cleanMentionIds(patch.mentionUsers)
      : current.mentionUsers,
    showCreatorOnEdit: Object.hasOwn(patch, "showCreatorOnEdit")
      ? Boolean(patch.showCreatorOnEdit)
      : current.showCreatorOnEdit
  };

  if (cleanScope === "group") {
    updateGroup(guildId, key, next);
    return getNotificationConfig(guildId, cleanScope, key);
  }

  getDB().prepare(`
    INSERT INTO notification_configs (
      guild_id, scope, scope_key, custom_message, mention_roles, mention_users,
      show_creator_on_edit, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)

    ON CONFLICT(guild_id, scope, scope_key) DO UPDATE SET
      custom_message = excluded.custom_message,
      mention_roles = excluded.mention_roles,
      mention_users = excluded.mention_users,
      show_creator_on_edit = excluded.show_creator_on_edit,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    guildId,
    cleanScope,
    key,
    next.customMessage,
    JSON.stringify(next.mentionRoles),
    JSON.stringify(next.mentionUsers),
    next.showCreatorOnEdit ? 1 : 0
  );

  return next;
}

export function deleteNotificationConfig(guildId, scope, scopeKey = "") {
  const cleanScope = NOTIFICATION_CONFIG_SCOPES.includes(scope) ? scope : "default";
  if (cleanScope === "default" || cleanScope === "group") {return false;}

  return getDB().prepare(`
    DELETE FROM notification_configs
    WHERE guild_id = ? AND scope = ? AND scope_key = ?
  `).run(guildId, cleanScope, String(scopeKey ?? "")).changes > 0;
}

export function listNotificationConfigTargets(guildId) {
  const targets = [
    {scope:"default", scopeKey:"", label:"Default (all notifications)"},
    ...PLATFORM_KEYS.map(platform => ({
      scope:"platform",
      scopeKey:platform,
      label:`Platform: ${getPlatformName(platform)}`
    })),
    ...getGuildSubscriptions(guildId).map(subscription => ({
      scope:"creator",
      scopeKey:`${normalizePlatform(subscription.platform)}:${subscription.channelId}`,
      label:`Creator: ${subscription.nickname} — ${getPlatformName(subscription.platform)}`
    })),
    ...getGuildGroups(guildId).map(group => ({
      scope:"group",
      scopeKey:group.groupId,
      label:`Group: ${group.name}`
    }))
  ];

  return targets.map(target => ({
    ...target,
    value:`${target.scope}:${target.scopeKey}`,
    config:getNotificationConfig(guildId, target.scope, target.scopeKey)
  }));
}

export function resolveNotificationConfig(guildId, context = {}) {
  const {platform, channelId, groupId = null, isGroupPost = false} = context;

  const normalizedPlatform = normalizePlatform(platform);
  const creatorKey = `${normalizedPlatform}:${String(channelId ?? "")}`;

  const defaultConfig = getNotificationConfig(guildId, "default", "");
  const platformConfig = getNotificationConfig(guildId, "platform", normalizedPlatform);
  const creatorConfig = getNotificationConfig(guildId, "creator", creatorKey);
  const groupConfig = groupId ? getNotificationConfig(guildId, "group", groupId) : null;

  const fallback =
    creatorConfig ??
    platformConfig ??
    defaultConfig ??
    null;

  if (isGroupPost) {return groupConfig ?? fallback;}

  if (groupId && !creatorConfig) {return groupConfig ?? fallback;}

  return fallback;
}

/*
=====================================================
Announcement Groups
=====================================================
*/

export const NOTIFICATION_GROUP_KINDS = [
  "live", "scheduled", "video", "short", "premiere", "post", "content"
];

const GROUP_FIELDS = {
  name: "name",
  title: "title",
  details: "details",
  thumbnailUrl: "thumbnail_url",
  windowMinutes: "window_minutes",
  discordChannelId: "discord_channel_id",
  customMessage: "custom_message",
  mentionRoles: "mention_roles",
  mentionUsers: "mention_users",
  showCreatorOnEdit: "show_creator_on_edit",
  allowedKinds: "allowed_kinds",
  allowMultiplePerChannel: "allow_multiple_per_channel"
};

function parseGroupKinds(value) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    if (!Array.isArray(parsed)) {return [];}
    return parsed
      .map(kind => String(kind))
      .filter(kind => NOTIFICATION_GROUP_KINDS.includes(kind));
  } catch {
    return [];
  }
}

function parseGroupContent(value) {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function rowToGroup(row) {
  if (!row) {return null;}
  return {
    guildId: row.guild_id,
    groupId: row.group_id,
    name: row.name,
    title: row.title ?? null,
    details: row.details ?? null,
    thumbnailUrl: row.thumbnail_url ?? null,
    windowMinutes: row.window_minutes ?? 60,
    discordChannelId: row.discord_channel_id ?? null,
    customMessage: row.custom_message ?? null,
    mentionRoles: parseMentionIds(row.mention_roles),
    mentionUsers: parseMentionIds(row.mention_users),
    showCreatorOnEdit: Boolean(row.show_creator_on_edit),
    allowedKinds: parseGroupKinds(row.allowed_kinds),
    allowMultiplePerChannel: Boolean(row.allow_multiple_per_channel)
  };
}

export function getGuildGroups(guildId) {
  return getDB().prepare(`
    SELECT * FROM notification_groups
    WHERE guild_id = ?
    ORDER BY name ASC
  `).all(guildId).map(rowToGroup);
}

export function findGroup(guildId, groupId) {
  return rowToGroup(getDB().prepare(`
    SELECT * FROM notification_groups
    WHERE guild_id = ? AND group_id = ?
  `).get(guildId, groupId));
}

export function findGroupByChannel(guildId, channelId, excludeGroupId = null) {
  const rows = getDB().prepare(`
    SELECT * FROM notification_groups
    WHERE guild_id = ? AND group_id != ?
  `).all(guildId, excludeGroupId ?? "");

  const target = String(channelId ?? "");

  return rowToGroup(rows.find(row =>
    target
      ? row.discord_channel_id === target
      : !row.discord_channel_id
  ));
}

export function createGroup(guildId, name = "New group", discordChannelId = null) {
  const groupId = `g_${Date.now().toString(36)}`;
  const cleanName = String(name ?? "").trim().slice(0, 100) || "New group";

  getDB().prepare(`
    INSERT INTO notification_groups (
      guild_id, group_id, name, discord_channel_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(guildId, groupId, cleanName, discordChannelId || null);

  return findGroup(guildId, groupId);
}

export function updateGroup(guildId, groupId, patch = {}) {
  const columns = [];
  const values = [];

  for (const [key, column] of Object.entries(GROUP_FIELDS)) {
    if (!Object.hasOwn(patch, key)) {continue;}

    let value = patch[key];

    if (key === "mentionRoles" || key === "mentionUsers") {
      value = JSON.stringify(cleanMentionIds(value));
    } else if (key === "allowedKinds") {
      value = JSON.stringify(
        (Array.isArray(value) ? value : [])
          .map(kind => String(kind))
          .filter(kind => NOTIFICATION_GROUP_KINDS.includes(kind))
      );
    } else if (key === "showCreatorOnEdit" || key === "allowMultiplePerChannel") {
      value = value ? 1 : 0;
    } else if (key === "windowMinutes") {
      value = Math.max(1, Math.min(10080, Number(value) || 60));
    } else if (key === "name") {
      value = String(value ?? "").trim().slice(0, 100) || "New group";
    } else if (key === "discordChannelId") {
      value = value || null;
    } else {
      value = value == null || value === "" ? null : String(value).slice(0, 2000);
    }

    columns.push(`${column} = ?`);
    values.push(value);
  }

  if (columns.length) {
    columns.push("updated_at = CURRENT_TIMESTAMP");
    getDB().prepare(`
      UPDATE notification_groups
      SET ${columns.join(", ")}
      WHERE guild_id = ? AND group_id = ?
    `).run(...values, guildId, groupId);
  }

  return findGroup(guildId, groupId);
}

export function deleteGroup(guildId, groupId) {
  return getDB().prepare(`
    DELETE FROM notification_groups
    WHERE guild_id = ? AND group_id = ?
  `).run(guildId, groupId).changes > 0;
}

export function getGroupMembers(guildId, groupId) {
  return getDB().prepare(`
    SELECT platform, channel_id FROM notification_group_members
    WHERE guild_id = ? AND group_id = ?
    ORDER BY platform ASC, channel_id ASC
  `).all(guildId, groupId).map(row => ({
    platform: row.platform,
    channelId: row.channel_id
  }));
}

export function setGroupMembers(guildId, groupId, members = []) {
  const db = getDB();
  const clean = [];
  const seen = new Set();

  for (const member of members) {
    const platform = normalizePlatform(member?.platform);
    const channelId = String(member?.channelId ?? "");
    const key = `${platform}:${channelId}`;

    if (!channelId || seen.has(key)) {continue;}
    seen.add(key);
    clean.push({platform, channelId});
  }

  db.transaction(() => {
    db.prepare(`
      DELETE FROM notification_group_members
      WHERE guild_id = ? AND group_id = ?
    `).run(guildId, groupId);

    const insert = db.prepare(`
      INSERT OR IGNORE INTO notification_group_members
        (guild_id, group_id, platform, channel_id, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    for (const member of clean) {
      insert.run(guildId, groupId, member.platform, member.channelId);
    }
  })();

  return clean;
}

export function getGroupsForChannel(guildId, platform, channelId) {
  return getDB().prepare(`
    SELECT groups.* FROM notification_groups AS groups
    INNER JOIN notification_group_members AS members
      ON members.guild_id = groups.guild_id
     AND members.group_id = groups.group_id
    WHERE groups.guild_id = ?
      AND members.platform = ?
      AND members.channel_id = ?
    ORDER BY groups.name ASC
  `).all(guildId, normalizePlatform(platform), String(channelId)).map(rowToGroup);
}

function getGroupActivities(guildId, groupId, cutoff) {
  return getDB().prepare(`
    SELECT * FROM notification_group_activity
    WHERE guild_id = ? AND group_id = ? AND seen_at >= ?
    ORDER BY seen_at ASC
  `).all(guildId, groupId, cutoff).map(row => ({
    guildId: row.guild_id,
    groupId: row.group_id,
    platform: row.platform,
    channelId: row.channel_id,
    contentId: row.content_id,
    kind: row.kind,
    nickname: row.nickname,
    data: parseGroupContent(row.content_json),
    batchKey: row.batch_key,
    seenAt: row.seen_at
  }));
}

function upsertGroupActivity(activity) {
  getDB().prepare(`
    INSERT INTO notification_group_activity (
      guild_id, group_id, platform, channel_id, content_id, kind,
      nickname, content_json, batch_key, seen_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)

    ON CONFLICT(guild_id, group_id, platform, channel_id, content_id, kind) DO UPDATE SET
      nickname = excluded.nickname,
      content_json = excluded.content_json,
      batch_key = excluded.batch_key,
      seen_at = excluded.seen_at,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    activity.guildId,
    activity.groupId,
    activity.platform,
    activity.channelId,
    activity.contentId,
    activity.kind,
    activity.nickname,
    JSON.stringify(activity.data),
    activity.batchKey,
    activity.seenAt
  );
}

function getGroupMessage(guildId, groupId, batchKey, channelId) {
  return getDB().prepare(`
    SELECT * FROM notification_group_messages
    WHERE guild_id = ? AND group_id = ? AND batch_key = ? AND discord_channel_id = ?
  `).get(guildId, groupId, batchKey, channelId) ?? null;
}

function saveGroupMessage(guildId, groupId, batchKey, kind, channelId, messageId, seenAt) {
  getDB().prepare(`
    INSERT INTO notification_group_messages (
      guild_id, group_id, batch_key, kind, discord_channel_id, discord_message_id,
      seen_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)

    ON CONFLICT(guild_id, group_id, batch_key, kind, discord_channel_id) DO UPDATE SET
      discord_message_id = excluded.discord_message_id,
      seen_at = excluded.seen_at,
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, groupId, batchKey, kind, channelId, messageId, seenAt);
}

function getStoredMessage(guildId,platform,contentId,eventType) {
  const db = getDB();
  return db.prepare(`
    SELECT
      guild_id,
      platform,
      content_id,
      event_type,
      discord_channel_id,
      discord_message_id,
      creator_channel_id,
      content_title,
      created_at,
      updated_at
    FROM notification_messages
    WHERE guild_id = ?
      AND platform = ?
      AND content_id = ?
      AND event_type = ?
  `).get(guildId,platform,contentId,eventType) ?? null;
}
function saveStoredMessage(guildId,platform,contentId,eventType,channelId,messageId,resetTracking = false,creatorChannelId = null,contentTitle = null) {
  const db = getDB();
  db.prepare(`
    INSERT INTO notification_messages (
      guild_id,
      platform,
      content_id,
      event_type,
      discord_channel_id,
      discord_message_id,
      creator_channel_id,
      content_title,
      created_at,
      updated_at
    )
    VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )

    ON CONFLICT(
      guild_id,
      platform,
      content_id,
      event_type
    ) DO UPDATE SET
      discord_channel_id =
        excluded.discord_channel_id,
      discord_message_id =
        excluded.discord_message_id,
      creator_channel_id =
        excluded.creator_channel_id,
      content_title =
        excluded.content_title,
      created_at =
        CASE WHEN ? = 1
          THEN CURRENT_TIMESTAMP
          ELSE notification_messages.created_at
        END,
      updated_at =
        CURRENT_TIMESTAMP
  `).run(guildId,platform,contentId,eventType,channelId,messageId,creatorChannelId,contentTitle,resetTracking ? 1 : 0);
}
function deleteStoredMessage(guildId,platform,contentId,eventType) {
  const db = getDB();
  db.prepare(`
    DELETE FROM notification_messages
    WHERE guild_id = ?
      AND platform = ?
      AND content_id = ?
      AND event_type = ?
  `).run(guildId,platform,contentId,eventType);
}
function isSameStream(row, content) {
  const rowChannelId = String(row.creator_channel_id ?? "");
  const contentChannelId = String(content.channelId ?? "");
  if (!rowChannelId || rowChannelId !== contentChannelId) {return false;}
  const trackingId = getTrackingContentId(content);
  if (row.content_id && String(row.content_id) === String(trackingId)) {return true;}
  const rowTitle = String(row.content_title ?? "");
  const contentTitle = String(content.title ?? "");
  return Boolean(rowTitle) && rowTitle === contentTitle;
}

async function findReusableMessage(guild,content,subscription) {
  const hours = getNotificationDedupeHours(guild.id);
  if (hours <= 0) {return null;}
  const cutoff = toSqlTimestamp(Date.now() - hours * 60 * 60 * 1000);
  const rows = getDB().prepare(`
    SELECT
      guild_id,
      platform,
      content_id,
      event_type,
      discord_channel_id,
      discord_message_id,
      creator_channel_id,
      content_title,
      created_at,
      updated_at
    FROM notification_messages
    WHERE guild_id = ?
      AND creator_channel_id = ?
      AND created_at >= ?
    ORDER BY created_at DESC, updated_at DESC
  `).all(guild.id,String(content.channelId ?? ""),cutoff);
  const row = rows.find(candidate => isSameStream(candidate, content));
  if (!row) {return null;}
  const channel = await resolveNotificationChannel(guild, subscription);
  if (!channel || channel.id !== row.discord_channel_id) {return null;}
  const latest = await channel.messages.fetch({limit: 1}).catch(() => null);
  const latestMessage = latest?.first() ?? null;
  if (!latestMessage || latestMessage.id !== row.discord_message_id) {return null;}
  return {row, message: latestMessage};
}
async function editReusableMessage(guild,content,eventType,subscription,reusable) {
  const messageOptions = subscription.resolvedConfig ?? getNotificationMessageOptions(guild.id,content.platform,content.channelId);
  await reusable.message.edit({content:buildMessageContent(content,subscription,messageOptions,true), embeds: [buildNotificationEmbed(content)]});
  const trackingId = getTrackingContentId(content);
  const oldKey = [guild.id, reusable.row.platform, reusable.row.content_id, reusable.row.event_type];
  const newKey = [guild.id, content.platform, trackingId, eventType];
  const keysMatch = oldKey[0] === newKey[0] && oldKey[1] === newKey[1] && String(oldKey[2]) === String(newKey[2]) && oldKey[3] === newKey[3];
  const db = getDB();
  db.transaction(() => {
    if (!keysMatch) {
      db.prepare(`
        DELETE FROM notification_messages
        WHERE guild_id = ?
          AND platform = ?
          AND content_id = ?
          AND event_type = ?
      `).run(...newKey);
    }
    db.prepare(`
      UPDATE notification_messages
      SET
        event_type = ?,
        content_id = ?,
        content_title = ?,
        creator_channel_id = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ?
        AND platform = ?
        AND content_id = ?
        AND event_type = ?
    `).run(eventType,trackingId,content.title ?? null,String(content.channelId ?? ""),...oldKey);
  })();
  return reusable.message;
}

export function getGuildSubscriptions(guildId,platform = null) {
  const db = getDB();
  const platforms = platform ? [normalizePlatform(platform)] : PLATFORM_KEYS;
  const subscriptions = [];
  for (const currentPlatform of platforms) {
    const subscriptionTable = getSubscriptionTable(currentPlatform);
    const channelTable = getChannelTable(currentPlatform);
    const rows = db.prepare(`
      SELECT
        subscriptions.guild_id,
        subscriptions.channel_id,
        subscriptions.nickname,
        subscriptions.discord_channel_id,
        subscriptions.custom_message,
        channels.channel_name,
        channels.channel_url,
        channels.channel_handle
      FROM ${subscriptionTable}
        AS subscriptions
      INNER JOIN ${channelTable}
        AS channels
        ON channels.channel_id =
          subscriptions.channel_id
      WHERE subscriptions.guild_id = ?
      ORDER BY
        channels.channel_name ASC
    `).all(guildId);
    for (const row of rows) {subscriptions.push({
      platform:currentPlatform, guildId:row.guild_id, channelId:row.channel_id,
      nickname:row.nickname, discordChannelId:row.discord_channel_id,
      customMessage:row.custom_message, channelName:row.channel_name,
      channelUrl:row.channel_url, channelHandle:row.channel_handle
    });}
  } return subscriptions;
}
export function findGuildSubscription(guildId,nickname,platform) {
  if (!platform) {return null;}
  const normalizedNickname = String(nickname ?? "").trim().toLowerCase();
  if (!normalizedNickname) {return null;}
  return (getGuildSubscriptions(guildId,platform).find(subscription => subscription.nickname ?.toLowerCase() === normalizedNickname) ?? null);
}

export async function addSubscription(guildId,platform,input,nickname,discordChannelId = null,customMessage = null) {
  const capacity = entitlements.canAddSubscription(guildId,platform);
  if (!capacity.allowed) {return {success: false, reason: "entitlement-limit", usage: capacity.usage, limit: capacity.limit};}
  const key = normalizePlatform(platform);
  const platformModule = getPlatformModule(key);
  const channel = await platformModule.resolveAndSaveChannel(input);
  if (!channel) {return {success: false, reason: "not-found"};}
  const db = getDB();
  const table = getSubscriptionTable(key);
  const result = db.prepare(`
    INSERT OR IGNORE INTO ${table} (
      guild_id,
      channel_id,
      nickname,
      discord_channel_id,
      custom_message,
      created_at,
      updated_at
    )
    VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
  `).run(guildId,channel.channel_id,nickname,discordChannelId,customMessage);
  if (result.changes === 0) {return {success: false, reason: "already-exists", channel};}
  if (key === "youtube") {await youtube.initializeChannel(channel.channel_id);}
  return {success: true, channel};
}

export function deleteSubscription(guildId,nickname,platform) {
  const subscription = findGuildSubscription(guildId,nickname,platform);
  if (!subscription) {return {success: false, reason: "not-found"};}
  const db = getDB();
  const table = getSubscriptionTable(subscription.platform);
  const result = db.prepare(`
    DELETE FROM ${table}
    WHERE guild_id = ?
      AND channel_id = ?
  `).run(guildId,subscription.channelId);
  if (result.changes > 0) {
    getDB().prepare(`
      DELETE FROM notification_message_options
      WHERE guild_id = ?
        AND platform = ?
        AND channel_id = ?
    `).run(
      guildId,
      subscription.platform,
      subscription.channelId
    );
    getDB().prepare(`
      DELETE FROM notification_configs
      WHERE guild_id = ?
        AND scope = 'creator'
        AND scope_key = ?
    `).run(
      guildId,
      `${subscription.platform}:${subscription.channelId}`
    );
    getDB().prepare(`
      DELETE FROM notification_group_members
      WHERE guild_id = ?
        AND platform = ?
        AND channel_id = ?
    `).run(
      guildId,
      subscription.platform,
      subscription.channelId
    );
  }

  return {
    success:
      result.changes > 0,

    subscription
  };
}
export function editSubscription(guildId,nickname,platform,newNickname) {
  const subscription = findGuildSubscription(guildId,nickname,platform);
  if (!subscription) {return {success: false, reason: "not-found"};}
  const db = getDB();
  const table = getSubscriptionTable(subscription.platform);
  try {db.prepare(`
    UPDATE ${table}
    SET
      nickname = ?,
      updated_at =
        CURRENT_TIMESTAMP
    WHERE guild_id = ?
      AND channel_id = ?
  `).run(newNickname,guildId,subscription.channelId);
  } catch (error) {if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") {return {success: false, reason: "nickname-exists"};} throw error;}
  return {success: true, subscription: {...subscription,nickname: newNickname}};
}
export function setSubscriptionMessage(guildId,nickname,platform,customMessage) {
  const subscription = findGuildSubscription(guildId,nickname,platform);
  if (!subscription) {return {success: false,reason: "not-found"};}
  const db = getDB();
  const table = getSubscriptionTable(platform);
  db.prepare(`
    UPDATE ${table}
    SET
      custom_message = ?,
      updated_at =
        CURRENT_TIMESTAMP
    WHERE guild_id = ?
      AND channel_id = ?
  `).run(customMessage,guildId,subscription.channelId);
  return {success: true,subscription: {...subscription,customMessage}};
}
export function setSubscriptionChannel(guildId,nickname,platform,discordChannelId) {
  const subscription = findGuildSubscription(guildId,nickname,platform);
  if (!subscription) {return {success: false,reason: "not-found"};}
  const db = getDB();
  const table = getSubscriptionTable(platform);
  db.prepare(`
    UPDATE ${table}
    SET
      discord_channel_id = ?,
      updated_at =
        CURRENT_TIMESTAMP
    WHERE guild_id = ?
      AND channel_id = ?
  `).run(discordChannelId,guildId,subscription.channelId);
  return {success: true,subscription: {...subscription,discordChannelId}};
}

function getSubscribedGuilds(platform,channelId) {return getPlatformModule(platform).getSubscribedGuilds(channelId);}
async function getGuild(client,guildId) {return (client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null));}

async function getExistingDiscordMessage(guild,storedMessage) {
  if (!storedMessage) {return null;}
  const channel = guild.channels.cache.get(storedMessage.discord_channel_id) ?? await guild.channels.fetch(storedMessage.discord_channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) {return null;}
  const message = await channel.messages.fetch(storedMessage.discord_message_id).catch(() => null);
  if (!message) {return null;}
  return {channel,message};
}
async function resolveNotificationChannel(guild,subscription) {
  let notificationChannel = null;
  if (subscription.discordChannelId) {notificationChannel = guild.channels.cache.get(subscription.discordChannelId) ?? await guild.channels.fetch(subscription.discordChannelId).catch(() => null);}
  if (!notificationChannel || !notificationChannel.isTextBased()) {notificationChannel = await channelManager.ensureChannel(guild,"notifications");}
  if (!notificationChannel || !notificationChannel.isTextBased()) {return null;}
  return notificationChannel;
}
async function sendNewNotification(guild,content,eventType,subscription,resetTracking = false) {
  const notificationChannel = await resolveNotificationChannel(guild,subscription);
  if (!notificationChannel) {return null;}
  const messageOptions =
    subscription.resolvedConfig ??
    getNotificationMessageOptions(
      guild.id,
      content.platform,
      content.channelId
    );

  const message =
    await notificationChannel.send({
      content:
        buildMessageContent(
          content,
          subscription,
          messageOptions
        ),

      embeds: [
        buildNotificationEmbed(
          content
        )
      ]
    });
    saveStoredMessage(guild.id,content.platform,getTrackingContentId(content),eventType,notificationChannel.id,message.id,resetTracking,String(content.channelId ?? ""),content.title ?? null);
  return message;
}
async function editExistingNotification(guild,content,eventType,subscription) {
  const storedMessage = getStoredMessage(guild.id,content.platform,getTrackingContentId(content),eventType);
  if (!storedMessage) {return null;}
  const existing = await getExistingDiscordMessage(guild,storedMessage);
  if (!existing) {deleteStoredMessage(guild.id,content.platform,getTrackingContentId(content),eventType); return null;}
  const messageOptions = subscription.resolvedConfig ?? getNotificationMessageOptions(guild.id,content.platform,content.channelId);
  await existing.message.edit({content:buildMessageContent(content,subscription,messageOptions,true), embeds: [buildNotificationEmbed(content)]});
  return existing.message;
}
async function sendOrUpdateGuildNotification(client,guildId,content,changes,subscription) {
  const eventType = getNotificationEventType(content,changes);
  const guild = await getGuild(client,guildId);
  if (!guild) {console.warn(`Cannot send notification: guild ${guildId} was not found.`); return null;}
  const memberGroups =
    getGroupsForChannel(
      guildId,
      content.platform,
      subscription.channelId ?? content.channelId
    );

  const destinationChannelId =
    subscription.discordChannelId ?? null;

  const memberGroup =
    memberGroups.find(group =>
      destinationChannelId
        ? group.discordChannelId === destinationChannelId
        : !group.discordChannelId
    ) ?? null;

  subscription.resolvedConfig =
    resolveNotificationConfig(
      guildId,
      {
        platform:content.platform,
        channelId:subscription.channelId ?? content.channelId,
        groupId:memberGroup?.groupId ?? null,
        isGroupPost:false
      }
    );
  const storedMessage = getStoredMessage(guildId,content.platform,getTrackingContentId(content),eventType);
  if (storedMessage && !(content.platform === "kick" && changes?.isNew)) {const edited = await editExistingNotification(guild,content,eventType,subscription); if (edited) {return {action: "edited",message: edited};}}
  const forceNew = content.platform === "kick" && Boolean(changes?.isNew);
  if (!forceNew) {const reusable = await findReusableMessage(guild,content,subscription); if (reusable) {const edited = await editReusableMessage(guild,content,eventType,subscription,reusable); if (edited) {return {action: "edited",message: edited};}}}
  if (changes?.ended) return null;
  const isNewAnnouncement = changes?.isNew || changes?.wentLive || changes?.reconnected;
  if (!isNewAnnouncement) return null;
  const sent = await sendNewNotification(guild,content,eventType,subscription,content.platform === "kick" && Boolean(changes?.isNew));
  if (!sent) {return null;}
  return {action: "sent",message: sent};
}

/*
=====================================================
Group Announcement
=====================================================
*/

function buildGroupAnnouncement(group, activities, config = null) {
  const items = activities.map(activity => ({
    ...activity,
    name: activity.data.channelName || activity.nickname || "Creator"
  }));

  const names = items.map(item => item.name);
  const titles = items.map(item => item.data.title).filter(Boolean);

  const fill = text => String(text ?? "")
    .replaceAll("{creators}", names.join(", "))
    .replaceAll("{count}", String(items.length))
    .replaceAll("{titles}", titles.join(", "));

  const active = config ?? {
    customMessage:group.customMessage,
    mentionRoles:group.mentionRoles,
    mentionUsers:group.mentionUsers,
    showCreatorOnEdit:group.showCreatorOnEdit
  };

  let content = fill(active.customMessage) ||
    `${names.join(", ")} — ${items.length} update${items.length === 1 ? "" : "s"}.`;

  const mentions = [
    ...active.mentionRoles.map(id => `<@&${id}>`),
    ...active.mentionUsers.map(id => `<@${id}>`)
  ].join(" ");

  if (mentions) {content = `${mentions} ${content}`;}

  const embed = new discord.EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(fill(group.title) || names.join(", "))
    .addFields(items.map(item => {
      const title = item.data.title || "View content";
      const label = item.data.isEnded ? `~~${title}~~` : title;
      const status = item.data.isEnded
        ? " — ended"
        : item.data.isLive
          ? " — live"
          : item.data.isScheduled
            ? " — scheduled"
            : "";

      return {
        name: `${item.name} — ${PLATFORM_NAMES[item.platform] ?? item.platform}`,
        value: `[${label}](${item.data.url || "#"})${status}`,
        inline: false
      };
    }))
    .setFooter({text:`BargazBot • ${items.length} creator${items.length === 1 ? "" : "s"}`})
    .setTimestamp();

  const details = fill(group.details);
  if (details) {embed.setDescription(details.slice(0, 4000));}

  const thumbnail =
    group.thumbnailUrl ||
    items.find(item => item.data.thumbnail)?.data.thumbnail;

  if (thumbnail) {embed.setThumbnail(thumbnail);}

  return {content, embeds:[embed]};
}

async function handleGroupAnnouncement(client, guildId, group, subscription, content, changes) {
  const kind = getNotificationEventType(content, changes);
  const now = Date.now();
  const cutoff = now - Math.max(1, group.windowMinutes) * 60 * 1000;

  const recent = getGroupActivities(guildId, group.groupId, cutoff);
  const sameKindOnly = group.allowedKinds.length === 0;

  let candidates = recent.filter(activity =>
    sameKindOnly
      ? activity.kind === kind
      : group.allowedKinds.includes(activity.kind)
  );

  if (!group.allowMultiplePerChannel) {
    candidates = candidates.filter(activity =>
      !(
        activity.platform === content.platform &&
        String(activity.channelId) === String(content.channelId)
      )
    );
  }

  const batchKey = candidates[0]?.batchKey ?? String(now);

  const data = {
    title: content.title ?? "",
    url: content.url ?? "",
    channelName: content.channelName ?? subscription.nickname ?? "Creator",
    thumbnail: content.thumbnail ?? null,
    isLive: Boolean(content.isLive),
    isScheduled: Boolean(content.isScheduled),
    isEnded: Boolean(content.isEnded)
  };

  upsertGroupActivity({
    guildId,
    groupId: group.groupId,
    platform: content.platform,
    channelId: String(content.channelId),
    contentId: getTrackingContentId(content),
    kind,
    nickname: subscription.nickname,
    data,
    batchKey,
    seenAt: now
  });

  const activities = getGroupActivities(guildId, group.groupId, cutoff)
    .filter(activity => activity.batchKey === batchKey);

  const guild = await getGuild(client, guildId);
  if (!guild) {return null;}

  const channel = await resolveNotificationChannel(guild, {
    discordChannelId: group.discordChannelId
  });

  if (!channel) {return null;}

  const config =
    resolveNotificationConfig(
      guildId,
      {
        platform:content.platform,
        channelId:content.channelId,
        groupId:group.groupId,
        isGroupPost:true
      }
    );

  const payload = buildGroupAnnouncement(group, activities, config);
  const stored = getGroupMessage(guildId, group.groupId, batchKey, channel.id);

  if (stored) {
    const existing = await channel.messages.fetch(stored.discord_message_id).catch(() => null);

    if (existing) {
      const lastId = channel.lastMessageId ??
        (await channel.messages.fetch({limit:1}).catch(() => null))?.first()?.id;

      if (lastId === existing.id) {
        await existing.edit(payload);
        saveGroupMessage(
          guildId,
          group.groupId,
          batchKey,
          stored.kind,
          channel.id,
          existing.id,
          now
        );

        return {action:"edited", message:existing};
      }
    }
  }

  const message = await channel.send(payload);

  saveGroupMessage(
    guildId,
    group.groupId,
    batchKey,
    kind,
    channel.id,
    message.id,
    now
  );

  return {action:"sent", message};
}

export async function broadcastContent(client,content,changes = {}) {
  const subscriptions = getSubscribedGuilds(content.platform,content.channelId);
  const results = [];
  for (const subscription of subscriptions) {
    try {
      const mapped = {
        discordChannelId:
          subscription.discord_channel_id ??
          null,

        customMessage:
          subscription.custom_message ??
          null,

        nickname:
          subscription.nickname ??
          null,

        channelId:
          subscription.channel_id ??
          null
      };

      const groups =
        getGroupsForChannel(
          subscription.guild_id,
          content.platform,
          subscription.channel_id
        );

      const result =
        await sendOrUpdateGuildNotification(
          client,
          subscription.guild_id,
          content,
          changes,
          mapped
        );

      for (const group of groups) {
        try {
          await handleGroupAnnouncement(
            client,
            subscription.guild_id,
            group,
            mapped,
            content,
            changes
          );
        } catch (error) {
          console.error(
            `Failed group ${group.groupId} announcement for guild ${subscription.guild_id}:`,
            error
          );
        }
      }

      results.push({guildId:subscription.guild_id, success:Boolean(result), action:result?.action ?? null, messageId:result?.message?.id ?? null});
    } catch (error) {
      console.error(`Failed to process ${content.platform} notification for guild ${subscription.guild_id}:`, error);
      results.push({guildId:subscription.guild_id, success: false, action: null, messageId: null});
    }
  } return results;
}
export async function processResult(client,result) {
  if (!result || !result.content || !result.changes) {return [];}
  const {content,changes} = result;
  const shouldProcess = changes.isNew || changes.wentLive || changes.ended || changes.reconnected || changes.titleChanged || changes.thumbnailChanged || changes.scheduleChanged || changes.endedChanged;
  if (!shouldProcess) {return [];}
  return broadcastContent(client,content,changes);
}
export async function processYouTubeResults(client,results) {
  const output = [];
  for (const result of results ?? []) {output.push(...(await processResult(client,result)));}
  return output;
}

function reserveRefresh(guildId,platform) {
  const db = getDB();
  const now = Date.now();
  const cutoff = now - REFRESH_WINDOW_MS;
  return db.transaction(() => {
    db.prepare(`DELETE FROM notification_refresh_usage WHERE used_at <= ?`).run(cutoff);
    const usage = db.prepare(`
      SELECT COUNT(*) AS count, MIN(used_at) AS oldest
      FROM notification_refresh_usage
      WHERE guild_id = ? AND platform = ?
    `).get(guildId,platform);
    if (usage.count >= DEFAULT_REFRESH_LIMIT) {return {allowed:false, remaining:0, retryAt:usage.oldest + REFRESH_WINDOW_MS};}
    const result = db.prepare(`
      INSERT INTO notification_refresh_usage (guild_id,platform,used_at)
      VALUES (?,?,?)
    `).run(guildId,platform,now);
    return {allowed:true, usageId:result.lastInsertRowid, remaining:DEFAULT_REFRESH_LIMIT - usage.count - 1};
  })();
}

function releaseRefresh(usageId) {getDB().prepare(`DELETE FROM notification_refresh_usage WHERE id = ?`).run(usageId);}

function getNewestRefreshResult(results,channelId) {
  const eligible = results.filter(result => result?.content?.id && String(result.content.channelId) === String(channelId) && !result.content.isEnded);
  const getTime = content => {
    const value = content.actualStartTime ?? content.startedAt ?? content.publishedAt ?? content.scheduledStartTime ?? content.discoveredAt;
    const timestamp = value ? Date.parse(value) : 0;
    return Number.isFinite(timestamp) ? timestamp : 0;
  };
  eligible.sort((a,b) => Number(Boolean(b.content.isLive)) - Number(Boolean(a.content.isLive)) || getTime(b.content) - getTime(a.content));
  return eligible[0] ?? null;
}

export async function refreshSubscription(client,guildId,nickname,platform) {
  const subscription = findGuildSubscription(guildId,nickname,platform);
  if (!subscription) return {success:false,reason:"not-found"};
  const key = subscription.platform;
  const platformModule = getPlatformModule(key);
  const allowance = reserveRefresh(guildId,key);
  if (!allowance.allowed) {return {success:false,reason:"refresh-limit",remaining:0,retryAt:allowance.retryAt};}
  let messagePosted = false;
  try {
    let refreshResult = null;
    if (typeof platformModule.refreshChannel === "function") {refreshResult = await platformModule.refreshChannel(subscription.channelId);} 
    else if (typeof platformModule.checkChannel === "function") {refreshResult = await platformModule.checkChannel(subscription.channelId);} 
    else if (typeof platformModule.checkChannels === "function") {refreshResult = await platformModule.checkChannels([subscription.channelId]);} 
    else if (typeof platformModule.pollChannel === "function") {refreshResult = await platformModule.pollChannel(subscription.channelId);} 
    else {throw new Error(`No refresh function available for ${key}`);}
    const results = Array.isArray(refreshResult)?refreshResult:refreshResult?[refreshResult]:[];
    const result = getNewestRefreshResult(results,subscription.channelId);
    if (!result) {releaseRefresh(allowance.usageId); return {success:false,reason:"no-content",subscription};}
    const content = result.content;
    const guild = await getGuild(client,guildId);
    if (!guild) {releaseRefresh(allowance.usageId); return {success:false,reason:"guild-unavailable",subscription};}
    const eventType = getNotificationEventType(content,result.changes ?? {});
    const message = await sendNewNotification(guild,content,eventType,subscription,true);
    if (!message) {releaseRefresh(allowance.usageId); return {success:false,reason:"channel-unavailable",subscription};}
    messagePosted = true;
    return {success:true,subscription,content,messageId:message.id,remaining:allowance.remaining,results};
  } catch (error) {
    if (!messagePosted) releaseRefresh(allowance.usageId);
    console.error(`Manual ${key} refresh failed for guild ${guildId}:`,error);
    return {success:false,reason:"refresh-error",subscription};
  }
}

export async function manualRefresh(client,guildId,nickname,platform) {return refreshSubscription(client,guildId,nickname,platform);}