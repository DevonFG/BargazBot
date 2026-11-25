import * as discord from "discord.js";

import * as appLogger from "./appLogger.js";
import * as featureSettings from "./featureSettings.js";
import { EnvVar } from "./config.js";
import * as channelManager from "./channelManager.js";

let client = null;
let initialized = false;

/*
=====================================================
Owner Channel Configuration
=====================================================
*/

const OWNER_CHANNELS = {
  status: "OWNER_STATUS_CHANNEL",
  updates: "OWNER_UPDATES_CHANNEL",
  console: "OWNER_CONSOLE_CHANNEL",
  errors: "OWNER_ERRORS_CHANNEL",
  alerts: "OWNER_ALERTS_CHANNEL"
};

/*
=====================================================
Initialization
=====================================================
*/

export function initOwnerSystem(discordClient) {
  if (initialized) {return;}
  client = discordClient;
  initialized = true;
  appLogger.setLogEventHandler(handleApplicationLogEvent);
  console.log("BargazBot owner system initialized.");
}

/*
=====================================================
Owner Access
=====================================================
*/

export function isOwner(userOrId) {
  if (!EnvVar.OWNER_USER_ID) {return false;}
  const userId = typeof userOrId === "string" ? userOrId : userOrId?.id;
  return userId === EnvVar.OWNER_USER_ID;
}

/*
=====================================================
Owner Server
=====================================================
*/

export async function getOwnerServer() {
  if (!client || !EnvVar.OWNER_SERVER_ID) {return null;}
  const cachedGuild = client.guilds.cache.get(EnvVar.OWNER_SERVER_ID);
  if (cachedGuild) {return cachedGuild;}
  return await client.guilds.fetch(EnvVar.OWNER_SERVER_ID).catch(() => null);
}

/*
=====================================================
Owner Channels
=====================================================
*/

export async function getOwnerChannel(purpose) {
  const envName = OWNER_CHANNELS[purpose];
  if (!envName) {throw new Error(`Unknown BargazBot owner channel purpose: ${purpose}`);}
  const channelId = EnvVar[envName];
  if (!channelId) {return null;}
  const guild = await getOwnerServer();
  if (!guild) {return null;}

  const cachedChannel = guild.channels.cache.get(channelId);
  if (cachedChannel?.isTextBased() && !cachedChannel.isThread()) {return cachedChannel;}

  const fetchedChannel = await guild.channels.fetch(channelId).catch(() => null);
  if (!fetchedChannel?.isTextBased() || fetchedChannel.isThread()) {return null;}
  return fetchedChannel;
}

/*
=====================================================
Diagnostic Formatting
=====================================================
*/

function truncateMessage(message, maxLength = 1900) {
  const text = String(message ?? "");
  if (text.length <= maxLength) {return text;}
  return text.slice(0, maxLength - 20) + "\n...[truncated]";
}

function formatLogMessage(event) {
  const level = String(event?.level ?? "info").toUpperCase();
  const message = truncateMessage(event?.message ?? "");
  return `**${level}**\n` + "```text\n" + message + "\n```";
}

/*
=====================================================
Diagnostic Delivery
=====================================================
*/

async function sendDiagnostic(purpose, content) {
  const channel = await getOwnerChannel(purpose);
  if (!channel) {return false;}
  try {
    await channel.send({content});
    return true;
  } catch (error) {
    process.stderr.write(`Failed to send BargazBot owner diagnostic: ${error?.stack ?? error}\n`);
    return false;
  }
}

/*
=====================================================
Application Log Events
=====================================================
*/

async function handleApplicationLogEvent(event) {
  await sendDiagnostic("console", formatLogMessage(event));
  if (event.level === "error") {
    await sendDiagnostic("errors", formatLogMessage(event));
  }
}

/*
=====================================================
Owner Updates
=====================================================
*/

export async function handleOwnerMessage(message) {
  if (!message || message.author?.bot) {return;}
  if (
    message.guildId !== EnvVar.OWNER_SERVER_ID ||
    message.channelId !== EnvVar.OWNER_UPDATES_CHANNEL
  ) {
    return;
  }
  if (!isOwner(message.author)) {return;}
  await broadcastOwnerUpdate(message);
}

/*
=====================================================
Owner Update Embed
=====================================================
*/

function buildOwnerUpdateEmbed(sourceMessage) {
  const description = sourceMessage.content?.trim() || "BargazBot update";
  return new discord.EmbedBuilder()
    .setTitle("BargazBot Update")
    .setDescription(description)
    .setTimestamp();
}

/*
=====================================================
Owner Update Broadcast
=====================================================
*/

async function broadcastOwnerUpdate(sourceMessage) {
  if (!client) {
    throw new Error("Cannot broadcast BargazBot owner update before the owner system is initialized.");
  }

  const embed = buildOwnerUpdateEmbed(sourceMessage);
  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (const guild of client.guilds.cache.values()) {
    if (guild.id === EnvVar.OWNER_SERVER_ID) {continue;}

    channelManager.ensureGuildData(guild);
    if (!featureSettings.isFeatureEnabled(guild.id, "updates")) {
      skippedCount++;
      continue;
    }

    try {
      const channel = await channelManager.getChannel(guild, "updates");
      if (!channel) {skippedCount++; continue;}
      if (!channel?.isTextBased() || channel.isThread()) {
        throw new Error("No usable notification channel was available.");
      }
      await channel.send({embeds: [embed]});
      sentCount++;
    } catch (error) {
      failedCount++;
      appLogger.error("Failed to send owner update to guild:", guild.id, guild.name, error);
    }
  }

  appLogger.info("BargazBot owner update broadcast completed:", {sent: sentCount, failed: failedCount, skipped: skippedCount});
  return {sent: sentCount, failed: failedCount, skipped: skippedCount};
}

/*
=====================================================
Owner Alerts
=====================================================
*/

export async function getOwnerAlertsChannel() {
  return await getOwnerChannel("alerts");
}

export async function sendOwnerAlert(content, embed = null) {
  const channel = await getOwnerAlertsChannel();
  if (!channel) {return false;}
  const payload = embed ? {embeds:[embed], allowedMentions:{parse:[]}} : {content:String(content).slice(0, 1900), allowedMentions:{parse:[]}};
  try { await channel.send(payload); return true; }
  catch (error) { appLogger.warn("Failed to send BargazBot owner alert:", error); return false; }
}

export async function broadcastAlert(client, {title, description, fields = [], color = 0xED4245} = {}) {
  const embed = new discord.EmbedBuilder()
    .setTitle(title || "BargazBot Alert")
    .setDescription(String(description || "BargazBot alert").slice(0, 4096))
    .setColor(color)
    .setTimestamp();
  if (fields.length) {embed.addFields(fields.slice(0, 25));}

  await sendOwnerAlert(null, embed);

  if (!client) {return {sent:0, failed:0, skipped:0};}
  let sent = 0, failed = 0, skipped = 0;
  for (const guild of client.guilds.cache.values()) {
    if (guild.id === EnvVar.OWNER_SERVER_ID) {continue;}
    channelManager.ensureGuildData(guild);
    if (!featureSettings.isFeatureEnabled(guild.id, "alerts")) {skipped++; continue;}
    try {
      const channel = await channelManager.getChannel(guild, "alerts");
      if (!channel?.isTextBased() || channel.isThread()) {skipped++; continue;}
      await Promise.race([
        channel.send({embeds:[embed], allowedMentions:{parse:[]}}),
        new Promise((_, reject) => setTimeout(() => reject(new Error("alert send timeout")), 5000))
      ]);
      sent++;
    } catch (error) {
      failed++;
      appLogger.warn("Failed to send guild alert:", guild.id, guild.name, error?.message ?? error);
    }
  }
  return {sent, failed, skipped};
}

/*
=====================================================
Owner Status Channel
=====================================================
*/

export async function getOwnerStatusChannel() {
  return await getOwnerChannel("status");
}
