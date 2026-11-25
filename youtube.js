import axios from "axios";
import { getDB } from "./storage.js";
import * as apiLimits from "./apiLimits.js";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

const CHECK_INTERVAL = 300000;
const METADATA_REFRESH_INTERVAL = 60000;
const METADATA_REFRESH_DURATION = 1800000;
const ENDED_CONTENT_RETENTION = 1800000;

const API_COSTS = {
  channels: 1,
  playlistItems: 1,
  videos: 1,
  search: 100
};

const CONTENT_RECHECK_INTERVAL = 24 * 60 * 60 * 1000;

let quotaUsed = 0;
let quotaDate = getQuotaDate();


/*
=====================================================
Quota Tracking
=====================================================
*/

function getQuotaDate() {
  return new Date().toISOString().slice(0, 10);
}


function resetQuotaIfNeeded() {
  const currentDate = getQuotaDate();

  if (currentDate !== quotaDate) {
    quotaDate = currentDate;
    quotaUsed = 0;

    console.log(
      "YouTube API quota counter reset for the new UTC day."
    );
  }
}

function recordQuotaUsage(units, kind = "units") {
  resetQuotaIfNeeded();
  quotaUsed += units;
  apiLimits.recordYouTubeUsage(units, kind);
}


export function getQuotaUsage() {
  resetQuotaIfNeeded();

  return {
    date: quotaDate,
    used: quotaUsed,
    searches: apiLimits.getLimitStatus("youtube")?.searches ?? 0,
    limits: apiLimits.getLimitStatus("youtube")
  };
}

/*
=====================================================
YouTube API
=====================================================
*/

async function youtubeRequest(endpoint, params, quotaCost = 1, options = {}) {
  if (!process.env.YOUTUBE_API_KEY) {
    throw new Error("YOUTUBE_API_KEY is not configured.");
  }

  const kind = endpoint === "search" ? "search" : "quota";
  const limit = apiLimits.limitDetails("youtube", kind);
  if (limit.limited) {
    const err = new Error(apiLimits.formatLimitMessage("youtube", limit));
    err.code = "YOUTUBE_LIMITED";
    throw err;
  }

  try {
    const response = await axios.get(
      `${YOUTUBE_API_BASE}/${endpoint}`,
      {
        timeout: 15000,
        params: {
          key: process.env.YOUTUBE_API_KEY,
          ...params
        }
      }
    );

    recordQuotaUsage(quotaCost, kind);
    if (apiLimits.isLimited("youtube", kind)) {await apiLimits.recordLimitRecovery("youtube", kind);}
    return response.data;

  } catch (error) {
    const status = error.response?.status;
    const reasons = (error.response?.data?.error?.errors ?? []).map(e => String(e.reason ?? "").toLowerCase());
    const message = String(error.response?.data?.error?.message ?? error.message ?? "");
    const quotaReason = reasons.find(r => ["quotaexceeded", "dailylimitexceeded", "userratelimitexceeded", "ratelimitexceeded"].includes(r));
    const isQuota = [403, 429].includes(status) && (quotaReason || /quota|rate limit|dailylimit/i.test(message));
    if (isQuota) {
      await apiLimits.recordLimitHit("youtube", {
        kind,
        status,
        reason: quotaReason || message,
        resetAt: null
      });
    }

    const apiError = error.response?.data?.error?.message ?? error.message;
    if (!options.quiet && !isQuota) {
      console.error(`YouTube API request failed (${endpoint}):`, apiError);
    }
    if (!options.quiet && isQuota) {
      console.warn(`YouTube API limit reached (${endpoint}):`, apiError);
    }
    throw error;
  }
}


/*
=====================================================
Channel Parsing
=====================================================
*/

export function parseChannelInput(input) {
  const value = input.trim();

  if (!value) {
    return null;
  }

  if (
    value.startsWith("UC") &&
    value.length === 24
  ) {
    return {
      type: "id",
      value
    };
  }

  if (value.includes("youtube.com")) {
    const channelMatch =
      value.match(
        /youtube\.com\/channel\/([^/?#]+)/
      );

    if (channelMatch) {
      return {
        type: "id",
        value: channelMatch[1]
      };
    }

    const handleMatch =
      value.match(
        /youtube\.com\/@([^/?#]+)/
      );

    if (handleMatch) {
      return {
        type: "handle",
        value: handleMatch[1]
      };
    }
  }

  if (value.startsWith("@")) {
    return {
      type: "handle",
      value: value.slice(1)
    };
  }

  return {
    type: "handle",
    value
  };
}


/*
=====================================================
Channel Lookup
=====================================================
*/

async function getChannelById(channelId) {
  const data = await youtubeRequest(
    "channels",
    {
      part: "snippet,contentDetails",
      id: channelId,
      maxResults: 1
    },
    API_COSTS.channels
  );

  return data.items?.[0] ?? null;
}


async function getChannelByHandle(handle) {
  const cleanHandle =
    handle.startsWith("@")
      ? handle
      : `@${handle}`;

  const data = await youtubeRequest(
    "channels",
    {
      part: "snippet,contentDetails",
      forHandle: cleanHandle,
      maxResults: 1
    },
    API_COSTS.channels
  );

  return data.items?.[0] ?? null;
}


function normalizeChannel(channel) {
  if (!channel) {
    return null;
  }

  const handle =
    channel.snippet?.customUrl ??
    null;

  return {
    channelId: channel.id,

    channelName:
      channel.snippet?.title ??
      channel.id,

    channelUrl:
      handle
        ? `https://www.youtube.com/${handle}`
        : `https://www.youtube.com/channel/${channel.id}`,

    channelHandle:
      handle,

    uploadsPlaylistId:
      channel.contentDetails
        ?.relatedPlaylists
        ?.uploads ??
      null,

    thumbnail:
      channel.snippet?.thumbnails?.high?.url ??
      channel.snippet?.thumbnails?.default?.url ??
      null
  };
}


export async function resolveChannel(input) {
  const parsed = parseChannelInput(input);

  if (!parsed) {
    return null;
  }

  let channel = null;

  if (parsed.type === "id") {
    channel =
      await getChannelById(
        parsed.value
      );
  }

  if (parsed.type === "handle") {
    channel =
      await getChannelByHandle(
        parsed.value
      );
  }

  return normalizeChannel(channel);
}


/*
=====================================================
Channel Storage
=====================================================
*/

export function getStoredChannel(channelId) {
  const db = getDB();

  return db.prepare(`
    SELECT
      channel_id,
      channel_name,
      channel_url,
      channel_handle,
      uploads_playlist_id,
      last_upload_id,
      content_available,
      content_check_at,
      created_at,
      updated_at
    FROM youtube_channels
    WHERE channel_id = ?
  `).get(channelId) ?? null;
}

export function saveChannel(channel) {
  const db = getDB();

  db.prepare(`
    INSERT INTO youtube_channels (
      channel_id,
      channel_name,
      channel_url,
      channel_handle,
      uploads_playlist_id,
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

    ON CONFLICT(channel_id) DO UPDATE SET
      channel_name = excluded.channel_name,
      channel_url = excluded.channel_url,
      channel_handle = excluded.channel_handle,
      uploads_playlist_id = excluded.uploads_playlist_id,
      content_available = 1,
      content_check_at = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    channel.channelId,
    channel.channelName,
    channel.channelUrl,
    channel.channelHandle,
    channel.uploadsPlaylistId
  );

  return getStoredChannel(
    channel.channelId
  );
}


export async function resolveAndSaveChannel(input) {
  const channel =
    await resolveChannel(input);

  if (!channel) {
    return null;
  }

  return saveChannel(channel);
}


/*
=====================================================
Subscriptions
=====================================================
*/

export function getSubscribedChannels() {
  const db = getDB();

  return db.prepare(`
    SELECT DISTINCT
      youtube_channels.channel_id,
      youtube_channels.channel_name,
      youtube_channels.channel_url,
      youtube_channels.channel_handle,
      youtube_channels.uploads_playlist_id,
      youtube_channels.last_upload_id,
      youtube_channels.content_available,
      youtube_channels.content_check_at
    FROM youtube_channels

    INNER JOIN guild_youtube_subs
      ON guild_youtube_subs.channel_id =
         youtube_channels.channel_id

    ORDER BY
      youtube_channels.channel_name ASC
  `).all();
}

export function getSubscribedGuilds(channelId) {
  const db = getDB();

  return db.prepare(`
    SELECT
      guild_id,
      channel_id,
      nickname,
      discord_channel_id,
      custom_message
    FROM guild_youtube_subs
    WHERE channel_id = ?
    ORDER BY created_at ASC
  `).all(channelId);
}

/*
=====================================================
Uploads Playlist
=====================================================
*/

async function getRecentUploadIds(
  uploadsPlaylistId,
  maxResults = 10,
  options = {}
) {
  if (!uploadsPlaylistId) {
    return [];
  }

  const data = await youtubeRequest(
    "playlistItems",
    {
      part: "contentDetails",
      playlistId: uploadsPlaylistId,
      maxResults
    },
    API_COSTS.playlistItems,
    options
  );

  return (
    data.items
      ?.map(
        item =>
          item.contentDetails?.videoId
      )
      .filter(Boolean) ??
    []
  );
}


function getNewUploadIds(
  recentIds,
  lastUploadId
) {
  if (!lastUploadId) {
    return [];
  }

  const newIds = [];

  for (const videoId of recentIds) {
    if (videoId === lastUploadId) {
      break;
    }

    newIds.push(videoId);
  }

  return newIds.reverse();
}


function updateLastUploadId(
  channelId,
  videoId
) {
  const db = getDB();

  db.prepare(`
    UPDATE youtube_channels
    SET
      last_upload_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE channel_id = ?
  `).run(
    videoId,
    channelId
  );
}


/*
=====================================================
Current Livestream Lookup
=====================================================
*/

async function getCurrentLivestreamIds(channelId) {
  const data = await youtubeRequest("search",{
    part:"snippet",
    channelId,
    eventType:"live",
    type:"video",
    maxResults:10
  },API_COSTS.search);

  return [...new Set(
    (data.items ?? []).map(item => item.id?.videoId).filter(Boolean)
  )];
}


/*
=====================================================
Video Information
=====================================================
*/

async function getVideos(videoIds) {
  if (!videoIds?.length) {
    return [];
  }

  const videos = [];

  for (
    let index = 0;
    index < videoIds.length;
    index += 50
  ) {
    const batch =
      videoIds.slice(
        index,
        index + 50
      );

    const data = await youtubeRequest(
      "videos",
      {
        part:
          "snippet,contentDetails,liveStreamingDetails,status",
        id: batch.join(","),
        maxResults: 50
      },
      API_COSTS.videos
    );

    if (data.items) {
      videos.push(
        ...data.items
      );
    }
  }

  return videos;
}


/*
=====================================================
Content Classification
=====================================================
*/

function parseDurationSeconds(duration) {
  if (!duration) {
    return null;
  }

  const match =
    duration.match(
      /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/
    );

  if (!match) {
    return null;
  }

  const hours =
    Number(match[1] ?? 0);

  const minutes =
    Number(match[2] ?? 0);

  const seconds =
    Number(match[3] ?? 0);

  return (
    hours * 3600 +
    minutes * 60 +
    seconds
  );
}


function classifyVideo(video) {
  const liveDetails =
    video.liveStreamingDetails;

  const liveBroadcastContent =
    video.snippet
      ?.liveBroadcastContent;

  if (liveDetails) {
    if (
      liveDetails.actualStartTime &&
      !liveDetails.actualEndTime
    ) {
      return "stream";
    }

    if (
      !liveDetails.actualStartTime &&
      liveDetails.scheduledStartTime
    ) {
      return "premiere";
    }

    if (
      liveDetails.actualStartTime &&
      liveDetails.actualEndTime
    ) {
      return "stream";
    }
  }

  if (
    liveBroadcastContent === "live"
  ) {
    return "stream";
  }

  if (
    liveBroadcastContent === "upcoming"
  ) {
    return "premiere";
  }

  const duration =
    parseDurationSeconds(
      video.contentDetails?.duration
    );

  if (
    duration !== null &&
    duration <= 180
  ) {
    return "short";
  }

  return "video";
}


function getLiveState(video) {
  const details =
    video.liveStreamingDetails;

  if (!details) {
    return "none";
  }

  if (
    details.actualStartTime &&
    !details.actualEndTime
  ) {
    return "live";
  }

  if (
    details.actualStartTime &&
    details.actualEndTime
  ) {
    return "ended";
  }

  if (
    details.scheduledStartTime
  ) {
    return "scheduled";
  }

  return "none";
}


function normalizeVideo(
  video,
  channel
) {
  const contentType =
    classifyVideo(video);

  const liveState =
    getLiveState(video);

  return {
    id: video.id,

    platform: "youtube",

    channelId:
      video.snippet?.channelId ??
      channel.channel_id,

    channelName:
      video.snippet?.channelTitle ??
      channel.channel_name,

    channelHandle:
      channel.channel_handle,

    title:
      video.snippet?.title ??
      "YouTube Content",

    description:
      video.snippet?.description ??
      "",

    thumbnail:
      video.snippet?.thumbnails?.maxres?.url ??
      video.snippet?.thumbnails?.standard?.url ??
      video.snippet?.thumbnails?.high?.url ??
      video.snippet?.thumbnails?.medium?.url ??
      video.snippet?.thumbnails?.default?.url ??
      null,

    url:
      `https://www.youtube.com/watch?v=${video.id}`,

    contentType,

    liveState,

    isLive:
      liveState === "live",

    isScheduled:
      liveState === "scheduled",

    isEnded:
      liveState === "ended",

    scheduledStartTime:
      video.liveStreamingDetails
        ?.scheduledStartTime ??
      null,

    actualStartTime:
      video.liveStreamingDetails
        ?.actualStartTime ??
      null,

    actualEndTime:
      video.liveStreamingDetails
        ?.actualEndTime ??
      null,

    publishedAt:
      video.snippet?.publishedAt ??
      null
  };
}


/*
=====================================================
Recent Content IDs
=====================================================
*/

function getRecentIds(
  channelId,
  contentType
) {
  const db = getDB();

  return db.prepare(`
    SELECT
      newest_id,
      previous_id
    FROM youtube_recent_ids
    WHERE channel_id = ?
      AND content_type = ?
  `).get(
    channelId,
    contentType
  ) ?? null;
}


function updateRecentIds(
  channelId,
  contentType,
  contentId
) {
  const db = getDB();

  const current =
    getRecentIds(
      channelId,
      contentType
    );

  if (
    current?.newest_id ===
    contentId
  ) {
    return;
  }

  db.prepare(`
    INSERT INTO youtube_recent_ids (
      channel_id,
      content_type,
      newest_id,
      previous_id,
      updated_at
    )
    VALUES (
      ?,
      ?,
      ?,
      ?,
      CURRENT_TIMESTAMP
    )

    ON CONFLICT(
      channel_id,
      content_type
    ) DO UPDATE SET
      previous_id =
        youtube_recent_ids.newest_id,
      newest_id =
        excluded.newest_id,
      updated_at =
        CURRENT_TIMESTAMP
  `).run(
    channelId,
    contentType,
    contentId,
    current?.newest_id ?? null
  );
}


/*
=====================================================
Content Storage
=====================================================
*/

function getStoredContent(videoId) {
  const db = getDB();

  return db.prepare(`
    SELECT
      video_id,
      channel_id,
      content_type,
      title,
      thumbnail_url,
      scheduled_start_time,
      discovered_at,
      ended_at,
      updated_at
    FROM youtube_content
    WHERE video_id = ?
  `).get(videoId) ?? null;
}


function saveContent(content,updateHistory = true) {
  const db = getDB();

  const existing =
    getStoredContent(
      content.id
    );

  const endedAt =
    content.isEnded
      ? (
          existing?.ended_at ??
          new Date().toISOString()
        )
      : null;

  db.prepare(`
    INSERT INTO youtube_content (
      video_id,
      channel_id,
      content_type,
      title,
      thumbnail_url,
      scheduled_start_time,
      discovered_at,
      ended_at,
      updated_at
    )
    VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      CURRENT_TIMESTAMP,
      ?,
      CURRENT_TIMESTAMP
    )

    ON CONFLICT(video_id) DO UPDATE SET
      channel_id =
        excluded.channel_id,
      content_type =
        excluded.content_type,
      title =
        excluded.title,
      thumbnail_url =
        excluded.thumbnail_url,
      scheduled_start_time =
        excluded.scheduled_start_time,
      ended_at =
        excluded.ended_at,
      updated_at =
        CURRENT_TIMESTAMP
  `).run(
    content.id,
    content.channelId,
    content.contentType,
    content.title,
    content.thumbnail,
    content.scheduledStartTime,
    endedAt
  );

  if (updateHistory) {
    updateRecentIds(
      content.channelId,
      content.contentType,
      content.id
    );
  }

  return {
    existing,
    current:
      getStoredContent(
        content.id
      )
  };
}


/*
=====================================================
Change Detection
=====================================================
*/

function compareContent(
  previous,
  content
) {
  if (!previous) {
    return {
      isNew: true,
      titleChanged: false,
      thumbnailChanged: false,
      scheduleChanged: false,
      endedChanged: false
    };
  }

  return {
    isNew: false,

    titleChanged:
      previous.title !==
      content.title,

    thumbnailChanged:
      previous.thumbnail_url !==
      content.thumbnail,

    scheduleChanged:
      previous.scheduled_start_time !==
      content.scheduledStartTime,

    endedChanged:
      Boolean(previous.ended_at) !==
      content.isEnded
  };
}


/*
=====================================================
Channel Polling
=====================================================
*/

function isPlaylistNotFoundError(error) {
  if (error?.response?.status !== 404) {
    return false;
  }

  const message =
    String(error.response?.data?.error?.message ?? "");

  return /playlistId|playlist identified/i.test(message);
}

function setChannelContentState(
  channelId,
  available,
  checkAt = null
) {
  const db = getDB();

  db.prepare(`
    UPDATE youtube_channels
    SET
      content_available = ?,
      content_check_at = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE channel_id = ?
  `).run(
    available ? 1 : 0,
    available ? null : (checkAt ?? Date.now()),
    channelId
  );
}

function markNoContent(channel, now) {
  if (channel.content_available !== 0) {
    console.warn(
      `YouTube channel ${channel.channel_id} has no accessible uploads playlist; pausing checks for 24 hours.`
    );
  }

  setChannelContentState(channel.channel_id, false, now);
}

async function checkChannelHasContent(channelId) {
  const data = await youtubeRequest(
    "search",
    {
      part: "snippet",
      channelId,
      type: "video",
      maxResults: 1
    },
    API_COSTS.search
  );

  return (data.items ?? []).length > 0;
}

async function refreshUploadsPlaylistId(channelId) {
  const channel = await getChannelById(channelId);

  const uploadsPlaylistId =
    channel?.contentDetails
      ?.relatedPlaylists
      ?.uploads ?? null;

  if (!uploadsPlaylistId) {
    return null;
  }
  const db = getDB();
  db.prepare(`
    UPDATE youtube_channels
    SET
      uploads_playlist_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE channel_id = ?
  `).run(
    uploadsPlaylistId,
    channelId
  );
  return uploadsPlaylistId;
}

export async function checkChannel(channel) {
  const now = Date.now();

  if (channel.content_available === 0) {
    const nextCheck =
      Number(channel.content_check_at ?? 0) +
      CONTENT_RECHECK_INTERVAL;

    if (now < nextCheck) {
      return [];
    }

    const hasContent =
      await checkChannelHasContent(channel.channel_id);

    if (!hasContent) {
      markNoContent(channel, now);
      return [];
    }

    setChannelContentState(channel.channel_id, true);

    if (!await refreshUploadsPlaylistId(channel.channel_id)) {
      markNoContent(channel, now);
      return [];
    }

    channel = getStoredChannel(channel.channel_id);
  }

  if (!channel.uploads_playlist_id) {
    markNoContent(channel, now);
    return [];
  }

  let recentIds;

  try {
    recentIds =
      await getRecentUploadIds(channel.uploads_playlist_id, 10, {quiet:true});
  } catch (error) {
    if (!isPlaylistNotFoundError(error)) {
      throw error;
    }

    const hasContent =
      await checkChannelHasContent(channel.channel_id);

    if (!hasContent) {
      markNoContent(channel, now);
      return [];
    }

    setChannelContentState(channel.channel_id, true);

    if (!await refreshUploadsPlaylistId(channel.channel_id)) {
      markNoContent(channel, now);
      return [];
    }

    channel = getStoredChannel(channel.channel_id);

    recentIds =
      await getRecentUploadIds(channel.uploads_playlist_id, 10, {quiet:true});
  }

  if (recentIds.length === 0) {
    return [];
  }

  if (!channel.last_upload_id) {
    updateLastUploadId(
      channel.channel_id,
      recentIds[0]
    );

    return [];
  }

  const newIds =
    getNewUploadIds(
      recentIds,
      channel.last_upload_id
    );

  if (newIds.length === 0) {
    return [];
  }

  const videos =
    await getVideos(newIds);

  const byId =
    new Map(
      videos.map(
        video => [
          video.id,
          video
        ]
      )
    );

  const results = [];

  for (const videoId of newIds) {
    const video =
      byId.get(videoId);

    if (!video) {
      continue;
    }

    const content =
      normalizeVideo(
        video,
        channel
      );

    const previous =
      getStoredContent(
        content.id
      );

    const changes =
      compareContent(
        previous,
        content
      );

    saveContent(content);

    results.push({
      content,
      changes
    });
  }

  updateLastUploadId(
    channel.channel_id,
    recentIds[0]
  );

  return results;
}

/*
=====================================================
Active Content Refresh
=====================================================
*/

function getRefreshableContent() {
  const db = getDB();

  return db.prepare(`
    SELECT
      youtube_content.video_id,
      youtube_content.channel_id,
      youtube_content.content_type,
      youtube_content.title,
      youtube_content.thumbnail_url,
      youtube_content.scheduled_start_time,
      youtube_content.discovered_at,
      youtube_content.ended_at,
      youtube_content.updated_at,

      youtube_channels.channel_name,
      youtube_channels.channel_url,
      youtube_channels.channel_handle,
      youtube_channels.uploads_playlist_id,
      youtube_channels.last_upload_id

    FROM youtube_content

    INNER JOIN youtube_channels
      ON youtube_channels.channel_id =
         youtube_content.channel_id

    WHERE
      (
        youtube_content.ended_at IS NULL
        AND
        (
          youtube_content.content_type = 'stream'
          OR
          youtube_content.content_type = 'premiere'
          OR
          (
            strftime(
              '%s',
              'now'
            ) -
            strftime(
              '%s',
              youtube_content.discovered_at
            )
          ) <= 1800
        )
      )

      OR

      (
        youtube_content.ended_at IS NOT NULL
        AND
        (
          strftime(
            '%s',
            'now'
          ) -
          strftime(
            '%s',
            youtube_content.ended_at
          )
        ) <= 1800
      )
  `).all();
}


export async function refreshActiveContent() {
  const rows =
    getRefreshableContent();

  if (rows.length === 0) {
    return [];
  }

  const videoIds =
    rows.map(
      row => row.video_id
    );

  const videos =
    await getVideos(videoIds);

  const rowMap =
    new Map(
      rows.map(
        row => [
          row.video_id,
          row
        ]
      )
    );

  const changes = [];

  for (const video of videos) {
    const row =
      rowMap.get(video.id);

    if (!row) {
      continue;
    }

    const content =
      normalizeVideo(
        video,
        row
      );

    const previous =
      getStoredContent(
        content.id
      );

    const contentChanges =
      compareContent(
        previous,
        content
      );

    saveContent(content);

    if (
      contentChanges.titleChanged ||
      contentChanges.thumbnailChanged ||
      contentChanges.scheduleChanged ||
      contentChanges.endedChanged
    ) {
      changes.push({
        content,
        changes: contentChanges
      });
    }
  }

  return changes;
}


/*
=====================================================
Ended Content Cleanup
=====================================================
*/

export function cleanupEndedContent() {
  const db = getDB();

  const cutoff =
    new Date(
      Date.now() -
      ENDED_CONTENT_RETENTION
    ).toISOString();

  const result =
    db.prepare(`
      DELETE FROM youtube_content
      WHERE ended_at IS NOT NULL
        AND ended_at <= ?
    `).run(cutoff);

  return result.changes;
}


/*
=====================================================
Manual Channel Refresh
=====================================================
*/

export async function refreshChannel(channelId) {
  const channel = getStoredChannel(channelId);
  if (!channel) throw new Error(`Unknown YouTube channel: ${channelId}`);

  const liveIds = await getCurrentLivestreamIds(channelId);
  const uploadIds = await getRecentUploadIds(channel.uploads_playlist_id,10);
  const videoIds = [...new Set([...liveIds,...uploadIds])];

  if (videoIds.length === 0) return [];

  const videos = await getVideos(videoIds);
  const results = [];

  for (const video of videos) {
    const content = normalizeVideo(video,channel);
    if (content.channelId !== channelId || content.isEnded) continue;

    const previous = getStoredContent(content.id);
    const changes = compareContent(previous,content);

    saveContent(content,false);
    results.push({content,changes});
  }

  results.sort((a,b) => {
    const getTime = content => {
      const value = content.actualStartTime ??
        content.publishedAt ??
        content.scheduledStartTime;
      const timestamp = value ? Date.parse(value) : 0;
      return Number.isFinite(timestamp)?timestamp:0;
    };

    if (a.content.isLive !== b.content.isLive) {
      return Number(b.content.isLive) - Number(a.content.isLive);
    }

    return getTime(b.content) - getTime(a.content);
  });

  return results;
}


/*
=====================================================
Initial Channel State
=====================================================
*/

export async function initializeChannel(channelId) {
  const channel =
    getStoredChannel(channelId);

  if (!channel) {
    throw new Error(
      `Unknown YouTube channel: ${channelId}`
    );
  }

  if (
    !channel.uploads_playlist_id
  ) {
    return false;
  }

  const recentIds =
    await getRecentUploadIds(
      channel.uploads_playlist_id
    );

  if (recentIds.length === 0) {
    return false;
  }

  if (!channel.last_upload_id) {
    updateLastUploadId(
      channel.channel_id,
      recentIds[0]
    );
  }

  return true;
}


/*
=====================================================
Monitor Configuration
=====================================================
*/

export const MONITOR_CONFIG = {
  checkInterval:
    CHECK_INTERVAL,

  metadataRefreshInterval:
    METADATA_REFRESH_INTERVAL,

  metadataRefreshDuration:
    METADATA_REFRESH_DURATION,

  endedContentRetention:
    ENDED_CONTENT_RETENTION
};
