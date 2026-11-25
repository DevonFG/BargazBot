import crypto             from "node:crypto";
import * as log           from "./appLogger.js";
import * as roleRewards   from "./roleRewards.js";
import * as featureSettings from "./featureSettings.js";
import { getDB }          from "./storage.js";

const PROVIDERS = new Set(["streamlabs", "streamelements", "patreon", "kofi"]);

function key(provider) {
  const value = String(provider ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return PROVIDERS.has(value) ? value : null;
}

function header(headers, name) {
  return headers?.[name] ?? headers?.[name.toLowerCase()] ?? null;
}

function safeEqualHex(expected, actual) {
  try {return crypto.timingSafeEqual(Buffer.from(String(expected), "hex"), Buffer.from(String(actual), "hex"));}
  catch {return false;}
}

export function getWebhookProviders() {return [...PROVIDERS];}

export function registerWebhookEvent(provider, eventId) {
  if (!eventId) {return true;}
  return getDB().prepare(
    "INSERT OR IGNORE INTO webhook_events (provider, event_id) VALUES (?, ?)"
  ).run(provider, String(eventId)).changes > 0;
}

function eventId(provider, body, headers) {
  return String(
    header(headers, "x-event-id") ??
    header(headers, "x-webhook-id") ??
    body?.event_id ?? body?.id ?? body?.data?.id ?? body?.data?.message_id ??
    body?.event?.id ?? ""
  ) || null;
}

export function verifyWebhookSignature(provider, rawBody, headers, body = {}) {
  const name = key(provider);
  if (!name) {return false;}
  const secret = process.env[`${name.toUpperCase()}_WEBHOOK_SECRET`];
  if (!secret) {return true;}
  const text = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody ?? {});
  if (name === "patreon") {
    return safeEqualHex(
      crypto.createHmac("md5", secret).update(text).digest("hex"),
      header(headers, "x-patreon-signature") ?? ""
    );
  }
  if (name === "kofi") {
    const token = body?.data?.verification_token ?? body?.verification_token ?? "";
    return token === secret;
  }
  const signature = String(
    header(headers, "x-hub-signature-256") ??
    header(headers, "x-signature") ?? ""
  );
  try {
    const expected = `sha256=${crypto.createHmac("sha256", secret).update(text).digest("hex")}`;
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {return false;}
}

export async function handleWebhookRequest(client, provider, body = {}, headers = {}, rawBody = null) {
  const name = key(provider);
  if (!name) {return {ok:false, reason:"unknown-provider"};}
  if (!verifyWebhookSignature(name, rawBody ?? body, headers, body)) {
    log.warn("BargazBot webhook verification failed:", name);
    return {ok:false, reason:"invalid-signature"};
  }

  const config = featureSettings.getWebhookConfig("global");
  if (config.enabled === false) {return {ok:true, ignored:true};}

  const id = eventId(name, body, headers);
  if (id && !registerWebhookEvent(name, id)) {return {ok:true, duplicate:true};}

  try {
    const applied = await roleRewards.handleWebhookEvent(client, name, body);
    return {ok:true, applied};
  } catch (error) {
    log.error("BargazBot webhook handling failed:", name, error);
    return {ok:false, reason:"handler-error"};
  }
}
