import * as youtube from "./youtube.js";
import * as twitch from "./twitch.js";
import * as kick from "./kick.js";
import * as notifications from "./notifications.js";
import * as counters from "./counters.js";
import * as roleRewards from "./roleRewards.js";
import * as log from "./appLogger.js";
import {isShutdownRequested} from "bargaz/shutdownCoordinator.js";

const DEFAULT_CHECK_INTERVAL = 300000;
const METADATA_REFRESH_INTERVAL = 60000;
const CLEANUP_INTERVAL = 300000;

let client = null;

let monitorInterval = null;
let metadataInterval = null;
let cleanupInterval = null;

let monitorRunning = false;
let metadataRunning = false;



const activeJobs = new Set();
let stopping = false;

function trackJob(promise) {
  const job = Promise.resolve(promise);
  activeJobs.add(job);
  job.finally(() => activeJobs.delete(job)).catch(() => {});
  return job;
}

function describePlatformError(error) {
  const status =
    error?.response?.status ??
    null;

  const message =
    error?.response?.data?.error?.message ??
    error?.message ??
    String(error);

  return status
    ? `${status}: ${message}`
    : message;
}

async function runPostPollHooks() {
  if (!client || stopping || isShutdownRequested()) {return;}
  for (const guild of client.guilds.cache.values()) {
    await roleRewards.recheckRewards(client, guild.id).catch(error =>
      log.warn("BargazBot reward recheck failed:", guild.id, error)
    );
    await counters.refreshSocialCounters(guild.id).catch(error =>
      log.warn("BargazBot social counter refresh failed:", guild.id, error)
    );
  }
}

export async function drainPlatformJobs() {
  while (activeJobs.size > 0 || monitorRunning || metadataRunning) {
    if (activeJobs.size > 0) {
      await Promise.allSettled([...activeJobs]);
    } else {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

/*
=====================================================
Platform Information
=====================================================
*/

export const PLATFORM_NAMES = {
  youtube: "YouTube",
  twitch: "Twitch",
  kick: "Kick"
};


export const PLATFORM_COLORS = {
  youtube: 0xFF0000,
  twitch: 0x9146FF,
  kick: 0x53FC18
};


export const PLATFORM_EMOJIS = {
  youtube: "🔴",
  twitch: "🟣",
  kick: "🟢"
};


export const PLATFORM_CONTENT_TYPES = {
  youtube: [
    "video",
    "short",
    "stream",
    "premiere"
  ],

  twitch: [
    "stream"
  ],

  kick: [
    "stream"
  ]
};


/*
=====================================================
Platform Lookup
=====================================================
*/

export function getPlatformModule(platform) {
  switch (platform) {
    case "youtube":
      return youtube;

    case "twitch":
      return twitch;

    case "kick":
      return kick;

    default:
      throw new Error(
        `Unknown platform: ${platform}`
      );
  }
}


export function isSupportedPlatform(platform) {
  return (
    platform === "youtube" ||
    platform === "twitch" ||
    platform === "kick"
  );
}


export function getSupportedPlatforms() {
  return [
    "youtube",
    "twitch",
    "kick"
  ];
}


/*
=====================================================
Platform Validation
=====================================================
*/

export function validatePlatform(platform) {
  if (
    !isSupportedPlatform(platform)
  ) {
    throw new Error(
      `Unsupported platform: ${platform}`
    );
  }

  return platform;
}


/*
=====================================================
Channel Resolution
=====================================================
*/

export async function resolveChannel(
  platform,
  input
) {
  validatePlatform(platform);

  const platformModule =
    getPlatformModule(platform);

  return platformModule
    .resolveChannel(input);
}


export async function resolveAndSaveChannel(
  platform,
  input
) {
  validatePlatform(platform);

  const platformModule =
    getPlatformModule(platform);

  return platformModule
    .resolveAndSaveChannel(input);
}


/*
=====================================================
YouTube Polling
=====================================================
*/

async function checkYouTube() {
  const channels =
    youtube.getSubscribedChannels();

  const results = [];

  for (const channel of channels) {
    if (stopping || isShutdownRequested()) {break;}
    try {
      const channelResults =
        await youtube.checkChannel(
          channel
        );

      if (
        !channelResults ||
        channelResults.length === 0
      ) {
        continue;
      }

      results.push(
        ...channelResults
      );

      await notifications
        .processYouTubeResults(
          client,
          channelResults
        );

    } catch (error) {
      log.error(
        `Failed to check YouTube channel ${channel.channel_id}:`,
        describePlatformError(error)
      );
    }
  }

  return results;
}


/*
=====================================================
Twitch Polling
=====================================================
*/

async function checkTwitch() {
  try {
    const results =
      await twitch
        .checkSubscribedChannels();

    for (const result of results) {
      await notifications
        .processResult(
          client,
          result
        );
    }

    return results;

  } catch (error) {
    log.error(
      "Failed to check Twitch channels:",
      error
    );

    return [];
  }
}


/*
=====================================================
Kick Polling
=====================================================
*/

async function checkKick() {
  try {
    const results =
      await kick
        .checkSubscribedChannels();

    for (const result of results) {
      await notifications
        .processResult(
          client,
          result
        );
    }

    return results;

  } catch (error) {
    log.error(
      "Failed to check Kick channels:",
      error
    );

    return [];
  }
}


/*
=====================================================
Main Platform Check
=====================================================
*/

export async function checkPlatforms() {
  if (stopping || isShutdownRequested()) {return;}
  if (!client) {
    throw new Error(
      "Platform manager has not been started."
    );
  }

  if (monitorRunning) {
    log.warn(
      "Platform check skipped because the previous check is still running."
    );

    return;
  }

  monitorRunning = true;

  try {
    const settled = await trackJob(Promise.allSettled([
      checkYouTube(),
      checkTwitch(),
      checkKick()
    ]));

    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        log.error("BargazBot platform check failed:", outcome.reason);
      }
    }

    await runPostPollHooks();

  } finally {
    monitorRunning = false;
  }

}


/*
=====================================================
YouTube Metadata Refresh
=====================================================
*/

async function refreshYouTubeMetadata() {
  if (stopping || isShutdownRequested()) {return;}
  if (
    !client ||
    metadataRunning
  ) {
    return;
  }

  metadataRunning = true;

  try {
    const results = await trackJob(youtube.refreshActiveContent());

    for (const result of results) {
      try {
        await notifications
          .processResult(
            client,
            result
          );

      } catch (error) {
        log.error(
          `Failed to process YouTube metadata update for ${result.content?.id}:`,
          error
        );
      }
    }

    await runPostPollHooks();

  } catch (error) {
    log.error(
      "Failed to refresh active YouTube content:",
      describePlatformError(error)
    );

  } finally {
    metadataRunning = false;
  }
}


/*
=====================================================
Content Cleanup
=====================================================
*/

function cleanupContent() {
  if (stopping || isShutdownRequested()) {return;}
  try {
    const youtubeRemoved =
      youtube.cleanupEndedContent();

    const twitchRemoved =
      twitch.cleanupEndedContent();

    const kickRemoved =
      kick.cleanupEndedContent();

    const totalRemoved =
      youtubeRemoved +
      twitchRemoved +
      kickRemoved;

    if (totalRemoved > 0) {
      log.info(
        `Removed ${totalRemoved} expired notification content record(s).`
      );
    }

  } catch (error) {
    log.error(
      "Failed to clean expired notification content:",
      error
    );
  }
}


/*
=====================================================
Monitor Startup
=====================================================
*/

export async function startPlatformManager(discordClient) {
  if (stopping || isShutdownRequested()) {return;}
  if (client) {
    log.warn(
      "Platform manager is already running."
    );

    return;
  }

  client =
    discordClient;

  log.info(
    "Starting BargazBot platform manager."
  );

  try {
    await checkPlatforms();
  } catch (error) {
    log.error("Initial platform check failed:", error);
  }

  if (stopping || isShutdownRequested()) {return;}

  monitorInterval =
    setInterval(
      () => {
        checkPlatforms().catch(
          error => {
            log.error(
              "Platform monitor failed:",
              error
            );
          }
        );
      },
      DEFAULT_CHECK_INTERVAL
    );

  metadataInterval =
    setInterval(
      () => {
        refreshYouTubeMetadata()
          .catch(
            error => {
              log.error(
                "YouTube metadata monitor failed:",
                error
              );
            }
          );
      },
      METADATA_REFRESH_INTERVAL
    );

  cleanupInterval =
    setInterval(
      cleanupContent,
      CLEANUP_INTERVAL
    );

  log.info(
    "BargazBot platform manager started."
  );
}


/*
=====================================================
Monitor Shutdown
=====================================================
*/

export function stopPlatformManager() {
  stopping = true;
  if (monitorInterval) {clearInterval(monitorInterval); monitorInterval = null;}
  if (metadataInterval) {clearInterval(metadataInterval); metadataInterval = null;}
  if (cleanupInterval) {clearInterval(cleanupInterval); cleanupInterval = null;}
  log.info("BargazBot platform manager stopped accepting new work.");
}


/*
=====================================================
Manual Platform Check
=====================================================
*/

export async function checkPlatform(platform) {
  if (stopping || isShutdownRequested()) {return;}
  validatePlatform(platform);

  if (!client) {
    throw new Error(
      "Platform manager has not been started."
    );
  }

  let results;
  switch (platform) {
    case "youtube": results = await trackJob(checkYouTube()); break;
    case "twitch": results = await trackJob(checkTwitch()); break;
    case "kick": results = await trackJob(checkKick()); break;
  }
  await runPostPollHooks();
  return results;
}


/*
=====================================================
Monitor Status
=====================================================
*/

export function getMonitorStatus() {
  return {
    running:
      Boolean(client),

    platformCheckRunning:
      monitorRunning,

    metadataRefreshRunning:
      metadataRunning,

    checkInterval:
      DEFAULT_CHECK_INTERVAL,

    metadataRefreshInterval:
      METADATA_REFRESH_INTERVAL,

    cleanupInterval:
      CLEANUP_INTERVAL,

    platforms:
      getSupportedPlatforms()
  };
}
