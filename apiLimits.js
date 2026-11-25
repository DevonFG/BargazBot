import * as log from "./appLogger.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;

function utcDay() {return new Date().toISOString().slice(0, 10);}

function nextUtcMidnightMs() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

function nowMs() {return Date.now();}

function defaultState() {
  return {
    youtube: {day:utcDay(), units:0, searches:0, limitedUntil:0, searchLimitedUntil:0, lastAlertAt:0, lastReason:null},
    twitch:  {limitedUntil:0, lastAlertAt:0, lastReason:null, remaining:null, resetAt:null},
    kick:    {limitedUntil:0, authFailedUntil:0, lastAlertAt:0, lastReason:null}
  };
}

const state = defaultState();
let alertHandler = null;

export function setApiLimitAlertHandler(handler) {alertHandler = typeof handler === "function" ? handler : null;}

function ensureYoutubeDay() {
  const day = utcDay();
  if (state.youtube.day !== day) {
    state.youtube.day = day;
    state.youtube.units = 0;
    state.youtube.searches = 0;
    state.youtube.limitedUntil = 0;
    state.youtube.searchLimitedUntil = 0;
    state.youtube.lastReason = null;
  }
}

async function emitAlert(payload) {
  const key = `${payload.provider}:${payload.kind}`;
  const provider = state[payload.provider];
  if (!provider) {return;}
  if (nowMs() - (provider.lastAlertAt ?? 0) < ALERT_COOLDOWN_MS && !payload.recovered) {return;}
  provider.lastAlertAt = nowMs();
  provider.lastReason = payload.reason ?? provider.lastReason;
  if (alertHandler) {await alertHandler({...payload, key}).catch(error => log.warn("API limit alert failed:", error));}
}

function youtubeResetAt(kind) {
  ensureYoutubeDay();
  if (kind === "search") {return state.youtube.searchLimitedUntil || nextUtcMidnightMs();}
  return state.youtube.limitedUntil || nextUtcMidnightMs();
}

export function getLimitStatus(provider = null) {
  ensureYoutubeDay();
  if (provider) {return structuredClone(state[provider] ?? null);}
  return structuredClone(state);
}

export function isLimited(provider, kind = "any") {
  ensureYoutubeDay();
  const now = nowMs();
  if (provider === "youtube") {
    if (kind === "search") {return now < state.youtube.searchLimitedUntil || now < state.youtube.limitedUntil;}
    return now < state.youtube.limitedUntil;
  }
  if (provider === "twitch") {return now < state.youtube?.limitedUntil ? false : now < state.twitch.limitedUntil;}
  if (provider === "kick") {
    if (kind === "auth") {return now < state.kick.authFailedUntil;}
    return now < state.kick.limitedUntil || now < state.kick.authFailedUntil;
  }
  return false;
}

export function limitDetails(provider, kind = "any") {
  ensureYoutubeDay();
  if (provider === "youtube") {
    const limited = isLimited("youtube", kind);
    return {
      limited,
      kind: kind === "search" || nowMs() < state.youtube.searchLimitedUntil ? "search" : "quota",
      resetAt: youtubeResetAt(kind),
      reason: state.youtube.lastReason
    };
  }
  if (provider === "twitch") {
    return {limited:isLimited("twitch"), kind:"rate", resetAt:state.twitch.limitedUntil || state.twitch.resetAt, reason:state.twitch.lastReason};
  }
  if (provider === "kick") {
    const auth = nowMs() < state.kick.authFailedUntil;
    return {limited:isLimited("kick", kind), kind:auth ? "auth" : "rate", resetAt:auth ? state.kick.authFailedUntil : state.kick.limitedUntil, reason:state.kick.lastReason};
  }
  return {limited:false, kind:"unknown", resetAt:null, reason:null};
}

export function recordYouTubeUsage(units = 0, kind = "units") {
  ensureYoutubeDay();
  state.youtube.units += Math.max(0, Number(units) || 0);
  if (kind === "search") {state.youtube.searches += 1;}
}

export async function recordLimitHit(provider, details = {}) {
  ensureYoutubeDay();
  const now = nowMs();
  let resetAt = details.resetAt ? Number(details.resetAt) : null;
  if (resetAt && resetAt < 1e12) {resetAt *= 1000;}

  if (provider === "youtube") {
    const reason = String(details.reason ?? "").toLowerCase();
    const search = details.kind === "search" || reason.includes("search") || reason.includes("dailylimitexceeded");
    const until = resetAt || nextUtcMidnightMs();
    if (search) {state.youtube.searchLimitedUntil = Math.max(state.youtube.searchLimitedUntil, until);}
    else {state.youtube.limitedUntil = Math.max(state.youtube.limitedUntil, until);}
    state.youtube.lastReason = details.reason ?? (search ? "YouTube search quota reached" : "YouTube quota reached");
    await emitAlert({
      provider:"youtube", kind:search ? "search" : "quota", limited:true,
      resetAt:search ? state.youtube.searchLimitedUntil : state.youtube.limitedUntil,
      reason:state.youtube.lastReason,
      affected:search ? ["YouTube search/refresh", "social counters", "role rewards"] : ["YouTube notifications", "refresh", "social counters", "role rewards"]
    });
    return;
  }

  if (provider === "twitch") {
    const until = resetAt || now + Math.max(1000, Number(details.retryAfterMs ?? 60000));
    state.twitch.limitedUntil = Math.max(state.twitch.limitedUntil, until);
    state.twitch.resetAt = state.twitch.limitedUntil;
    state.twitch.remaining = details.remaining ?? state.twitch.remaining;
    state.twitch.lastReason = details.reason ?? "Twitch rate limit reached";
    await emitAlert({provider:"twitch", kind:"rate", limited:true, resetAt:state.twitch.limitedUntil, reason:state.twitch.lastReason, affected:["Twitch notifications", "Twitch social counters"]});
    return;
  }

  if (provider === "kick") {
    const auth = details.kind === "auth" || [401,403].includes(Number(details.status));
    const until = resetAt || now + Math.max(1000, Number(details.retryAfterMs ?? (auth ? 10 * 60 * 1000 : 60000)));
    if (auth) {state.kick.authFailedUntil = Math.max(state.kick.authFailedUntil, until);}
    else {state.kick.limitedUntil = Math.max(state.kick.limitedUntil, until);}
    state.kick.lastReason = details.reason ?? (auth ? "Kick authentication failed" : "Kick rate limit reached");
    await emitAlert({provider:"kick", kind:auth ? "auth" : "rate", limited:true, resetAt:until, reason:state.kick.lastReason, affected:["Kick notifications", "Kick social counters"]});
  }
}

export async function recordLimitRecovery(provider, kind = "any") {
  ensureYoutubeDay();
  const now = nowMs();
  if (provider === "youtube") {
    const wasLimited = isLimited("youtube", kind);
    if (kind === "search") {state.youtube.searchLimitedUntil = 0;}
    else {state.youtube.limitedUntil = 0;}
    if (wasLimited && !isLimited("youtube", kind)) {
      await emitAlert({provider:"youtube", kind, limited:false, recovered:true, resetAt:now, reason:"YouTube quota available again", affected:["YouTube features"]});
    }
    return;
  }
  if (provider === "twitch" && state.twitch.limitedUntil) {
    state.twitch.limitedUntil = 0; state.twitch.lastReason = null;
    await emitAlert({provider:"twitch", kind:"rate", limited:false, recovered:true, resetAt:now, reason:"Twitch rate limit cleared", affected:["Twitch features"]});
  }
  if (provider === "kick" && (state.kick.limitedUntil || state.kick.authFailedUntil)) {
    state.kick.limitedUntil = 0; state.kick.authFailedUntil = 0; state.kick.lastReason = null;
    await emitAlert({provider:"kick", kind, limited:false, recovered:true, resetAt:now, reason:"Kick limit cleared", affected:["Kick features"]});
  }
}

export function formatLimitMessage(provider, detail = {}) {
  const reset = detail.resetAt ? new Date(Number(detail.resetAt)).toLocaleString("en-US", {timeZone:"UTC", hour12:true, month:"short", day:"numeric", hour:"numeric", minute:"2-digit"}) + " UTC" : "later";
  const name = provider === "youtube" ? "YouTube" : provider === "twitch" ? "Twitch" : "Kick";
  if (detail.kind === "auth") {
    return `${name} authentication failed: ${detail.reason ?? "Unauthorized"}. Affected features may pause until credentials or app access are fixed.`;
  }
  return `${name} ${detail.kind ?? "limit"}: ${detail.reason ?? "limit reached"}. Affected features may pause until ${reset}.`;
}
