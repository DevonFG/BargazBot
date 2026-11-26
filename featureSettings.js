import * as discord      from "discord.js";
import * as log          from "./appLogger.js";
import * as guildLogger  from "./guildLogger.js";
import * as storage      from "./storage.js";

const {
  FEATURE_KEYS,
  FEATURE_DEFAULTS,
  getFeatureSetting,
  setFeatureSetting,
  setAllFeatureResponseTypes,
  getCommandResponseType,
  setCommandResponseType,
  setGuildWelcomeMessage,
  getGuildWelcomeOptions,
  setGuildWelcomeOptions,
  getGuildGoodbyeMessage,
  setGuildGoodbyeMessage,
  getGuildGoodbyeOptions,
  setGuildGoodbyeOptions,
  getUserDmSettings,
  setUserDmSetting,
  clearUserDmSettings,
  getUserDmSubscriptions,
  addUserDmSubscription,
  removeUserDmSubscription,
  emptyUserDmConfig,
  getUserDmConfig,
  setUserDmConfig,
  getFeatureConfig,
  setFeatureConfig,
  patchFeatureConfig
} = storage;

export {
  FEATURE_KEYS,
  FEATURE_DEFAULTS,
  getFeatureSettings,
  getFeatureSetting,
  setFeatureSetting,
  getCommandResponseType,
  getGuildWelcomeMessage,
  getGuildWelcomeOptions,
  getGuildGoodbyeMessage,
  getGuildGoodbyeOptions,
  getUserDmSettings,
  getUserDmSubscriptions,
  emptyUserDmConfig,
  getUserDmConfig,
  getGuildTimezone,
  setGuildTimezone,
  getPrivacyNoticeChannel,
  savePrivacyNoticeChannel,
  isGuildSetupComplete,
  markGuildSetupComplete,
  countDmEnabledUsers,
  resetGuildSetup,
  getFeatureConfig,
  setFeatureConfig,
  patchFeatureConfig
} from "./storage.js";

const RESPONSE_ALIASES        = {test:"notifications"};
const NO_RESPONSE_FEATURES    = new Set(["autopublish", "feedback"]);
const FIXED_MESSAGE_FEATURES  = new Set(["logs", "inactivity"]);

const FEATURE_CONFIG_DEFAULTS = {
  "reaction-roles":   {style:"reactions", wrapCode:true, maxOptions:20, toggleDefault:true},
  verification:       {mode:1, roleId:null, roleIds:[], createRole:true, permissionPreset:"none", channelIds:[], botDetectionChannelId:null, botAction:"kick", hideAfterVerify:true, explainBot:false, deleteTriggerMessage:false},
  tickets:            {transcriptEnabled:true, transcriptChannelId:null, defaultContainer:"thread", nameTemplate:"{user}-{count}", categories:[]},
  navigation:         {autoUpdate:true, useTopics:true, omitEmpty:true, title:"Server navigation", description:"", channels:[]},
  "auto-mod":         {rules:{}, warnDm:true, warnChannel:true, ignoredRoleIds:[], ignoredUserIds:[], channelIds:[]},
  "audit-monitor":    {enabled:false, events:[]},
  "social-counters":  {refreshEnabled:true, refreshIntervalMinutes:10, sources:[]},
  "role-rewards":     {recheckEnabled:true, recheckIntervalMinutes:10, manualOnly:false, autoRemoveOnly:true, triggers:[]},
  "account-linking":  {inServerOnly:true, providers:["youtube", "twitch", "kick"], publicFallback:true},
  webhooks:           {enabled:false, providers:["streamlabs", "streamelements", "patreon", "kofi"]}
};

function responseKey(feature) {return RESPONSE_ALIASES[feature] ?? feature;}

function logChange(target, action, detail = "") {
  log.info("BargazBot config change:", action, "target:", target ?? "dm", detail);
}

function configLog(guildId, actorId, action, detail = "", fields = null) {
  logChange(guildId, action, detail);
  if (!guildId) {return;}
  guildLogger.logConfigurationChange(guildId, {
    title:"BargazBot feature configuration changed",
    description:`A BargazBot configuration setting was changed${actorId ? ` by <@${actorId}>` : ""}.`,
    fields:Array.isArray(fields) && fields.length
      ? fields.slice(0, 25)
      : [
          {name:"Setting", value:action.slice(0, 1024), inline:true},
          ...(detail ? [{name:"Detail", value:detail.slice(0, 1024), inline:false}] : [])
        ]
  }).catch(() => {});
}

export function logFeatureConfigBatch(guildId, actorId, action, changes = []) {
  const lines = changes.filter(Boolean).slice(0, 20).map(change => `• ${String(change).slice(0, 120)}`);
  const detail = lines.join("\n") || "No changes.";
  configLog(guildId, actorId, action, detail, [
    {name:"Setting", value:action.slice(0, 1024), inline:true},
    {name:"Changes", value:detail.slice(0, 1024), inline:false}
  ]);
}

export function updateFeatureConfig(guildId, feature, patch, actorId = null, fallback = {}) {
  const result = patchFeatureConfig(guildId, feature, patch, fallback ?? FEATURE_CONFIG_DEFAULTS[feature] ?? {});
  const keys = Object.keys(patch ?? {}).join(", ") || "none";
  configLog(guildId, actorId, `feature config ${feature}`, `keys=${keys}`);
  return result;
}

export function getFeatureConfigWithDefaults(guildId, feature) {
  return getFeatureConfig(guildId, feature, FEATURE_CONFIG_DEFAULTS[feature] ?? {});
}

function configUpdater(feature) {
  return (guildId, patch = {}, actorId = null) =>
    updateFeatureConfig(guildId, feature, patch, actorId, FEATURE_CONFIG_DEFAULTS[feature] ?? {});
}

export const getReactionRoleConfig     = guildId => getFeatureConfigWithDefaults(guildId, "reaction-roles");
export const updateReactionRoleConfig  = configUpdater("reaction-roles");
export const getVerificationConfig     = guildId => getFeatureConfigWithDefaults(guildId, "verification");
export const updateVerificationConfig  = configUpdater("verification");
export const getTicketConfig           = guildId => getFeatureConfigWithDefaults(guildId, "tickets");
export const updateTicketConfig        = configUpdater("tickets");
export const getNavigationConfig       = guildId => getFeatureConfigWithDefaults(guildId, "navigation");
export const updateNavigationConfig    = configUpdater("navigation");
export const getAutoModConfig          = guildId => getFeatureConfigWithDefaults(guildId, "auto-mod");
export const updateAutoModConfig       = configUpdater("auto-mod");
export const getAuditMonitorConfig     = guildId => getFeatureConfigWithDefaults(guildId, "audit-monitor");
export const updateAuditMonitorConfig  = configUpdater("audit-monitor");
export const getSocialCounterConfig    = guildId => getFeatureConfigWithDefaults(guildId, "social-counters");
export const updateSocialCounterConfig = configUpdater("social-counters");
export const getRoleRewardConfig       = guildId => getFeatureConfigWithDefaults(guildId, "role-rewards");
export const updateRoleRewardConfig    = configUpdater("role-rewards");
export const getAccountLinkConfig      = guildId => getFeatureConfigWithDefaults(guildId, "account-linking");
export const updateAccountLinkConfig   = configUpdater("account-linking");
export const getWebhookConfig          = guildId => getFeatureConfigWithDefaults(guildId, "webhooks");
export const updateWebhookConfig       = configUpdater("webhooks");

// Feature state
export function isFeatureEnabled(guildId, feature) {return Boolean(getFeatureSetting(guildId, feature)?.enabled);}
export function getEnabledFeatures(guildId) {return FEATURE_KEYS.filter(feature => isFeatureEnabled(guildId, feature));}
export function usesPopup(feature) {return NO_RESPONSE_FEATURES.has(responseKey(feature));}

// Response types
export function getFeatureResponseType(guildId, feature) {
  const key = responseKey(feature);
  if (FIXED_MESSAGE_FEATURES.has(key)) {return "message";}
  return getFeatureSetting(guildId, key)?.responseType ?? getCommandResponseType(guildId);
}

export function shouldSendResponse(guildId, feature) {
  const key = responseKey(feature);
  if (NO_RESPONSE_FEATURES.has(key)) {return false;}
  return Boolean(getFeatureResponseType(guildId, key));
}

function replyOptionsFor(type) {return type === "ephemeral" ? {flags:discord.MessageFlags.Ephemeral} : {};}
export function getFeatureReplyOptions(guildId, feature) {return replyOptionsFor(getFeatureResponseType(guildId, feature));}
export function getCommandReplyOptions(guildId) {return replyOptionsFor(getCommandResponseType(guildId));}

export async function replyWithFeatureType(guildId, feature, interaction, payload) {
  if (!shouldSendResponse(guildId, feature)) {return null;}
  const options = {...payload, ...getFeatureReplyOptions(guildId, feature)};
  if (interaction.replied || interaction.deferred) {return interaction.followUp(options);}
  return interaction.reply(options);
}

// Logged config writers
export function setFeatureEnabled(guildId, feature, enabled, actorId = null) {
  const result = setFeatureSetting(guildId, feature, {enabled:Boolean(enabled)});
  if (result) {configLog(guildId, actorId, `feature ${feature}`, `enabled=${result.enabled}`);}
  return result;
}

export function setFeatureReplyType(guildId, feature, responseType, actorId = null) {
  const result = setFeatureSetting(guildId, feature, {responseType});
  if (result) {configLog(guildId, actorId, `response ${feature}`, `responseType=${result.responseType}`);}
  return result;
}

export function setAllFeatureToggles(guildId, enabled, actorId = null) {
  const value = Boolean(enabled);
  const features = FEATURE_KEYS.filter(feature => feature !== "dm");
  for (const feature of features) {setFeatureSetting(guildId, feature, {enabled:value});}
  configLog(guildId, actorId, "all feature toggles", `enabled=${value}; excluded=dm`);
  return value;
}

export function setAllFeatureReplyTypes(guildId, responseType, actorId = null) {
  const result = setAllFeatureResponseTypes(guildId, responseType);
  if (result) {configLog(guildId, actorId, "all feature response types", `responseType=${result}`);}
  return result;
}

export function updateCommandReplyType(guildId, responseType, actorId = null) {
  const result = setCommandResponseType(guildId, responseType);
  if (result) {configLog(guildId, actorId, "command default response", `responseType=${result}`);}
  return result;
}

export function updateGuildWelcomeMessage(guildId, message, actorId = null) {
  const result = setGuildWelcomeMessage(guildId, message);
  configLog(guildId, actorId, "welcome message", message ? "updated" : "cleared");
  return result;
}

export function updateGuildWelcomeOptions(guildId, options, actorId = null) {
  const result = setGuildWelcomeOptions(guildId, options);
  configLog(guildId, actorId, "welcome options", `keys=${Object.keys(options ?? {}).join(", ") || "none"}`);
  return result;
}

export function updateGuildGoodbyeMessage(guildId, message, actorId = null) {
  const result = setGuildGoodbyeMessage(guildId, message);
  configLog(guildId, actorId, "goodbye message", message ? "updated" : "cleared");
  return result;
}

export function updateGuildGoodbyeOptions(guildId, options, actorId = null) {
  const result = setGuildGoodbyeOptions(guildId, options);
  configLog(guildId, actorId, "goodbye options", `keys=${Object.keys(options ?? {}).join(", ") || "none"}`);
  return result;
}

export function resetFeatureSettings(guildId, actorId = null) {
  for (const [feature, defaults] of Object.entries(FEATURE_DEFAULTS)) {
    setFeatureSetting(guildId, feature, {enabled:defaults.enabled, responseType:defaults.responseType});
  }
  setCommandResponseType(guildId, "ephemeral");
  setGuildWelcomeMessage(guildId, null);
  setGuildGoodbyeMessage(guildId, null);
  setGuildWelcomeOptions(guildId, {});
  setGuildGoodbyeOptions(guildId, {});
  configLog(guildId, actorId, "feature settings reset");
}

// DM settings (per-user only)
export function canUseDmFeatures(userId) {return getUserDmSettings(userId).dmEnabled;}

export function updateUserDmSetting(userId, patch, actorId = null) {
  const result = setUserDmSetting(userId, patch);
  if (result) {logChange(userId, "dm setting", `${JSON.stringify(patch)} by=${actorId ?? "user"}`);}
  return result;
}

export function resetUserDmSettings(userId, actorId = null) {
  clearUserDmSettings(userId);
  logChange(userId, "dm settings cleared", `by=${actorId ?? "user"}`);
}

export function addDmSubscription(userId, platform, channelId, nickname = null, actorId = null) {
  const result = addUserDmSubscription(userId, platform, channelId, nickname);
  if (result) {logChange(userId, "dm subscription added", `${platform}:${channelId} by=${actorId ?? "user"}`);}
  return result;
}

export function removeDmSubscription(userId, platform, channelId, actorId = null) {
  const result = removeUserDmSubscription(userId, platform, channelId);
  if (result) {logChange(userId, "dm subscription removed", `${platform}:${channelId} by=${actorId ?? "user"}`);}
  return result;
}

export function updateUserDmConfig(userId, scope, scopeKey, patch, actorId = null) {
  const result = setUserDmConfig(userId, scope, scopeKey, patch);
  logChange(userId, `dm config ${scope}`, `key=${scopeKey ?? ""} by=${actorId ?? "user"}`);
  return result;
}
