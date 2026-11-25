import {startUpsMonitor} from "bargaz/upsMonitor.js";
import {beginShutdown, addShutdownBlocker, removeShutdownBlocker, isShutdownRequested} from "bargaz/shutdownCoordinator.js";
import {getOwnerStatusChannel} from "./owner.js";
import * as channelManager from "./channelManager.js";
import * as featureSettings from "./featureSettings.js";
import {EnvVar} from "./config.js";

const BATTERY_UPDATE_INTERVAL_MS = 15 * 60 * 1000;

let monitor = null;
let previousPowerSource = null;
let previousNetwork = null;
let lastBatteryUpdate = null;

function networkMessage(network, connected) {
  let message = "\n\n**Network Status**\n";

  message += `Connection: **${network.name}**`;

  if (network.type === "wifi") {
    const bars = network.bars;
    message += `\nSignal: **${bars === null ? "Unknown" : `${"▰".repeat(bars)}${"▱".repeat(4 - bars)} (${bars}/4 bars)`}**`;
  }

  return message;
}

function batteryMessage(percent) {
  const battery = typeof percent === "number" ? `${percent.toFixed(1)}%` : "Unknown";

  return (
    "🟡 **BargazBot is running on battery power.**\n" +
    `Battery remaining: **${battery}**\n\n` +
    "The UPS can run BargazBot for roughly **12 hours from 100% " +
    "until the 30% automatic-shutdown threshold**. " +
    "The Raspberry Pi will automatically shut down at **30%**."
  );
}

function externalMessage() {
  return (
    "🟢 **BargazBot is running on external power.**\n" +
    "If it loses power, this message will update " +
    "with the relevant information."
  );
}

function shutdownMessage(status, shutdownRequest) {
  const battery = typeof status?.battery_percent === "number" ? `${status.battery_percent.toFixed(1)}%` : "Unknown";

  let reason = shutdownRequest?.shutdown_reason;

  if (reason === "low_battery") {reason = "Low battery";}
  else if (reason === "manual") {reason = "Manual shutdown";}
  else if (reason === "network") {reason = "Network connection lost";}
  else if (!reason) {reason = "Shutdown requested";}

  let message = (
    "🔴 **BargazBot is about to shut down.**\n" +
    `Battery remaining: **${battery}**\n` +
    `Reason: **${reason}**\n\n`
  );

  if (shutdownRequest?.shutdown_reason === "network") {
    message +=
      "The Raspberry Pi has been unable to communicate " +
      "with external services for over **2 minutes**.";
  } else if (shutdownRequest?.shutdown_reason === "manual") {
    message += "A manual system shutdown was requested.";
  } else {
    message +=
      "The Raspberry Pi automatically shuts down when " +
      "the UPS reaches the **30% battery threshold**.";
  }

  return message;
}

async function broadcastGuildStatus(client, content) {
  if (!client) {return;}
  const tasks = [];
  for (const guild of client.guilds.cache.values()) {
    if (guild.id === EnvVar.OWNER_SERVER_ID) {continue;}
    tasks.push((async () => {
      try {
        channelManager.ensureGuildData(guild);
        if (!featureSettings.isFeatureEnabled(guild.id, "status")) {return;}
        const channel = await channelManager.getChannel(guild, "status");
        if (!channel?.isTextBased() || channel.isThread()) {return;}
        await Promise.race([
          channel.send({content:String(content).slice(0, 1900), allowedMentions:{parse:[]}}),
          new Promise((_, reject) => setTimeout(() => reject(new Error("status send timeout")), 5000))
        ]);
      } catch {}
    })());
  }
  await Promise.race([
    Promise.allSettled(tasks),
    new Promise(resolve => setTimeout(resolve, 7000))
  ]);
}

async function sendOrEditUpsMessage(channel, client, content) {
  try {
    const messages = await channel.messages.fetch({limit: 1});
    const latest = messages.first();

    if (latest?.author.id === client.user.id) {
      await latest.edit(content);
    } else {
      await channel.send(content);
    }

    return true;
  } catch (error) {
    console.error("Unable to send/edit UPS Discord message:", error);
    return false;
  }
}

function networkChanged(previous, current) {
  if (!previous) {return false;}

  return previous.connected !== current.connected ||
    previous.type !== current.type ||
    previous.name !== current.name ||
    previous.ssid !== current.ssid ||
    previous.interface !== current.interface ||
    previous.bars !== current.bars;
}

export function startUpsNotifier(client) {
  if (monitor || isShutdownRequested()) {
    return;
  }

  monitor = startUpsMonitor({
    async onStatus({status, network, timestamp}) {
      if (!status || isShutdownRequested()) {
        return;
      }

      const powerSource = status.power_source;

      if (previousPowerSource === null) {
        previousPowerSource = powerSource;
        previousNetwork = network;
        lastBatteryUpdate = timestamp;
        return;
      }

      const powerChanged = powerSource !== previousPowerSource;
      const connectionChanged = networkChanged(previousNetwork, network);
      const batteryUpdate = powerSource === "battery" &&
        timestamp - lastBatteryUpdate >= BATTERY_UPDATE_INTERVAL_MS;

      if (
        !network.connected ||
        (!powerChanged && !connectionChanged && !batteryUpdate)
      ) {
        return;
      }

      const powerMessage = powerSource === "battery"
        ? batteryMessage(status.battery_percent)
        : externalMessage();
      const content = powerMessage + networkMessage(network);

      const channel = await getOwnerStatusChannel();
      let sent = false;
      if (channel) {
        sent = await sendOrEditUpsMessage(channel, client, content);
      }
      await broadcastGuildStatus(client, content);

      if (sent) {
        previousPowerSource = powerSource;
        previousNetwork = network;
        lastBatteryUpdate = timestamp;
      }
    },

    async onShutdown({status, request, network, requestId, source}) {
      if (!beginShutdown(requestId, source)) {
        return;
      }

      if (source === "network" || !network.connected) {
        return;
      }

      addShutdownBlocker("discord-shutdown-notification");

      try {
        const content = shutdownMessage(status, request);
        const channel = await getOwnerStatusChannel();
        if (channel) {
          await Promise.race([
            channel.send({content, allowedMentions: {parse: []}}),
            new Promise(resolve => setTimeout(resolve, 5000))
          ]).catch(error => console.error("Owner shutdown Discord notification failed:", error));
        }
        await broadcastGuildStatus(client, content).catch(() => {});
      } catch (error) {
        console.error("Shutdown Discord notification failed:", error);
      } finally {
        removeShutdownBlocker("discord-shutdown-notification");
      }
    }
  });

  console.log("Shared UPS monitoring connected to BargazBot.");
}

export async function stopUpsNotifier() {
  if (!monitor) {
    return;
  }

  const current = monitor;
  monitor = null;
  await current.stop();
}
