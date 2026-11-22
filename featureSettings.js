import * as discord from "discord.js";

import * as log     from "./appLogger.js";
import * as storage from "./storage.js";

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
  setUserDmConfig
} = storage;

export {
  FEATURE_KEYS,
  FEATURE_DEFAULTS,
  getFeatureSettings,
  getFeatureSetting,
  getCommandResponseType,
  getGuildWelcomeMessage,
  getGuildWelcomeOptions,
  getGuildGoodbyeMessage,
  getGuildGoodbyeOptions,
  getUserDmSettings,
  getUserDmSubscriptions,
  emptyUserDmConfig,
  getUserDmConfig,
  getPrivacyNoticeChannel,
  savePrivacyNoticeChannel,
  isGuildSetupComplete,
  markGuildSetupComplete,
  resetGuildSetup
} from "./storage.js";

const RESPONSE_ALIASES        = {test:"notifications"};
const NO_RESPONSE_FEATURES    = new Set(["autopublish", "feedback"]);
const FIXED_MESSAGE_FEATURES  = new Set(["logs", "inactivity"]);

function responseKey(feature) {return RESPONSE_ALIASES[feature] ?? feature;}
function logChange(target, action, detail = "") {
  log.info("BargazBot config change:", action, "target:", target ?? "dm", detail);
}

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
  if (result) {logChange(guildId, `feature ${feature}`, `enabled=${result.enabled} by=${actorId ?? "unknown"}`);}
  return result;
}

export function setFeatureReplyType(guildId, feature, responseType, actorId = null) {
  const result = setFeatureSetting(guildId, feature, {responseType});
  if (result) {logChange(guildId, `response ${feature}`, `${result.responseType} by=${actorId ?? "unknown"}`);}
  return result;
}

export function setAllFeatureToggles(guildId, enabled, actorId = null) {
  const value = Boolean(enabled);
  for (const feature of FEATURE_KEYS) {setFeatureSetting(guildId, feature, {enabled:value});}
  logChange(guildId, "all feature toggles", `${value} by=${actorId ?? "unknown"}`);
  return value;
}

export function setAllFeatureReplyTypes(guildId, responseType, actorId = null) {
  const result = setAllFeatureResponseTypes(guildId, responseType);
  if (result) {logChange(guildId, "all feature response types", `${result} by=${actorId ?? "unknown"}`);}
  return result;
}

export function updateCommandReplyType(guildId, responseType, actorId = null) {
  const result = setCommandResponseType(guildId, responseType);
  if (result) {logChange(guildId, "command default response", `${result} by=${actorId ?? "unknown"}`);}
  return result;
}

export function updateGuildWelcomeMessage(guildId, message, actorId = null) {
  const result = setGuildWelcomeMessage(guildId, message);
  logChange(guildId, "welcome message", `by=${actorId ?? "unknown"}`);
  return result;
}


export function updateGuildWelcomeOptions(guildId, options, actorId = null) {
  const result = setGuildWelcomeOptions(guildId, options);
  logChange(guildId, "welcome options", `by=${actorId ?? "unknown"}`);
  return result;
}

export function updateGuildGoodbyeMessage(guildId, message, actorId = null) {
  const result = setGuildGoodbyeMessage(guildId, message);
  logChange(guildId, "goodbye message", `by=${actorId ?? "unknown"}`);
  return result;
}

export function updateGuildGoodbyeOptions(guildId, options, actorId = null) {
  const result = setGuildGoodbyeOptions(guildId, options);
  logChange(guildId, "goodbye options", `by=${actorId ?? "unknown"}`);
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
  logChange(guildId, "feature settings reset", `by=${actorId ?? "unknown"}`);
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
