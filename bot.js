import dotenv from "dotenv";
import path from "path";
import express from "express";

dotenv.config();

import * as discord         from "discord.js";
import * as channelManager  from "./channelManager.js";
import * as commands        from "./commands.js";
import * as appLogger       from "./appLogger.js";
import * as owner           from "./owner.js";
import * as platformManager from "./platformManager.js";
import * as entitlements    from "./entitlements.js";
import * as permissions     from "./permissions.js";
import * as feedback        from "./feedback.js";
import * as featureSettings from "./featureSettings.js";
import * as inactivity      from "./inactivity.js";
import * as timers          from "./timers.js";
import * as autopublish     from "./autopublish.js";
import * as counters        from "./counters.js";

import {startUpsNotifier, stopUpsNotifier}                           from "./upsNotifier.js";
import {startDiagnosticsNotifier, stopDiagnosticsNotifier}           from "./diagnosticsNotifier.js";
import {trackBotCallback, drainBotTasks}                             from "./lifecycle.js";
import { initDB, getDB, closeDB }                                    from "./storage.js";
import {beginShutdown, registerShutdownHandler, isShutdownRequested} from "bargaz/shutdownCoordinator.js";
import {startDataCleanup, stopDataCleanup}                           from "./dataCleanup.js";

/*
=====================================================
Health and Feedback Server
=====================================================
*/

const app = express();
const PORT = process.env.PORT || 3500;

app.get("/", (req, res) => {res.status(200).send("Bargaz-Bot online");});
app.get("/health", (req, res) => {
  const stopping = isShutdownRequested() || shutdownStarted;
  res.status(stopping ? 503 : 200).json({
    status: stopping ? "shutting_down" : "online",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

feedback.registerRoutes(app);

const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`Health and feedback server listening on 127.0.0.1:${PORT}`);
});

/*
=====================================================
Discord Client
=====================================================
*/

const client = new discord.Client({
  intents: [
    discord.GatewayIntentBits.Guilds,
    discord.GatewayIntentBits.GuildMessages,
    discord.GatewayIntentBits.MessageContent,
    discord.GatewayIntentBits.GuildMembers
  ]
});

function onBotEvent(event, handler)   {client.on(event, trackBotCallback(handler));}
function onceBotEvent(event, handler) {client.once(event, trackBotCallback(handler));}

appLogger.initAppLogger();
appLogger.captureConsole();

process.on("uncaughtException", error => {console.error("Uncaught exception:", error);});
process.on("unhandledRejection", reason => {console.error("Unhandled promise rejection:", reason);});

initDB();
feedback.initFeedback(client);

let shutdownStarted = false;
let servicesClosed = false;
let shutdownTask = null;
let shutdownHold = null;
let terminationStarted = false;

/*
=====================================================
Feature Gating and Response Types
=====================================================
*/

const COMMAND_FEATURES = {
  notification: "notifications",
  entitlement:  "entitlement",
  logging:      "logging",
  inactivity:   "inactivity",
  timers:       "timers",
  dm:           "dm"
};

const DIRECT_MESSAGE_COMMANDS = new Set([
  "ping", "help", "stats", "data", "dm", "dm-help", "invite",
  "notification", "entitlement", "timers", "set-timezone"
]);

const ALWAYS_ALLOWED_DM_COMMANDS = new Set(["ping", "help", "stats", "data", "dm", "set-timezone", "invite"]);

function isDmFeatureAllowed(interaction) {
  if (interaction.guild) {return true;}

  const settings = featureSettings.getUserDmSettings(interaction.user.id);
  if (!settings.dmEnabled && !ALWAYS_ALLOWED_DM_COMMANDS.has(interaction.commandName)) {return false;}

  if (interaction.commandName === "notification" || interaction.commandName === "entitlement") {
    return settings.notificationsEnabled;
  }
  if (interaction.commandName === "timers") {
    return settings.remindersEnabled || settings.birthdaysEnabled;
  }

  return true;
}

function getCommandFeature(commandName) {
  return COMMAND_FEATURES[commandName] ?? null;
}

function resolveResponseType(interaction, commandName) {
  if (!interaction.guild) {return "ephemeral";}
  const feature = getCommandFeature(commandName);
  const featureType = feature
    ? featureSettings.getFeatureResponseType(interaction.guild.id, feature)
    : null;
  return featureType || featureSettings.getCommandResponseType(interaction.guild.id) || "message";
}

function applyResponseMode(interaction, responseType) {
  if (responseType !== "message") {return;}
  for (const method of ["reply", "editReply", "followUp"]) {
    const original = interaction[method].bind(interaction);
    interaction[method] = payload => {
      if (!payload || typeof payload !== "object") {return original(payload);}
      const adjusted = {...payload};
      delete adjusted.flags;
      delete adjusted.ephemeral;
      return original(adjusted);
    };
  }
}

async function isCommandFeatureEnabled(interaction) {
  if (!interaction.guild) {return true;}
  const feature = getCommandFeature(interaction.commandName);
  if (!feature) {return true;}
  if (featureSettings.isFeatureEnabled(interaction.guild.id, feature)) {return true;}
  await interaction.reply({
    content: `The **${feature}** feature is disabled in this server. An administrator can enable it with \`/features-config\`.`,
    flags: discord.MessageFlags.Ephemeral
  }).catch(() => {});
  appLogger.info("BargazBot command blocked by disabled feature:", interaction.guild.id, interaction.commandName, feature);
  return false;
}

/*
=====================================================
Join Detection
=====================================================
*/

async function detectInstaller(guild) {
  try {
    const logs = await guild.fetchAuditLogs({
      type: discord.AuditLogEvent.BotAdd,
      limit: 20
    });
    const entry = logs.entries.find(item =>
      item.target?.id === client.user.id &&
      Date.now() - item.createdTimestamp < 15 * 60 * 1000
    );
    if (entry?.executor?.id) {return entry.executor.id;}
  } catch (error) {
    appLogger.warn("BargazBot could not read the BOT_ADD audit log:", guild.id, error.message ?? error);
  }
  return guild.ownerId;
}

async function sendWelcomeMessage(member) {
  try {
    const channel = await channelManager.findBargazChannel(member.guild);
    if (!channel) {return;}
    await channel.send({
      content: `Welcome to ${member.guild.name}, ${member}!`,
      allowedMentions: {parse: []}
    });
  } catch (error) {
    appLogger.warn("BargazBot welcome message failed:", member.guild.id, member.id, error);
  }
}

function buildGreetingEmbed(member, kind, options) {
  const fields = [];
  if (options.username) {fields.push({name:"Username", value:`\`${member.user.tag}\``, inline:true});}
  if (options.nickname) {fields.push({name:"Nickname", value:`\`${member.displayName}\``, inline:true});}
  if (options.profile) {
    fields.push({name:"Account created", value:`<t:${Math.floor(member.user.createdAt.getTime() / 1000)}:R>`, inline:true});
    if (kind === "welcome" && member.joinedAt) {
      fields.push({name:"Joined server", value:`<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>`, inline:true});
    }
  }
  if (fields.length === 0) {return null;}

  const embed = new discord.EmbedBuilder()
    .setTitle(kind === "welcome" ? "Member joined" : "Member left")
    .setColor(kind === "welcome" ? 0x57F287 : 0xED4245);
  if (options.profile) {embed.setThumbnail(member.user.displayAvatarURL());}
  embed.addFields(fields);
  return embed;
}

function renderGreetingMessage(template, member, kind) {
  const fallback = kind === "welcome"
    ? "Welcome to {server}, {user}!"
    : "{user} has left {server}.";
  return (template ?? fallback)
    .replaceAll("{user}", `<@${member.id}>`)
    .replaceAll("{username}", member.user.tag)
    .replaceAll("{nickname}", member.displayName)
    .replaceAll("{server}", member.guild.name)
    .replaceAll("{count}", String(member.guild.memberCount));
}

async function sendMemberAnnouncement(member, kind) {
  const feature = kind === "welcome" ? "welcome" : "goodbye";
  try {
    if (!featureSettings.isFeatureEnabled(member.guild.id, feature)) {return;}
    const channel = await channelManager.getChannel(member.guild, feature);
    if (!channel) {return;}

    const template = kind === "welcome"
      ? featureSettings.getGuildWelcomeMessage(member.guild.id)
      : featureSettings.getGuildGoodbyeMessage(member.guild.id);
    const options = kind === "welcome"
      ? featureSettings.getGuildWelcomeOptions(member.guild.id)
      : featureSettings.getGuildGoodbyeOptions(member.guild.id);
    const embed = buildGreetingEmbed(member, kind, options);

    await channel.send({
      content: renderGreetingMessage(template, member, kind),
      ...(embed ? {embeds:[embed]} : {}),
      allowedMentions: {parse: []}
    });
  } catch (error) {
    appLogger.warn(`BargazBot ${feature} announcement failed:`, member.guild.id, member.id, error);
  }
}

async function sendGoodbyeMessage(member) {
  await sendMemberAnnouncement(member, "goodbye");
}

/*
=====================================================
Shutdown
=====================================================
*/

async function closeHealthServer() {
  if (!server.listening) {return;}
  await new Promise((resolve, reject) => {
    server.close(error => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {reject(error);} else {resolve();}
    });
    server.closeIdleConnections();
  });
}

function closeBotServices() {
  if (shutdownTask) {return shutdownTask;}
  shutdownStarted = true;
  shutdownHold = setInterval(() => {}, 1000);

  shutdownTask = (async () => {
    console.log("Stopping BargazBot services.");

    inactivity.stopInactivityMonitor();
    timers.stopTimers();
    autopublish.stopAutoPublish();
    counters.stopCounters();
    platformManager.stopPlatformManager();
    stopDataCleanup();
    commands.stopCommandCollectors();

    const limited = async (label, promise, ms = 3000) => {
      let timer;
      try {
        return await Promise.race([
          Promise.resolve(promise),
          new Promise(resolve => {
            timer = setTimeout(() => {
              console.log(`BargazBot shutdown step timed out: ${label}`);
              resolve(undefined);
            }, ms);
          })
        ]);
      } finally {clearTimeout(timer);}
    };

    const finish = (async () => {
      await Promise.allSettled([
        limited("UPS notifier", stopUpsNotifier(), 2000),
        limited("diagnostics notifier", stopDiagnosticsNotifier(), 2000)
      ]);

      await limited("bot tasks", drainBotTasks());
      await limited("platform jobs", platformManager.drainPlatformJobs());

      appLogger.setLogEventHandler(null);

      await limited("health server", closeHealthServer());
      await limited("Discord client", client.destroy());

      if (!closeDB()) {throw new Error("SQLite could not close.");}
    })();

    const completed = await Promise.race([
      finish.then(() => true, error => {
        console.error("BargazBot shutdown cleanup failed:", error);
        return false;
      }),
      new Promise(resolve => setTimeout(() => resolve(false), 20000))
    ]);

    if (completed) {
      servicesClosed = true;
      console.log("BargazBot services stopped.");
    } else {
      console.warn("BargazBot shutdown cleanup timed out; continuing.");
    }
  })();

  return shutdownTask;
}

registerShutdownHandler("bot-services", closeBotServices);

async function handleTermination(signal) {
  if (terminationStarted) {return;}
  terminationStarted = true;
  console.log(`Received ${signal}.`);
  beginShutdown(`signal-${process.pid}-${Date.now()}`, "ups");

  const deadline = setTimeout(() => {
    process.stderr.write("BargazBot shutdown exceeded 60 seconds.\n");
    process.exit(1);
  }, 60000);

  try {
    await closeBotServices();
    clearTimeout(deadline);
    clearInterval(shutdownHold);
    process.exit(0);
  } catch (error) {
    clearTimeout(deadline);
    clearInterval(shutdownHold);
    console.error("BargazBot shutdown failed:", error);
    process.exit(1);
  }
}

process.once("SIGINT",  () => {void handleTermination("SIGINT");});
process.once("SIGTERM", () => {void handleTermination("SIGTERM");});

/*
=====================================================
Allocation Reconciliation
=====================================================
*/

async function reconcileGuildAllocations(guild) {
  const allocations = getDB().prepare(`
    SELECT user_id
    FROM entitlement_allocations
    WHERE guild_id = ?
  `).all(guild.id);

  for (const allocation of allocations) {
    let member;
    try {
      member = await guild.members.fetch(allocation.user_id);
    } catch (error) {
      if (error.code === 10007) {entitlements.removeGuildAllocations(allocation.user_id, guild.id);}
      else {appLogger.error("Failed to retrieve member for allocation reconciliation:", guild.id, allocation.user_id, error);}
      continue;
    }
    if (!permissions.canUseCommand(member, "entitlement", "allocate")) {
      entitlements.removeGuildAllocations(allocation.user_id, guild.id);
    }
  }
}

/*
=====================================================
Events
=====================================================
*/

onceBotEvent("clientReady", async () => {
  owner.initOwnerSystem(client);
  startUpsNotifier(client);
  startDiagnosticsNotifier();
  console.log(`Logged in as ${client.user.tag}!`);

  const memberLists = new Map();
  let membershipComplete = true;

  for (const guild of client.guilds.cache.values()) {
    try {
      channelManager.ensureGuildData(guild);
      const members = await guild.members.fetch();
      const memberIds = new Set();
      for (const member of members.values()) {
        if (member.user.bot) {continue;}
        entitlements.ensureUser(member.user);
        entitlements.ensureGuildMember(guild.id, member.user.id, member.joinedAt);
        memberIds.add(member.user.id);
      }
      console.log(`Registered ${members.filter(member => !member.user.bot).size} users from ${guild.name}.`);
      memberLists.set(guild.id, memberIds);
    } catch (error) {
      console.error(`Failed to register users from ${guild.name}:`, error);
      membershipComplete = false;
    }
  }

  for (const guild of client.guilds.cache.values()) {
    try {
      await reconcileGuildAllocations(guild);
    } catch (error) {
      appLogger.error("Failed to reconcile allocations for guild:", guild.id, error);
    }
  }

  startDataCleanup(client, {memberLists, membershipComplete});

  if (isShutdownRequested()) {return;}
  await commands.registerCommands(client);
  if (isShutdownRequested()) {return;}
  await platformManager.startPlatformManager(client);
  if (isShutdownRequested()) {return;}

  inactivity.startInactivityMonitor(client);
  timers.startTimers(client);
  autopublish.startAutoPublish(client);
  counters.startCounters(client);
});

onBotEvent("guildCreate", async guild => {
  if (isShutdownRequested()) {return;}
  try {
    channelManager.ensureGuildData(guild);
    const setup = await channelManager.setupGuild(guild);
    const installerId = await detectInstaller(guild);
    entitlements.ensureUser({id: installerId});
    permissions.ensureInstallerPermissions(guild, installerId);
    await channelManager.sendStorageNotice(guild, installerId);
    for (const feature of ["autopublish", "inactivity", "timers"]) {featureSettings.setFeatureEnabled(guild.id, feature, false, installerId);}
    if (!setup.skipped) {console.log(`Set up BargazBot channels for guild: ${guild.name} (${guild.id})`);}
  } catch (error) {
    appLogger.error("Failed to set up BargazBot for guild:", guild.id, error);
  }
});

onBotEvent("guildMemberAdd", async member => {
  if (isShutdownRequested()) {return;}
  if (member.user.bot) {return;}
  try {
    channelManager.ensureGuildData(member.guild);
    entitlements.ensureUser(member.user);
    entitlements.ensureGuildMember(member.guild.id, member.user.id, member.joinedAt);
    await channelManager.sendStorageNotice(member.guild, member.user.id);
    await sendWelcomeMessage(member);
    await sendMemberAnnouncement(member, "welcome");
    await counters.refreshGuildCounters(member.guild);
  } catch (error) {
    appLogger.error("Failed to process joining member:", member.guild.id, member.id, error);
  }
});

onBotEvent("guildMemberUpdate", async (oldMember, newMember) => {
  if (isShutdownRequested()) {return;}
  try {
    const previouslyAllowed = permissions.canUseCommand(oldMember, "entitlement", "allocate");
    const beforeRoles = new Set(oldMember.roles.cache.keys());
    const afterRoles  = new Set(newMember.roles.cache.keys());
    if (beforeRoles.size !== afterRoles.size || [...beforeRoles].some(id => !afterRoles.has(id))) {
      await counters.refreshGuildCounters(newMember.guild);
    }
    const currentlyAllowed  = permissions.canUseCommand(newMember, "entitlement", "allocate");
    if (previouslyAllowed && !currentlyAllowed) {
      entitlements.removeGuildMember(newMember.guild.id, newMember.id);
      entitlements.removeGuildAllocations(newMember.id, newMember.guild.id);
    }
  } catch (error) {
    appLogger.error("Failed to process member permission changes:", newMember.guild.id, newMember.id, error);
  }
});

onBotEvent("guildMemberRemove", async member => {
  if (isShutdownRequested()) {return;}
  try {
    entitlements.removeGuildAllocations(member.id, member.guild.id);
    await sendGoodbyeMessage(member);
    await counters.refreshGuildCounters(member.guild);
  } catch (error) {
    appLogger.error("Failed to process departing member:", member.guild.id, member.id, error);
  }
});

onBotEvent("roleDelete", async role => {
  if (isShutdownRequested()) {return;}
  try {
    await reconcileGuildAllocations(role.guild);
  } catch (error) {
    appLogger.error("Failed to reconcile allocations after role deletion:", role.guild.id, error);
  }
});

onBotEvent("roleUpdate", async (oldRole, newRole) => {
  if (isShutdownRequested()) {return;}
  try {
    const oldAdmin = oldRole.permissions.has(discord.PermissionFlagsBits.Administrator);
    const newAdmin = newRole.permissions.has(discord.PermissionFlagsBits.Administrator);
    if (oldAdmin && !newAdmin) {await reconcileGuildAllocations(newRole.guild);}
  } catch (error) {
    appLogger.error("Failed to reconcile allocations after role update:", newRole.guild.id, error);
  }
});

onBotEvent("guildUpdate", async (oldGuild, newGuild) => {
  if (isShutdownRequested()) {return;}
  try {
    if (oldGuild.ownerId !== newGuild.ownerId) {await reconcileGuildAllocations(newGuild);}
  } catch (error) {
    appLogger.error("Failed to reconcile allocations after ownership change:", newGuild.id, error);
  }
});

onBotEvent("messageCreate", async message => {
  if (isShutdownRequested()) {return;}

  if (!message.guild) {
    if (message.channel?.type !== discord.ChannelType.DM) {return;}
    const settings = featureSettings.getUserDmSettings(message.author.id);
    if (settings?.dmEnabled === false) {return;}
    await feedback.handleReply(message);
    return;
  }

  await feedback.handleReply(message);
  await owner.handleOwnerMessage(message);
});

onBotEvent("interactionCreate", async interaction => {
  if (isShutdownRequested()) {
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: "BargazBot is shutting down. Please try again later.",
        flags: discord.MessageFlags.Ephemeral
      }).catch(() => {});
    }
    return;
  }
  if (!interaction.isChatInputCommand()) {return;}
  if (!interaction.guild && interaction.channel?.type === discord.ChannelType.GroupDM) {
    await interaction.reply({
      content: "BargazBot commands cannot be used in group DMs.",
      flags: discord.MessageFlags.Ephemeral
    }).catch(() => {});
    return;
  }
  if (!interaction.guild && !DIRECT_MESSAGE_COMMANDS.has(interaction.commandName)) {
    await interaction.reply({
      content: "This command can only be used in a Discord server.",
      flags: discord.MessageFlags.Ephemeral
    }).catch(() => {});
    return;
  }
  if (!await isCommandFeatureEnabled(interaction)) {return;}
  if (!isDmFeatureAllowed(interaction)) {
    await interaction.reply({content:"That DM feature is off. Use `/dm` to turn it on.", flags:discord.MessageFlags.Ephemeral}).catch(() => {});
    return;
  }

  applyResponseMode(interaction, resolveResponseType(interaction, interaction.commandName));
  await commands.handleInteraction(interaction);
});

/*
=====================================================
Login
=====================================================
*/

client.login(process.env.BOT_TOKEN).catch(error => {
  console.error("Discord login failed:", error);
});
