import crypto             from "node:crypto";
import * as log           from "./appLogger.js";
import * as guildLogger   from "./guildLogger.js";
import * as notifications from "./notifications.js";
import * as featureSettings from "./featureSettings.js";
import { getDB }          from "./storage.js";

const PROVIDERS = new Set(["youtube", "twitch", "kick"]);
const OAUTH = {
  youtube:{auth:"https://accounts.google.com/o/oauth2/v2/auth", token:"https://oauth2.googleapis.com/token", scope:"https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/userinfo.profile"},
  twitch: {auth:"https://id.twitch.tv/oauth2/authorize",        token:"https://id.twitch.tv/oauth2/token",        scope:"user:read:email"},
  kick:   {auth:"https://id.kick.com/oauth/authorize",          token:"https://id.kick.com/oauth/token",          scope:"user:read"}
};

function key(platform) {
  const value = String(platform ?? "").toLowerCase();
  if (!PROVIDERS.has(value)) {throw new Error(`Unsupported OAuth provider: ${platform}`);}
  return value;
}

const PKCE_VERIFIERS = new Map();

function startPkce(state) {
  const verifier = crypto.randomBytes(48).toString("base64url");
  PKCE_VERIFIERS.set(state, {verifier, expires:Date.now() + 10 * 60 * 1000});
  return {verifier, challenge:crypto.createHash("sha256").update(verifier).digest("base64url")};
}

function consumePkce(state, provider) {
  if (provider !== "kick") {return null;}
  const entry = PKCE_VERIFIERS.get(state);
  PKCE_VERIFIERS.delete(state);
  return entry && entry.expires > Date.now() ? entry.verifier : null;
}

function credentials(platform) {
  const prefix = key(platform).toUpperCase();
  return {id:process.env[`${prefix}_CLIENT_ID`] ?? null, secret:process.env[`${prefix}_CLIENT_SECRET`] ?? null};
}

export function isProviderConfigured(platform) {
  const config = credentials(platform);
  return Boolean(config.id && config.secret && process.env.PUBLIC_BASE_URL);
}

export function getRedirectUri(platform) {
  const base = String(process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/oauth/${key(platform)}/callback`;
}

export function buildAuthorizationUrl(platform, state) {
  const provider = key(platform);
  if (!isProviderConfigured(provider)) {throw new Error(`${provider} OAuth is not configured.`);}
  const config = OAUTH[provider];
  const creds = credentials(provider);
  const params = new URLSearchParams({
    client_id:creds.id,
    redirect_uri:getRedirectUri(provider),
    response_type:"code",
    scope:config.scope,
    state
  });
  if (provider === "youtube") {params.set("access_type", "offline"); params.set("prompt", "consent");}
  if (provider === "kick") {
    const {challenge} = startPkce(state);
    params.set("code_challenge", challenge);
    params.set("code_challenge_method", "S256");
  }
  return `${config.auth}?${params}`;
}

export function createOAuthState(guildId, userId, platform) {
  const provider = key(platform);
  const state = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  getDB().prepare(`
    INSERT INTO oauth_states (state, guild_id, user_id, platform, created_at, expires_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
  `).run(state, String(guildId), String(userId), provider, expiresAt);
  return state;
}

export function consumeOAuthState(state, platform) {
  const provider = key(platform);
  const row = getDB().prepare(
    "SELECT * FROM oauth_states WHERE state = ? AND platform = ?"
  ).get(String(state ?? ""), provider);
  getDB().prepare("DELETE FROM oauth_states WHERE state = ?").run(String(state ?? ""));
  if (!row || Date.parse(row.expires_at) < Date.now()) {return null;}
  return row;
}

async function tokenRequest(platform, params) {
  const provider = key(platform);
  const creds = credentials(provider);
  const response = await fetch(OAUTH[provider].token, {
    method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({client_id:creds.id, client_secret:creds.secret, ...params})
  });
  if (!response.ok) {throw new Error(`${provider} token request failed: ${response.status}`);}
  return response.json();
}

async function exchangeCode(platform, code, state) {
  const provider = key(platform);
  const params = {
    code,
    grant_type:"authorization_code",
    redirect_uri:getRedirectUri(provider)
  };
  if (provider === "kick") {
    const verifier = consumePkce(state, provider);
    if (!verifier) {throw new Error("Kick PKCE verifier expired; restart the link.");}
    params.code_verifier = verifier;
  }
  return tokenRequest(platform, params);
}

function expiryFrom(tokens) {
  const seconds = Number(tokens.expires_in ?? 3600);
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function fetchAccount(platform, tokens) {
  const provider = key(platform);
  const access = tokens.access_token;
  if (provider === "youtube") {
    const profile = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers:{authorization:`Bearer ${access}`}
    }).then(response => response.json()).catch(() => ({}));
    const channels = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
      headers:{authorization:`Bearer ${access}`}
    }).then(response => response.json()).catch(() => ({}));
    const channel = channels.items?.[0];
    return {
      providerAccountId:channel?.id ?? profile.sub,
      username:channel?.snippet?.title ?? profile.name ?? "YouTube account"
    };
  }
  if (provider === "twitch") {
    const profile = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers:{authorization:`OAuth ${access}`}
    }).then(response => response.json()).catch(() => ({}));
    return {providerAccountId:profile.user_id, username:profile.login ?? "Twitch account"};
  }
  const profile = await fetch("https://api.kick.com/public/v1/users", {
    headers:{authorization:`Bearer ${access}`}
  }).then(response => response.json()).catch(() => ({}));
  const user = profile.data?.[0] ?? {};
  return {providerAccountId:String(user.user_id ?? user.id ?? ""), username:user.name ?? "Kick account"};
}

export async function handleOAuthCallback(client, payload = {}) {
  const provider = key(payload.platform);
  const state = consumeOAuthState(payload.state, provider);
  if (!state) {return {success:false, reason:"invalid-state"};}

  try {
    const tokens = await exchangeCode(provider, payload.code, payload.state);
    const account = await fetchAccount(provider, tokens);
    if (!account.providerAccountId) {return {success:false, reason:"no-account"};}

    getDB().prepare(`
      INSERT INTO account_links (
        guild_id, user_id, platform, provider_account_id, username,
        access_token, refresh_token, expires_at, linked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id, user_id, platform) DO UPDATE SET
        provider_account_id = excluded.provider_account_id,
        username = excluded.username,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        linked_at = CURRENT_TIMESTAMP
    `).run(
      state.guild_id, state.user_id, provider, account.providerAccountId, account.username,
      tokens.access_token, tokens.refresh_token ?? null, expiryFrom(tokens)
    );

    const guild = client?.guilds?.cache?.get(state.guild_id) ?? null;
    if (guild) {
      guildLogger.logCategoryEvent(guild, "account-linking", {
        title:"Account linked",
        description:"A user linked an external account.",
        user:{id:state.user_id},
        fields:[
          {name:"Platform", value:provider, inline:true},
          {name:"Account", value:account.username, inline:true}
        ]
      }).catch(() => {});
    }
    return {success:true, account:{...account, platform:provider}};
  } catch (error) {
    log.error("BargazBot OAuth callback failed:", provider, error);
    return {success:false, reason:"callback-error"};
  }
}

export function getLinkedAccount(guildId, userId, platform) {
  return getDB().prepare(
    "SELECT * FROM account_links WHERE guild_id = ? AND user_id = ? AND platform = ?"
  ).get(guildId, userId, key(platform)) ?? null;
}

export function listLinkedAccounts(guildId, userId) {
  return getDB().prepare(
    "SELECT * FROM account_links WHERE guild_id = ? AND user_id = ? ORDER BY platform ASC"
  ).all(guildId, userId);
}

export function listGuildLinks(guildId) {
  return getDB().prepare(
    "SELECT * FROM account_links WHERE guild_id = ? ORDER BY platform ASC"
  ).all(guildId);
}

export function findLinkByProviderAccount(provider, providerAccountId) {
  return getDB().prepare(
    "SELECT * FROM account_links WHERE platform = ? AND provider_account_id = ? ORDER BY linked_at DESC LIMIT 1"
  ).get(key(provider), String(providerAccountId)) ?? null;
}

export function unlinkAccount(guildId, userId, platform) {
  return getDB().prepare(
    "DELETE FROM account_links WHERE guild_id = ? AND user_id = ? AND platform = ?"
  ).run(guildId, userId, key(platform)).changes > 0;
}

export async function getValidAccessToken(guildId, userId, platform) {
  const provider = key(platform);
  const link = getLinkedAccount(guildId, userId, provider);
  if (!link) {return null;}
  if (!link.expires_at || Date.parse(link.expires_at) > Date.now() + 60000) {return link.access_token;}
  if (!link.refresh_token) {return link.access_token;}

  try {
    const tokens = await tokenRequest(provider, {grant_type:"refresh_token", refresh_token:link.refresh_token});
    getDB().prepare(`
      UPDATE account_links
      SET access_token = ?, refresh_token = ?, expires_at = ?, linked_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND user_id = ? AND platform = ?
    `).run(
      tokens.access_token, tokens.refresh_token ?? link.refresh_token, expiryFrom(tokens),
      guildId, userId, provider
    );
    return tokens.access_token;
  } catch (error) {
    log.warn("BargazBot token refresh failed:", provider, guildId, error);
    return link.access_token;
  }
}

export function getPublicAccount(client, guildId, userId, platform) {
  const provider = key(platform);
  const link = getLinkedAccount(guildId, userId, provider);
  if (link) {
    return {
      platform:provider,
      accountId:link.provider_account_id,
      username:link.username,
      source:"linked",
      userId:link.user_id
    };
  }
  const config = featureSettings.getAccountLinkConfig(guildId);
  if (config.publicFallback === false) {return null;}
  const subscription = notifications.getGuildSubscriptions(guildId, provider)[0] ?? null;
  if (!subscription) {return null;}
  return {
    platform:provider,
    accountId:subscription.channelId,
    username:subscription.channelName,
    source:"subscription",
    userId:null
  };
}
