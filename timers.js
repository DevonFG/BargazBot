import * as discord from "discord.js";
import * as log from "./appLogger.js";
import * as featureSettings from "./featureSettings.js";
import { getDB } from "./storage.js";
import {
  formatRelativeTimestamp,
  parseTimerSchedule,
  nextOccurrence,
  resolveTimezone,
  safeJsonParse
} from "./utils.js";
import {
  trackInterval,
  trackTimeout,
  clearTrackedTimer,
  trackBackgroundTask,
  trackBotCallback
} from "./lifecycle.js";

const CHECK_INTERVAL_MS = 60000;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const BIRTHDAY_MODES = new Set(["month", "as-coming", "ascoming", "upcoming"]);

let client = null;
let checkHandle = null;
let birthdayHandle = null;
let messageHandler = null;
let checking = false;
let checkingBirthdays = false;

/*
=====================================================
Storage
=====================================================
*/

function ensureTimerTables() {
  const db = getDB();
  db.exec(`
    CREATE TABLE IF NOT EXISTS timers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'once',
      schedule TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT 'Reminder: {name}',
      channel_id TEXT,
      time_zone TEXT,
      next_run_at DATETIME,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS birthday_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      trigger_text TEXT NOT NULL,
      date_format TEXT NOT NULL DEFAULT 'MM-DD',
      channel_id TEXT,
      role_ids TEXT,
      message TEXT NOT NULL DEFAULT 'Happy birthday, {user}!',
      mode TEXT NOT NULL DEFAULT 'month',
      time_zone TEXT,
      last_announced_at DATETIME,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS birthday_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      command_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      birthday_date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (command_id, user_id),
      FOREIGN KEY (command_id) REFERENCES birthday_commands(id) ON DELETE CASCADE
    )
  `);

  const addColumns = (table, columns) => {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
    for (const [column, definition] of Object.entries(columns)) {
      if (!existing.includes(column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    }
  };
  addColumns("timers", {
    kind: "TEXT NOT NULL DEFAULT 'once'",
    schedule: "TEXT NOT NULL DEFAULT ''",
    message: "TEXT NOT NULL DEFAULT 'Reminder: {name}'",
    channel_id: "TEXT",
    time_zone: "TEXT",
    next_run_at: "DATETIME",
    enabled: "INTEGER NOT NULL DEFAULT 1",
    created_by: "TEXT"
  });
  addColumns("birthday_commands", {
    name: "TEXT NOT NULL DEFAULT 'Birthday command'",
    trigger_text: "TEXT NOT NULL DEFAULT ''",
    date_format: "TEXT NOT NULL DEFAULT 'MM-DD'",
    channel_id: "TEXT",
    role_ids: "TEXT",
    message: "TEXT NOT NULL DEFAULT 'Happy birthday, {user}!'",
    mode: "TEXT NOT NULL DEFAULT 'month'",
    time_zone: "TEXT",
    last_announced_at: "DATETIME",
    enabled: "INTEGER NOT NULL DEFAULT 1"
  });
}

function toBoolean(value) {
  return value === true || value === 1 || value === "1";
}

/*
=====================================================
Formatting
=====================================================
*/

function serverTimeZone() {
  return resolveTimezone(null, "UTC");
}

function announceTime(value) {
  if (!value) {return "soon";}
  return formatRelativeTimestamp(value, {
    timeZone: serverTimeZone(),
    includeTime: true,
    now: new Date()
  });
}

function applyTemplate(template, values) {
  let text = String(template || "");
  for (const [key, value] of Object.entries(values)) {
    text = text.replaceAll(`{${key}}`, String(value ?? ""));
  }
  return text;
}

function monthNumber(name) {
  const index = MONTHS.indexOf(String(name || "").trim().toLowerCase().slice(0, 3));
  return index >= 0 ? index + 1 : null;
}

function parseBirthdayDate(text, dateFormat) {
  const value = String(text || "").trim();
  const format = String(dateFormat || "MM-DD").toUpperCase();
  let month = null;
  let day = null;
  let year = null;

  if (format === "YYYY-MM-DD") {
    const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);}
  } else if (format === "DD/MM" || format === "DD-MM") {
    const match = value.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
    if (match) {day = Number(match[1]); month = Number(match[2]);}
  } else if (format === "MONTH DD" || format === "MMMM D") {
    const match = value.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
    if (match) {month = monthNumber(match[1]); day = Number(match[2]);}
  } else {
    const match = value.match(/^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/);
    if (match) {year = match[1] ? Number(match[1]) : null; month = Number(match[2]); day = Number(match[3]);}
  }

  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) {return null;}
  return {month, day, year};
}

function nextBirthdayDate(birthday, from = new Date()) {
  const now = new Date(from);
  for (let offset = 0; offset <= 1; offset++) {
    const year = now.getFullYear() + offset;
    const candidate = new Date(year, birthday.month - 1, birthday.day, 9, 0, 0);
    if (candidate.getTime() >= now.getTime()) {return candidate;}
  }
  return null;
}

/*
=====================================================
Timer CRUD
=====================================================
*/

function formatTimer(row) {
  if (!row) {return null;}
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    name: row.name,
    kind: row.kind ?? "once",
    schedule: row.schedule ?? "",
    message: row.message ?? "",
    channelId: row.channel_id ?? null,
    timeZone: row.time_zone ?? null,
    nextRunAt: row.next_run_at ?? null,
    enabled: toBoolean(row.enabled),
    createdBy: row.created_by ?? null
  };
}

export function getTimers(guildId) {
  ensureTimerTables();
  return getDB().prepare(
    "SELECT * FROM timers WHERE guild_id = ? ORDER BY next_run_at, id"
  ).all(guildId).map(formatTimer);
}

export function createTimer(guildId, data = {}) {
  ensureTimerTables();
  const input = String(data.schedule ?? data.input ?? "").trim();
  const timeZone = resolveTimezone(data.timeZone ?? data.time_zone ?? data.timezone, serverTimeZone());
  const schedule = parseTimerSchedule(input, timeZone);
  if (!schedule.valid) {
    throw new Error(`Invalid timer schedule: ${input || "(empty)"}`);
  }
  const nextAt = nextOccurrence(schedule, new Date());
  if (!nextAt) {
    throw new Error("That timer schedule cannot produce a next run time.");
  }
  const result = getDB().prepare(`
    INSERT INTO timers (
      guild_id, name, kind, schedule, message, channel_id, time_zone,
      next_run_at, enabled, created_by, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    guildId,
    String(data.name || "Reminder"),
    schedule.kind,
    input,
    String(data.message || "Reminder: {name}"),
    data.channelId ?? data.channel_id ?? null,
    timeZone,
    nextAt.toISOString(),
    data.enabled === false ? 0 : 1,
    data.createdBy ?? data.created_by ?? null
  );
  log.info("BargazBot timer created:", guildId, result.lastInsertRowid, schedule.kind, nextAt.toISOString());
  return formatTimer(getDB().prepare("SELECT * FROM timers WHERE id = ?").get(result.lastInsertRowid));
}

export function updateTimer(guildId, timerId, data = {}) {
  ensureTimerTables();
  const existing = getDB().prepare("SELECT * FROM timers WHERE guild_id = ? AND id = ?").get(guildId, timerId);
  if (!existing) {return null;}
  const name = data.name !== undefined ? String(data.name) : existing.name;
  const message = data.message !== undefined ? String(data.message) : existing.message;
  const channelId = data.channelId !== undefined ? data.channelId : (data.channel_id !== undefined ? data.channel_id : existing.channel_id);
  const enabled = data.enabled !== undefined ? toBoolean(data.enabled) : toBoolean(existing.enabled);

  let scheduleText = existing.schedule;
  let kind = existing.kind;
  let timeZone = existing.time_zone;
  let nextAt = existing.next_run_at;

  if (data.schedule !== undefined || data.input !== undefined) {
    scheduleText = String(data.schedule ?? data.input ?? "").trim();
    timeZone = resolveTimezone(data.timeZone ?? data.time_zone ?? timeZone, serverTimeZone());
    const schedule = parseTimerSchedule(scheduleText, timeZone);
    if (!schedule.valid) {throw new Error(`Invalid timer schedule: ${scheduleText || "(empty)"}`);}
    const computed = nextOccurrence(schedule, new Date());
    if (!computed) {throw new Error("That timer schedule cannot produce a next run time.");}
    kind = schedule.kind;
    nextAt = computed.toISOString();
  }

  getDB().prepare(`
    UPDATE timers
    SET name = ?, message = ?, channel_id = ?, enabled = ?,
        kind = ?, schedule = ?, time_zone = ?, next_run_at = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = ? AND id = ?
  `).run(name, message, channelId ?? null, enabled ? 1 : 0, kind, scheduleText, timeZone, nextAt, guildId, timerId);
  log.info("BargazBot timer updated:", guildId, timerId);
  return formatTimer(getDB().prepare("SELECT * FROM timers WHERE id = ?").get(timerId));
}

export function deleteTimer(guildId, timerId) {
  ensureTimerTables();
  const result = getDB().prepare("DELETE FROM timers WHERE guild_id = ? AND id = ?").run(guildId, timerId);
  if (result.changes > 0) {log.info("BargazBot timer deleted:", guildId, timerId);}
  return result.changes > 0;
}

/*
=====================================================
Birthday Command CRUD
=====================================================
*/

function formatBirthdayCommand(row) {
  if (!row) {return null;}
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    name: row.name,
    triggerText: row.trigger_text,
    dateFormat: row.date_format,
    channelId: row.channel_id ?? null,
    roleIds: safeJsonParse(row.role_ids, []) ?? [],
    message: row.message ?? "",
    mode: row.mode ?? "month",
    timeZone: row.time_zone ?? null,
    enabled: toBoolean(row.enabled),
    lastAnnouncedAt: row.last_announced_at ?? null
  };
}

export function getBirthdayCommands(guildId) {
  ensureTimerTables();
  return getDB().prepare(
    "SELECT * FROM birthday_commands WHERE guild_id = ? ORDER BY id"
  ).all(guildId).map(formatBirthdayCommand);
}

export function createBirthdayCommand(guildId, data = {}) {
  ensureTimerTables();
  const trigger = String(data.triggerText ?? data.trigger_text ?? "").trim();
  if (!trigger) {throw new Error("A birthday command needs trigger text.");}
  const modeRaw = String(data.mode ?? "month").toLowerCase();
  const mode = BIRTHDAY_MODES.has(modeRaw) ? (modeRaw.startsWith("as") || modeRaw === "upcoming" ? "as-coming" : "month") : "month";
  const roleIds = Array.isArray(data.roleIds) ? data.roleIds : (safeJsonParse(data.roleIds ?? data.role_ids, []) ?? []);
  const result = getDB().prepare(`
    INSERT INTO birthday_commands (
      guild_id, name, trigger_text, date_format, channel_id, role_ids,
      message, mode, time_zone, enabled, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    guildId,
    String(data.name || trigger),
    trigger,
    String(data.dateFormat ?? data.date_format ?? "MM-DD"),
    data.channelId ?? data.channel_id ?? null,
    JSON.stringify(roleIds),
    String(data.message || "Happy birthday, {user}!"),
    mode,
    resolveTimezone(data.timeZone ?? data.time_zone ?? null, serverTimeZone()),
    data.enabled === false ? 0 : 1
  );
  log.info("BargazBot birthday command created:", guildId, result.lastInsertRowid, trigger);
  return formatBirthdayCommand(getDB().prepare("SELECT * FROM birthday_commands WHERE id = ?").get(result.lastInsertRowid));
}

export function updateBirthdayCommand(guildId, commandId, data = {}) {
  ensureTimerTables();
  const existing = getDB().prepare("SELECT * FROM birthday_commands WHERE guild_id = ? AND id = ?").get(guildId, commandId);
  if (!existing) {return null;}
  const merged = {...formatBirthdayCommand(existing), ...data};
  const modeRaw = String(merged.mode ?? "month").toLowerCase();
  const mode = BIRTHDAY_MODES.has(modeRaw) ? (modeRaw.startsWith("as") || modeRaw === "upcoming" ? "as-coming" : "month") : "month";
  const roleIds = Array.isArray(merged.roleIds) ? merged.roleIds : (safeJsonParse(merged.roleIds, []) ?? []);
  getDB().prepare(`
    UPDATE birthday_commands
    SET name = ?, trigger_text = ?, date_format = ?, channel_id = ?, role_ids = ?,
        message = ?, mode = ?, time_zone = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = ? AND id = ?
  `).run(
    String(merged.name ?? "Birthday command"),
    String(merged.triggerText ?? ""),
    String(merged.dateFormat ?? "MM-DD"),
    merged.channelId ?? null,
    JSON.stringify(roleIds),
    String(merged.message ?? "Happy birthday, {user}!"),
    mode,
    resolveTimezone(merged.timeZone ?? null, serverTimeZone()),
    merged.enabled === false ? 0 : 1,
    guildId,
    commandId
  );
  log.info("BargazBot birthday command updated:", guildId, commandId);
  return formatBirthdayCommand(getDB().prepare("SELECT * FROM birthday_commands WHERE id = ?").get(commandId));
}

export function deleteBirthdayCommand(guildId, commandId) {
  ensureTimerTables();
  const result = getDB().prepare("DELETE FROM birthday_commands WHERE guild_id = ? AND id = ?").run(guildId, commandId);
  if (result.changes > 0) {log.info("BargazBot birthday command deleted:", guildId, commandId);}
  return result.changes > 0;
}

export function getBirthdayEntries(guildId, commandId = null) {
  ensureTimerTables();
  const query = commandId
    ? "SELECT * FROM birthday_entries WHERE guild_id = ? AND command_id = ? ORDER BY birthday_date"
    : "SELECT * FROM birthday_entries WHERE guild_id = ? ORDER BY birthday_date";
  const rows = commandId ? getDB().prepare(query).all(guildId, commandId) : getDB().prepare(query).all(guildId);
  return rows.map(row => ({
    id: Number(row.id),
    guildId: row.guild_id,
    commandId: Number(row.command_id),
    userId: row.user_id,
    birthdayDate: row.birthday_date
  }));
}

/*
=====================================================
Birthday Trigger Handling
=====================================================
*/

async function registerBirthdayFromMessage(message, command, dateText) {
  const parsed = parseBirthdayDate(dateText, command.dateFormat);
  if (!parsed) {
    await message.reply({
      content: `That date does not match the expected format (${command.dateFormat}).`,
      allowedMentions: {parse: []}
    }).catch(() => {});
    return;
  }
  const stored = parsed.year
    ? `${String(parsed.year).padStart(4, "0")}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`
    : `${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`;
  getDB().prepare(`
    INSERT INTO birthday_entries (guild_id, command_id, user_id, birthday_date, created_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(command_id, user_id) DO UPDATE SET birthday_date = excluded.birthday_date
  `).run(message.guild.id, command.id, message.author.id, stored);
  log.info("BargazBot birthday registered:", message.guild.id, command.id, message.author.id, stored);
  await message.reply({
    content: `Saved your birthday as **${stored}**.`,
    allowedMentions: {parse: []}
  }).catch(() => {});
}

function handleBirthdayMessage(message) {
  if (!client || !message.guild || message.author.bot || !message.content) {return;}
  if (!featureSettings.isFeatureEnabled(message.guild.id, "timers")) {return;}
  const lower = message.content.toLowerCase();
  for (const command of getBirthdayCommands(message.guild.id)) {
    if (!command.enabled || !command.triggerText) {continue;}
    const trigger = command.triggerText.toLowerCase();
    if (!lower.includes(trigger)) {continue;}

    if (command.roleIds.length > 0) {
      const memberRoles = message.member?.roles?.cache;
      if (!memberRoles || !command.roleIds.some(roleId => memberRoles.has(roleId))) {
        message.reply({
          content: "You do not have a role allowed to use this birthday command.",
          allowedMentions: {parse: []}
        }).catch(() => {});
        return;
      }
    }

    const dateText = message.content.slice(message.content.toLowerCase().indexOf(trigger) + trigger.length).trim();
    if (!dateText) {
      message.reply({
        content: `Include a birthday in ${command.dateFormat} format after the trigger.`,
        allowedMentions: {parse: []}
      }).catch(() => {});
      return;
    }
    trackBackgroundTask(registerBirthdayFromMessage(message, command, dateText), "birthday registration");
    return;
  }
}

/*
=====================================================
Timer Delivery
=====================================================
*/

async function fireTimer(guild, timer) {
  let channel = null;
  if (timer.channelId) {
    channel = await client.channels.fetch(timer.channelId).catch(() => null);
    if (!channel?.isTextBased() || channel.isThread() || channel.guild?.id !== guild.id) {
      log.warn("BargazBot timer channel unavailable:", guild.id, timer.id, timer.channelId);
      channel = null;
    }
  }
  if (!channel) {
    for (const candidate of guild.channels.cache.values()) {
      if (candidate.isTextBased() && !candidate.isThread() && candidate.type === discord.ChannelType.GuildText) {
        channel = candidate;
        break;
      }
    }
  }
  if (!channel) {
    log.warn("BargazBot timer has no usable channel:", guild.id, timer.id);
    return;
  }

  const content = applyTemplate(timer.message || "Reminder: {name}", {
    name: timer.name,
    channel: `<#${channel.id}>`,
    time: announceTime(timer.nextRunAt),
    date: announceTime(timer.nextRunAt)
  });
  try {
    await channel.send({content, allowedMentions: {parse: []}});
    log.info("BargazBot timer fired:", guild.id, timer.id, channel.id);
  } catch (error) {
    log.error("BargazBot timer delivery failed:", guild.id, timer.id, error);
    return;
  }

  const db = getDB();
  if (timer.kind === "once") {
    db.prepare("UPDATE timers SET enabled = 0, next_run_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(timer.id);
  } else {
    const schedule = parseTimerSchedule(timer.schedule, timer.timeZone ?? serverTimeZone());
    const next = schedule.valid ? nextOccurrence(schedule, new Date()) : null;
    if (next) {
      db.prepare("UPDATE timers SET next_run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(next.toISOString(), timer.id);
    } else {
      db.prepare("UPDATE timers SET enabled = 0, next_run_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(timer.id);
      log.warn("BargazBot recurring timer stopped after final run:", guild.id, timer.id, timer.kind);
    }
  }
}

async function runTimerCheck() {
  if (checking || !client) {return;}
  checking = true;
  const now = Date.now();
  try {
    for (const guild of client.guilds.cache.values()) {
      if (!featureSettings.isFeatureEnabled(guild.id, "timers")) {continue;}
      const due = getDB().prepare(`
        SELECT * FROM timers
        WHERE guild_id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at
      `).all(guild.id, new Date(now).toISOString());
      for (const row of due) {
        await fireTimer(guild, formatTimer(row));
      }
    }
  } catch (error) {
    log.error("BargazBot timer monitor cycle failed:", error);
  } finally {
    checking = false;
  }
}

/*
=====================================================
Birthday Announcements
=====================================================
*/

async function announceBirthdays(guild, command, entries) {
  if (entries.length === 0) {return;}
  let channel = await client.channels.fetch(command.channelId).catch(() => null);
  if (!channel?.isTextBased() || channel.isThread() || channel.guild?.id !== guild.id) {
    log.warn("BargazBot birthday command channel unavailable:", guild.id, command.id, command.channelId);
    return;
  }

  const names = entries.map(entry => `<@${entry.userId}>`).join(", ");
  const content = applyTemplate(command.message || "Happy birthday, {user}!", {
    user: names,
    users: names,
    channel: `<#${channel.id}>`,
    count: String(entries.length)
  });
  try {
    await channel.send({content, allowedMentions: {parse: ["users"]}});
    getDB().prepare("UPDATE birthday_commands SET last_announced_at = CURRENT_TIMESTAMP WHERE id = ?").run(command.id);
    log.info("BargazBot birthday announcement posted:", guild.id, command.id, entries.length);
  } catch (error) {
    log.error("BargazBot birthday announcement failed:", guild.id, command.id, error);
  }
}

async function runBirthdayCheck() {
  if (checkingBirthdays || !client) {return;}
  checkingBirthdays = true;
  const now = new Date();
  try {
    for (const guild of client.guilds.cache.values()) {
      if (!featureSettings.isFeatureEnabled(guild.id, "timers")) {continue;}
      for (const command of getBirthdayCommands(guild.id)) {
        if (!command.enabled || !command.channelId) {continue;}
        if (command.lastAnnouncedAt) {
          const last = new Date(command.lastAnnouncedAt);
          if (!Number.isNaN(last.getTime()) && last.toDateString() === now.toDateString()) {continue;}
        }
        const entries = getBirthdayEntries(guild.id, command.id);
        const matches = [];
        for (const entry of entries) {
          const parsed = parseBirthdayDate(entry.birthdayDate, command.dateFormat);
          if (!parsed) {continue;}
          if (command.mode === "as-coming") {
            const next = nextBirthdayDate(parsed, now);
            if (!next) {continue;}
            const days = Math.ceil((next.getTime() - now.getTime()) / 86400000);
            if (days <= 7) {matches.push(entry);}
          } else if (parsed.month === now.getMonth() + 1) {
            matches.push(entry);
          }
        }
        if (matches.length > 0) {
          await announceBirthdays(guild, command, matches);
        }
      }
    }
  } catch (error) {
    log.error("BargazBot birthday monitor cycle failed:", error);
  } finally {
    checkingBirthdays = false;
  }
}

/*
=====================================================
Service Lifecycle
=====================================================
*/

export function startTimers(discordClient) {
  if (checkHandle) {return;}
  client = discordClient;
  ensureTimerTables();
  messageHandler = trackBotCallback(handleBirthdayMessage);
  client.on("messageCreate", messageHandler);
  checkHandle = trackInterval(() => trackBackgroundTask(runTimerCheck(), "timer check"), CHECK_INTERVAL_MS, "timer monitor");
  birthdayHandle = trackInterval(() => trackBackgroundTask(runBirthdayCheck(), "birthday check"), CHECK_INTERVAL_MS, "birthday monitor");
  trackTimeout(() => trackBackgroundTask(runTimerCheck(), "initial timer check"), 5000, "initial timer check");
  trackTimeout(() => trackBackgroundTask(runBirthdayCheck(), "initial birthday check"), 10000, "initial birthday check");
  log.info("BargazBot timers and birthdays started.");
}

export function stopTimers() {
  if (messageHandler && client) {
    client.off("messageCreate", messageHandler);
    messageHandler = null;
  }
  if (checkHandle) {clearTrackedTimer(checkHandle); checkHandle = null;}
  if (birthdayHandle) {clearTrackedTimer(birthdayHandle); birthdayHandle = null;}
  client = null;
  log.info("BargazBot timers and birthdays stopped.");
}