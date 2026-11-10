import dotenv from "dotenv"; // loads .env file so process.env variables are available
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

import {startUpsNotifier, stopUpsNotifier}                           from "./upsNotifier.js";
import {startDiagnosticsNotifier, stopDiagnosticsNotifier}           from "./diagnosticsNotifier.js";
import {trackBotCallback, drainBotTasks}                             from "./lifecycle.js";
import { initDB, getDB, closeDB }                                    from "./storage.js";
import {beginShutdown, registerShutdownHandler, isShutdownRequested} from "bargaz/shutdownCoordinator.js";



// Create a server for runtime/endpoints
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => { res.status(200).send("Bargaz-Bot online"); });
app.get("/health", (req, res) => {
  const stopping = isShutdownRequested() || shutdownStarted;

  res.status(stopping ? 503 : 200).json({
    status: stopping ? "shutting_down" : "online",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Start server
const server = app.listen(PORT, () => {console.log(`Health server listening on ${PORT}`);});

// Set up the Discord client with the permissions it needs
const client = new discord.Client({
  intents: [
    discord.GatewayIntentBits.Guilds,        // allows bot to see servers
    discord.GatewayIntentBits.GuildMessages, // allows bot to see messages
    discord.GatewayIntentBits.MessageContent, // allows bot to read message content
    discord.GatewayIntentBits.GuildMembers   // allows bot to see members
  ]
});

function onBotEvent(event, handler)   {client.on(event, trackBotCallback(handler));}
function onceBotEvent(event, handler) {client.once(event, trackBotCallback(handler));}

appLogger.initAppLogger();
appLogger.captureConsole();

process.on("uncaughtException", error => {console.error("Uncaught exception:", error);});
process.on("unhandledRejection", reason => {console.error("Unhandled promise rejection:", reason);});

initDB();

let shutdownStarted = false;
let servicesClosed = false;
let shutdownTask = null;
let shutdownHold = null;
let terminationStarted = false;

async function closeHealthServer() {
  if (!server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close(error => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
      } else {
        resolve();
      }
    });

    server.closeIdleConnections();
  });
}

function closeBotServices() {
  if (shutdownTask) {
    return shutdownTask;
  }

  shutdownStarted = true;

  // Keep PM2 from restarting the bot while the host prepares to halt.
  shutdownHold = setInterval(() => {}, 1000);

  shutdownTask = (async () => {
    console.log("Stopping BargazBot services.");

    platformManager.stopPlatformManager();
    commands.stopCommandCollectors();

    await Promise.all([
      stopUpsNotifier(),
      stopDiagnosticsNotifier()
    ]);

    await drainBotTasks();
    await platformManager.drainPlatformJobs();

    appLogger.setLogEventHandler(null);

    await closeHealthServer();
    await client.destroy();

    if (!closeDB()) {
      throw new Error("SQLite could not close.");
    }

    servicesClosed = true;
    console.log("BargazBot services stopped.");
  })();

  return shutdownTask;
}

registerShutdownHandler("bot-services", closeBotServices);

async function handleTermination(signal) {
  if (terminationStarted) {
    return;
  }

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

process.once("SIGINT", () => {
  void handleTermination("SIGINT");
});

process.once("SIGTERM", () => {
  void handleTermination("SIGTERM");
});

// Reconcile allocations against a server's current effective permissions
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
      if (error.code === 10007) {
        entitlements.removeGuildAllocations(allocation.user_id, guild.id);
      } else {
        console.error(`Failed to retrieve member ${allocation.user_id} in ${guild.id}:`, error);
      }
      continue;
    }
    if (!permissions.canUseCommand(member, "entitlement", "allocate")) {
      entitlements.removeGuildAllocations(allocation.user_id, guild.id);
    }
  }
}

// When the bot first starts up and is ready
onceBotEvent("clientReady", async () => {
  owner.initOwnerSystem(client);
  startUpsNotifier(client);
  startDiagnosticsNotifier();
  console.log(`Logged in as ${client.user.tag}!`);

  for (const guild of client.guilds.cache.values()) {
    try {
      const members = await guild.members.fetch();
      for (const member of members.values()){
        if (member.user.bot){ continue; }
        entitlements.ensureUser( member.user );
      }
      console.log(`Registered ${members.filter(member => !member.user.bot).size} users from ${guild.name}.`);
    } catch (error) { console.error(`Failed to register users from ${guild.anme}:`,error);
  }
}

// Reconcile allocations that lost authorization while the bot was offline
for (const guild of client.guilds.cache.values()) {
  try {
    await reconcileGuildAllocations(guild);
  } catch (error) {console.error(`Failed to reconcile allocations for ${guild.id}:`, error);}
}
  if (isShutdownRequested()) {return;}
  if (isShutdownRequested()) {return;}
  await commands.registerCommands(client);
  if (isShutdownRequested()) {return;}
  await platformManager.startPlatformManager(client);
});

// When a new member joins a server
onBotEvent(
  "guildMemberAdd",
  member => {
    if (isShutdownRequested()) {return;}
    if (member.user.bot) {
      return;
    }

    entitlements.ensureUser(
      member.user
    );
  }
);

// Remove server allocations when a member loses entitlement allocation access
onBotEvent("guildMemberUpdate", async (oldMember, newMember) => {
  if (isShutdownRequested()) {return;}
  try {
    const previouslyAllowed = permissions.canUseCommand(oldMember, "entitlement", "allocate");
    const currentlyAllowed  = permissions.canUseCommand(newMember, "entitlement", "allocate");
    if (previouslyAllowed && !currentlyAllowed) {
      entitlements.removeGuildAllocations(newMember.id, newMember.guild.id);
    }
  } catch (error) {console.error("Failed to process member permission changes:", error);}
});

// Remove a member's server allocations when they leave
onBotEvent("guildMemberRemove", member => {
  if (isShutdownRequested()) {return;}
  try {
    entitlements.removeGuildAllocations(member.id, member.guild.id);
  } catch (error) {console.error("Failed to remove departing member allocations:", error);}
});

// Reconcile allocations when a server role is deleted
onBotEvent("roleDelete", async role => {
  if (isShutdownRequested()) {return;}
  try {
    await reconcileGuildAllocations(role.guild);
  } catch (error) {console.error("Failed to reconcile allocations after role deletion:", error);}
});

// Reconcile allocations when a role's Administrator permission changes
onBotEvent("roleUpdate", async (oldRole, newRole) => {
  if (isShutdownRequested()) {return;}
  try {
    const oldAdmin = oldRole.permissions.has(discord.PermissionFlagsBits.Administrator);
    const newAdmin = newRole.permissions.has(discord.PermissionFlagsBits.Administrator);
    if (oldAdmin && !newAdmin) {
      await reconcileGuildAllocations(newRole.guild);
    }
  } catch (error) {console.error("Failed to reconcile allocations after role update:", error);}
});

// Reconcile allocations when server ownership changes
onBotEvent("guildUpdate", async (oldGuild, newGuild) => {
  if (isShutdownRequested()) {return;}
  try {
    if (oldGuild.ownerId !== newGuild.ownerId) {
      await reconcileGuildAllocations(newGuild);
    }
  } catch (error) {console.error("Failed to reconcile allocations after ownership change:", error);}
});

// When the bot joins a new server setup guild
onBotEvent("guildCreate", async (guild) => {
  if (isShutdownRequested()) {return;}
  try {
    await channelManager.setupGuild(guild);
    console.log(`Set up BargazBot channels for guild: ${guild.name} (${guild.id})`);
  } catch (error) {
    console.error(
      `Failed to set up BargazBot channels for guild ${guild.name} (${guild.id}):`, error
    );
  }
});

onBotEvent("messageCreate", async message => {
  if (isShutdownRequested()) {return;}
  await owner.handleOwnerMessage(message);
});

// Start setup of /commands
onBotEvent("interactionCreate", async interaction => {
  if (isShutdownRequested()) {
    if (interaction.isRepliable()) {
      await interaction.reply({content: "BargazBot is shutting down. Please try again later.", ephemeral: true}).catch(() => {});
    }
    return;
  }
  await commands.handleInteraction(interaction);
});

// Log the bot in using the token from the .env file
client.login(process.env.BOT_TOKEN).catch(err => {
  console.error("Discord login failed:", err);
});
