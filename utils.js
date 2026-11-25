import * as discord from "discord.js";

// Sleep function for adding delays when needed
export function sleep(ms) {return new Promise(resolve => setTimeout(resolve, ms));}

// Creates a new timestamp of the current time
export function newTimestamp() {return new Date().toISOString();}

// Converts a JavaScript date object into a readable format
// e.g. "March 21 2026, 9:45 PM PDT"
export function formatTimestamp(date) {
  const value = date instanceof Date ? date : parseStoredDate(date);
  if (!value || Number.isNaN(value.getTime())) {return String(date ?? "None");}
  return value.toLocaleString("en-US", {
    month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
    timeZoneName: "short"
  });
}

// Converts normal text into Discord strikethrough format
export function strikethroughText(text) {return `~~${text}~~`;}

const DISCORD_LIMITS = {customId:100,label:100,value:100,description:100,placeholder:150,options:25,buttons:5};
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function clipText(value, max) {return String(value ?? "").slice(0, max);}

/*
=====================================================
Menu Helpers
=====================================================
*/

// Builds a consistent custom ID, e.g. menuId("notification", "edit", channelId)
export function menuId(...parts) {
  return clipText(parts.map(part => String(part ?? "").trim()).filter(Boolean).join(":"), DISCORD_LIMITS.customId);
}

// Splits a custom ID back into its parts for routing
export function parseMenuId(customId) {return String(customId ?? "").split(":");}

// Builds one select option with Discord's length limits applied
export function menuOption(label, value, description = "", isDefault = false) {
  const option = {
    label:   clipText(label || "Option", DISCORD_LIMITS.label),
    value:   clipText(value || "option", DISCORD_LIMITS.value),
    default: Boolean(isDefault)
  };
  if (description) {option.description = clipText(description, DISCORD_LIMITS.description);}
  return option;
}

// Builds an action row containing one string select menu
// config = {placeholder, minValues, maxValues, disabled}
export function buildSelectRow(customId, options, config = {}) {
  const choices = (options ?? []).slice(0, DISCORD_LIMITS.options);
  if (!choices.length) {throw new Error("A select menu needs at least one option.");}
  const maxValues = Math.max(1, Math.min(config.maxValues ?? 1, choices.length));
  const minValues = Math.max(0, Math.min(config.minValues ?? 1, maxValues));
  return new discord.ActionRowBuilder().addComponents(
    new discord.StringSelectMenuBuilder()
      .setCustomId(clipText(customId, DISCORD_LIMITS.customId))
      .setPlaceholder(clipText(config.placeholder || "Choose an option", DISCORD_LIMITS.placeholder))
      .setMinValues(minValues)
      .setMaxValues(maxValues)
      .setDisabled(Boolean(config.disabled))
      .addOptions(choices)
  );
}

// Builds an action row containing one mentionable select menu
// config = {placeholder, minValues, maxValues, disabled}
export function buildMentionableRow(customId, config = {}) {
  const maxValues = Math.max(1, Math.min(config.maxValues ?? 5, 5));
  const minValues = Math.max(0, Math.min(config.minValues ?? 0, maxValues));
  return new discord.ActionRowBuilder().addComponents(
    new discord.MentionableSelectMenuBuilder()
      .setCustomId(clipText(customId, DISCORD_LIMITS.customId))
      .setPlaceholder(clipText(config.placeholder || "Choose roles or users", DISCORD_LIMITS.placeholder))
      .setMinValues(minValues)
      .setMaxValues(maxValues)
      .setDisabled(Boolean(config.disabled))
  );
}

// Builds an action row of buttons
// buttons = [{customId, label, style, emoji, disabled, url}]
export function buildButtonRow(buttons) {
  const styles = {
    primary:   discord.ButtonStyle.Primary,
    secondary: discord.ButtonStyle.Secondary,
    success:   discord.ButtonStyle.Success,
    danger:    discord.ButtonStyle.Danger,
    link:      discord.ButtonStyle.Link
  };
  const components = (buttons ?? []).slice(0, DISCORD_LIMITS.buttons).map((button, index) => {
    const style = typeof button.style === "number" ? button.style : (styles[button.style] ?? discord.ButtonStyle.Secondary);
    const builder = new discord.ButtonBuilder().setStyle(style);
    if (style === discord.ButtonStyle.Link) {builder.setURL(button.url);}
    else {builder.setCustomId(clipText(button.customId || menuId("button", index), DISCORD_LIMITS.customId));}
    if (button.label) {builder.setLabel(clipText(button.label, DISCORD_LIMITS.label));}
    if (button.emoji) {builder.setEmoji(button.emoji);}
    if (button.disabled) {builder.setDisabled(true);}
    return builder;
  });
  return new discord.ActionRowBuilder().addComponents(...components);
}

// Clips text to a maximum length without creating mentions
export function clip(value, max = 100) {return String(value ?? "").slice(0, max);}

// Returns one clamped page of items with the page count
export function paged(items, page = 0, size = 25) {
  const list = Array.isArray(items) ? items : [];
  const pageCount = Math.max(1, Math.ceil(list.length / Math.max(1, size)));
  const current = Math.max(0, Math.min(pageCount - 1, Number(page) || 0));
  return {entries:list.slice(current * size, (current + 1) * size), page:current, pageCount};
}

// Builds a standard Prev/Next row with optional extra buttons
export function buildPagingRow(prefix, page, pageCount, buttons = []) {
  return buildButtonRow([
    {customId:menuId(prefix,"prev"), label:"Prev", style:"secondary", disabled:page <= 0},
    {customId:menuId(prefix,"next"), label:"Next", style:"secondary", disabled:page >= pageCount - 1},
    ...(buttons ?? []).slice(0, 3)
  ]);
}

// Splits long text into multiple fields that fit Discord's 1024-character limit
export function splitFields(name, text, max = 1024) {
  const value = String(text ?? "");
  if (!value) {return [{name, value:"None"}];}
  const parts = chunk([...value], max).map(part => part.join(""));
  return parts.length === 1
    ? [{name, value:parts[0]}]
    : parts.map((part, index) => ({name:`${name} (${index + 1}/${parts.length})`, value:part}));
}

// Builds a safe mention for a Discord id
export function mention(kind, id) {
  if (!id) {return "None";}
  if (kind === "role")   {return `<@&${id}>`;}
  if (kind === "user")   {return `<@${id}>`;}
  if (kind === "channel"){return `<#${id}>`;}
  return String(id);
}

// Replaces {variable} placeholders in a template string
export function renderTemplate(template, variables = {}) {
  return String(template ?? "").replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) =>
    Object.hasOwn(variables, key) ? String(variables[key] ?? "") : match
  );
}

// Returns a usable button emoji from a configured emoji or label
export function firstEmoji(value, fallback = "•") {
  const text = String(value ?? "").trim();
  if (!text) {return fallback;}
  const custom = /^<a?:\w+:\d+>$/.exec(text);
  if (custom) {return text;}
  return [...text][0] ?? fallback;
}

/*
=====================================================
Channel Helpers
=====================================================
*/

export function isTextChannel(channel) {
  return Boolean(
    channel &&
    channel.isTextBased() &&
    !channel.isThread() &&
    [discord.ChannelType.GuildText, discord.ChannelType.GuildAnnouncement].includes(channel.type)
  );
}

// Builds text and announcement channel options for a menu
export function textChannelOptions(guild, options = {}) {
  const list = [...(guild?.channels?.cache?.values() ?? [])]
    .filter(isTextChannel)
    .slice(0, options.limit ?? 24)
    .map(channel => menuOption(
      channel.name,
      channel.id,
      options.describe
        ? (channel.type === discord.ChannelType.GuildAnnouncement ? "Announcement channel" : "Text channel")
        : ""
    ));

  if (options.includeClear) {list.unshift(menuOption("Clear (unset)", "clear", "Remove this channel assignment"));}
  if (options.includeDefault) {list.unshift(menuOption("Default BargazBot channel", "default", "Use the server default channel"));}
  return list;
}

export function formatChannel(channelId) {
  return channelId ? `<#${channelId}>` : "Not configured";
}

export function channelIdFromChoice(value) {
  if (!value || value === "clear" || value === "default" || value === "none") {return null;}
  return String(value);
}

/*
=====================================================
Small Parsing Helpers
=====================================================
*/

export function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined) {return fallback;}
  if (typeof value !== "string") {return value;}
  try {return JSON.parse(value);} catch {return fallback;}
}

export function chunk(values, size = 10) {
  const list = [...(values ?? [])];
  const width = Math.max(1, Number(size) || 10);
  const result = [];
  for (let index = 0; index < list.length; index += width) {result.push(list.slice(index, index + width));}
  return result;
}

export function formatDuration(minutes) {
  const total = Math.max(0, Number(minutes) || 0);
  if (total < 60) {return `${total} minute${total === 1 ? "" : "s"}`;}
  const hours = Math.floor(total / 60);
  const rest  = total % 60;
  if (!rest) {return `${hours} hour${hours === 1 ? "" : "s"}`;}
  return `${hours} hour${hours === 1 ? "" : "s"} ${rest} minute${rest === 1 ? "" : "s"}`;
}

/*
=====================================================
Date and Timezone Helpers
=====================================================
*/

export function parseStoredDate(value) {
  if (value instanceof Date) {return value;}
  const text = String(value ?? "").trim();
  if (!text) {return null;}
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    const [, year, month, day, hour, minute, second = "00"] = match;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function relativeDayLabel(date, now) {
  const startTarget = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const startNow    = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days        = Math.round((startTarget - startNow) / 86400000);
  if (days === 0)  {return "today";}
  if (days === 1)  {return "tomorrow";}
  if (days === -1) {return "yesterday";}
  if (days > 1)    {return `in ${days} days`;}
  return `${Math.abs(days)} days ago`;
}

// Formats a timestamp like "Sunday, December 13, 2026 4:30 PM in 23 days"
// options = {timeZone, includeTime, now}
export function formatRelativeTimestamp(value, options = {}) {
  const date = parseStoredDate(value);
  if (!date) {return String(value ?? "None");}
  const includeTime = options.includeTime !== false;
  const settings = {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    ...(options.timeZone ? {timeZone: options.timeZone} : {}),
    ...(includeTime ? {hour: "numeric", minute: "2-digit", hour12: true} : {})
  };
  const base = new Intl.DateTimeFormat("en-US", settings).format(date);
  return `${base} ${relativeDayLabel(date, options.now ?? new Date())}`;
}

// Accepts IANA zones, UTC offsets, and local/server aliases
export function resolveTimezone(input, fallback = "UTC") {
  const value = String(input ?? "").trim();
  if (!value) {return fallback;}
  const normalized = value.toLowerCase();
  if (["local", "server", "here"].includes(normalized)) {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || fallback;
  }
  if (["utc", "gmt", "z"].includes(normalized)) {return "UTC";}

  const offset = normalized.match(/^(?:utc|gmt)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (offset) {
    const sign  = offset[1] === "-" ? -1 : 1;
    const hours = Math.min(14, Number(offset[2]));
    const minutes = offset[3] ? Math.min(59, Number(offset[3])) : 0;
    const etfSign = sign > 0 ? "-" : "+";
    return `Etc/GMT${etfSign}${hours}${minutes ? `:${minutes}` : ""}`;
  }

  try {
    new Intl.DateTimeFormat("en-US", {timeZone: value}).format(new Date());
    return value;
  } catch {
    return fallback;
  }
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const values = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {values[part.type] = Number(part.value);}
  }
  return values;
}

function zonedOffsetMs(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

// Converts wall-clock values in a timezone into a real Date
export function wallTimeToUtc(year, month, day, hour, minute, timeZone = "UTC") {
  const zone = resolveTimezone(timeZone);
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = zonedOffsetMs(new Date(guess), zone);
  return new Date(guess - offset);
}

// Parses timer input into a repeat rule or one-shot date
// Supports: cron:, every 30m, daily HH:MM, weekly Mon HH:MM, YYYY-MM-DD HH:MM, MM-DD HH:MM
export function parseTimerSchedule(input, timeZone = "UTC") {
  const text = String(input ?? "").trim();
  if (!text) {return {valid: false, reason: "empty"};}
  const zone = resolveTimezone(timeZone);

  if (/^cron:/i.test(text)) {
    return {valid: true, kind: "cron", expression: text.slice(5).trim()};
  }

  const every = text.match(/^every\s+(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/i);
  if (every) {
    const amount = Number(every[1]);
    const unit = every[2].toLowerCase();
    const multiplier = unit.startsWith("h") ? 60 : unit.startsWith("d") ? 1440 : 1;
    return {valid: amount > 0, kind: "interval", everyMinutes: amount * multiplier};
  }

  const daily = text.match(/^daily\s+(\d{1,2}):(\d{2})$/i);
  if (daily) {
    return {valid: true, kind: "daily", hour: Number(daily[1]), minute: Number(daily[2]), timeZone: zone};
  }

  const weekly = text.match(/^weekly\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}):(\d{2})$/i);
  if (weekly) {
    const name = weekly[1].toLowerCase();
    const full = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].includes(name)
      ? WEEKDAYS[["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(name)]
      : name;
    return {
      valid: true,
      kind: "weekly",
      weekday: WEEKDAYS.indexOf(full),
      hour: Number(weekly[2]),
      minute: Number(weekly[3]),
      timeZone: zone
    };
  }

  const dateTime = text.match(/^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (dateTime) {
    const now = new Date();
    const current = zonedParts(now, zone);
    const year = dateTime[1] ? Number(dateTime[1]) : current.year;
    const month = Number(dateTime[2]);
    const day = Number(dateTime[3]);
    const hour = dateTime[4] === undefined ? 9 : Number(dateTime[4]);
    const minute = dateTime[5] === undefined ? 0 : Number(dateTime[5]);
    let at = wallTimeToUtc(year, month, day, hour, minute, zone);
    if (!dateTime[1] && at.getTime() < now.getTime()) {
      at = wallTimeToUtc(year + 1, month, day, hour, minute, zone);
    }
    return {valid: true, kind: "once", at, timeZone: zone};
  }

  return {valid: false, reason: "unrecognized"};
}

// Calculates the next run time for a parsed schedule
export function nextOccurrence(schedule, now = new Date()) {
  if (!schedule?.valid) {return null;}
  if (schedule.kind === "once") {return schedule.at;}
  if (schedule.kind === "interval") {return new Date(now.getTime() + schedule.everyMinutes * 60000);}
  if (schedule.kind === "cron" || schedule.hour === undefined) {return null;}

  const zone = schedule.timeZone ?? "UTC";
  const parts = zonedParts(now, zone);
  const target = wallTimeToUtc(parts.year, parts.month, parts.day, schedule.hour, schedule.minute, zone);
  if (schedule.kind === "daily") {
    return target.getTime() > now.getTime() ? target : new Date(target.getTime() + 86400000);
  }
  if (schedule.kind === "weekly") {
    let offset = (schedule.weekday - parts.weekday + 7) % 7;
    if (offset === 0 && target.getTime() <= now.getTime()) {offset = 7;}
    return new Date(target.getTime() + offset * 86400000);
  }
  return null;
}
