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
      alerts_channel_id TEXT,
      notification_dedupe_hours INTEGER NOT NULL DEFAULT 24,
      setup_complete INTEGER NOT NULL DEFAULT 0,
      installer_user_id TEXT,
      welcome_message TEXT,
      goodbye_message TEXT,
      notice_channel_id TEXT,
      timezone TEXT,
      tickers_channel_id TEXT,
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
      FOREIGN KEY (guild_id) REFERENCES users(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS user_dm_subscriptions (
      user_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      nickname TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, platform, channel_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS user_dm_configs (
      user_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT '',
      custom_message TEXT,
      mention_roles TEXT NOT NULL DEFAULT '[]',
      mention_users TEXT NOT NULL DEFAULT '[]',
      show_creator_on_edit INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, scope, scope_key),
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE);
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
    CREATE TABLE IF NOT EXISTS feature_configs (
      guild_id TEXT NOT NULL,
      feature TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, feature),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS reaction_role_messages (
      guild_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      style TEXT NOT NULL DEFAULT 'reactions',
      wrap_code INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, message_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS reaction_role_options (
      guild_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      option_id TEXT NOT NULL,
      label TEXT NOT NULL,
      emoji TEXT,
      role_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, message_id, option_id),
      FOREIGN KEY (guild_id, message_id) REFERENCES reaction_role_messages(guild_id, message_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS ticket_panels (
      guild_id TEXT NOT NULL,
      panel_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      title TEXT NOT NULL DEFAULT 'Support tickets',
      description TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, panel_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS ticket_types (
      guild_id TEXT NOT NULL,
      panel_id TEXT NOT NULL,
      type_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      name_template TEXT NOT NULL DEFAULT '{user}-{count}',
      container_type TEXT NOT NULL DEFAULT 'thread',
      category_id TEXT,
      emoji TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, panel_id, type_id),
      FOREIGN KEY (guild_id, panel_id) REFERENCES ticket_panels(guild_id, panel_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS ticket_access (
      guild_id TEXT NOT NULL,
      panel_id TEXT NOT NULL,
      type_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      group_id TEXT,
      PRIMARY KEY (guild_id, panel_id, type_id, action, target_type, target_id));
    CREATE TABLE IF NOT EXISTS ticket_form_questions (
      guild_id TEXT NOT NULL,
      panel_id TEXT NOT NULL,
      type_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      label TEXT NOT NULL,
      placeholder TEXT,
      kind TEXT NOT NULL DEFAULT 'short',
      required INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, panel_id, type_id, question_id),
      FOREIGN KEY (guild_id, panel_id, type_id) REFERENCES ticket_types(guild_id, panel_id, type_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS ticket_form_routes (
      guild_id TEXT NOT NULL,
      panel_id TEXT NOT NULL,
      type_id TEXT NOT NULL,
      route_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      conditions_json TEXT NOT NULL DEFAULT '[]',
      target_kind TEXT NOT NULL DEFAULT 'default',
      target_channel_id TEXT,
      target_category_id TEXT,
      thread_name_template TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, panel_id, type_id, route_id),
      FOREIGN KEY (guild_id, panel_id, type_id) REFERENCES ticket_types(guild_id, panel_id, type_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS ticket_form_answers (
      guild_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      question_label TEXT NOT NULL,
      answer TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, ticket_id, question_id),
      FOREIGN KEY (guild_id, ticket_id) REFERENCES tickets(guild_id, ticket_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS tickets (
      guild_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      panel_id TEXT NOT NULL,
      type_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT,
      PRIMARY KEY (guild_id, ticket_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS navigation_messages (
      guild_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'Server navigation',
      description TEXT,
      auto_update INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, message_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS navigation_categories (
      guild_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, message_id, category_id),
      FOREIGN KEY (guild_id, message_id) REFERENCES navigation_messages(guild_id, message_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS navigation_channels (
      guild_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      description_override TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, message_id, channel_id),
      FOREIGN KEY (guild_id, message_id) REFERENCES navigation_messages(guild_id, message_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS automod_rules (
      guild_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      settings_json TEXT NOT NULL DEFAULT '{}',
      actions_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, rule_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS automod_scope (
      guild_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, rule_id, scope_type, target_id),
      FOREIGN KEY (guild_id, rule_id) REFERENCES automod_rules(guild_id, rule_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS automod_warnings (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      last_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id));
    CREATE TABLE IF NOT EXISTS account_links (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      username TEXT,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TEXT,
      linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id, platform),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS role_reward_rules (
      guild_id TEXT NOT NULL,
      reward_id TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      platform TEXT,
      provider_account_id TEXT,
      metric TEXT,
      threshold INTEGER,
      role_id TEXT NOT NULL,
      auto_remove INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, reward_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS role_reward_grants (
      guild_id TEXT NOT NULL,
      reward_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      auto_added INTEGER NOT NULL DEFAULT 1,
      granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, reward_id, user_id),
      FOREIGN KEY (guild_id, reward_id) REFERENCES role_reward_rules(guild_id, reward_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS webhook_events (
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider, event_id));
    CREATE TABLE IF NOT EXISTS guild_counters (
      guild_id TEXT NOT NULL,
      counter_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      type TEXT NOT NULL,
      role_id TEXT,
      label TEXT,
      metric TEXT,
      source TEXT NOT NULL DEFAULT 'guild',
      platform TEXT,
      creator_id TEXT,
      refresh_enabled INTEGER NOT NULL DEFAULT 1,
      last_value TEXT,
      last_refreshed_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, counter_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL);
  `);

  db.exec(`
    INSERT INTO notification_configs (
      guild_id, scope, scope_key, mention_roles, mention_users, show_creator_on_edit
    )
    SELECT guild_id, 'creator', platform || ':' || channel_id, mention_roles, mention_users, show_creator_on_edit
    FROM notification_message_options
    WHERE true
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
  addColumnIfMissing("guild_settings", "welcome_username", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing("guild_settings", "welcome_nickname", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("guild_settings", "welcome_profile", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("guild_settings", "goodbye_username", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing("guild_settings", "goodbye_nickname", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("guild_settings", "goodbye_profile", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("guild_settings", "notice_channel_id", "TEXT");
  addColumnIfMissing("guild_settings", "timezone", "TEXT");
  addColumnIfMissing("guild_settings", "tickets_channel_id", "TEXT");
  addColumnIfMissing("guild_settings", "bot_detection_channel_id", "TEXT");
  addColumnIfMissing("guild_settings", "alerts_channel_id", "TEXT");
  addColumnIfMissing("guild_counters", "metric", "TEXT");
  addColumnIfMissing("guild_counters", "source", "TEXT NOT NULL DEFAULT 'guild'");
  addColumnIfMissing("guild_counters", "platform", "TEXT");
  addColumnIfMissing("guild_counters", "creator_id", "TEXT");
  addColumnIfMissing("guild_counters", "refresh_enabled", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing("guild_counters", "last_value", "TEXT");
  addColumnIfMissing("guild_counters", "last_refreshed_at", "TEXT");
  addColumnIfMissing("user_dm_settings", "timezone", "TEXT");
  addColumnIfMissing("youtube_channels", "content_available", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing("youtube_channels", "content_check_at", "INTEGER");

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

  addColumnIfMissing("role_reward_rules", "conditions_json", "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing("role_reward_rules", "name", "TEXT");
  addColumnIfMissing("reaction_role_messages", "nickname", "TEXT");
  addColumnIfMissing("reaction_role_options", "group_label", "TEXT");
  addColumnIfMissing("reaction_role_options", "menu_kind", "TEXT");
  addColumnIfMissing("reaction_role_options", "button_label", "TEXT");
  addColumnIfMissing("reaction_role_options", "position", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("ticket_panels", "config_json", "TEXT NOT NULL DEFAULT '{}'");
  addColumnIfMissing("ticket_types", "config_json", "TEXT NOT NULL DEFAULT '{}'");

  const legacyRewards = db.prepare(`
    SELECT guild_id, reward_id, trigger_type, platform, provider_account_id, metric, threshold, conditions_json
    FROM role_reward_rules
  `).all();
  const updateLegacyReward = db.prepare(`
    UPDATE role_reward_rules SET conditions_json = ? WHERE guild_id = ? AND reward_id = ?
  `);
  for (const row of legacyRewards) {
    let conditions = [];
    try { conditions = JSON.parse(row.conditions_json ?? "[]"); } catch { conditions = []; }
    if (Array.isArray(conditions) && conditions.length > 0) {continue;}
    const legacy = {
      type: "condition",
      kind: row.trigger_type ?? "manual",
      platform: row.platform ?? null,
      providerAccountId: row.provider_account_id ?? null,
      metric: row.metric ?? null,
      threshold: row.threshold ?? null
    };
    updateLegacyReward.run(JSON.stringify([{op:"AND", children:[legacy]}]), row.guild_id, row.reward_id);
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

export function getGuildTimezone(guildId) {
  const row = getDB().prepare(
    "SELECT timezone FROM guild_settings WHERE guild_id = ?"
  ).get(guildId);
  return row?.timezone ?? null;
}

export function setGuildTimezone(guildId, timezone) {
  ensureGuildRow(guildId);
  const value = timezone ? String(timezone) : null;
  getDB().prepare(`
    INSERT INTO guild_settings (guild_id, timezone, created_at, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO UPDATE SET
      timezone = excluded.timezone,
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

/* Feature settings, DM settings, and setup state helpers. */

const FEATURE_ALIASES = {
  logging: "logs",
  logger: "logs",
  notification: "notifications",
  test: "notifications",
  notification_test: "notifications"
};

export const FEATURE_KEYS = [
  "notifications",
  "welcome",
  "goodbye",
  "logs",
  "updates",
  "status",
  "alerts",
  "entitlement",
  "inactivity",
  "timers",
  "birthdays",
  "autopublish",
  "feedback",
  "dm",
  "counters",
  "reaction-roles",
  "verification",
  "tickets",
  "navigation",
  "auto-mod",
  "social-counters",
  "role-rewards",
  "account-linking"
];

export const FEATURE_DEFAULTS = {
  notifications: {enabled: false, responseType: null},
  welcome:       {enabled: false, responseType: null},
  goodbye:       {enabled: false, responseType: null},
  logs:          {enabled: true,  responseType: "message"},
  updates:       {enabled: true,  responseType: null},
  status:        {enabled: true,  responseType: null},
  alerts:        {enabled: true,  responseType: null},
  entitlement:   {enabled: false, responseType: null},
  inactivity:    {enabled: false, responseType: "message"},
  timers:        {enabled: false, responseType: null},
  birthdays:     {enabled: false, responseType: null},
  autopublish:   {enabled: false, responseType: null},
  feedback:      {enabled: false, responseType: null},
  dm:            {enabled: false, responseType: null},
  counters:        {enabled: false, responseType: null},
  "reaction-roles":{enabled: false, responseType: null},
  verification:    {enabled: false, responseType: null},
  tickets:         {enabled: false, responseType: null},
  navigation:      {enabled: false, responseType: null},
  "auto-mod":      {enabled: false, responseType: null},
  "social-counters":{enabled: false, responseType: null},
  "role-rewards":  {enabled: false, responseType: null},
  "account-linking":{enabled: false, responseType: null}
};

function canonicalFeature(feature) {
  const key = String(feature ?? "");
  return FEATURE_ALIASES[key] ?? key;
}

function toBoolean(value) {
  return value === true || value === 1;
}

function normalizeResponseType(value, fallback = null) {
  if (value === "message" || value === "ephemeral") {return value;}
  return fallback;
}

function parseJsonArray(value) {
  if (!value) {return [];}
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ensureUserRow(userId) {
  getDB().prepare("INSERT OR IGNORE INTO users (user_id) VALUES (?)").run(String(userId));
}

function ensureGuildRow(guildId) {
  getDB().prepare("INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)").run(String(guildId));
}

export function getFeatureSetting(guildId, feature) {
  const key = canonicalFeature(feature);
  const defaults = FEATURE_DEFAULTS[key] ?? {enabled: false, responseType: null};
  const db = getDB();
  const row = db.prepare(
    "SELECT enabled FROM feature_settings WHERE guild_id = ? AND feature = ?"
  ).get(guildId, key);
  const response = db.prepare(
    "SELECT response_type FROM response_settings WHERE guild_id = ? AND scope = 'feature' AND scope_key = ?"
  ).get(guildId, key);

  return {
    feature: key,
    enabled: row ? toBoolean(row.enabled) : Boolean(defaults.enabled),
    responseType: response ? normalizeResponseType(response.response_type) : defaults.responseType
  };
}

export function getFeatureSettings(guildId) {
  return Object.fromEntries(FEATURE_KEYS.map(feature => [feature, getFeatureSetting(guildId, feature)]));
}

export function setFeatureSetting(guildId, feature, patch = {}) {
  const key = canonicalFeature(feature);
  const db = getDB();
  ensureGuildRow(guildId);

  if (Object.hasOwn(patch, "enabled")) {
    db.prepare(`
      INSERT INTO feature_settings (guild_id, feature, feature_key, enabled, created_at, updated_at)
      VALUES (?, ?, '', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id, feature) DO UPDATE SET
        enabled = excluded.enabled,
        updated_at = CURRENT_TIMESTAMP
    `).run(guildId, key, patch.enabled ? 1 : 0);
  }

  if (Object.hasOwn(patch, "responseType")) {
    db.prepare(`
      INSERT INTO response_settings (guild_id, scope, scope_key, target_key, response_type, created_at, updated_at)
      VALUES (?, 'feature', ?, '', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id, scope, scope_key) DO UPDATE SET
        response_type = excluded.response_type,
        updated_at = CURRENT_TIMESTAMP
    `).run(guildId, key, normalizeResponseType(patch.responseType, "") ?? "");
  }

  return getFeatureSetting(guildId, key);
}

export function getFeatureConfig(guildId, feature, fallback = {}) {
  const row = getDB().prepare(
    "SELECT config_json FROM feature_configs WHERE guild_id = ? AND feature = ?"
  ).get(guildId, feature);
  if (!row) {return structuredClone(fallback);}
  try {return {...structuredClone(fallback), ...JSON.parse(row.config_json)};}
  catch {return structuredClone(fallback);}
}

export function setFeatureConfig(guildId, feature, config = {}) {
  ensureGuildRow(guildId);
  getDB().prepare(`
    INSERT INTO feature_configs (guild_id, feature, config_json, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id, feature) DO UPDATE SET
      config_json = excluded.config_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, feature, JSON.stringify(config ?? {}));
  return config;
}

export function patchFeatureConfig(guildId, feature, patch = {}, fallback = {}) {
  const merged = {...getFeatureConfig(guildId, feature, fallback), ...patch};
  return setFeatureConfig(guildId, feature, merged);
}

export function setAllFeatureResponseTypes(guildId, responseType) {
  const value = normalizeResponseType(responseType, "") ?? "";
  const db = getDB();
  ensureGuildRow(guildId);
  const statement = db.prepare(`
    INSERT INTO response_settings (guild_id, scope, scope_key, target_key, response_type, created_at, updated_at)
    VALUES (?, 'feature', ?, '', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id, scope, scope_key) DO UPDATE SET
      response_type = excluded.response_type,
      updated_at = CURRENT_TIMESTAMP
  `);

  for (const feature of FEATURE_KEYS) {statement.run(guildId, feature, value);}
  return normalizeResponseType(value);
}

export function getCommandResponseType(guildId) {
  const row = getDB().prepare(`
    SELECT response_type
    FROM response_settings
    WHERE guild_id = ? AND scope = 'default' AND scope_key = ''
  `).get(guildId);

  return normalizeResponseType(row?.response_type, "ephemeral");
}

export function setCommandResponseType(guildId, responseType) {
  const value = normalizeResponseType(responseType);
  if (!value) {return null;}
  ensureGuildRow(guildId);
  getDB().prepare(`
    INSERT INTO response_settings (guild_id, scope, scope_key, target_key, response_type, created_at, updated_at)
    VALUES (?, 'default', '', '', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id, scope, scope_key) DO UPDATE SET
      response_type = excluded.response_type,
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, value);
  return value;
}

export function getGuildWelcomeMessage(guildId) {
  return getDB().prepare(
    "SELECT welcome_message FROM guild_settings WHERE guild_id = ?"
  ).get(guildId)?.welcome_message ?? null;
}

export function setGuildWelcomeMessage(guildId, message) {
  ensureGuildRow(guildId);
  getDB().prepare(`
    INSERT INTO guild_settings (guild_id, welcome_message, created_at, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO UPDATE SET
      welcome_message = excluded.welcome_message,
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, message ?? null);
  return message ?? null;
}


export function getGuildWelcomeOptions(guildId) {
  const row = getDB().prepare(
    "SELECT welcome_username, welcome_nickname, welcome_profile FROM guild_settings WHERE guild_id = ?"
  ).get(guildId) ?? {};
  return {
    username: row.welcome_username !== 0,
    nickname: row.welcome_nickname === 1,
    profile: row.welcome_profile === 1
  };
}

export function setGuildWelcomeOptions(guildId, options = {}) {
  ensureGuildRow(guildId);
  getDB().prepare(`
    INSERT INTO guild_settings (guild_id, welcome_username, welcome_nickname, welcome_profile, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO UPDATE SET
      welcome_username = excluded.welcome_username,
      welcome_nickname = excluded.welcome_nickname,
      welcome_profile = excluded.welcome_profile,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    guildId,
    options.username === false ? 0 : 1,
    options.nickname === true ? 1 : 0,
    options.profile === true ? 1 : 0
  );
  return getGuildWelcomeOptions(guildId);
}

export function getGuildGoodbyeMessage(guildId) {
  return getDB().prepare(
    "SELECT goodbye_message FROM guild_settings WHERE guild_id = ?"
  ).get(guildId)?.goodbye_message ?? null;
}

export function setGuildGoodbyeMessage(guildId, message) {
  ensureGuildRow(guildId);
  getDB().prepare(`
    INSERT INTO guild_settings (guild_id, goodbye_message, created_at, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO UPDATE SET
      goodbye_message = excluded.goodbye_message,
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, message ?? null);
  return message ?? null;
}

export function getGuildGoodbyeOptions(guildId) {
  const row = getDB().prepare(
    "SELECT goodbye_username, goodbye_nickname, goodbye_profile FROM guild_settings WHERE guild_id = ?"
  ).get(guildId) ?? {};
  return {
    username: row.goodbye_username !== 0,
    nickname: row.goodbye_nickname === 1,
    profile: row.goodbye_profile === 1
  };
}

export function setGuildGoodbyeOptions(guildId, options = {}) {
  ensureGuildRow(guildId);
  getDB().prepare(`
    INSERT INTO guild_settings (guild_id, goodbye_username, goodbye_nickname, goodbye_profile, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO UPDATE SET
      goodbye_username = excluded.goodbye_username,
      goodbye_nickname = excluded.goodbye_nickname,
      goodbye_profile = excluded.goodbye_profile,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    guildId,
    options.username === false ? 0 : 1,
    options.nickname === true ? 1 : 0,
    options.profile === true ? 1 : 0
  );
  return getGuildGoodbyeOptions(guildId);
}

export function getPrivacyNoticeChannel(guildId) {
  return getDB().prepare(
    "SELECT notice_channel_id FROM guild_settings WHERE guild_id = ?"
  ).get(guildId)?.notice_channel_id ?? null;
}

export function savePrivacyNoticeChannel(guildId, channelId) {
  ensureGuildRow(guildId);
  getDB().prepare(`
    INSERT INTO guild_settings (guild_id, notice_channel_id, created_at, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO UPDATE SET
      notice_channel_id = excluded.notice_channel_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, channelId ?? null);
  return channelId ?? null;
}

export function isGuildSetupComplete(guildId) {
  const db = getDB();
  const state = db.prepare(
    "SELECT setup_complete FROM guild_setup_state WHERE guild_id = ?"
  ).get(guildId);
  if (state) {return toBoolean(state.setup_complete);}
  const settings = db.prepare(
    "SELECT setup_complete FROM guild_settings WHERE guild_id = ?"
  ).get(guildId);
  return toBoolean(settings?.setup_complete);
}

export function markGuildSetupComplete(guildId, channelId = null, installerId = null) {
  const db = getDB();
  ensureGuildRow(guildId);
  db.prepare(`
    INSERT INTO guild_setup_state
      (guild_id, setup_complete, setup_channel_id, installer_user_id, setup_completed_at, created_at, updated_at)
    VALUES (?, 1, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO UPDATE SET
      setup_complete = 1,
      setup_channel_id = COALESCE(excluded.setup_channel_id, guild_setup_state.setup_channel_id),
      installer_user_id = COALESCE(excluded.installer_user_id, guild_setup_state.installer_user_id),
      setup_completed_at = excluded.setup_completed_at,
      updated_at = CURRENT_TIMESTAMP
  `).run(guildId, channelId ?? null, installerId ?? null, Date.now());
  db.prepare(`
    UPDATE guild_settings
    SET setup_complete = 1,
        installer_user_id = COALESCE(?, installer_user_id),
        updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = ?
  `).run(installerId ?? null, guildId);
  return true;
}

export function resetGuildSetup(guildId) {
  const db = getDB();
  ensureGuildRow(guildId);
  db.prepare(`
    UPDATE guild_settings
    SET announcement_channel_id = NULL,
        welcome_channel_id = NULL,
        goodbye_channel_id = NULL,
        logs_channel_id = NULL,
        updates_channel_id = NULL,
        status_channel_id = NULL,
        alerts_channel_id = NULL,
        notice_channel_id = NULL,
        welcome_message = NULL,
        goodbye_message = NULL,
        setup_complete = 0,
        installer_user_id = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = ?
  `).run(guildId);
  db.prepare("DELETE FROM guild_setup_state WHERE guild_id = ?").run(guildId);
  db.prepare("DELETE FROM feature_settings WHERE guild_id = ?").run(guildId);
  db.prepare("DELETE FROM response_settings WHERE guild_id = ?").run(guildId);
  return true;
}

export function emptyUserDmConfig() {
  return {
    customMessage: null,
    mentionRoles: [],
    mentionUsers: [],
    showCreatorOnEdit: false
  };
}

function mapUserDmSettings(userId, row) {
  return {
    userId: row?.user_id ?? String(userId),
    dmEnabled: row ? toBoolean(row.dms_enabled) : true,
    notificationsEnabled: row ? toBoolean(row.notifications_enabled) : false,
    remindersEnabled: row ? toBoolean(row.reminders_enabled) : false,
    birthdaysEnabled: row ? toBoolean(row.birthdays_enabled) : false,
    feedbackEnabled: row ? toBoolean(row.feedback_enabled) : true,
    feedbackDelivery: row?.feedback_method ?? "dm",
    feedbackEmail: row?.feedback_email ?? null,
    storageNoticeSent: row ? toBoolean(row.storage_notice_sent) : false,
    noticeChannelId: row?.notice_channel_id ?? null,
    timezone: row?.timezone ?? null
  };
}

export function countDmEnabledUsers() {
  return getDB().prepare(
    "SELECT COUNT(*) AS total FROM user_dm_settings WHERE dms_enabled = 1"
  ).get().total;
}

export function getUserDmSettings(userId) {
  const row = getDB().prepare(
    "SELECT * FROM user_dm_settings WHERE user_id = ?"
  ).get(String(userId));
  return mapUserDmSettings(userId, row ?? null);
}

export function setUserDmSetting(userId, patch = {}) {
  const current = getUserDmSettings(userId);
  const db = getDB();
  ensureUserRow(userId);

  const feedbackDelivery = Object.hasOwn(patch, "feedbackDelivery")
    ? patch.feedbackDelivery
    : (Object.hasOwn(patch, "feedbackMethod") ? patch.feedbackMethod : current.feedbackDelivery);

  db.prepare(`
    INSERT INTO user_dm_settings (
      user_id, dms_enabled, notifications_enabled, reminders_enabled,
      birthdays_enabled, feedback_enabled, feedback_method, feedback_email,
      storage_notice_sent, notice_channel_id, timezone, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      dms_enabled = excluded.dms_enabled,
      notifications_enabled = excluded.notifications_enabled,
      reminders_enabled = excluded.reminders_enabled,
      birthdays_enabled = excluded.birthdays_enabled,
      feedback_enabled = excluded.feedback_enabled,
      feedback_method = excluded.feedback_method,
      feedback_email = excluded.feedback_email,
      storage_notice_sent = excluded.storage_notice_sent,
      notice_channel_id = excluded.notice_channel_id,
      timezone = excluded.timezone,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    String(userId),
    Object.hasOwn(patch, "dmEnabled") ? (patch.dmEnabled ? 1 : 0) : (current.dmEnabled ? 1 : 0),
    Object.hasOwn(patch, "notificationsEnabled") ? (patch.notificationsEnabled ? 1 : 0) : (current.notificationsEnabled ? 1 : 0),
    Object.hasOwn(patch, "remindersEnabled") ? (patch.remindersEnabled ? 1 : 0) : (current.remindersEnabled ? 1 : 0),
    Object.hasOwn(patch, "birthdaysEnabled") ? (patch.birthdaysEnabled ? 1 : 0) : (current.birthdaysEnabled ? 1 : 0),
    Object.hasOwn(patch, "feedbackEnabled") ? (patch.feedbackEnabled ? 1 : 0) : (current.feedbackEnabled ? 1 : 0),
    feedbackDelivery ?? "dm",
    Object.hasOwn(patch, "feedbackEmail") ? patch.feedbackEmail : current.feedbackEmail,
    Object.hasOwn(patch, "storageNoticeSent") ? (patch.storageNoticeSent ? 1 : 0) : (current.storageNoticeSent ? 1 : 0),
    Object.hasOwn(patch, "noticeChannelId") ? patch.noticeChannelId : current.noticeChannelId,
    Object.hasOwn(patch, "timezone") ? patch.timezone : current.timezone
  );

  return getUserDmSettings(userId);
}

export function clearUserDmSettings(userId) {
  const db = getDB();
  for (const table of ["user_dm_settings", "user_dm_subscriptions", "user_dm_configs"]) {
    db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(String(userId));
  }
  return true;
}

export function getUserDmSubscriptions(userId, platform = null) {
  const db = getDB();
  const rows = platform
    ? db.prepare(
        "SELECT user_id, platform, channel_id, nickname FROM user_dm_subscriptions WHERE user_id = ? AND platform = ? ORDER BY platform, channel_id"
      ).all(String(userId), String(platform).toLowerCase())
    : db.prepare(
        "SELECT user_id, platform, channel_id, nickname FROM user_dm_subscriptions WHERE user_id = ? ORDER BY platform, channel_id"
      ).all(String(userId));

  return rows.map(row => ({
    userId: row.user_id,
    platform: row.platform,
    channelId: row.channel_id,
    nickname: row.nickname ?? null
  }));
}

export function addUserDmSubscription(userId, platform, channelId, nickname = null) {
  ensureUserRow(userId);
  const result = getDB().prepare(`
    INSERT OR IGNORE INTO user_dm_subscriptions
      (user_id, platform, channel_id, nickname, created_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(String(userId), String(platform).toLowerCase(), String(channelId), nickname ?? null);
  return result.changes > 0;
}

export function removeUserDmSubscription(userId, platform, channelId) {
  const result = getDB().prepare(`
    DELETE FROM user_dm_subscriptions
    WHERE user_id = ? AND platform = ? AND channel_id = ?
  `).run(String(userId), String(platform).toLowerCase(), String(channelId));
  return result.changes > 0;
}

export function getUserDmConfig(userId, scope, scopeKey = "") {
  const row = getDB().prepare(`
    SELECT custom_message, mention_roles, mention_users, show_creator_on_edit
    FROM user_dm_configs
    WHERE user_id = ? AND scope = ? AND scope_key = ?
  `).get(String(userId), String(scope ?? ""), String(scopeKey ?? ""));

  if (!row) {return null;}
  return {
    customMessage: row.custom_message ?? null,
    mentionRoles: parseJsonArray(row.mention_roles),
    mentionUsers: parseJsonArray(row.mention_users),
    showCreatorOnEdit: toBoolean(row.show_creator_on_edit)
  };
}

export function setUserDmConfig(userId, scope, scopeKey = "", patch = {}) {
  const current = getUserDmConfig(userId, scope, scopeKey) ?? emptyUserDmConfig();
  const next = {
    customMessage: Object.hasOwn(patch, "customMessage") ? patch.customMessage : current.customMessage,
    mentionRoles: Object.hasOwn(patch, "mentionRoles") ? (patch.mentionRoles ?? []) : current.mentionRoles,
    mentionUsers: Object.hasOwn(patch, "mentionUsers") ? (patch.mentionUsers ?? []) : current.mentionUsers,
    showCreatorOnEdit: Object.hasOwn(patch, "showCreatorOnEdit")
      ? Boolean(patch.showCreatorOnEdit)
      : current.showCreatorOnEdit
  };
  ensureUserRow(userId);
  getDB().prepare(`
    INSERT INTO user_dm_configs (
      user_id, scope, scope_key, custom_message, mention_roles, mention_users,
      show_creator_on_edit, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, scope, scope_key) DO UPDATE SET
      custom_message = excluded.custom_message,
      mention_roles = excluded.mention_roles,
      mention_users = excluded.mention_users,
      show_creator_on_edit = excluded.show_creator_on_edit,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    String(userId),
    String(scope ?? ""),
    String(scopeKey ?? ""),
    next.customMessage ?? null,
    JSON.stringify(next.mentionRoles),
    JSON.stringify(next.mentionUsers),
    next.showCreatorOnEdit ? 1 : 0
  );
  return next;
}
