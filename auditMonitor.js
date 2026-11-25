import * as discord        from "discord.js";
import * as log            from "./appLogger.js";
import * as guildLogger    from "./guildLogger.js";
import * as featureSettings from "./featureSettings.js";

const lastSeen = new Map();
let timer = null;

function eventName(action) {
  switch (action) {
    case discord.AuditLogEvent.RoleUpdate:      return "role-update";
    case discord.AuditLogEvent.RoleCreate:      return "role-create";
    case discord.AuditLogEvent.RoleDelete:      return "role-delete";
    case discord.AuditLogEvent.ChannelUpdate:   return "channel-update";
    case discord.AuditLogEvent.ChannelCreate:   return "channel-create";
    case discord.AuditLogEvent.ChannelDelete:   return "channel-delete";
    case discord.AuditLogEvent.MemberKick:      return "member-kick";
    case discord.AuditLogEvent.MemberBanAdd:    return "member-ban";
    case discord.AuditLogEvent.MemberRoleUpdate:return "member-role-update";
    case discord.AuditLogEvent.MemberUpdate:    return "member-update";
    default: return null;
  }
}

function targetLabel(entry) {
  return String(entry.target?.name ?? entry.target?.tag ?? entry.targetId ?? "Unknown");
}

function permissionChange(entry) {
  const changes = [...(entry.changes?.values() ?? [])];
  const change = changes.find(row => row.key === "permissions");
  return change ? {old:change.old, new:change.new} : null;
}

async function logEntry(guild, entry, event) {
  if (event === "role-update") {
    const change = permissionChange(entry);
    if (change) {
      await guildLogger.logRolePermissionChange(guild, {
        user:entry.executor,
        role:entry.target,
        previous:change.old,
        current:change.new
      });
      return;
    }
  }
  await guildLogger.logModerationAction(guild, {
    title:`Audit: ${event}`,
    description:`${entry.executor?.tag ?? "Someone"} performed ${event}.`,
    user:entry.executor,
    fields:[
      {name:"Target", value:targetLabel(entry), inline:true},
      {name:"Reason", value:entry.reason ?? "None", inline:false}
    ]
  });
}

export async function checkGuildAudit(guild) {
  if (!featureSettings.isFeatureEnabled(guild.id, "logs")) {return 0;}
  const config = featureSettings.getAuditMonitorConfig(guild.id);
  if (config.enabled === false) {return 0;}
  if (!guild.members.me?.permissions?.has(discord.PermissionFlagsBits.ViewAuditLog)) {return 0;}

  const entries = await guild.auditLogs.fetch({limit:20}).catch(() => null);
  if (!entries?.size) {return 0;}

  const seen = lastSeen.get(guild.id) ?? null;
  const ordered = [...entries.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  let handled = 0;

  for (const entry of ordered) {
    if (seen?.id === entry.id) {break;}
    if (seen?.createdAt && entry.createdTimestamp <= seen.createdAt) {continue;}
    const event = eventName(entry.action);
    if (!event) {continue;}
    if (Array.isArray(config.events) && config.events.length && !config.events.includes(event)) {continue;}
    await logEntry(guild, entry, event);
    handled++;
  }

  const newest = ordered[0];
  lastSeen.set(guild.id, {id:newest.id, createdAt:newest.createdTimestamp});
  return handled;
}

export async function checkAllAudit(client) {
  let handled = 0;
  for (const guild of client.guilds.cache.values()) {
    handled += await checkGuildAudit(guild).catch(error => {
      log.warn("Audit monitor failed:", guild.id, error);
      return 0;
    });
  }
  return handled;
}

export function resetAuditCursor(guildId) {lastSeen.delete(guildId);}

export function startAuditMonitor(client) {
  if (timer) {return;}
  timer = setInterval(() => {
    checkAllAudit(client).catch(error => log.warn("Audit monitor tick failed:", error));
  }, 60000);
  timer.unref?.();
}

export function stopAuditMonitor() {
  if (timer) {clearInterval(timer);}
  timer = null;
  lastSeen.clear();
}
