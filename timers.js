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
import { randomUUID } from "node:crypto";

const CHECK_INTERVAL_MS = 60000;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const BIRTHDAY_MODES = new Set(["month", "day", "as-coming", "ascoming", "upcoming"]);

let client = null;
let checkHandle = null;
let birthdayHandle = null;
let messageHandler = null;
let checking = false;
let checkingBirthdays = false;

function ensureTimerTables() {
  const db = getDB();
  db.exec(`
    CREATE TABLE IF NOT EXISTS birthday_registrations (
      guild_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      birthday_date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (command_id, user_id),
      FOREIGN KEY (guild_id, command_id) REFERENCES birthday_commands(guild_id, command_id) ON DELETE CASCADE
    )
  `);
  const userBirthdayColumns = db.prepare("PRAGMA table_info(user_birthdays)").all().map(column => column.name);
  if (!userBirthdayColumns.includes("trigger_text")) {
    db.exec("ALTER TABLE user_birthdays ADD COLUMN trigger_text TEXT NOT NULL DEFAULT 'birthday'");
  }
}

function toBoolean(value) {
  return value === true || value === 1 || value === "1";
}

function parseIds(value) {
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function serverTimeZone() {
  return resolveTimezone(null, "UTC");
}

function userTimeZone(userId) {
  const settings = featureSettings.getUserDmSettings(userId);
  return resolveTimezone(settings?.timezone, serverTimeZone());
}

function timerOwner(ownerType, ownerId) {
  if (ownerType === "user") {
    return {table:"user_timers", key:"user_id", id:ownerId, guildId:null, userId:ownerId, timeZone:userTimeZone(ownerId)};
  }
  return {table:"timers", key:"guild_id", id:ownerId, guildId:ownerId, userId:null, timeZone:serverTimeZone()};
}

function birthdayOwner(ownerType, ownerId) {
  if (ownerType === "user") {
    return {table:"user_birthdays", key:"user_id", id:ownerId, guildId:null, userId:ownerId, commandId:ownerId, timeZone:userTimeZone(ownerId)};
  }
  return {table:"birthday_commands", key:"guild_id", id:ownerId, guildId:ownerId, userId:null, timeZone:serverTimeZone()};
}

function storedTime(value) {
  if (value === null || value === undefined || value === "") {return null;}
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {return numeric;}
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function isoTime(value) {
  const ms = storedTime(value);
  return ms ? new Date(ms).toISOString() : null;
}

function announceTime(value) {
  const ms = storedTime(value);
  if (!ms) {return "soon";}
  return formatRelativeTimestamp(new Date(ms).toISOString(), {
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

function formatTimer(row) {
  if (!row) {return null;}
  return {
    timerId: row.timer_id,
    guildId: row.guild_id ?? null,
    userId: row.user_id ?? null,
    name: row.name,
    kind: row.schedule_type ?? "once",
    schedule: row.schedule ?? row.trigger_text ?? "",
    message: row.message ?? "",
    channelId: row.channel_id ?? null,
    timeZone: row.timezone ?? null,
    nextRunAt: isoTime(row.next_run_at),
    lastRunAt: isoTime(row.last_run_at),
    enabled: toBoolean(row.enabled),
    createdAt: row.created_at ?? null
  };
}

function findTimerRow(ownerType, ownerId, timerId) {
  ensureTimerTables();
  const owner = timerOwner(ownerType, ownerId);
  return getDB().prepare(
    `SELECT * FROM ${owner.table} WHERE ${owner.key} = ? AND timer_id = ?`
  ).get(owner.id, timerId);
}

export function getTimer(ownerType, ownerId, timerId) {
  return formatTimer(findTimerRow(ownerType, ownerId, timerId));
}

export function getTimers(ownerType, ownerId) {
  ensureTimerTables();
  const owner = timerOwner(ownerType, ownerId);
  return getDB().prepare(
    `SELECT * FROM ${owner.table} WHERE ${owner.key} = ? ORDER BY next_run_at, timer_id`
  ).all(owner.id).map(formatTimer);
}

export function createTimer(ownerType, ownerId, data = {}) {
  ensureTimerTables();
  const owner = timerOwner(ownerType, ownerId);
  const input = String(data.schedule ?? data.input ?? data.triggerText ?? "").trim();
  const timeZone = resolveTimezone(data.timeZone ?? data.timezone ?? owner.timeZone, owner.timeZone);
  const parsed = parseTimerSchedule(input, timeZone);
  if (!parsed.valid) {throw new Error(`Invalid timer schedule: ${input || "(empty)"}`);}
  const next = nextOccurrence(parsed, new Date());
  if (!next) {throw new Error("That timer schedule cannot produce a next run time.");}

  const timerId = randomUUID();
  const name = String(data.name || "Reminder");
  const message = String(data.message ?? data.payload?.message ?? "Reminder: {name}");
  const dateFormat = String(data.dateFormat ?? data.date_format ?? "YYYY-MM-DD");
  const enabled = data.enabled === false ? 0 : 1;

  if (owner.table === "timers") {
    const roleIds = Array.isArray(data.roleIds) ? data.roleIds.map(String) : parseIds(data.roleIds);
    getDB().prepare(`
      INSERT INTO timers (
        timer_id, guild_id, user_id, name, message, channel_id, trigger_text,
        date_format, timezone, schedule, schedule_type, next_run_at,
        role_ids, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      timerId,
      owner.guildId,
      data.createdBy ?? data.userId ?? null,
      name,
      message,
      data.channelId ?? data.channel_id ?? null,
      input,
      dateFormat,
      timeZone,
      input,
      parsed.kind,
      next.getTime(),
      JSON.stringify(roleIds),
      enabled
    );
  } else {
    getDB().prepare(`
      INSERT INTO user_timers (
        user_id, timer_id, name, message, trigger_text, date_format, timezone,
        schedule, schedule_type, next_run_at, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      owner.userId,
      timerId,
      name,
      message,
      input,
      dateFormat,
      timeZone,
      input,
      parsed.kind,
      next.getTime(),
      enabled
    );
  }

  log.info("BargazBot timer created:", ownerType, owner.id, timerId, parsed.kind);
  return getTimer(ownerType, ownerId, timerId);
}

export function updateTimer(ownerType, ownerId, timerId, data = {}) {
  ensureTimerTables();
  const owner = timerOwner(ownerType, ownerId);
  const existingRow = findTimerRow(ownerType, ownerId, timerId);
  if (!existingRow) {return null;}
  const existing = formatTimer(existingRow);

  const scheduleChanged = data.schedule !== undefined || data.input !== undefined || data.triggerText !== undefined;
  const input = scheduleChanged
    ? String(data.schedule ?? data.input ?? data.triggerText ?? "").trim()
    : existing.schedule;
  const timeZone = data.timeZone !== undefined || data.timezone !== undefined
    ? resolveTimezone(data.timeZone ?? data.timezone, existing.timeZone ?? owner.timeZone)
    : (existing.timeZone ?? owner.timeZone);
  const parsed = parseTimerSchedule(input, timeZone);
  if (!parsed.valid) {throw new Error(`Invalid timer schedule: ${input || "(empty)"}`);}

  let nextAt = storedTime(existing.nextRunAt);
  if (scheduleChanged) {
    const next = nextOccurrence(parsed, new Date());
    if (!next) {throw new Error("That timer schedule cannot produce a next run time.");}
    nextAt = next.getTime();
  }

  const name = data.name !== undefined ? String(data.name) : existing.name;
  const message = data.message !== undefined ? String(data.message) : existing.message;
  const enabled = data.enabled !== undefined ? (toBoolean(data.enabled) ? 1 : 0) : (existing.enabled ? 1 : 0);

  if (owner.table === "timers") {
    const roleIds = data.roleIds !== undefined
      ? (Array.isArray(data.roleIds) ? data.roleIds.map(String) : parseIds(data.roleIds))
      : parseIds(existingRow.role_ids);
    getDB().prepare(`
      UPDATE timers
      SET name = ?, message = ?, channel_id = ?, trigger_text = ?, timezone = ?,
          schedule = ?, schedule_type = ?, next_run_at = ?, role_ids = ?,
          enabled = ?, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND timer_id = ?
    `).run(
      name,
      message,
      data.channelId !== undefined ? data.channelId : (data.channel_id !== undefined ? data.channel_id : existing.channelId),
      input,
      timeZone,
      input,
      parsed.kind,
      nextAt,
      JSON.stringify(roleIds),
      enabled,
      owner.id,
      timerId
    );
  } else {
    getDB().prepare(`
      UPDATE user_timers
      SET name = ?, message = ?, trigger_text = ?, timezone = ?,
          schedule = ?, schedule_type = ?, next_run_at = ?, enabled = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND timer_id = ?
    `).run(name, message, input, timeZone, input, parsed.kind, nextAt, enabled, owner.id, timerId);
  }

  log.info("BargazBot timer updated:", ownerType, owner.id, timerId);
  return getTimer(ownerType, ownerId, timerId);
}

export function deleteTimer(ownerType, ownerId, timerId) {
  ensureTimerTables();
  const owner = timerOwner(ownerType, ownerId);
  const result = getDB().prepare(
    `DELETE FROM ${owner.table} WHERE ${owner.key} = ? AND timer_id = ?`
  ).run(owner.id, timerId);
  if (result.changes > 0) {log.info("BargazBot timer deleted:", ownerType, owner.id, timerId);}
  return result.changes > 0;
}

function normalizeAnnounceMode(value) {
  const raw = String(value ?? "day").toLowerCase();
  return ["as-coming", "ascoming", "upcoming"].includes(raw) ? "as-coming" : "day";
}

function formatBirthdayCommand(row, ownerType = "guild") {
  if (!row) {return null;}
  const commandId = ownerType === "user" ? row.user_id : row.command_id;
  return {
    commandId,
    timerId: commandId,
    guildId: row.guild_id ?? null,
    userId: row.user_id ?? null,
    name: row.trigger_text || "Birthday command",
    triggerText: row.trigger_text ?? (ownerType === "user" ? "birthday" : ""),
    dateFormat: row.date_format ?? "MM-DD",
    channelId: row.channel_id ?? null,
    roleIds: parseIds(row.role_ids),
    message: row.message ?? "Happy birthday, {user}!",
    announceMode: normalizeAnnounceMode(row.announce_mode ?? row.mode),
    announceDaysBefore: Math.max(0, Number(row.announce_days_before ?? 0) || 0),
    timeZone: row.timezone ?? row.time_zone ?? null,
    enabled: toBoolean(row.enabled),
    lastRunAt: isoTime(row.last_run_at ?? row.last_announced_at),
    nextRunAt: isoTime(row.next_run_at),
    birthdayDate: row.birthday_date ?? null
  };
}

function findBirthdayRow(ownerType, ownerId, commandId) {
  ensureTimerTables();
  const owner = birthdayOwner(ownerType, ownerId);
  if (owner.table === "user_birthdays") {
    return getDB().prepare("SELECT * FROM user_birthdays WHERE user_id = ?").get(owner.id);
  }
  return getDB().prepare(
    "SELECT * FROM birthday_commands WHERE guild_id = ? AND command_id = ?"
  ).get(owner.id, commandId);
}

export function getBirthdayCommand(ownerType, ownerId, commandId) {
  return formatBirthdayCommand(findBirthdayRow(ownerType, ownerId, commandId), ownerType);
}

export function getBirthdayCommands(ownerType, ownerId) {
  ensureTimerTables();
  const owner = birthdayOwner(ownerType, ownerId);
  const rows = owner.table === "user_birthdays"
    ? getDB().prepare("SELECT * FROM user_birthdays WHERE user_id = ? ORDER BY created_at").all(owner.id)
    : getDB().prepare("SELECT * FROM birthday_commands WHERE guild_id = ? ORDER BY created_at, command_id").all(owner.id);
  return rows.map(row => formatBirthdayCommand(row, ownerType));
}

export function createBirthdayCommand(ownerType, ownerId, data = {}) {
  ensureTimerTables();
  const owner = birthdayOwner(ownerType, ownerId);
  const trigger = String(data.triggerText ?? data.trigger_text ?? "birthday").trim() || "birthday";
  const dateFormat = String(data.dateFormat ?? data.date_format ?? "MM-DD");
  const announceMode = normalizeAnnounceMode(data.announceMode ?? data.announce_mode ?? data.mode ?? "day");
  const announceDaysBefore = Math.max(0, Number(data.announceDaysBefore ?? data.announce_days_before ?? 7) || 7);
  const roleIds = Array.isArray(data.roleIds) ? data.roleIds.map(String) : parseIds(data.roleIds ?? data.role_ids);
  const message = String(data.message ?? "Happy birthday, {user}!");
  const timeZone = resolveTimezone(data.timeZone ?? data.time_zone ?? owner.timeZone, owner.timeZone);
  const enabled = data.enabled === false ? 0 : 1;
  const commandId = owner.table === "user_birthdays" ? owner.commandId : randomUUID();

  if (owner.table === "birthday_commands") {
    getDB().prepare(`
      INSERT INTO birthday_commands (
        command_id, guild_id, user_id, birthday_date, birthday_month, birthday_day,
        birthday_year, trigger_text, date_format, channel_id, role_ids, message,
        announce_mode, announce_days_before, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      commandId,
      owner.guildId,
      data.createdBy ?? data.userId ?? null,
      null,
      null,
      null,
      null,
      trigger,
      dateFormat,
      data.channelId ?? data.channel_id ?? null,
      JSON.stringify(roleIds),
      message,
      announceMode,
      announceDaysBefore,
      enabled
    );
  } else {
    getDB().prepare(`
      INSERT INTO user_birthdays (
        user_id, trigger_text, birthday_date, date_format, message, announce_mode,
        announce_days_before, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        trigger_text = excluded.trigger_text,
        date_format = excluded.date_format,
        message = excluded.message,
        announce_mode = excluded.announce_mode,
        announce_days_before = excluded.announce_days_before,
        enabled = excluded.enabled,
        updated_at = CURRENT_TIMESTAMP
    `).run(owner.userId, trigger, null, dateFormat, message, announceMode, announceDaysBefore, enabled);
  }

  log.info("BargazBot birthday command created:", ownerType, owner.id, commandId, trigger);
  return getBirthdayCommand(ownerType, ownerId, commandId);
}

export function updateBirthdayCommand(ownerType, ownerId, commandId, data = {}) {
  ensureTimerTables();
  const owner = birthdayOwner(ownerType, ownerId);
  const existing = getBirthdayCommand(ownerType, ownerId, commandId);
  if (!existing) {return null;}

  const trigger = data.triggerText !== undefined || data.trigger_text !== undefined
    ? String(data.triggerText ?? data.trigger_text).trim()
    : existing.triggerText;
  const dateFormat = data.dateFormat !== undefined || data.date_format !== undefined
    ? String(data.dateFormat ?? data.date_format)
    : existing.dateFormat;
  const announceMode = data.announceMode !== undefined || data.announce_mode !== undefined || data.mode !== undefined
    ? normalizeAnnounceMode(data.announceMode ?? data.announce_mode ?? data.mode)
    : existing.announceMode;
  const announceDaysBefore = data.announceDaysBefore !== undefined || data.announce_days_before !== undefined
    ? Math.max(0, Number(data.announceDaysBefore ?? data.announce_days_before ?? 0) || 0)
    : existing.announceDaysBefore;
  const message = data.message !== undefined ? String(data.message) : existing.message;
  const enabled = data.enabled !== undefined ? (toBoolean(data.enabled) ? 1 : 0) : (existing.enabled ? 1 : 0);

  if (owner.table === "birthday_commands") {
    const roleIds = data.roleIds !== undefined
      ? (Array.isArray(data.roleIds) ? data.roleIds.map(String) : parseIds(data.roleIds))
      : existing.roleIds;
    getDB().prepare(`
      UPDATE birthday_commands
      SET trigger_text = ?, date_format = ?, channel_id = ?, role_ids = ?, message = ?,
          announce_mode = ?, announce_days_before = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
      WHERE guild_id = ? AND command_id = ?
    `).run(
      trigger,
      dateFormat,
      data.channelId !== undefined ? data.channelId : (data.channel_id !== undefined ? data.channel_id : existing.channelId),
      JSON.stringify(roleIds),
      message,
      announceMode,
      announceDaysBefore,
      enabled,
      owner.id,
      commandId
    );
  } else {
    getDB().prepare(`
      UPDATE user_birthdays
      SET trigger_text = ?, date_format = ?, message = ?, announce_mode = ?,
          announce_days_before = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(trigger, dateFormat, message, announceMode, announceDaysBefore, enabled, owner.id);
  }

  log.info("BargazBot birthday command updated:", ownerType, owner.id, commandId);
  return getBirthdayCommand(ownerType, ownerId, commandId);
}

export function deleteBirthdayCommand(ownerType, ownerId, commandId) {
  ensureTimerTables();
  const owner = birthdayOwner(ownerType, ownerId);
  const result = owner.table === "user_birthdays"
    ? getDB().prepare("DELETE FROM user_birthdays WHERE user_id = ?").run(owner.id)
    : getDB().prepare("DELETE FROM birthday_commands WHERE guild_id = ? AND command_id = ?").run(owner.id, commandId);
  if (result.changes > 0) {log.info("BargazBot birthday command deleted:", ownerType, owner.id, commandId);}
  return result.changes > 0;
}

export function getBirthdayEntries(ownerType, ownerId, commandId = null) {
  ensureTimerTables();
  const owner = birthdayOwner(ownerType, ownerId);
  if (owner.table === "user_birthdays") {
    const row = getDB().prepare("SELECT * FROM user_birthdays WHERE user_id = ?").get(owner.id);
    if (!row || !row.birthday_date) {return [];}
    return [{
      guildId: null,
      commandId: owner.commandId,
      userId: owner.userId,
      birthdayDate: row.birthday_date
    }];
  }
  const rows = commandId
    ? getDB().prepare("SELECT * FROM birthday_registrations WHERE guild_id = ? AND command_id = ? ORDER BY birthday_date").all(owner.id, commandId)
    : getDB().prepare("SELECT * FROM birthday_registrations WHERE guild_id = ? ORDER BY birthday_date").all(owner.id);
  return rows.map(row => ({
    guildId: row.guild_id,
    commandId: row.command_id,
    userId: row.user_id,
    birthdayDate: row.birthday_date
  }));
}

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
    INSERT INTO birthday_registrations (guild_id, command_id, user_id, birthday_date, created_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(command_id, user_id) DO UPDATE SET birthday_date = excluded.birthday_date
  `).run(message.guild.id, command.commandId, message.author.id, stored);
  log.info("BargazBot birthday registered:", message.guild.id, command.commandId, message.author.id, stored);
  await message.reply({
    content: `Saved your birthday as **${stored}**.`,
    allowedMentions: {parse: []}
  }).catch(() => {});
}

function handleBirthdayMessage(message) {
  if (!client || !message.guild || message.author.bot || !message.content) {return;}
  if (!featureSettings.isFeatureEnabled(message.guild.id, "timers")) {return;}
  const lower = message.content.toLowerCase();
  for (const command of getBirthdayCommands("guild", message.guild.id)) {
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

    const dateText = message.content.slice(lower.indexOf(trigger) + trigger.length).trim();
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

async function findUsableChannel(guild, channelId) {
  const configured = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
  if (configured?.isTextBased() && !configured.isThread() && configured.guild?.id === guild.id) {
    return configured;
  }
  const allowed = new Set([discord.ChannelType.GuildText, discord.ChannelType.GuildAnnouncement]);
  for (const candidate of guild.channels.cache.values()) {
    if (candidate.isTextBased() && !candidate.isThread() && allowed.has(candidate.type)) {
      return candidate;
    }
  }
  return null;
}

async function fireTimer(guild, timer) {
  const channel = await findUsableChannel(guild, timer.channelId);
  if (!channel) {
    log.warn("BargazBot timer has no usable channel:", guild.id, timer.timerId);
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
    log.info("BargazBot timer fired:", guild.id, timer.timerId, channel.id);
  } catch (error) {
    log.error("BargazBot timer delivery failed:", guild.id, timer.timerId, error);
    return;
  }

  const db = getDB();
  const now = Date.now();
  if (timer.kind === "once") {
    db.prepare("UPDATE timers SET enabled = 0, next_run_at = NULL, last_run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND timer_id = ?")
      .run(now, guild.id, timer.timerId);
    return;
  }

  const parsed = parseTimerSchedule(timer.schedule, timer.timeZone ?? serverTimeZone());
  const next = parsed.valid ? nextOccurrence(parsed, new Date()) : null;
  if (next) {
    db.prepare("UPDATE timers SET next_run_at = ?, last_run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND timer_id = ?")
      .run(next.getTime(), now, guild.id, timer.timerId);
  } else {
    db.prepare("UPDATE timers SET enabled = 0, next_run_at = NULL, last_run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND timer_id = ?")
      .run(now, guild.id, timer.timerId);
    log.warn("BargazBot recurring timer stopped after final run:", guild.id, timer.timerId, timer.kind);
  }
}

async function runTimerCheck() {
  if (checking || !client) {return;}
  checking = true;
  try {
    for (const guild of client.guilds.cache.values()) {
      if (!featureSettings.isFeatureEnabled(guild.id, "timers")) {continue;}
      const due = getDB().prepare(`
        SELECT * FROM timers
        WHERE guild_id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at
      `).all(guild.id, Date.now());
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

async function announceBirthdays(guild, command, entries) {
  if (entries.length === 0) {return;}
  const channel = await findUsableChannel(guild, command.channelId);
  if (!channel) {
    log.warn("BargazBot birthday command has no usable channel:", guild.id, command.commandId);
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
    getDB().prepare("UPDATE birthday_commands SET last_run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ? AND command_id = ?")
      .run(Date.now(), guild.id, command.commandId);
    log.info("BargazBot birthday announcement posted:", guild.id, command.commandId, entries.length);
  } catch (error) {
    log.error("BargazBot birthday announcement failed:", guild.id, command.commandId, error);
  }
}

async function runBirthdayCheck() {
  if (checkingBirthdays || !client) {return;}
  checkingBirthdays = true;
  const now = new Date();
  try {
    for (const guild of client.guilds.cache.values()) {
      if (!featureSettings.isFeatureEnabled(guild.id, "timers")) {continue;}
      for (const command of getBirthdayCommands("guild", guild.id)) {
        if (!command.enabled) {continue;}
        if (command.lastRunAt) {
          const last = new Date(command.lastRunAt);
          if (!Number.isNaN(last.getTime()) && last.toDateString() === now.toDateString()) {continue;}
        }
        const entries = getBirthdayEntries("guild", guild.id, command.commandId);
        const matches = [];
        const daysBefore = command.announceDaysBefore || 7;
        for (const entry of entries) {
          const parsed = parseBirthdayDate(entry.birthdayDate, command.dateFormat);
          if (!parsed) {continue;}
          if (command.announceMode === "as-coming") {
            const next = nextBirthdayDate(parsed, now);
            if (!next) {continue;}
            const days = Math.ceil((next.getTime() - now.getTime()) / 86400000);
            if (days <= daysBefore) {matches.push(entry);}
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
