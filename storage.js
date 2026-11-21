import Database from "better-sqlite3";
import {DB_DIR, DB_PATH} from "./config.js";
import fs from "node:fs";

let db;
let databaseClosing = false;

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`Added BargazBot ${table}.${column}.`);
  }
}

// Initialize SQLite connection & Schema
export function initDB() {
  fs.mkdirSync(DB_DIR, {recursive: true});
  databaseClosing = false;
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      paid_until DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS guilds (
      guild_id TEXT PRIMARY KEY,
      guild_name TEXT,
      owner_id TEXT,
      installer_user_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS guild_members (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS user_entitlements (
      user_id TEXT PRIMARY KEY,
      youtube_limit INTEGER DEFAULT NULL,
      twitch_limit INTEGER DEFAULT NULL,
      kick_limit INTEGER DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS entitlement_allocations (
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      youtube_limit INTEGER DEFAULT 0,
      twitch_limit INTEGER DEFAULT 0,
      kick_limit INTEGER DEFAULT 0,
      auto_allocated INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, guild_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      announcement_channel_id TEXT,
      welcome_channel_id TEXT,
      goodbye_channel_id TEXT,
      logs_channel_id TEXT,
      updates_channel_id TEXT,
      status_channel_id TEXT,
      notification_dedupe_hours INTEGER NOT NULL DEFAULT 24,
      setup_complete INTEGER NOT NULL DEFAULT 0,
      installer_user_id TEXT,
      welcome_message TEXT,
      goodbye_message TEXT,
      notice_channel_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS guild_log_settings (
      guild_id TEXT NOT NULL,
      category TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, category),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS youtube_channels (
      channel_id TEXT PRIMARY KEY,
      channel_name TEXT,
      channel_url TEXT,
      channel_handle TEXT,
      uploads_playlist_id TEXT,
      last_upload_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS youtube_recent_ids (
      channel_id TEXT NOT NULL,
      content_type TEXT NOT NULL,
      newest_id TEXT,
      previous_id TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (channel_id, content_type),
      FOREIGN KEY (channel_id) REFERENCES youtube_channels(channel_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS twitch_channels (
      channel_id TEXT PRIMARY KEY,
      channel_name TEXT,
      channel_url TEXT,
      channel_handle TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS kick_channels (
      channel_id TEXT PRIMARY KEY,
      channel_name TEXT,
      channel_url TEXT,
      channel_handle TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS guild_youtube_subs (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      nickname TEXT,
      discord_channel_id TEXT,
      custom_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, channel_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES youtube_channels(channel_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS guild_twitch_subs (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      nickname TEXT,
      discord_channel_id TEXT,
      custom_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, channel_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES twitch_channels(channel_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS guild_kick_subs (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      nickname TEXT,
      discord_channel_id TEXT,
      custom_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, channel_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES kick_channels(channel_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS youtube_content (
      video_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      content_type TEXT NOT NULL,
      title TEXT,
      thumbnail_url TEXT,
      scheduled_start_time DATETIME,
      discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (channel_id) REFERENCES youtube_channels(channel_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS twitch_content (
      stream_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      title TEXT,
      thumbnail_url TEXT,
      discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (channel_id) REFERENCES twitch_channels(channel_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS kick_content (
      channel_id TEXT PRIMARY KEY,
      title TEXT,
      thumbnail_url TEXT,
      started_at DATETIME,
      discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (channel_id) REFERENCES kick_channels(channel_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS guild_permissions (
      guild_id TEXT NOT NULL,
      permission_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      can_manage_permissions INTEGER NOT NULL DEFAULT 0 CHECK (can_manage_permissions IN (0,1)),
      source TEXT NOT NULL DEFAULT 'manual',
      is_implicit INTEGER NOT NULL DEFAULT 0,
      installer_grant INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, permission_type, target_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS guild_permission_profiles (
      guild_id TEXT NOT NULL,
      permission_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      access_level TEXT NOT NULL DEFAULT 'configuration'
        CHECK (access_level IN ('full', 'configuration', 'custom')),
      can_delete_data INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, permission_type, target_id),
      FOREIGN KEY (guild_id, permission_type, target_id)
        REFERENCES guild_permissions(guild_id, permission_type, target_id)
        ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS guild_command_permissions (
      guild_id TEXT NOT NULL,
      permission_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      command_name TEXT NOT NULL,
      allowed INTEGER NOT NULL DEFAULT 0
        CHECK (allowed IN (0,1)),
      PRIMARY KEY (guild_id, permission_type, target_id, command_name),
      FOREIGN KEY (guild_id, permission_type, target_id)
        REFERENCES guild_permissions(guild_id, permission_type, target_id)
        ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS notification_messages (
      guild_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      content_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      creator_channel_id TEXT,
      content_title TEXT,
      discord_channel_id TEXT NOT NULL,
      discord_message_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, platform, content_id, event_type),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS notification_message_options (
      guild_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      mention_roles TEXT NOT NULL DEFAULT '[]',
      mention_users TEXT NOT NULL DEFAULT '[]',
      show_creator_on_edit INTEGER NOT NULL DEFAULT 0 CHECK (show_creator_on_edit IN (0,1)),
      allowed_kinds TEXT NOT NULL DEFAULT '[]',
      allow_multiple_per_channel INTEGER NOT NULL DEFAULT 0 CHECK (allow_multiple_per_channel IN (0,1)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, platform, channel_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS notification_configs (
      guild_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'default',
      scope_key TEXT NOT NULL DEFAULT '',
      custom_message TEXT,
      mention_roles TEXT NOT NULL DEFAULT '[]',
      mention_users TEXT NOT NULL DEFAULT '[]',
      show_creator_on_edit INTEGER NOT NULL DEFAULT 0 CHECK (show_creator_on_edit IN (0,1)),
      allowed_kinds TEXT NOT NULL DEFAULT '[]',
      allow_multiple_per_channel INTEGER NOT NULL DEFAULT 0 CHECK (allow_multiple_per_channel IN (0,1)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, scope, scope_key),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS notification_groups (
      guild_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      title TEXT,
      details TEXT,
      thumbnail_url TEXT,
      window_minutes INTEGER NOT NULL DEFAULT 60,
      discord_channel_id TEXT,
      custom_message TEXT,
      mention_roles TEXT NOT NULL DEFAULT '[]',
      mention_users TEXT NOT NULL DEFAULT '[]',
      show_creator_on_edit INTEGER NOT NULL DEFAULT 0 CHECK (show_creator_on_edit IN (0,1)),
      allowed_kinds TEXT NOT NULL DEFAULT '[]',
      allow_multiple_per_channel INTEGER NOT NULL DEFAULT 0 CHECK (allow_multiple_per_channel IN (0,1)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, group_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS notification_group_members (
      guild_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, group_id, platform, channel_id),
      FOREIGN KEY (guild_id, group_id) REFERENCES notification_groups(guild_id, group_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS notification_group_activity (
      guild_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      content_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      nickname TEXT,
      content_json TEXT NOT NULL DEFAULT '{}',
      batch_key TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, group_id, platform, channel_id, content_id, kind),
      FOREIGN KEY (guild_id, group_id) REFERENCES notification_groups(guild_id, group_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS notification_group_messages (
      guild_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      batch_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      discord_channel_id TEXT NOT NULL,
      discord_message_id TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, group_id, batch_key, kind, discord_channel_id),
      FOREIGN KEY (guild_id, group_id) REFERENCES notification_groups(guild_id, group_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS notification_refresh_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      used_at INTEGER NOT NULL,
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS idx_notification_refresh_usage
      ON notification_refresh_usage (guild_id, platform, used_at);
    CREATE TABLE IF NOT EXISTS data_deletions (
      user_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'all',
      expires_at INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP);

    CREATE TABLE IF NOT EXISTS feature_settings (
      guild_id TEXT NOT NULL,
      feature TEXT NOT NULL,
      feature_key TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, feature),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS response_settings (
      guild_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'default',
      scope_key TEXT NOT NULL DEFAULT '',
      target_key TEXT NOT NULL DEFAULT '',
      response_type TEXT NOT NULL DEFAULT 'message',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, scope, scope_key),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS guild_setup_state (
      guild_id TEXT PRIMARY KEY,
      setup_complete INTEGER NOT NULL DEFAULT 0,
      setup_channel_id TEXT,
      installer_user_id TEXT,
      setup_completed_at INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS storage_notices (
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT,
      sent_at INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, guild_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS user_dm_settings (
      user_id TEXT PRIMARY KEY,
      dms_enabled INTEGER NOT NULL DEFAULT 1,
      notifications_enabled INTEGER NOT NULL DEFAULT 0,
      reminders_enabled INTEGER NOT NULL DEFAULT 0,
      birthdays_enabled INTEGER NOT NULL DEFAULT 0,
      feedback_enabled INTEGER NOT NULL DEFAULT 1,
      feedback_method TEXT NOT NULL DEFAULT 'dm',
      feedback_email TEXT,
      storage_notice_sent INTEGER NOT NULL DEFAULT 0,
      notice_channel_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS feedback_settings (
      guild_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      method TEXT NOT NULL DEFAULT 'dm',
      email TEXT,
      channel_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS entitlement_auto_allocations (
      guild_id TEXT PRIMARY KEY,
      installer_user_id TEXT,
      youtube_limit INTEGER DEFAULT 0,
      twitch_limit INTEGER DEFAULT 0,
      kick_limit INTEGER DEFAULT 0,
      allocated INTEGER NOT NULL DEFAULT 1,
      allocated_at INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS inactivity_rules (
      guild_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      name TEXT NOT NULL,
      message TEXT,
      idle_minutes INTEGER NOT NULL DEFAULT 60,
      timeout_minutes INTEGER NOT NULL DEFAULT 60,
      destination_channel_id TEXT,
      include_bot_messages INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      channels TEXT NOT NULL DEFAULT '[]',
      guild_ids TEXT NOT NULL DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, rule_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS inactivity_targets (
      guild_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      channel_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, rule_id, target_type, target_id),
      FOREIGN KEY (guild_id, rule_id) REFERENCES inactivity_rules(guild_id, rule_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS inactivity_rule_targets (
      guild_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      channel_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, rule_id, target_type, target_id),
      FOREIGN KEY (guild_id, rule_id) REFERENCES inactivity_rules(guild_id, rule_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS inactivity_state (
      guild_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      last_activity_at INTEGER,
      last_activity INTEGER,
      last_notified_at INTEGER,
      last_notified INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, target_type, target_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS timers (
      timer_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      user_id TEXT,
      name TEXT,
      message TEXT,
      channel_id TEXT,
      trigger_text TEXT,
      date_format TEXT NOT NULL DEFAULT 'YYYY-MM-DD',
      timezone TEXT,
      schedule TEXT,
      schedule_type TEXT NOT NULL DEFAULT 'once',
      next_run_at INTEGER,
      last_run_at INTEGER,
      role_ids TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, timer_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS user_timers (
      user_id TEXT NOT NULL,
      timer_id TEXT NOT NULL,
      name TEXT,
      message TEXT,
      trigger_text TEXT,
      date_format TEXT NOT NULL DEFAULT 'YYYY-MM-DD',
      timezone TEXT,
      schedule TEXT,
      schedule_type TEXT NOT NULL DEFAULT 'once',
      next_run_at INTEGER,
      last_run_at INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, timer_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS birthday_commands (
      command_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      user_id TEXT,
      birthday_date TEXT,
      birthday_month INTEGER,
      birthday_day INTEGER,
      birthday_year INTEGER,
      trigger_text TEXT,
      date_format TEXT NOT NULL DEFAULT 'YYYY-MM-DD',
      channel_id TEXT,
      role_ids TEXT NOT NULL DEFAULT '[]',
      message TEXT,
      announce_mode TEXT NOT NULL DEFAULT 'day',
      announce_days_before INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER,
      last_run_at INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, command_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS user_birthdays (
      user_id TEXT NOT NULL,
      birthday_date TEXT,
      birthday_month INTEGER,
      birthday_day INTEGER,
      birthday_year INTEGER,
      date_format TEXT NOT NULL DEFAULT 'YYYY-MM-DD',
      message TEXT,
      announce_mode TEXT NOT NULL DEFAULT 'day',
      announce_days_before INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER,
      last_run_at INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS autopublish_settings (
      guild_id TEXT PRIMARY KEY,
      all_enabled INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS autopublish_channels (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, channel_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
  `);

  db.exec(`
    INSERT INTO notification_configs (
      guild_id, scope, scope_key, mention_roles, mention_users, show_creator_on_edit
    )
    SELECT guild_id, 'creator', platform || ':' || channel_id, mention_roles, mention_users, show_creator_on_edit
    FROM notification_message_options
    ON CONFLICT(guild_id, scope, scope_key) DO NOTHING;

    INSERT INTO notification_configs (
      guild_id, scope, scope_key, custom_message
    )
    SELECT guild_id, 'creator', 'youtube:' || channel_id, custom_message
    FROM guild_youtube_subs
    WHERE custom_message IS NOT NULL
    ON CONFLICT(guild_id, scope, scope_key) DO UPDATE SET
      custom_message = excluded.custom_message;

    INSERT INTO notification_configs (
      guild_id, scope, scope_key, custom_message
    )
    SELECT guild_id, 'creator', 'twitch:' || channel_id, custom_message
    FROM guild_twitch_subs
    WHERE custom_message IS NOT NULL
    ON CONFLICT(guild_id, scope, scope_key) DO UPDATE SET
      custom_message = excluded.custom_message;

    INSERT INTO notification_configs (
      guild_id, scope, scope_key, custom_message
    )
    SELECT guild_id, 'creator', 'kick:' || channel_id, custom_message
    FROM guild_kick_subs
    WHERE custom_message IS NOT NULL
    ON CONFLICT(guild_id, scope, scope_key) DO UPDATE SET
      custom_message = excluded.custom_message;
  `);

  const guildSettingsColumns = db.prepare("PRAGMA table_info(guild_settings)").all().map(column => column.name);
  if (!guildSettingsColumns.includes("updates_channel_id")) {
    db.exec("ALTER TABLE guild_settings ADD COLUMN updates_channel_id TEXT");
    db.exec("UPDATE guild_settings SET updates_channel_id = COALESCE(announcement_channel_id, status_channel_id, logs_channel_id)");
    console.log("Added BargazBot Updates channel setting.");
  }
  if (!guildSettingsColumns.includes("notification_dedupe_hours")) {
    db.exec("ALTER TABLE guild_settings ADD COLUMN notification_dedupe_hours INTEGER NOT NULL DEFAULT 24");
    console.log("Added notification dedupe window setting.");
  }
  addColumnIfMissing("guild_settings", "setup_complete", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("guild_settings", "installer_user_id", "TEXT");
  addColumnIfMissing("guild_settings", "welcome_message", "TEXT");
  addColumnIfMissing("guild_settings", "goodbye_message", "TEXT");
  addColumnIfMissing("guild_settings", "notice_channel_id", "TEXT");

  const notificationMessageColumns = db.prepare("PRAGMA table_info(notification_messages)").all().map(column => column.name);
  if (!notificationMessageColumns.includes("creator_channel_id")) {
    db.exec("ALTER TABLE notification_messages ADD COLUMN creator_channel_id TEXT");
  }
  if (!notificationMessageColumns.includes("content_title")) {
    db.exec("ALTER TABLE notification_messages ADD COLUMN content_title TEXT");
  }

  addColumnIfMissing("notification_message_options", "allowed_kinds", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing("notification_message_options", "allow_multiple_per_channel", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("notification_configs", "allowed_kinds", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing("notification_configs", "allow_multiple_per_channel", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("notification_groups", "allowed_kinds", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing("notification_groups", "allow_multiple_per_channel", "INTEGER NOT NULL DEFAULT 0");

  addColumnIfMissing("guilds", "installer_user_id", "TEXT");
  addColumnIfMissing("entitlement_allocations", "auto_allocated", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("guild_permissions", "source", "TEXT NOT NULL DEFAULT 'manual'");
  addColumnIfMissing("guild_permissions", "is_implicit", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("guild_permissions", "installer_grant", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("data_deletions", "scope", "TEXT NOT NULL DEFAULT 'all'");

  const userColumns = db.prepare("PRAGMA table_info(users)").all().map(column => column.name);
  if (!userColumns.includes("paid_until")) {
    db.exec("ALTER TABLE users ADD COLUMN paid_until DATETIME");
    console.log("Added BargazBot paid entitlement placeholder.");
  }

  const profileColumns = db.prepare("PRAGMA table_info(guild_permission_profiles)").all().map(column => column.name);
  if (!profileColumns.includes("can_delete_data")) {
    db.exec("ALTER TABLE guild_permission_profiles ADD COLUMN can_delete_data INTEGER NOT NULL DEFAULT 0");
    console.log("Added BargazBot server data deletion flag.");
  }

  console.log("SQLite initialized at:", DB_PATH);
  return db;
}

export function getNotificationDedupeHours(guildId) {
  const row = getDB().prepare(`
    SELECT notification_dedupe_hours
    FROM guild_settings
    WHERE guild_id = ?
  `).get(guildId);

  return Number.isInteger(row?.notification_dedupe_hours)
    ? row.notification_dedupe_hours
    : 24;
}

export function setNotificationDedupeHours(guildId, hours) {
  const parsed = Number(hours);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  const value = Math.min(8760, Math.floor(parsed));

  getDB().prepare(`
    INSERT INTO guild_settings (
      guild_id,
      notification_dedupe_hours,
      created_at,
      updated_at
    )
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO UPDATE SET
      notification_dedupe_hours = excluded.notification_dedupe_hours,
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, value);

  return value;
}

// Note: Adding new columns of data requires a 1-time command in addition to adding to CREATE TABLE

// Get active DB connection
export function getDB() {
  if (databaseClosing) {throw new Error("SQLite is shutting down. New database operations are disabled.");}
  if (!db) {throw new Error("SQLite not initialized. Call initDB() first.");}
  return db;
}

export function closeDB() {
  databaseClosing = true;
  if (!db || !db.open) {return true;}
  try {db.close(); console.log("SQLite database closed.");                   return true;
  } catch (error) {console.error("Unable to close SQLite database:", error); return false;}
}