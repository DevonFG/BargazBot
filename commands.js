import * as discord          from "discord.js";
import * as channelManager   from "./channelManager.js";
import * as permissions      from "./permissions.js";
import * as notifications    from "./notifications.js";
import * as entitlements     from "./entitlements.js";
import * as log              from "./appLogger.js";
import * as featureSettings  from "./featureSettings.js";
import * as inactivity       from "./inactivity.js";
import * as timers           from "./timers.js";
import * as autopublish      from "./autopublish.js";
import * as youtube          from "./youtube.js";
import * as twitch           from "./twitch.js";
import * as kick             from "./kick.js";
import fs                    from "node:fs";
import path                  from "node:path";
import Database              from "better-sqlite3";
import {createLogger}        from "bargaz/logging.js";
import {isShutdownRequested} from "bargaz/shutdownCoordinator.js";
import {trackBotCallback}    from "./lifecycle.js";
import {getDB, closeDB, initDB, getNotificationDedupeHours, setNotificationDedupeHours} from "./storage.js";
import {menuId, menuOption, buildSelectRow, buildButtonRow, buildMentionableRow, parseMenuId} from "./utils.js";
import {DB_BACKUP_DIR, DB_DIR, DB_PATH}                                                 from "./config.js";

const BOT_VERSION = (() => {
  try {return JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version ?? "unknown";}
  catch {return "unknown";}
})();

const logging = createLogger({
  EmbedBuilder: discord.EmbedBuilder,
  getDB,
  getChannel: channelManager.getChannel
});

const commandCollectors = new Set();
const NOTIFICATION_GROUP_KINDS = ["live", "scheduled", "video", "short", "premiere", "post", "content"];

const DM_TIMEZONE_OPTIONS = [
  "UTC", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York",
  "America/Toronto", "America/Sao_Paulo", "Europe/London", "Europe/Paris", "Europe/Berlin",
  "Europe/Madrid", "Europe/Rome", "Europe/Amsterdam", "Europe/Warsaw", "Europe/Stockholm",
  "Europe/Moscow", "Africa/Johannesburg", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore",
  "Asia/Shanghai", "Asia/Seoul", "Asia/Tokyo", "Australia/Sydney"
];

function isValidTimezone(value) {
  try {new Intl.DateTimeFormat("en-US", {timeZone:value}); return true;} catch {return false;}
}

function dmTimezoneOptions(current) {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const options = [...new Set([local, ...DM_TIMEZONE_OPTIONS].filter(Boolean))].slice(0, 24);
  if (current && isValidTimezone(current) && !options.includes(current)) {options[0] = current;}
  return options;
}

function createCommandCollector(message, options) {
  const collector = message.createMessageComponentCollector(options);

  if (isShutdownRequested()) {
    collector.stop("shutdown");
    return collector;
  }

  commandCollectors.add(collector);
  collector.once("end", () => commandCollectors.delete(collector));

  return collector;
}

function onCommandComponent(collector, handler) {
  collector.on("collect", trackBotCallback(handler));
}

export function stopCommandCollectors() {
  for (const collector of commandCollectors) {
    collector.stop("shutdown");
  }

  commandCollectors.clear();
}

// Checks whether a member can execute a specific command
// interaction = ChatInputCommandInteraction
// command = String, command name
// subcommand = String, subcommand name
async function requireCommandAccess(interaction, command, subcommand) {
  if (!interaction.guild) {
    await interaction.reply({content: "This command can only be used in a Discord server.", flags: discord.MessageFlags.Ephemeral});
    return false;
  }
  if (command === "permissions" && subcommand === "list") {return true;}
  const member = interaction.member?.roles?.cache ? interaction.member : await interaction.guild.members.fetch(interaction.user.id);
  if (permissions.canUseCommand(member, command, subcommand)) {return true;}
  await interaction.reply({
    content: `You do not have permission to use \`/${command} ${subcommand}\` in this server.`,
    flags: discord.MessageFlags.Ephemeral
  });
  return false;
}

// Adds supported creator platforms to a command option
// option = SlashCommandStringOption
function addPlatformChoices(option) {
  return option.addChoices({name: "YouTube", value: "youtube"}, {name: "Twitch", value: "twitch"}, {name: "Kick", value: "kick"});
}

const commands = [
  new discord.SlashCommandBuilder()
    .setName("ping")
    .setDescription("Checks whether BargazBot is responding.")
    .setIntegrationTypes(0, 1)
    .setContexts(0, 1),
  new discord.SlashCommandBuilder()
    .setName("help")
    .setDescription("Shows information about BargazBot's commands.")
    .addStringOption(option => option
      .setName("command")
      .setDescription("A command to describe in detail.")
      .setRequired(false)
    )
    .setIntegrationTypes(0, 1)
    .setContexts(0, 1),
  new discord.SlashCommandBuilder()
    .setName("stats")
    .setDescription("Shows BargazBot statistics.")
    .setIntegrationTypes(0, 1)
    .setContexts(0, 1),
  new discord.SlashCommandBuilder()
    .setName("leave-join")
    .setDescription("Configure a welcome or goodbye announcement.")
    .addStringOption(option => option
      .setName("type")
      .setDescription("Which announcement to configure.")
      .setRequired(true)
      .addChoices(
        {name:"Welcome (join)", value:"welcome"},
        {name:"Goodbye (leave)", value:"goodbye"}
      ))
    .addBooleanOption(option => option
      .setName("reset").setDescription("Restore defaults for this announcement.").setRequired(false)),

  //===================================================
  // Creator Notifications
  //===================================================
  new discord.SlashCommandBuilder()
    .setName("notification")
    .setDescription("Manage creator notifications from a menu.")
    .setIntegrationTypes(0, 1)
    .setContexts(0, 1),
  new discord.SlashCommandBuilder()
    .setName("test")
    .setDescription("Send a test message for a BargazBot feature.")
    .addStringOption(option => option
      .setName("feature")
      .setDescription("What to test.")
      .setRequired(true)
      .addChoices(
        {name:"Notification", value:"notification"},
        {name:"Leave message", value:"leave"},
        {name:"Join message", value:"join"},
        {name:"Inactivity", value:"inactivity"},
        {name:"Logging", value:"logging"},
        {name:"Timers", value:"timers"}
      )
    ),

  //===================================================
  // Feature Configuration
  //===================================================
  new discord.SlashCommandBuilder()
    .setName("features-config")
    .setDescription("Open the BargazBot feature, channel, welcome, and response setup menu."),

  //===================================================
  // Logging
  //===================================================
  new discord.SlashCommandBuilder()
    .setName("logging")
    .setDescription("Manage BargazBot logging for this server.")
    .addSubcommand(subcommand => subcommand
      .setName("view")
      .setDescription("Show and toggle the logging categories.")
    )
    .addSubcommand(subcommand => subcommand
      .setName("set")
      .setDescription("Enable or disable a logging category.")
      .addStringOption(option => option
        .setName("category")
        .setDescription("The logging category.")
        .setRequired(true)
        .addChoices(...loggingCategoryChoices())
      )
      .addBooleanOption(option => option
        .setName("enabled")
        .setDescription("Whether the category should be logged.")
        .setRequired(true)
      )
    )
    .addSubcommand(subcommand => subcommand
      .setName("reset")
      .setDescription("Restore a logging category to its default.")
      .addStringOption(option => option
        .setName("category")
        .setDescription("The logging category.")
        .setRequired(true)
        .addChoices(...loggingCategoryChoices())
      )
    ),

  //===================================================
  // Data
  //===================================================
  new discord.SlashCommandBuilder()
    .setName("data")
    .setDescription("View, delete, or export the data BargazBot holds about you.")
    .addSubcommand(subcommand => subcommand
      .setName("view")
      .setDescription("Show the data BargazBot holds about you or this server.")
      .addStringOption(option => option
        .setName("scope")
        .setDescription("Whose data to show.")
        .setRequired(true)
        .addChoices(
          {name:"You",         value:"user"},
          {name:"This server", value:"server"}
        )
      )
    )
    .addSubcommand(subcommand => subcommand
      .setName("delete")
      .setDescription("Delete the data BargazBot holds about you or this server.")
      .addStringOption(option => option
        .setName("scope")
        .setDescription("Whose data to delete.")
        .setRequired(true)
        .addChoices(
          {name:"You",         value:"user"},
          {name:"This server", value:"server"},
          {name:"This DM",     value:"dm"}
        )
      )
    )
    .addSubcommand(subcommand => subcommand
      .setName("export")
      .setDescription("Export the data BargazBot holds about you or this server.")
      .addStringOption(option => option
        .setName("scope")
        .setDescription("Whose data to export.")
        .setRequired(true)
        .addChoices(
          {name:"You",         value:"user"},
          {name:"This server", value:"server"}
        )
      )
      .addStringOption(option => option
        .setName("format")
        .setDescription("The file format.")
        .setRequired(true)
        .addChoices(
          {name:"JSON", value:"json"},
          {name:"Text", value:"text"}
        )
      )
      .addChannelOption(option => option
        .setName("channel")
        .setDescription("Post the file in a channel instead of sending it privately.")
        .addChannelTypes(discord.ChannelType.GuildText, discord.ChannelType.GuildAnnouncement)
        .setRequired(false)
      )
    )
    .addSubcommand(subcommand => subcommand
      .setName("restore")
      .setDescription("Restore this server from a backup.")
      .addStringOption(option => option
        .setName("scope")
        .setDescription("Which data to restore.")
        .setRequired(true)
        .addChoices(
          {name:"This server", value:"guild"},
          {name:"All servers", value:"all"}
        )
      )
    )
    .setIntegrationTypes(0, 1)
    .setContexts(0, 1),

  new discord.SlashCommandBuilder()
    .setName("restore-all")
    .setDescription("Restore every server from a backup. Bot owner only."),

  //===================================================
  // Entitlements
  //===================================================
  new discord.SlashCommandBuilder()
    .setName("entitlement")
    .setDescription("Manage your BargazBot entitlement allocation.")
    .setIntegrationTypes(0, 1)
    .setContexts(0, 1),
  //===================================================
  // Permissions
  //===================================================
  new discord.SlashCommandBuilder()
    .setName("permissions")
    .setDescription("Open the BargazBot permissions menu."),

  //===================================================
  // Inactivity / Timers / Auto Publish / DMs
  //===================================================
  new discord.SlashCommandBuilder()
    .setName("inactivity")
    .setDescription("Configure inactivity alerts for channels or this server."),
  new discord.SlashCommandBuilder()
    .setName("timers")
    .setDescription("Manage reminders, recurring timers, and birthday announcements.")
    .setIntegrationTypes(0, 1)
    .setContexts(0, 1),
  new discord.SlashCommandBuilder()
    .setName("autopublish")
    .setDescription("Publish messages from announcement channels.")
    .addStringOption(option => option
      .setName("mode")
      .setDescription("What to publish.")
      .setRequired(true)
      .addChoices(
        {name:"Channel",                      value:"channel"},
        {name:"All announcement channels",    value:"all"},
        {name:"List configured channels",     value:"list"}
      )
    ),
  new discord.SlashCommandBuilder()
    .setName("dm")
    .setDescription("Configure your personal BargazBot direct messages.")
    .setIntegrationTypes(1)
    .setContexts(1),
  new discord.SlashCommandBuilder()
    .setName("dm-help")
    .setDescription("Shows BargazBot commands available in DMs.")
    .addStringOption(option => option
      .setName("command")
      .setDescription("A command to describe in detail.")
      .setRequired(false)
    )
    .setIntegrationTypes(1)
    .setContexts(1),
  new discord.SlashCommandBuilder()
    .setName("set-timezone")
    .setDescription("Set the timezone used for timers and birthdays.")
    .addStringOption(option => option
      .setName("timezone")
      .setDescription("An IANA name, e.g. America/New_York. Omit to pick from a menu.")
      .setRequired(false)
    )
    .setIntegrationTypes(0, 1)
    .setContexts(0, 1),
]
// Registers BargazBot's slash commands with Discord
// client = Discord Client
export async function registerCommands(client) {
  const commandData = commands.map(command => command.toJSON());
  await client.application.commands.set(commandData);
  console.log(`Registered ${commandData.length} BargazBot commands.`);
}

async function getGitHubCommitCount() {
  try {
    const response = await fetch("https://api.github.com/repos/DevonFG/BargazBot/commits?per_page=1", {
      headers: {"User-Agent": "BargazBot", "Accept": "application/vnd.github+json"},
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {return "unavailable";}
    const link = response.headers.get("link") ?? "";
    const match = /[?&]page=(\d+)>;\s*rel="last"/.exec(link);
    if (match) {return Number(match[1]).toLocaleString();}
    const commits = await response.json();
    return Array.isArray(commits) ? String(commits.length) : "unavailable";
  } catch {
    return "unavailable";
  }
}

async function handleStats(interaction) {
  const commits = await getGitHubCommitCount();
  const embed = new discord.EmbedBuilder()
    .setTitle("BargazBot statistics")
    .addFields(
      {name:"Servers",           value:String(interaction.client.guilds.cache.size), inline:true},
      {name:"YouTube channels",  value:String(youtube.getSubscribedChannels().length),   inline:true},
      {name:"Twitch channels",   value:String(twitch.getSubscribedChannels().length),    inline:true},
      {name:"Kick channels",     value:String(kick.getSubscribedChannels().length),      inline:true},
      {name:"GitHub commits",    value:commits, inline:true},
      {name:"Version",           value:BOT_VERSION, inline:true}
    )
    .setTimestamp();
  await interaction.reply({embeds:[embed], flags:discord.MessageFlags.Ephemeral});
}

function greetingMessage(kind, guildId) {
  return kind === "welcome"
    ? featureSettings.getGuildWelcomeMessage(guildId)
    : featureSettings.getGuildGoodbyeMessage(guildId);
}

function greetingOptions(kind, guildId) {
  return kind === "welcome"
    ? featureSettings.getGuildWelcomeOptions(guildId)
    : featureSettings.getGuildGoodbyeOptions(guildId);
}

async function handleLeaveJoin(interaction) {
  if (!interaction.guild) {
    await interaction.reply({content:"Use this command in a server.", flags:discord.MessageFlags.Ephemeral});
    return;
  }
  if (!await requireCommandAccess(interaction, "features-config", "setup")) {return;}

  const kind    = interaction.options.getString("type", true);
  const guildId = interaction.guild.id;
  const welcome = kind === "welcome";

  if (interaction.options.getBoolean("reset") === true) {
    if (welcome) {
      featureSettings.updateGuildWelcomeMessage(guildId, null, interaction.user.id);
      featureSettings.updateGuildWelcomeOptions(guildId, {}, interaction.user.id);
    } else {
      featureSettings.updateGuildGoodbyeMessage(guildId, null, interaction.user.id);
      featureSettings.updateGuildGoodbyeOptions(guildId, {}, interaction.user.id);
    }
    await interaction.reply({content:`${welcome ? "Welcome" : "Goodbye"} announcement reset to defaults.`, flags:discord.MessageFlags.Ephemeral});
    return;
  }

  const assignments = channelManager.getChannelAssignments(guildId) ?? {};
  const channelKey = welcome ? "welcome_channel_id" : "goodbye_channel_id";
  if (!assignments[channelKey]) {
    await interaction.reply({
      content:`No channel is configured for ${welcome ? "welcome" : "goodbye"} messages. Set one in /features-config > Channels.`,
      flags:discord.MessageFlags.Ephemeral
    });
    return;
  }

  const draft = {
    message: greetingMessage(kind, guildId),
    options: greetingOptions(kind, guildId)
  };
  let msg = null;

  const askMessage = async source => {
    const customId = menuId("leave-join", "modal", kind);
    const wait = source.awaitModalSubmit({
      filter:item => item.customId === customId && item.user.id === interaction.user.id,
      time:300000
    }).catch(() => null);
    await source.showModal(new discord.ModalBuilder()
      .setCustomId(customId)
      .setTitle(welcome ? "Welcome message" : "Goodbye message")
      .addComponents(new discord.ActionRowBuilder().addComponents(new discord.TextInputBuilder()
        .setCustomId("message")
        .setLabel("Announcement message")
        .setStyle(discord.TextInputStyle.Paragraph)
        .setValue(draft.message ?? "")
        .setRequired(false)
        .setMaxLength(1000)
      ))
    );
    const submitted = await wait;
    if (submitted) {
      draft.message = submitted.fields.getTextInputValue("message").trim() || null;
    }
    return submitted;
  };

  const render = () => {
    const fallback = welcome ? "Welcome to {server}, {user}!" : "{user} has left {server}.";
    return {
      embeds:[new discord.EmbedBuilder()
        .setTitle(welcome ? "Welcome announcement" : "Goodbye announcement")
        .setDescription(
          `**Message**\n${draft.message ?? fallback}\n\n` +
          `Username: ${draft.options.username ? "on" : "off"}\n` +
          `Nickname: ${draft.options.nickname ? "on" : "off"}\n` +
          `Profile embed: ${draft.options.profile ? "on" : "off"}`
        )
        .setFooter({text:"Placeholders: {user}, {username}, {nickname}, {server}, {count}"})],
      components:[
        buildSelectRow(menuId("leave-join", "options", kind), [
          menuOption("Username", "username", "Show username", draft.options.username),
          menuOption("Nickname", "nickname", "Show nickname", draft.options.nickname),
          menuOption("Profile embed", "profile", "Avatar, account age, join date", draft.options.profile)
        ], {placeholder:"Details to include", minValues:0, maxValues:3}),
        buildButtonRow([
          {customId:menuId("leave-join", "edit", kind), label:"Edit message", style:"primary"},
          {customId:menuId("leave-join", "save", kind), label:"Save", style:"success"},
          {customId:menuId("leave-join", "cancel", kind), label:"Cancel", style:"secondary"}
        ])
      ],
      flags:discord.MessageFlags.Ephemeral
    };
  };

  const firstSubmit = await askMessage(interaction);
  if (!firstSubmit) {return;}
  await firstSubmit.reply(render());
  msg = await firstSubmit.fetchReply();

  const collector = createCommandCollector(msg, {time:300000});
  onCommandComponent(collector, async component => {
    if (component.user.id !== interaction.user.id) {
      await component.reply({content:"Only the person who opened this menu can use it.", flags:discord.MessageFlags.Ephemeral});
      return;
    }
    const action = parseMenuId(component.customId)[1];
    try {
      if (action === "options") {
        const values = new Set(component.values ?? []);
        draft.options = {
          username: values.has("username"),
          nickname: values.has("nickname"),
          profile:  values.has("profile")
        };
        await component.update(render());
        return;
      }
      if (action === "edit") {
        const submitted = await askMessage(component);
        if (!submitted) {return;}
        await submitted.update(render());
        return;
      }
      if (action === "cancel") {
        collector.stop("cancel");
        await component.update({content:"Cancelled.", embeds:[], components:[]});
        return;
      }
      if (action === "save") {
        await component.deferUpdate();
        if (welcome) {
          featureSettings.updateGuildWelcomeMessage(guildId, draft.message, interaction.user.id);
          featureSettings.updateGuildWelcomeOptions(guildId, draft.options, interaction.user.id);
        } else {
          featureSettings.updateGuildGoodbyeMessage(guildId, draft.message, interaction.user.id);
          featureSettings.updateGuildGoodbyeOptions(guildId, draft.options, interaction.user.id);
        }
        await interaction.editReply({content:"Saved.", embeds:[], components:[]});
        collector.stop("saved");
      }
    } catch (error) {
      log.error("Leave/join menu error:", error);
      await interaction.editReply({content:"The menu encountered an error. No changes were saved.", embeds:[], components:[]}).catch(() => {});
      collector.stop("error");
    }
  });
  collector.on("end", async () => {await interaction.editReply({components:[]}).catch(() => {});});
}

async function handleTest(interaction) {
  if (!interaction.guild) {
    await interaction.reply({content:"Use this command in a server.", flags:discord.MessageFlags.Ephemeral});
    return;
  }
  const feature = interaction.options.getString("feature", true);
  const access = {
    notification:["notification","test"],
    leave:["features-config","setup"],
    join:["features-config","setup"],
    inactivity:["inactivity","setup"],
    logging:["logging","view"],
    timers:["timers","setup"]
  }[feature];
  if (!access || !await requireCommandAccess(interaction, access[0], access[1])) {return;}

  if (feature === "notification") {await testNotification(interaction); return;}
  if (feature === "leave" || feature === "join") {await testGreeting(interaction, feature === "join" ? "welcome" : "goodbye"); return;}
  if (feature === "inactivity") {await testInactivity(interaction); return;}
  if (feature === "logging") {await testLogging(interaction); return;}
  if (feature === "timers") {await testTimer(interaction); return;}
}

async function testNotification(interaction) {
  const targets = notifications.getTestTargets(interaction.guild.id);
  if (!targets.length) {
    await interaction.reply({content:"No notification configs exist in this server yet.", flags:discord.MessageFlags.Ephemeral});
    return;
  }
  const state = {selected:[], useLatest:false};
  const render = () => ({
    embeds:[new discord.EmbedBuilder()
      .setTitle("Test notification")
      .setDescription("Pick one notification and the data to use, then send. This posts to the real destination.")],
    components:[
      buildSelectRow(menuId("test", "notification", "pick"),
        targets.slice(0,25).map(target => menuOption(target.label, target.value)),
        {placeholder:"Choose a notification", minValues:1, maxValues:1}),
      buildSelectRow(menuId("test", "notification", "data"), [
        menuOption("Preset data", "preset"),
        menuOption("Latest cached data", "latest")
      ], {placeholder:"Test data", minValues:1, maxValues:1}),
      buildButtonRow([
        {customId:menuId("test", "notification", "send"), label:"Send test", style:"primary"},
        {customId:menuId("test", "notification", "cancel"), label:"Cancel", style:"secondary"}
      ])
    ],
    flags:discord.MessageFlags.Ephemeral
  });

  await interaction.deferReply({flags:discord.MessageFlags.Ephemeral});
  const msg = await interaction.editReply(render());
  const collector = createCommandCollector(msg, {time:300000});
  onCommandComponent(collector, async component => {
    if (component.user.id !== interaction.user.id) {
      await component.reply({content:"Only the person who opened this menu can use it.", flags:discord.MessageFlags.Ephemeral});
      return;
    }
    const action = parseMenuId(component.customId)[2];
    try {
      if (action === "pick") {state.selected = component.values ?? []; await component.deferUpdate(); return;}
      if (action === "data") {state.useLatest = component.values?.[0] === "latest"; await component.deferUpdate(); return;}
      if (action === "cancel") {collector.stop("cancel"); await component.update({content:"Cancelled.", embeds:[], components:[]}); return;}
      if (action === "send") {
        await component.deferUpdate();
        if (!state.selected.length) {
          await interaction.editReply({content:"Pick a notification first.", embeds:[], components:[]});
          collector.stop("error");
          return;
        }
        const lines = [];
        for (const value of state.selected) {
          const target = targets.find(item => item.value === value);
          const result = await notifications.sendTestNotification(interaction.client, interaction.guild.id, target, state.useLatest);
          lines.push(result.success ? `Sent **${target.label}**.` : `Failed **${target.label}**: ${result.reason}.`);
        }
        await interaction.editReply({content:lines.join("\n"), embeds:[], components:[]});
        collector.stop("sent");
      }
    } catch (error) {
      log.error("Notification test error:", error);
      await interaction.editReply({content:"The test failed.", embeds:[], components:[]}).catch(() => {});
      collector.stop("error");
    }
  });
  collector.on("end", async () => {await interaction.editReply({components:[]}).catch(() => {});});
}

async function testGreeting(interaction, kind) {
  const channel = await channelManager.getChannel(interaction.guild, kind);
  if (!channel) {
    await interaction.reply({content:`No ${kind} channel is configured. Set it in /features-config.`, flags:discord.MessageFlags.Ephemeral});
    return;
  }
  const welcome   = kind === "welcome";
  const template  = welcome ? featureSettings.getGuildWelcomeMessage(interaction.guild.id) : featureSettings.getGuildGoodbyeMessage(interaction.guild.id);
  const options   = welcome ? featureSettings.getGuildWelcomeOptions(interaction.guild.id) : featureSettings.getGuildGoodbyeOptions(interaction.guild.id);
  const member    = interaction.member;
  const fallback  = welcome ? "Welcome to {server}, {user}!" : "{user} has left {server}.";
  const content   = (template ?? fallback)
    .replaceAll("{user}", `<@${interaction.user.id}>`)
    .replaceAll("{username}", interaction.user.tag)
    .replaceAll("{nickname}", member?.displayName ?? interaction.user.username)
    .replaceAll("{server}", interaction.guild.name)
    .replaceAll("{count}", String(interaction.guild.memberCount));

  const fields = [];
  if (options.username) {fields.push({name:"Username", value:`\`${interaction.user.tag}\``, inline:true});}
  if (options.nickname) {fields.push({name:"Nickname", value:`\`${member?.displayName ?? interaction.user.username}\``, inline:true});}
  if (options.profile) {
    fields.push({name:"Account created", value:`<t:${Math.floor(interaction.user.createdAt.getTime() / 1000)}:R>`, inline:true});
    if (welcome && member?.joinedAt) {
      fields.push({name:"Joined server", value:`<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>`, inline:true});
    }
  }
  let embed = null;
  if (fields.length) {
    embed = new discord.EmbedBuilder()
      .setTitle(welcome ? "Member joined" : "Member left")
      .setColor(welcome ? 0x57F287 : 0xED4245);
    if (options.profile) {embed.setThumbnail(interaction.user.displayAvatarURL());}
    embed.addFields(fields);
  }

  await channel.send({
    content:`**This is a test**\n${content}`,
    ...(embed ? {embeds:[embed]} : {}),
    allowedMentions:{parse:[]}
  });
  await interaction.reply({content:`Sent a test ${welcome ? "join" : "leave"} message to ${channel}.`, flags:discord.MessageFlags.Ephemeral});
}

async function testInactivity(interaction) {
  const rules = inactivity.getRules(interaction.guild.id);
  if (!rules.length) {
    await interaction.reply({content:"No inactivity rules are configured in this server.", flags:discord.MessageFlags.Ephemeral});
    return;
  }
  const state = {selected:0};
  const render = () => ({
    embeds:[new discord.EmbedBuilder()
      .setTitle("Test inactivity rule")
      .setDescription("Pick a rule. Its alert message is posted to its destination channel with a test header; no rule state changes.")],
    components:[
      buildSelectRow(menuId("test", "inactivity", "pick"),
        rules.map((rule, index) => menuOption(rule.name, String(index))),
        {placeholder:"Choose a rule", minValues:1, maxValues:1}),
      buildButtonRow([
        {customId:menuId("test", "inactivity", "send"), label:"Send test", style:"primary"},
        {customId:menuId("test", "inactivity", "cancel"), label:"Cancel", style:"secondary"}
      ])
    ],
    flags:discord.MessageFlags.Ephemeral
  });

  await interaction.deferReply({flags:discord.MessageFlags.Ephemeral});
  const msg = await interaction.editReply(render());
  const collector = createCommandCollector(msg, {time:300000});
  onCommandComponent(collector, async component => {
    if (component.user.id !== interaction.user.id) {
      await component.reply({content:"Only the person who opened this menu can use it.", flags:discord.MessageFlags.Ephemeral});
      return;
    }
    const action = parseMenuId(component.customId)[2];
    try {
      if (action === "pick") {state.selected = Number(component.values?.[0] ?? 0); await component.deferUpdate(); return;}
      if (action === "cancel") {collector.stop("cancel"); await component.update({content:"Cancelled.", embeds:[], components:[]}); return;}
      if (action === "send") {
        await component.deferUpdate();
        const rule = rules[state.selected];
        const channelId = rule.destinationChannelId ?? rule.channelId ?? rule.targets?.[0];
        const channel = channelId
          ? interaction.guild.channels.cache.get(channelId) ?? await interaction.guild.channels.fetch(channelId).catch(() => null)
          : null;
        if (!channel?.isTextBased() || channel.isThread()) {
          await interaction.editReply({content:"That rule has no usable destination channel.", embeds:[], components:[]});
          collector.stop("error");
          return;
        }
        const minutes = rule.thresholdMinutes;
        const duration = minutes >= 60
          ? `${Math.floor(minutes / 60)} hour${Math.floor(minutes / 60) === 1 ? "" : "s"}`
          : `${minutes} minute${minutes === 1 ? "" : "s"}`;
        const text = (rule.message || "This channel has been inactive for {duration}.")
          .replaceAll("{channel}", `<#${channel.id}>`)
          .replaceAll("{duration}", duration)
          .replaceAll("{minutes}", String(minutes));
        await channel.send({content:`**This is a test**\n${text}`, allowedMentions:{parse:[]}});
        await interaction.editReply({content:`Sent a test alert for **${rule.name}** to ${channel}.`, embeds:[], components:[]});
        collector.stop("sent");
      }
    } catch (error) {
      log.error("Inactivity test error:", error);
      await interaction.editReply({content:"The test failed.", embeds:[], components:[]}).catch(() => {});
      collector.stop("error");
    }
  });
  collector.on("end", async () => {await interaction.editReply({components:[]}).catch(() => {});});
}

async function testTimer(interaction) {
  const list = timers.getTimers("guild",interaction.guild.id);
  if (!list.length) {
    await interaction.reply({content:"No timers are configured in this server.", flags:discord.MessageFlags.Ephemeral});
    return;
  }
  const state = {selected:0};
  const render = () => ({
    embeds:[new discord.EmbedBuilder()
      .setTitle("Test timer")
      .setDescription("Pick a timer. Its message is posted now with a test header; its schedule is not changed.")],
    components:[
      buildSelectRow(menuId("test", "timer", "pick"),
        list.map((timer, index) => menuOption(timer.name || "Reminder", String(index))),
        {placeholder:"Choose a timer", minValues:1, maxValues:1}),
      buildButtonRow([
        {customId:menuId("test", "timer", "send"), label:"Send test", style:"primary"},
        {customId:menuId("test", "timer", "cancel"), label:"Cancel", style:"secondary"}
      ])
    ],
    flags:discord.MessageFlags.Ephemeral
  });

  await interaction.deferReply({flags:discord.MessageFlags.Ephemeral});
  const msg = await interaction.editReply(render());
  const collector = createCommandCollector(msg, {time:300000});
  onCommandComponent(collector, async component => {
    if (component.user.id !== interaction.user.id) {
      await component.reply({content:"Only the person who opened this menu can use it.", flags:discord.MessageFlags.Ephemeral});
      return;
    }
    const action = parseMenuId(component.customId)[2];
    try {
      if (action === "pick") {state.selected = Number(component.values?.[0] ?? 0); await component.deferUpdate(); return;}
      if (action === "cancel") {collector.stop("cancel"); await component.update({content:"Cancelled.", embeds:[], components:[]}); return;}
      if (action === "send") {
        await component.deferUpdate();
        const timer = list[state.selected];
        const channelId = timer.channelId;
        const channel = channelId
          ? interaction.guild.channels.cache.get(channelId) ?? await interaction.guild.channels.fetch(channelId).catch(() => null)
          : [...interaction.guild.channels.cache.values()].find(item => item.isTextBased() && !item.isThread() && item.type === discord.ChannelType.GuildText);
        if (!channel?.isTextBased() || channel.isThread()) {
          await interaction.editReply({content:"That timer has no usable channel.", embeds:[], components:[]});
          collector.stop("error");
          return;
        }
        const timeValue = `<t:${Math.floor((timer.nextRunAt ? new Date(timer.nextRunAt).getTime() : Date.now()) / 1000)}:f>`;
        const content = (timer.message || "Reminder: {name}")
          .replaceAll("{name}", timer.name)
          .replaceAll("{channel}", `<#${channel.id}>`)
          .replaceAll("{time}", timeValue)
          .replaceAll("{date}", timeValue);
        await channel.send({content:`**This is a test**\n${content}`, allowedMentions:{parse:[]}});
        await interaction.editReply({content:`Sent a test for **${timer.name || "Reminder"}** to ${channel}.`, embeds:[], components:[]});
        collector.stop("sent");
      }
    } catch (error) {
      log.error("Timer test error:", error);
      await interaction.editReply({content:"The test failed.", embeds:[], components:[]}).catch(() => {});
      collector.stop("error");
    }
  });
  collector.on("end", async () => {await interaction.editReply({components:[]}).catch(() => {});});
}

async function testLogging(interaction) {
  const channel = await channelManager.getChannel(interaction.guild, "logs");
  if (!channel) {
    await interaction.reply({content:"No log channel is configured. Set it in /features-config.", flags:discord.MessageFlags.Ephemeral});
    return;
  }
  await channel.send({
    embeds:[new discord.EmbedBuilder()
      .setTitle("BargazBot logging test")
      .setDescription("**This is a test.** BargazBot log messages appear here. Use `/logging` to choose which events are logged.")
      .setColor(0x5865F2)
      .setTimestamp()]
  });
  await interaction.reply({content:`Sent a test log message to ${channel}.`, flags:discord.MessageFlags.Ephemeral});
}

// Registers BargazBot's slash commands with Discord
// client = Discord Client
export async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) {return;}
  try {
    if (interaction.guild) {channelManager.ensureGuildData(interaction.guild);}
    entitlements.ensureUser(interaction.user);
    switch (interaction.commandName) {
      case "ping":            await handlePing(interaction); break;
      case "help":            await handleHelp(interaction); break;
      case "stats":           await handleStats(interaction); break;
      case "leave-join":      await handleLeaveJoin(interaction); break;
      case "features-config": await handleFeaturesConfig(interaction); break;
      case "logging":         await handleLogging(interaction); break;
      case "data":            await handleData(interaction); break;
      case "entitlement":     await handleEntitlement(interaction); break;
      case "permissions":     await handlePermissions(interaction); break;
      case "restore-all":     await handleRestoreAll(interaction); break;
      case "notification":    await handleNotification(interaction); break;
      case "inactivity":      await handleInactivity(interaction); break;
      case "timers":          await handleTimers(interaction); break;
      case "autopublish":     await handleAutopublish(interaction); break;
      case "dm-help":         await handleDmHelp(interaction); break;
      case "set-timezone":    await handleSetTimezone(interaction); break;
      case "dm":              await handleDm(interaction); break;
      case "test":            await handleTest(interaction); break;
      default: await interaction.reply({content: "BargazBot does not recognize this command.", flags: discord.MessageFlags.Ephemeral});
    }
    if (interaction.guild) {await logging.logCommand(interaction);}
  } catch (error) {
    log.error("Error handling /" + interaction.commandName + ":", error);
    const response = {
      content:"BargazBot encountered an error while processing that command.",
      flags: discord.MessageFlags.Ephemeral
    };
    if (interaction.guild) {
      await logging.logCommand(
        interaction, {successful: false, details: error.message}
      ).catch(loggingError => {console.error("Failed to log command error:", loggingError);});
    }
    if (interaction.deferred && !interaction.replied) {await interaction.editReply({content:response.content}).catch(() => {});
    } else if (interaction.replied)                   {await interaction.followUp(response).catch(() => {});
    } else                                            {await interaction.reply(response).catch(() => {});}
  }
}

// Responds to the ping command
// interaction = ChatInputCommandInteraction
async function handlePing(interaction) {await interaction.reply({content: "Pong!", flags: discord.MessageFlags.Ephemeral});}

// Builds the help catalog from the registered command definitions
function buildCommandCatalog() {
  return commands.map(command => {
    const data    = command.toJSON();
    const options = data.options ?? [];
    const subcommands = options
      .filter(option => option.type === discord.ApplicationCommandOptionType.Subcommand)
      .map(option => ({
        name: option.name,
        description: option.description,
        options: (option.options ?? []).map(child => child.name)
      }));

    return {
      name: data.name,
      description: data.description,
      subcommands,
      options: options
        .filter(option => option.type !== discord.ApplicationCommandOptionType.Subcommand)
        .map(option => ({name: option.name, description: option.description ?? ""}))
    };
  });
}

// Builds the detail view for one command
function buildCommandHelpEmbed(catalog, requested) {
  const command = catalog.find(entry => entry.name === requested);
  if (!command) {return null;}

  const fields = [];

  if (command.subcommands.length) {
    fields.push({name:"Subcommands", value: command.subcommands
      .map(subcommand => `**${subcommand.name}** — ${subcommand.description}${subcommand.options.length ? ` (${subcommand.options.join(", ")})` : ""}`)
      .join("\n").slice(0, 1024)});
  }
  if (command.options.length) {
    fields.push({name:"Options", value: command.options
      .map(option => `**${option.name}** — ${option.description}`)
      .join("\n").slice(0, 1024)});
  }

  const embed = new discord.EmbedBuilder()
    .setTitle(`/${command.name}`)
    .setDescription(command.description);

  if (fields.length) {embed.addFields(...fields);}
  return embed;
}

// Displays BargazBot's command help information
// interaction = ChatInputCommandInteraction
async function handleHelp(interaction) {
  const catalog   = buildCommandCatalog();
  const requested = interaction.options.getString("command")?.replace(/^\//, "").trim().toLowerCase();

  if (requested) {
    const embed = buildCommandHelpEmbed(catalog, requested);
    if (!embed) {
      await interaction.reply({content: `\`${requested}\` is not a BargazBot command. Use \`/help\` to list them.`, flags:discord.MessageFlags.Ephemeral});
      return;
    }
    await interaction.reply({embeds:[embed], flags:discord.MessageFlags.Ephemeral});
    return;
  }

  const embed = new discord.EmbedBuilder()
    .setTitle("BargazBot Commands")
    .setDescription(`Use \`/help command:<name>\` for details. ${catalog.length} commands available.`)
    .addFields(catalog.map(command => ({
      name: `/${command.name}`,
      value: `${command.description}${command.subcommands.length ? `\n${command.subcommands.map(subcommand => `\`${subcommand.name}\``).join(", ")}` : ""}`.slice(0, 1024)
    })))
    .setTimestamp();

  await interaction.reply({embeds:[embed], flags:discord.MessageFlags.Ephemeral});
}

async function handleDmHelp(interaction) {
  const dmCommandNames = new Set([
    "ping", "help", "stats", "data", "dm", "dm-help",
    "notification", "entitlement", "timers", "set-timezone"
  ]);
  const catalog = buildCommandCatalog().filter(command => dmCommandNames.has(command.name));
  const requested = interaction.options.getString("command")?.replace(/^\//, "").trim().toLowerCase();

  if (requested) {
    const embed = buildCommandHelpEmbed(catalog, requested);
    if (!embed) {
      await interaction.reply({content:`\`${requested}\` is not a DM command. Use \`/dm-help\` to list them.`, flags:discord.MessageFlags.Ephemeral});
      return;
    }
    await interaction.reply({embeds:[embed], flags:discord.MessageFlags.Ephemeral});
    return;
  }

  const embed = new discord.EmbedBuilder()
    .setTitle("BargazBot DM Commands")
    .setDescription(`Use \`/dm-help command:<name>\` for details. ${catalog.length} commands available.`)
    .addFields(catalog.map(command => ({
      name:`/${command.name}`,
      value:`${command.description}${command.subcommands.length ? `\n${command.subcommands.map(subcommand => `\`${subcommand.name}\``).join(", ")}` : ""}`.slice(0, 1024)
    })))
    .setTimestamp();

  await interaction.reply({embeds:[embed], flags:discord.MessageFlags.Ephemeral});
}

const FEATURE_LABELS = {
  notifications:"Creator notifications", welcome:"Welcome messages", goodbye:"Goodbye messages",
  logs:"Server logs", updates:"BargazBot updates", status:"Status",
  inactivity:"Inactivity alerts", timers:"Timers and reminders", birthdays:"Birthday announcements",
  autopublish:"Auto publish", dm:"Direct messages"
};

const CHANNEL_PURPOSES = [
  ["notifications", "Creator notification fallback", "announcement_channel_id"],
  ["welcome",       "Welcome messages",              "welcome_channel_id"],
  ["goodbye",       "Goodbye messages",              "goodbye_channel_id"],
  ["logs",          "Server logs",                   "logs_channel_id"],
  ["updates",       "BargazBot updates",             "updates_channel_id"],
  ["status",        "Status",                        "status_channel_id"]
];

function featureChannelRows(guildId) {
  const settings = channelManager.getChannelAssignments(guildId) ?? {};
  return [
    menuOption("Channels", "channels", "Assign the feature channels"),
    menuOption("Features", "features", "Toggle features and set response types"),
    menuOption("Responses", "responses", "Command default and all-but-default response types"),
    menuOption("Reset setup", "reset", "Clear this server's setup so join setup runs again")
  ];
}

function renderFeatureChannelMenu(guildId, state) {
  const embed = new discord.EmbedBuilder()
    .setTitle("BargazBot Features")
    .setColor(0x5865F2)
    .setTimestamp();
  let rows = [];

  if (state.page === "home") {
    const settings = channelManager.getChannelAssignments(guildId) ?? {};
    const summary = CHANNEL_PURPOSES
      .map(([, label, key]) => `${label}: ${settings[key] ? `<#${settings[key]}>` : "Not set"}`)
      .join("\n");
    const featureLines = featureSettings.FEATURE_KEYS
      .map(key => `${featureSettings.isFeatureEnabled(guildId, key) ? "✅" : "❌"} ${FEATURE_LABELS[key] ?? key} — ${featureSettings.getFeatureResponseType(guildId, key) ?? "none"}`)
      .join("\n");
    embed.setDescription((state.status ? `${state.status}\n\n` : "") +
      `**Channels**\n${summary}\n\n**Features**\n${featureLines}`);
    rows = [buildSelectRow(menuId("features-config","home"), featureChannelRows(guildId), {placeholder:"Choose a setup area"})];
  }

  if (state.page === "channels") {
    const settings = channelManager.getChannelAssignments(guildId) ?? {};
    embed.setDescription("Pick a feature, then pick a channel. Use **Clear** to unset it.");
    rows = [
      buildSelectRow(menuId("features-config","channels"), CHANNEL_PURPOSES.map(([key,label]) =>
        menuOption(label, key, settings[CHANNEL_PURPOSES.find(row => row[0] === key)[2]] ? "Configured" : "Not set")
      ), {placeholder:"Choose a feature channel"}),
      buildButtonRow([{customId:menuId("features-config","channels","back"), label:"Back", style:"secondary"}])
    ];
  }

  if (state.page === "channels-pick") {
    const purpose = CHANNEL_PURPOSES.find(row => row[0] === state.purpose);
    embed.setDescription(`Choose the channel for **${purpose[1]}**.`);
    rows = [
      buildSelectRow(menuId("features-config","channels","pick"), [
        menuOption("Clear (unset)", "clear", "Remove this channel assignment"),
        ...[...state.guild.channels.cache.values()]
          .filter(channel => channel.isTextBased() && [discord.ChannelType.GuildText, discord.ChannelType.GuildAnnouncement].includes(channel.type))
          .slice(0, 24)
          .map(channel => menuOption(channel.name, channel.id))
      ], {placeholder:"Choose a channel"}),
      buildButtonRow([{customId:menuId("features-config","channels","pick","back"), label:"Back", style:"secondary"}])
    ];
  }

  if (state.page === "features") {
    embed.setDescription("Select features to toggle together. Logging, updates, and status are on by default.");
    rows = [
      buildSelectRow(menuId("features-config","features"), featureSettings.FEATURE_KEYS.map(key =>
        menuOption(FEATURE_LABELS[key] ?? key, key, featureSettings.isFeatureEnabled(guildId, key) ? "On" : "Off", featureSettings.isFeatureEnabled(guildId, key))
      ), {placeholder:"Choose features", minValues:1, maxValues:Math.min(featureSettings.FEATURE_KEYS.length,25)}),
      buildSelectRow(menuId("features-config","features","toggle"), [
        menuOption("Turn selected on", "on"),
        menuOption("Turn selected off", "off"),
        menuOption("Reset all to defaults", "reset")
      ], {placeholder:"Apply to selected features"}),
      buildSelectRow(menuId("features-config","features","response"), [
        menuOption("Message", "message", "Visible to everyone"),
        menuOption("Ephemeral", "ephemeral", "Only the command user sees it")
      ], {placeholder:"Set response type for selected features"}),
      buildButtonRow([{customId:menuId("features-config","features","back"), label:"Back", style:"secondary"}])
    ];
  }

  if (state.page === "responses") {
    embed.setDescription(
      `Command default: **${featureSettings.getCommandResponseType(guildId)}**\n\n` +
      "Changing all response types does not change the command default."
    );
    rows = [
      buildSelectRow(menuId("features-config","responses","command"), [
        menuOption("Message", "message", "Visible command replies"),
        menuOption("Ephemeral", "ephemeral", "Private command replies")
      ], {placeholder:"Set command default"}),
      buildSelectRow(menuId("features-config","responses","all"), [
        menuOption("All features → message", "message"),
        menuOption("All features → ephemeral", "ephemeral")
      ], {placeholder:"Set all feature response types (except command default)"}),
      buildButtonRow([{customId:menuId("features-config","responses","back"), label:"Back", style:"secondary"}])
    ];
  }
  return {embeds:[embed], components:rows, flags:discord.MessageFlags.Ephemeral};
}

async function handleFeaturesConfig(interaction) {
  if (!await requireCommandAccess(interaction, "features-config", "setup")) {return;}
  const state = {page:"home", purpose:null, status:null, features:[], guild:interaction.guild};
  const render = () => ({...renderFeatureChannelMenu(interaction.guild.id, state), guild:interaction.guild});
  await interaction.deferReply({flags:discord.MessageFlags.Ephemeral});
  const reply = await interaction.editReply(renderFeatureChannelMenu(interaction.guild.id, state));

  const collector = createCommandCollector(reply, {time:300000});
  onCommandComponent(collector, async component => {
    if (component.user.id !== interaction.user.id) {await component.reply({content:"Only the person who opened this menu can use it.", flags:discord.MessageFlags.Ephemeral}); return;}
    const parts = parseMenuId(component.customId);
    const action = parts[1];
    try {
      if (action === "back") {state.page = "home"; state.status = null; await component.update(renderFeatureChannelMenu(interaction.guild.id, state)); return;}

      if (action === "home") {
        const choice = component.values?.[0];
        state.status = null;
        state.page = choice === "home" ? "home" : choice;
        await component.update(renderFeatureChannelMenu(interaction.guild.id, state));
        return;
      }

      if (action === "channels" && parts[2] !== "pick") {
        if (parts[2] === "back") {state.page = "home"; await component.update(renderFeatureChannelMenu(interaction.guild.id, state)); return;}
        state.purpose = component.values?.[0];
        state.page = "channels-pick";
        await component.update(renderFeatureChannelMenu(interaction.guild.id, state));
        return;
      }

      if (action === "channels" && parts[2] === "pick") {
        if (parts[3] === "back") {state.page = "channels"; await component.update(renderFeatureChannelMenu(interaction.guild.id, state)); return;}
        const purpose = CHANNEL_PURPOSES.find(row => row[0] === state.purpose);
        const channelId = component.values?.[0] === "clear" ? null : component.values?.[0];
        channelManager.setChannel(interaction.guild.id, state.purpose, channelId);
        await logging.logConfigurationChange(interaction.guild, {
          user:interaction.user,
          title:"BargazBot Channel Changed",
          description:`${interaction.user} changed a BargazBot channel setting.`,
          fields:[{name:"Purpose", value:purpose[1], inline:true}, {name:"Channel", value:channelId ? `<#${channelId}>` : "Cleared", inline:true}]
        });
        state.status = `Updated **${purpose[1]}**.`;
        state.page = "home";
        await component.update(renderFeatureChannelMenu(interaction.guild.id, state));
        return;
      }

      if (action === "features") {
        if (parts[2] === "back") {state.page = "home"; await component.update(renderFeatureChannelMenu(interaction.guild.id, state)); return;}
        if (component.values && !parts[2]) {state.features = component.values ?? []; await component.update(renderFeatureChannelMenu(interaction.guild.id, state)); return;}
        const choice = component.values?.[0];
        if (parts[2] === "toggle") {
          if (choice === "reset") {
            featureSettings.resetFeatureSettings(interaction.guild.id, interaction.user.id);
            if (state.features.includes("entitlement")) {
              entitlements.removeGuildAllocations(interaction.user.id, interaction.guild.id);
              entitlements.clearInstallerAutoAllocation(interaction.guild.id, interaction.user.id);
            }
            state.status = "Feature settings restored to defaults.";
          }
          else {
            for (const feature of state.features) {
              featureSettings.setFeatureEnabled(interaction.guild.id, feature, choice === "on", interaction.user.id);
              if (feature === "entitlement") {
                if (choice === "on") {
                  entitlements.ensureUser({id: interaction.user.id});
                  entitlements.autoAllocateInstaller(interaction.guild.id, interaction.user.id);
                }
                if (choice === "off") {
                  entitlements.removeGuildAllocations(interaction.user.id, interaction.guild.id);
                  entitlements.clearInstallerAutoAllocation(interaction.guild.id, interaction.user.id);
                }
              }
            }
            state.status = `Updated ${state.features.length} feature(s).`;
          }
        }
        if (parts[2] === "response") {
          for (const feature of state.features) {featureSettings.setFeatureReplyType(interaction.guild.id, feature, choice, interaction.user.id);}
          state.status = `Set response type for ${state.features.length} feature(s).`;
        }
        await component.update(renderFeatureChannelMenu(interaction.guild.id, state));
        return;
      }

      if (action === "responses") {
        if (parts[2] === "back") {state.page = "home"; await component.update(renderFeatureChannelMenu(interaction.guild.id, state)); return;}
        const choice = component.values?.[0];
        if (parts[2] === "command") {featureSettings.updateCommandReplyType(interaction.guild.id, choice, interaction.user.id); state.status = `Command default is now **${choice}**.`;}
        if (parts[2] === "all") {featureSettings.setAllFeatureReplyTypes(interaction.guild.id, choice, interaction.user.id); state.status = `All feature response types are now **${choice}**.`;}
        await component.update(renderFeatureChannelMenu(interaction.guild.id, state));
        return;
      }

      if (action === "reset") {
        featureSettings.resetGuildSetup(interaction.guild.id);
        state.status = "Setup cleared. The next join or data deletion will run setup again.";
        state.page = "home";
        await component.update(renderFeatureChannelMenu(interaction.guild.id, state));
        return;
      }

      await component.update(renderFeatureChannelMenu(interaction.guild.id, state));
    } catch (error) {
      log.error("Feature configuration menu error:", error);
      await component.reply({content:"The feature menu encountered an error.", flags:discord.MessageFlags.Ephemeral}).catch(() => {});
      collector.stop("error");
    }
  });
  collector.on("end", async () => {await interaction.editReply({components:[]}).catch(() => {});});
}

// Builds the logging category choices from the shared logger definition
function loggingCategoryChoices() {
  return Object.entries(logging.LOG_CATEGORIES).map(([value, definition]) => ({name: definition.name, value}));
}

// Builds the logging settings embed
// settings = Object returned by logging.getLogSettings()
function buildLoggingEmbed(settings, logsChannelId) {
  const description = Object.entries(settings)
    .map(([, setting]) => `${setting.enabled ? "✅" : "❌"} **${setting.name}**${setting.isOverride ? " (custom)" : ""}`)
    .join("\n");

  return new discord.EmbedBuilder()
    .setTitle("BargazBot Logging")
    .setDescription(description)
    .addFields({name:"Log channel", value: logsChannelId ? `<#${logsChannelId}>` : "Not configured"})
    .setFooter({text:"Use /channels set to change the log channel."})
    .setTimestamp();
}

// Builds the logging category menu
// settings = Object returned by logging.getLogSettings()
function buildLoggingMenu(settings) {
  return new discord.ActionRowBuilder().addComponents(
    new discord.StringSelectMenuBuilder()
      .setCustomId("logging:category")
      .setPlaceholder("Select a category to toggle")
      .addOptions(
        Object.entries(settings).map(([value, setting]) => ({
          label: setting.name,
          value,
          description: `${setting.enabled ? "Enabled" : "Disabled"}${setting.isOverride ? " - custom" : " - default"}`
        }))
      )
  );
}

// Routes logging commands after checking individual access
// interaction = ChatInputCommandInteraction
async function handleLogging(interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (!await requireCommandAccess(interaction, "logging", subcommand)) {return;}
  switch (subcommand) {
    case "view":  await handleLoggingView(interaction); break;
    case "set":   await handleLoggingSet(interaction); break;
    case "reset": await handleLoggingReset(interaction); break;
  }
}

// Displays the server's logging categories and toggles them from the menu
// interaction = ChatInputCommandInteraction
async function handleLoggingView(interaction) {
  const getChannelId = () => channelManager.getChannelAssignments(interaction.guild.id)?.logs_channel_id;
  const settings = logging.getLogSettings(interaction.guild.id);
  await interaction.reply({embeds:[buildLoggingEmbed(settings, getChannelId())], components:[buildLoggingMenu(settings)], flags:discord.MessageFlags.Ephemeral});
  const message = await interaction.fetchReply();
  const collector = createCommandCollector(message, {time: 300000});
  onCommandComponent(collector, async component => {
    if (component.user.id !== interaction.user.id) {await component.reply({content: "Only the person who opened this menu can use it.", flags: discord.MessageFlags.Ephemeral}); return;}
    if (!permissions.canUseCommand(component.member, "logging", "set")) {await component.reply({content: "You do not have permission to change logging settings.", flags: discord.MessageFlags.Ephemeral}); return;}
    try {
      const category = component.values[0];
      const enabled  = !logging.getLogSettings(interaction.guild.id)[category].enabled;
      logging.setCategoryEnabled(interaction.guild.id, category, enabled);
      const updated = logging.getLogSettings(interaction.guild.id);
      await component.update({embeds:[buildLoggingEmbed(updated, getChannelId())], components:[buildLoggingMenu(updated)]});
      await logging.logConfigurationChange(interaction.guild, {
        user: interaction.user,
        title: "BargazBot Logging Changed",
        description: `${interaction.user} changed a BargazBot logging category.`,
        fields: [
          {name:"Category", value: updated[category].name, inline: true},
          {name:"Enabled",  value: enabled ? "Yes" : "No",    inline: true}
        ]
      }).catch(error => console.error("Failed to log logging change:", error));
    } catch (error) {
      console.error("Logging menu error:", error);
      if (!component.replied && !component.deferred) {await component.reply({content: "The logging menu encountered an error.", flags: discord.MessageFlags.Ephemeral}).catch(() => {});}
      collector.stop("error");
    }
  });
  collector.on("end", async (_, reason) => {if (reason === "shutdown") {return;} await interaction.editReply({components: []}).catch(() => {});});
}

// Enables or disables a logging category
// interaction = ChatInputCommandInteraction
async function handleLoggingSet(interaction) {
  const category = interaction.options.getString("category", true);
  const enabled  = interaction.options.getBoolean("enabled", true);
  logging.setCategoryEnabled(interaction.guild.id, category, enabled);
  const setting = logging.getLogSettings(interaction.guild.id)[category];
  await logging.logConfigurationChange(interaction.guild, {
    user: interaction.user,
    title: "BargazBot Logging Changed",
    description: `${interaction.user} changed a BargazBot logging category.`,
    fields: [
      {name:"Category", value: setting.name,          inline: true},
      {name:"Enabled",  value: enabled ? "Yes" : "No", inline: true}
    ]
  });
  await interaction.reply({content:`**${setting.name}** logging is now **${enabled ? "enabled" : "disabled"}**.`, flags:discord.MessageFlags.Ephemeral});
}

// Restores a logging category to its default
// interaction = ChatInputCommandInteraction
async function handleLoggingReset(interaction) {
  const category = interaction.options.getString("category", true);
  logging.resetCategory(interaction.guild.id, category);
  const setting = logging.getLogSettings(interaction.guild.id)[category];
  await logging.logConfigurationChange(interaction.guild, {
    user: interaction.user,
    title: "BargazBot Logging Reset",
    description: `${interaction.user} restored a BargazBot logging category to its default.`,
    fields: [
      {name:"Category", value: setting.name,                   inline: true},
      {name:"Enabled",  value: setting.enabled ? "Yes" : "No", inline: true}
    ]
  });
  await interaction.reply({content:`**${setting.name}** logging was restored to its default (**${setting.enabled ? "enabled" : "disabled"}**).`, flags:discord.MessageFlags.Ephemeral});
}

// Formats an id without creating a mention
function formatId(id) {return `\`${id}\``;}

// Formats a SQLite UTC timestamp for display
function formatTimestamp(value) {
  if (!value) {return "None";}
  const date = new Date(String(value).replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime()) ? String(value) : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// Collects everything BargazBot stores under one user id
function getUserDataSnapshot(userId) {
  const db = getDB();
  return {
    user:         db.prepare("SELECT user_id, paid_until, created_at, updated_at FROM users WHERE user_id = ?").get(userId) ?? null,
    entitlements: db.prepare("SELECT youtube_limit, twitch_limit, kick_limit FROM user_entitlements WHERE user_id = ?").get(userId) ?? null,
    allocations:  db.prepare("SELECT guild_id, youtube_limit, twitch_limit, kick_limit FROM entitlement_allocations WHERE user_id = ?").all(userId),
    memberships:  db.prepare("SELECT guild_id, joined_at FROM guild_members WHERE user_id = ?").all(userId),
    profiles:     db.prepare("SELECT guild_id, access_level FROM guild_permission_profiles WHERE permission_type = 'user' AND target_id = ?").all(userId),
    dmSettings:    db.prepare("SELECT * FROM user_dm_settings WHERE user_id = ?").get(userId) ?? null,
    dmSubscriptions: db.prepare("SELECT * FROM user_dm_subscriptions WHERE user_id = ?").all(userId),
    dmConfigs:     db.prepare("SELECT * FROM user_dm_configs WHERE user_id = ?").all(userId),
    suppression:  db.prepare("SELECT expires_at FROM data_deletions WHERE user_id = ?").get(userId) ?? null
  };
}

// Joins a bounded list of rows for an embed field
function formatDataList(rows, formatter, limit = 10) {
  if (rows.length === 0) {return "None";}
  const shown = rows.slice(0, limit).map(formatter);
  if (rows.length > limit) {shown.push(`+${rows.length - limit} more`);}
  return shown.join("\n").slice(0, 1024);
}

function formatGuildName(client, guildId) {
  return client.guilds.cache.get(guildId)?.name ?? `Unknown server (${guildId})`;
}

// Builds the member data summary
function buildUserDataEmbed(snapshot, userId, client) {
  const entitlements = snapshot.entitlements
    ? `YouTube: ${snapshot.entitlements.youtube_limit ?? "Not granted"}\nTwitch: ${snapshot.entitlements.twitch_limit ?? "Not granted"}\nKick: ${snapshot.entitlements.kick_limit ?? "Not granted"}`
    : "No entitlement record";

  const fields = [
    {name:"Account", value: snapshot.user ? `Created ${formatTimestamp(snapshot.user.created_at)}\nUpdated ${formatTimestamp(snapshot.user.updated_at)}\nPaid access: ${formatTimestamp(snapshot.user.paid_until)}` : "No account record", inline:false},
    {name:"Creator entitlements", value: entitlements, inline:true},
    {name:`Allocations (${snapshot.allocations.length}) — Y YouTube, T Twitch, K Kick`, value: formatDataList(snapshot.allocations, row => `${formatGuildName(client, row.guild_id)}: Y ${row.youtube_limit ?? "∞"} / T ${row.twitch_limit ?? "∞"} / K ${row.kick_limit ?? "∞"}`), inline:false},
    {name:`Servers (${snapshot.memberships.length})`, value: formatDataList(snapshot.memberships, row => formatGuildName(client, row.guild_id)), inline:false},
    {name:`Permission profiles (${snapshot.profiles.length})`, value: formatDataList(snapshot.profiles, row => `${formatGuildName(client, row.guild_id)}: ${row.access_level}`), inline:false},
    {name:`DM subscriptions (${snapshot.dmSubscriptions.length})`, value: formatDataList(snapshot.dmSubscriptions, row => `${row.platform}: ${row.nickname ?? row.channelId}`), inline:false},
    {name:"DM settings", value: snapshot.dmSettings ? `Enabled: ${snapshot.dmSettings.dms_enabled ? "yes" : "no"}\nTimezone: ${snapshot.dmSettings.timezone ?? "Not set"}\nFeedback: ${snapshot.dmSettings.feedback_method ?? "dm"}` : "None", inline:false}
  ];

  if (snapshot.suppression) {
    fields.push({name:"Collection paused", value:`Until ${formatTimestamp(new Date(Number(snapshot.suppression.expires_at)).toISOString())}`, inline:false});
  }

  return new discord.EmbedBuilder()
    .setTitle("Your BargazBot Data")
    .setDescription(`Everything BargazBot stores under ${formatId(userId)}.`)
    .addFields(...fields)
    .setFooter({text:"Old copies remain in rotated database backups until those backups expire."})
    .setTimestamp();
}

// Builds the member data deletion preview
function buildUserDeletePreview(snapshot) {
  return new discord.EmbedBuilder()
    .setTitle("Delete Your BargazBot Data")
    .setDescription([
      `Account record: **${snapshot.user ? 1 : 0}**`,
      `Creator entitlements: **${snapshot.entitlements ? 1 : 0}**`,
      `Server allocations: **${snapshot.allocations.length}**`,
      `Server memberships: **${snapshot.memberships.length}**`,
      `Permission profiles: **${snapshot.profiles.length}**`,
      `DM settings: **${snapshot.dmSettings ? 1 : 0}**`,
      `DM subscriptions: **${snapshot.dmSubscriptions.length}**`,
      `DM message configs: **${snapshot.dmConfigs.length}**`
    ].join("\n"))
    .addFields({name:"What happens next", value:"Anything you allocated to a server is withdrawn. Your user id is then kept for **24 hours** so it is not immediately re-collected."})
    .setFooter({text:"This does not delete anything about other people. Backups keep older copies until they rotate."});
}

// Deletes one member's data and starts the 24 hour suppression window
function deleteUserData(userId) {
  const db = getDB();

  db.transaction(() => {
    db.prepare("DELETE FROM guild_permissions WHERE permission_type = 'user' AND target_id = ?").run(userId);
    for (const table of ["user_dm_settings", "user_dm_subscriptions", "user_dm_configs"]) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
    }
    db.prepare("DELETE FROM users WHERE user_id = ?").run(userId);
  })();

  entitlements.suppressUserData(userId);
}

// Routes data commands. Member scope works in direct messages.
// interaction = ChatInputCommandInteraction
async function handleData(interaction) {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "view":   await handleDataView(interaction);   break;
    case "delete": await handleDataDelete(interaction); break;
    case "export":  await handleDataExport(interaction);  break;
    case "restore": await handleDataRestore(interaction); break;
  }
}

// Routes data views. Member scope works in direct messages.
async function handleDataView(interaction) {
  const scope = interaction.options.getString("scope") ?? "user";

  if (scope !== "server") {await handleDataUserView(interaction); return;}

  if (!interaction.guild) {await interaction.reply({content: "Server data can only be viewed inside a server.", flags: discord.MessageFlags.Ephemeral}); return;}
  if (!await requireCommandAccess(interaction, "data", "server")) {return;}

  await handleDataServerView(interaction);
}

// Collects what BargazBot stores for one server
function getServerDataSnapshot(guildId) {
  const db = getDB();
  const count = (table, column = "guild_id") => db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(guildId).count;
  const allocations = db.prepare("SELECT youtube_limit, twitch_limit, kick_limit FROM entitlement_allocations WHERE guild_id = ?").all(guildId);
  const settings = db.prepare("SELECT * FROM guild_settings WHERE guild_id = ?").get(guildId) ?? null;
  const sum = column => allocations.some(row => row[column] === null) ? "Unlimited" : allocations.reduce((total, row) => total + Number(row[column] ?? 0), 0);

  return {
    created: db.prepare("SELECT created_at FROM guilds WHERE guild_id = ?").get(guildId)?.created_at ?? null,
    members: count("guild_members"),
    subscriptions: {
      youtube: count("guild_youtube_subs"),
      twitch:  count("guild_twitch_subs"),
      kick:    count("guild_kick_subs")
    },
    allocations: {
      total:   allocations.length,
      youtube: sum("youtube_limit"),
      twitch:  sum("twitch_limit"),
      kick:    sum("kick_limit")
    },
    profiles:      count("guild_permission_profiles"),
    logOverrides:  count("guild_log_settings"),
    notifications: count("notification_messages"),
    settings
  };
}

// Builds the server data summary
function buildServerDataEmbed(guild, snapshot) {
  const configured = [
    ["Creator notification fallback", snapshot.settings?.announcement_channel_id],
    ["Welcome",                       snapshot.settings?.welcome_channel_id],
    ["Goodbye",                       snapshot.settings?.goodbye_channel_id],
    ["Logs",                          snapshot.settings?.logs_channel_id],
    ["Updates",                       snapshot.settings?.updates_channel_id],
    ["Status",                        snapshot.settings?.status_channel_id]
  ].filter(([, id]) => Boolean(id)).map(([name, id]) => `${name}: <#${id}>`);

  return new discord.EmbedBuilder()
    .setTitle("Server BargazBot Data")
    .setDescription(`${guild.name} — \`${guild.id}\``)
    .addFields(
      {name:"Recorded",             value:`Created ${formatTimestamp(snapshot.created)}`, inline:true},
      {name:"Members tracked",      value:String(snapshot.members),       inline:true},
      {name:"Permission profiles",  value:String(snapshot.profiles),      inline:true},
      {name:"Subscriptions",        value:`YouTube: ${snapshot.subscriptions.youtube}\nTwitch: ${snapshot.subscriptions.twitch}\nKick: ${snapshot.subscriptions.kick}`, inline:true},
      {name:"Allocation slots",     value:`YouTube: ${snapshot.allocations.youtube}\nTwitch: ${snapshot.allocations.twitch}\nKick: ${snapshot.allocations.kick}\nFrom ${snapshot.allocations.total} creator${snapshot.allocations.total === 1 ? "" : "s"}`, inline:true},
      {name:"Log overrides",        value:String(snapshot.logOverrides),  inline:true},
      {name:"Tracked notifications", value:String(snapshot.notifications), inline:true},
      {name:"Configured channels",  value: configured.length ? configured.join("\n").slice(0, 1024) : "None", inline:false}
    )
    .setFooter({text:"Old copies remain in rotated database backups until those backups expire."})
    .setTimestamp();
}

// Shows what BargazBot stores for this server
async function handleDataServerView(interaction) {
  const snapshot = getServerDataSnapshot(interaction.guild.id);
  await interaction.reply({embeds:[buildServerDataEmbed(interaction.guild, snapshot)], flags:discord.MessageFlags.Ephemeral});
}

// Shows the member's own stored data
// interaction = ChatInputCommandInteraction
async function handleDataUserView(interaction) {
  const snapshot = getUserDataSnapshot(interaction.user.id);
  await interaction.reply({embeds:[buildUserDataEmbed(snapshot, interaction.user.id, interaction.client)], flags:discord.MessageFlags.Ephemeral});
}

// Everything a server deletion can target
const SERVER_DATA_CATEGORIES = {
  settings:      {label:"Channel settings",        description:"Configured channel assignments"},
  subscriptions: {label:"Creator subscriptions",   description:"Followed channels on every platform"},
  permissions:   {label:"Permission profiles",     description:"Access levels and command grants"},
  allocations:   {label:"Entitlement allocations", description:"Creator capacity assigned to this server"},
  members:       {label:"Member records",          description:"Members BargazBot recorded"},
  logging:       {label:"Logging overrides",       description:"Per-category logging switches"},
  notifications: {label:"Tracked notifications",   description:"Posted notification message records"}
};

// Counts every deletable row for the server
function getServerDeleteCounts(guildId) {
  const db = getDB();
  const count = sql => db.prepare(sql).get(guildId).count;

  return {
    settings:      count("SELECT COUNT(*) AS count FROM guild_settings WHERE guild_id = ?"),
    subscriptions: count("SELECT COUNT(*) AS count FROM guild_youtube_subs WHERE guild_id = ?")
                 + count("SELECT COUNT(*) AS count FROM guild_twitch_subs WHERE guild_id = ?")
                 + count("SELECT COUNT(*) AS count FROM guild_kick_subs WHERE guild_id = ?"),
    permissions:   count("SELECT COUNT(*) AS count FROM guild_permissions WHERE guild_id = ?"),
    allocations:   count("SELECT COUNT(*) AS count FROM entitlement_allocations WHERE guild_id = ?"),
    members:       count("SELECT COUNT(*) AS count FROM guild_members WHERE guild_id = ?"),
    logging:       count("SELECT COUNT(*) AS count FROM guild_log_settings WHERE guild_id = ?"),
    notifications: count("SELECT COUNT(*) AS count FROM notification_messages WHERE guild_id = ?")
  };
}

// Deletes only the selected categories
function deleteServerData(guildId, categories) {
  const db = getDB();
  const statements = {
    settings:      ["DELETE FROM guild_settings WHERE guild_id = ?"],
    subscriptions: ["DELETE FROM guild_youtube_subs WHERE guild_id = ?", "DELETE FROM guild_twitch_subs WHERE guild_id = ?", "DELETE FROM guild_kick_subs WHERE guild_id = ?"],
    permissions:   ["DELETE FROM guild_permissions WHERE guild_id = ?"],
    allocations:   ["DELETE FROM entitlement_allocations WHERE guild_id = ?"],
    members:       ["DELETE FROM guild_members WHERE guild_id = ?"],
    logging:       ["DELETE FROM guild_log_settings WHERE guild_id = ?"],
    notifications: ["DELETE FROM notification_messages WHERE guild_id = ?", "DELETE FROM notification_refresh_usage WHERE guild_id = ?"]
  };

  const removed = {};

  db.transaction(() => {
    for (const category of categories) {
      if (!statements[category]) {continue;}
      removed[category] = statements[category].reduce((total, statement) => total + db.prepare(statement).run(guildId).changes, 0);
    }
  })();

  return removed;
}

function buildServerDeletePreview(guild, counts, selected) {
  const lines = Object.entries(SERVER_DATA_CATEGORIES)
    .map(([key, category]) => `${selected.has(key) ? "✅" : "⬜"} **${category.label}** — ${counts[key]}`);

  return new discord.EmbedBuilder()
    .setTitle("Delete Server BargazBot Data")
    .setDescription(`${guild.name} — \`${guild.id}\`\n\n${lines.join("\n")}`)
    .addFields({name:"Backup retention", value:"Rotated database backups keep older copies until they expire. This only clears the live database."})
    .setFooter({text:"Pick categories above, then choose whether BargazBot stays."});
}

function buildServerDeleteMenu(selected) {
  return new discord.ActionRowBuilder().addComponents(
    new discord.StringSelectMenuBuilder()
      .setCustomId("data:server-categories")
      .setPlaceholder("Choose what to delete")
      .setMinValues(1)
      .setMaxValues(Object.keys(SERVER_DATA_CATEGORIES).length)
      .addOptions(Object.entries(SERVER_DATA_CATEGORIES).map(([value, category]) => ({
        label: category.label,
        value,
        description: category.description,
        default: selected.has(value)
      })))
  );
}

function buildServerDeleteButtons() {
  return new discord.ActionRowBuilder().addComponents(
    new discord.ButtonBuilder().setCustomId("data:server-delete-stay") .setLabel("Delete and stay")  .setStyle(discord.ButtonStyle.Danger),
    new discord.ButtonBuilder().setCustomId("data:server-delete-leave").setLabel("Delete and leave") .setStyle(discord.ButtonStyle.Danger),
    new discord.ButtonBuilder().setCustomId("data:server-cancel")      .setLabel("Cancel")           .setStyle(discord.ButtonStyle.Secondary)
  );
}

// Sends the deletion record to the channel that was configured before the wipe
async function sendServerDeletionLog(interaction, logsChannelId, removed, leave) {
  if (!logsChannelId) {return;}

  const channel = interaction.client.channels.cache.get(logsChannelId)
    ?? await interaction.client.channels.fetch(logsChannelId).catch(() => null);

  if (!channel?.isTextBased()) {return;}

  const embed = new discord.EmbedBuilder()
    .setTitle("BargazBot Server Data Deleted")
    .setDescription(`${interaction.user} deleted BargazBot data for this server.`)
    .addFields(
      {name:"Deleted",        value:Object.entries(removed).map(([key, total]) => `${SERVER_DATA_CATEGORIES[key].label}: ${total}`).join("\n").slice(0, 1024)},
      {name:"Server action",  value:leave ? "BargazBot left the server" : "BargazBot stayed", inline:true},
      {name:"Deleted by",     value:`${interaction.user} (${formatId(interaction.user.id)})`, inline:true}
    )
    .setTimestamp();

  await channel.send({embeds:[embed], allowedMentions:{parse:[]}}).catch(error => console.error("Unable to log server data deletion:", error));
}

// Routes deletion for member or server scope
// interaction = ChatInputCommandInteraction
async function handleDataDelete(interaction) {
  const scope = interaction.options.getString("scope");
  if (scope === "server") {await handleDataServerDelete(interaction); return;}
  if (scope === "dm") {
    featureSettings.resetUserDmSettings(interaction.user.id, interaction.user.id);
    log.info("BargazBot DM data cleared:", interaction.user.id);
    await interaction.reply({content:"Your BargazBot DM settings, subscriptions, and message configs were deleted.", flags:discord.MessageFlags.Ephemeral});
    return;
  }
  await handleDataUserDelete(interaction);
}

// Deletes selected server data after confirmation
// interaction = ChatInputCommandInteraction
async function handleDataServerDelete(interaction) {
  if (!interaction.guild) {await interaction.reply({content:"Server data can only be deleted inside a server.", flags:discord.MessageFlags.Ephemeral}); return;}
  if (!permissions.canDeleteServerData(interaction.member)) {
    await interaction.reply({content:"Deleting server data requires the server owner, Administrator, or Manage Server, or a permission profile granted server data access.", flags:discord.MessageFlags.Ephemeral});
    return;
  }

  const selected     = new Set(Object.keys(SERVER_DATA_CATEGORIES));
  const counts       = getServerDeleteCounts(interaction.guild.id);
  const logsChannelId = channelManager.getChannelAssignments(interaction.guild.id)?.logs_channel_id ?? null;

  await interaction.reply({embeds:[buildServerDeletePreview(interaction.guild, counts, selected)], components:[buildServerDeleteMenu(selected), buildServerDeleteButtons()], flags:discord.MessageFlags.Ephemeral});
  const message = await interaction.fetchReply();
  const collector = createCommandCollector(message, {time: 300000});
  onCommandComponent(collector, async component => {
    if (component.user.id !== interaction.user.id) {await component.reply({content: "Only the person who opened this prompt can use it.", flags: discord.MessageFlags.Ephemeral}); return;}
    if (!permissions.canDeleteServerData(component.member)) {await component.update({content: "You no longer have permission to delete server data.", embeds: [], components: []}); collector.stop("denied"); return;}
    try {
      if (component.customId === "data:server-categories") {selected.clear(); for (const value of component.values) {selected.add(value);} await component.update({embeds:[buildServerDeletePreview(interaction.guild, counts, selected)], components:[buildServerDeleteMenu(selected), buildServerDeleteButtons()]}); return;}
      if (component.customId === "data:server-cancel") {await component.update({content: "Server data deletion cancelled.", embeds: [], components: []}); collector.stop("cancelled"); return;}
      const leave = component.customId === "data:server-delete-leave";
      await component.deferUpdate();
      const removed = deleteServerData(interaction.guild.id, [...selected]);
      const summary = Object.entries(removed).map(([key, total]) => `${SERVER_DATA_CATEGORIES[key].label}: **${total}**`).join("\n");
      await component.editReply({content:`Deleted BargazBot server data.${leave ? " BargazBot is leaving the server." : ""}\n\n${summary}\n\nBackups keep older copies until they rotate.`, embeds:[], components:[]});
      collector.stop("deleted");
      await sendServerDeletionLog(interaction, logsChannelId, removed, leave);
      if (leave) {await interaction.guild.leave().catch(error => console.error("Unable to leave the server after data deletion:", error));}
    } catch (error) {
      console.error("Server data deletion error:", error);
      if (!component.replied && !component.deferred) {await component.reply({content: "The deletion failed. Nothing was removed.", flags: discord.MessageFlags.Ephemeral}).catch(() => {});}
      collector.stop("error");
    }
  });
  collector.on("end", async (_, reason) => {if (["deleted", "cancelled", "denied", "error", "shutdown"].includes(reason)) {return;} await interaction.editReply({components: []}).catch(() => {});});
}

// Rows exported for one member
const USER_EXPORT_TABLES = {
  users:                     "SELECT * FROM users WHERE user_id = ?",
  user_entitlements:         "SELECT * FROM user_entitlements WHERE user_id = ?",
  entitlement_allocations:   "SELECT * FROM entitlement_allocations WHERE user_id = ?",
  guild_members:             "SELECT * FROM guild_members WHERE user_id = ?",
  guild_permissions:         "SELECT * FROM guild_permissions WHERE permission_type = 'user' AND target_id = ?",
  guild_permission_profiles: "SELECT * FROM guild_permission_profiles WHERE permission_type = 'user' AND target_id = ?",
  guild_command_permissions: "SELECT * FROM guild_command_permissions WHERE permission_type = 'user' AND target_id = ?",
  user_dm_settings:          "SELECT * FROM user_dm_settings WHERE user_id = ?",
  user_dm_subscriptions:     "SELECT * FROM user_dm_subscriptions WHERE user_id = ?",
  user_dm_configs:           "SELECT * FROM user_dm_configs WHERE user_id = ?",
  data_deletions:            "SELECT * FROM data_deletions WHERE user_id = ?"
};

// Rows exported for one server
const SERVER_EXPORT_TABLES = {
  guilds:                     "SELECT * FROM guilds WHERE guild_id = ?",
  guild_members:              "SELECT * FROM guild_members WHERE guild_id = ?",
  guild_settings:             "SELECT * FROM guild_settings WHERE guild_id = ?",
  guild_log_settings:         "SELECT * FROM guild_log_settings WHERE guild_id = ?",
  guild_permissions:          "SELECT * FROM guild_permissions WHERE guild_id = ?",
  guild_permission_profiles:  "SELECT * FROM guild_permission_profiles WHERE guild_id = ?",
  guild_command_permissions:  "SELECT * FROM guild_command_permissions WHERE guild_id = ?",
  entitlement_allocations:    "SELECT * FROM entitlement_allocations WHERE guild_id = ?",
  guild_youtube_subs:         "SELECT * FROM guild_youtube_subs WHERE guild_id = ?",
  guild_twitch_subs:          "SELECT * FROM guild_twitch_subs WHERE guild_id = ?",
  guild_kick_subs:            "SELECT * FROM guild_kick_subs WHERE guild_id = ?",
  notification_messages:      "SELECT * FROM notification_messages WHERE guild_id = ?",
  notification_refresh_usage: "SELECT * FROM notification_refresh_usage WHERE guild_id = ?"
};

// Collects every exported row into one object
function collectExport(scope, id) {
  const db = getDB();
  const tables = scope === "server" ? SERVER_EXPORT_TABLES : USER_EXPORT_TABLES;
  const data = {};

  for (const [table, statement] of Object.entries(tables)) {data[table] = db.prepare(statement).all(id);}
  return {exportedAt: new Date().toISOString(), scope, id, tables: data};
}

// Renders an export as plain text
function formatExportText(payload) {
  const sections = Object.entries(payload.tables).map(([table, rows]) => {
    const body = rows.length === 0
      ? "No rows."
      : rows.map(row => Object.entries(row).map(([key, value]) => `${key}=${value ?? "null"}`).join(", ")).join("\n");
    return `${table} (${rows.length} row${rows.length === 1 ? "" : "s"})\n${body}`;
  });

  return [`BargazBot export`, `Scope: ${payload.scope}`, `Id: ${payload.id}`, `Exported: ${payload.exportedAt}`, "", ...sections].join("\n\n");
}

// Routes an export request
async function handleDataExport(interaction) {
  const scope  = interaction.options.getString("scope", true);
  const format = interaction.options.getString("format", true);
  const target = interaction.options.getChannel("channel");

  if (scope === "server" && !interaction.guild) {await interaction.reply({content: "Server data can only be exported inside a server.", flags: discord.MessageFlags.Ephemeral}); return;}
  if (scope === "server" && !await requireCommandAccess(interaction, "data", "server")) {return;}

  const payload = collectExport(scope, scope === "server" ? interaction.guild.id : interaction.user.id);
  const content = format === "json" ? JSON.stringify(payload, null, 2) : formatExportText(payload);
  const name    = `bargazbot-${scope}-${payload.id}-${payload.exportedAt.slice(0, 19).replace(/[:T]/g, "-")}.${format === "json" ? "json" : "txt"}`;
  const file    = new discord.AttachmentBuilder(Buffer.from(content, "utf8"), {name});

  if (!target) {await interaction.reply({files: [file], flags: discord.MessageFlags.Ephemeral}); return;}

  const channel = await interaction.client.channels.fetch(target.id).catch(() => null);
  if (!channel?.isTextBased()) {await interaction.reply({content: "That channel cannot receive files.", flags: discord.MessageFlags.Ephemeral}); return;}
  await channel.send({files: [file]});
  await interaction.reply({content: `Exported ${scope === "server" ? "this server's" : "your"} data to ${channel}.`, flags: discord.MessageFlags.Ephemeral});
}

// Lists BargazBot database backups, newest first
function listDatabaseBackups() {
  if (!fs.existsSync(DB_BACKUP_DIR)) {return [];}

  const database = path.basename(DB_PATH, ".db");
  return fs.readdirSync(DB_BACKUP_DIR)
    .filter(file => file.endsWith(`_${database}.db`))
    .map(file => {
      const fullPath = path.join(DB_BACKUP_DIR, file);
      const stat     = fs.statSync(fullPath);
      const match    = file.match(/^(hourly|daily|weekly)_(.+)_[0-9a-f-]{36}_/);
      return {file, fullPath, tier: match?.[1] ?? "unknown", stamp: match?.[2] ?? file, size: stat.size, modified: stat.mtimeMs};
    })
    .sort((a, b) => b.modified - a.modified);
}

// Returns an error message when a backup cannot be restored
function validateBackup(fullPath) {
  let db;

  try {
    db = new Database(fullPath, {readonly: true, fileMustExist: true});
    const integrity = db.pragma("integrity_check");
    const foreignKeys = db.pragma("foreign_key_check");
    const hasUsers = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get());

    if (!hasUsers)                                             {return "That file is not a BargazBot database.";}
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {return "That backup failed its SQLite integrity check.";}
    if (foreignKeys.length !== 0)                               {return "That backup failed its foreign-key check.";}
    return null;
  } catch (error) {
    return `That backup could not be opened: ${error.message}`;
  } finally {
    db?.close();
  }
}

// Swaps the live database for a backup and reopens it
function restoreDatabase(fullPath) {
  const stamp        = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const snapshotPath = path.join(DB_DIR, `pre-restore_${stamp}.db`);

  closeDB();
  fs.copyFileSync(DB_PATH, snapshotPath);
  fs.copyFileSync(fullPath, DB_PATH);
  fs.rmSync(`${DB_PATH}-wal`, {force: true});
  fs.rmSync(`${DB_PATH}-shm`, {force: true});
  initDB();
  return snapshotPath;
}

// Copies the live database to a timestamped file
function dbCopy(source, destination) {
  fs.copyFileSync(source, destination);
  return destination;
}

// Column names for one table in either database
function tableColumns(db, schema, table) {
  return db.prepare(`PRAGMA ${schema}.table_info(${table})`).all().map(column => column.name);
}

// Copies parent rows a restored table references, if they are missing locally
function copyMissingParents(db, table) {
  for (const reference of db.prepare(`PRAGMA main.foreign_key_list(${table})`).all()) {
    if (!reference.table || reference.table === table) {continue;}
    const parentColumns = tableColumns(db, "main", reference.table);
    if (parentColumns.join(",") !== tableColumns(db, "backup", reference.table).join(",")) {continue;}

    const columns = parentColumns.join(", ");
    db.prepare(`
      INSERT OR IGNORE INTO main.${reference.table} (${columns})
      SELECT ${columns} FROM backup.${reference.table}
      WHERE ${reference.to} IN (SELECT ${reference.from} FROM main.${table} WHERE ${reference.from} IS NOT NULL)
    `).run();
  }
}

// Restores every stored row for one server from a backup, leaving other servers alone
function restoreGuildDatabase(guildId, fullPath) {
  const db     = getDB();
  const tables = Object.keys(SERVER_EXPORT_TABLES);
  const quoted = fullPath.replace(/'/g, "''");

  db.exec(`ATTACH DATABASE '${quoted}' AS backup`);
  db.pragma("defer_foreign_keys = ON");

  try {
    db.transaction(() => {
      for (const table of tables) {
        const columns = tableColumns(db, "main", table);
        if (columns.join(",") !== tableColumns(db, "backup", table).join(",")) {
          throw new Error(`The backup's ${table} table does not match the current schema.`);
        }
        if (table === "guilds") {continue;}

        const list = columns.join(", ");
        db.prepare(`DELETE FROM main.${table} WHERE guild_id = ?`).run(guildId);
        db.prepare(`INSERT OR REPLACE INTO main.${table} (${list}) SELECT ${list} FROM backup.${table} WHERE guild_id = ?`).run(guildId);
      }

      const guildColumns = tableColumns(db, "main", "guilds").join(", ");
      db.prepare(`INSERT OR REPLACE INTO main.guilds (${guildColumns}) SELECT ${guildColumns} FROM backup.guilds WHERE guild_id = ?`).run(guildId);
      for (let pass = 0; pass < 2; pass += 1) {for (const table of tables) {copyMissingParents(db, table);}}
    })();
  } finally {
    db.pragma("defer_foreign_keys = OFF");
    db.exec("DETACH DATABASE backup");
  }

  const violations = db.pragma("foreign_key_check");
  if (violations.length > 0) {throw new Error(`The restored server failed ${violations.length} foreign-key check${violations.length === 1 ? "" : "s"}.`);}
}

// The whole database can only be restored by the configured bot owner
function canRestoreDatabase(interaction) {
  const ownerId = process.env.OWNER_USER_ID;
  return Boolean(ownerId) && interaction.user.id === ownerId;
}

function buildRestoreMenu(backups) {
  return new discord.ActionRowBuilder().addComponents(
    new discord.StringSelectMenuBuilder()
      .setCustomId("data:restore-backup")
      .setPlaceholder("Choose a backup to restore")
      .addOptions(backups.slice(0, 25).map((backup, index) => ({
        label: `${backup.tier} — ${backup.stamp}`.slice(0, 100),
        value: String(index),
        description: `${Math.max(1, Math.round(backup.size / 1024))} KB — ${new Date(backup.modified).toISOString().slice(0, 16).replace("T", " ")} UTC`
      })))
  );
}

function buildRestoreConfirm(backup, scope) {
  return new discord.ActionRowBuilder().addComponents(
    new discord.ButtonBuilder().setCustomId("data:restore-confirm").setLabel(scope === "all" ? "Restore all servers" : "Restore this server").setStyle(discord.ButtonStyle.Danger),
    new discord.ButtonBuilder().setCustomId("data:restore-cancel") .setLabel("Cancel")              .setStyle(discord.ButtonStyle.Secondary)
  );
}

async function handleRestoreAll(interaction) {
  if (!canRestoreDatabase(interaction)) {await interaction.reply({content:"Restoring every server is limited to the configured bot owner.", flags:discord.MessageFlags.Ephemeral}); 
    return;
  } await handleDataRestore(interaction, "all");
}

// Restores one server, or the whole database, from a rotated backup
async function handleDataRestore(interaction, forcedScope = null) {
  const scope = forcedScope ?? interaction.options.getString("scope", true);

  if (scope === "all") {
    if (!canRestoreDatabase(interaction)) {
      await interaction.reply({content: "Restoring every server is limited to the configured bot owner.", flags: discord.MessageFlags.Ephemeral});
      return;
    }
  } else {
    if (!interaction.guild) {await interaction.reply({content: "Server data can only be restored inside a server.", flags: discord.MessageFlags.Ephemeral}); return;}
    if (!permissions.canDeleteServerData(interaction.member)) {
      await interaction.reply({content: "Restoring server data requires the server owner, Administrator, Manage Server, or a permission profile granted server data access.", flags: discord.MessageFlags.Ephemeral});
      return;
    }
  }

  const backups = listDatabaseBackups();
  if (backups.length === 0) {await interaction.reply({content: "No database backups were found.", flags: discord.MessageFlags.Ephemeral}); return;}

  const warning = scope === "all"
    ? "**Restoring replaces the entire database.** Every server and every user rolls back to the chosen backup. Current data is snapshotted first, then BargazBot restarts."
    : `**Restoring replaces this server's stored data only.** ${interaction.guild.name} rolls back to the chosen backup; other servers are untouched. BargazBot restarts afterward.`;

  let chosen = null;
  await interaction.reply({content: `${warning}\n\n${backups.length} backup${backups.length === 1 ? "" : "s"} available.`, components: [buildRestoreMenu(backups)], flags: discord.MessageFlags.Ephemeral});
  const message = await interaction.fetchReply();
  const collector = createCommandCollector(message, {time: 300000});
  onCommandComponent(collector, async component => {
    if (component.user.id !== interaction.user.id) {await component.reply({content: "Only the person who opened this prompt can use it.", flags: discord.MessageFlags.Ephemeral}); return;}
    if (scope === "all" && !canRestoreDatabase(component)) {await component.update({content: "You no longer have permission to restore the database.", components: []}); collector.stop("denied"); return;}
    if (scope === "guild" && !permissions.canDeleteServerData(component.member)) {await component.update({content: "You no longer have permission to restore server data.", components: []}); collector.stop("denied"); return;}

    try {
      if (component.customId === "data:restore-cancel") {await component.update({content: "Database restore cancelled.", components: []}); collector.stop("cancelled"); return;}

      if (component.customId === "data:restore-backup") {
        chosen = backups[Number(component.values[0])] ?? null;
        if (!chosen) {await component.update({content: "That backup is no longer available.", components: []}); collector.stop("missing"); return;}
        const problem = validateBackup(chosen.fullPath);
        if (problem) {await component.update({content: problem, components: []}); collector.stop("invalid"); return;}
        await component.update({
          content: `Restore **${chosen.tier} — ${chosen.stamp}** ${scope === "all" ? "over every server" : `over ${interaction.guild.name}`}?`,
          components: [buildRestoreConfirm(chosen, scope)]
        });
        return;
      }

      if (component.customId !== "data:restore-confirm" || !chosen) {return;}
      await component.deferUpdate();
      const problem = validateBackup(chosen.fullPath);
      if (problem) {await component.editReply({content: problem, components: []}); collector.stop("invalid"); return;}

      let snapshotPath = null;
      if (scope === "all") {snapshotPath = restoreDatabase(chosen.fullPath);}
      else {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        snapshotPath = path.join(DB_DIR, `pre-restore_${stamp}.db`);
        dbCopy(DB_PATH, snapshotPath);
        restoreGuildDatabase(interaction.guild.id, chosen.fullPath);
      }

      await component.editReply({content: `Restored **${chosen.tier} — ${chosen.stamp}** ${scope === "all" ? "for every server" : `for ${interaction.guild.name}`}. The previous database was saved as \`${path.basename(snapshotPath)}\`. BargazBot is restarting to load it.`, components: []});
      collector.stop("restored");
      setTimeout(() => process.exit(0), 1500);
    } catch (error) {
      console.error("Database restore error:", error);
      await component.editReply({content: `The restore failed: ${error.message}`, components: []}).catch(() => {});
      collector.stop("error");
    }
  });
  collector.on("end", async (_, reason) => {if (["restored", "cancelled", "invalid", "missing", "denied", "error", "shutdown"].includes(reason)) {return;} await interaction.editReply({components: []}).catch(() => {});});
}

// Deletes the member's own stored data after confirmation
// interaction = ChatInputCommandInteraction
async function handleDataUserDelete(interaction) {
  const snapshot = getUserDataSnapshot(interaction.user.id);
  const buttons = new discord.ActionRowBuilder().addComponents(
    new discord.ButtonBuilder().setCustomId("data:delete-confirm").setLabel("Delete my data").setStyle(discord.ButtonStyle.Danger),
    new discord.ButtonBuilder().setCustomId("data:delete-cancel") .setLabel("Cancel")         .setStyle(discord.ButtonStyle.Secondary)
  );
  await interaction.reply({embeds:[buildUserDeletePreview(snapshot)], components:[buttons], flags:discord.MessageFlags.Ephemeral});
  const message = await interaction.fetchReply();
  const collector = createCommandCollector(message, {time: 120000});
  onCommandComponent(collector, async component => {
    if (component.user.id !== interaction.user.id) {await component.reply({content: "Only the person who opened this prompt can use it.", flags: discord.MessageFlags.Ephemeral}); return;}
    try {
      if (component.customId === "data:delete-cancel") {await component.update({content: "Data deletion cancelled.", embeds: [], components: []}); collector.stop("cancelled"); return;}
      deleteUserData(interaction.user.id);
      await component.update({content: "Your BargazBot data was deleted. Your user id is ignored for 24 hours, and backups keep older copies until they rotate.", embeds: [], components: []});
      collector.stop("deleted");
      if (interaction.guild) {
        await logging.logConfigurationChange(interaction.guild, {
          user: interaction.user,
          title: "BargazBot User Data Deleted",
          description: `${interaction.user} deleted their own BargazBot data.`,
          fields: [{name:"User", value: formatId(interaction.user.id), inline: true}]
        }).catch(error => console.error("Failed to log data deletion:", error));
      }
    } catch (error) {
      console.error("Data deletion error:", error);
      if (!component.replied && !component.deferred) {await component.reply({content: "The deletion failed. Nothing was removed.", flags: discord.MessageFlags.Ephemeral}).catch(() => {});}
      collector.stop("error");
    }
  });
  collector.on("end", async (_, reason) => {if (["deleted", "cancelled", "error", "shutdown"].includes(reason)) {return;} await interaction.editReply({components: []}).catch(() => {});});
}

const ENTITLEMENT_PLATFORMS = ["youtube", "twitch", "kick"];

function parseEntitlementLimit(text) {
  const value = String(text ?? "").trim().toLowerCase();
  if (!value) {return null;}
  if (value === "unlimited") {return {amount:null};}
  if (!/^\d+$/.test(value)) {return null;}
  return {amount:Number(value)};
}

function formatEntitlementLimit(value) {
  return value === null ? "Unlimited" : String(value ?? 0);
}

function normalizeEntitlementPlatforms(values) {
  const selected = values ?? [];
  if (selected.includes("all")) {return [...ENTITLEMENT_PLATFORMS];}
  return selected.filter(value => ENTITLEMENT_PLATFORMS.includes(value));
}

function entitlementSummaryEmbed(userId, guildId) {
  const summary = entitlements.getAllocationSummary(userId, guildId);
  if (!summary.entitlements) {
    return new discord.EmbedBuilder()
      .setTitle("Your BargazBot Entitlements")
      .setDescription("You do not currently have a BargazBot entitlement record.")
      .setTimestamp();
  }
  return new discord.EmbedBuilder()
    .setTitle("Your BargazBot Entitlements")
    .setDescription("Entitlements are your total capacity. Allocations are what you have contributed to this server.")
    .addFields(ENTITLEMENT_PLATFORMS.map(platform => {
      const column = `${platform}_limit`;
      return {
        name:notifications.getPlatformName(platform),
        value:
          `Entitlement: **${formatEntitlementLimit(summary.entitlements[column])}**\n` +
          `This server: **${formatEntitlementLimit(summary.allocation?.[column])}**`,
        inline:true
      };
    }))
    .setTimestamp();
}

async function handleEntitlement(interaction) {
  if (!await requireCommandAccess(interaction, "entitlement", "view")) {return;}

  const guildId = interaction.guild.id;
  const userId = interaction.user.id;
  const member = interaction.member?.roles?.cache
    ? interaction.member
    : await interaction.guild.members.fetch(userId);
  const canUse = action => permissions.canUseCommand(member, "entitlement", action);

  const state = {page:"home", mode:"allocate", draft:{limit:null, platforms:[]}, status:null};
  const platformOptions = () => [
    menuOption("All platforms", "all"),
    menuOption("YouTube", "youtube"),
    menuOption("Twitch", "twitch"),
    menuOption("Kick", "kick")
  ];

  const render = () => {
    let embed;
    let rows = [];

    if (state.page === "home") {
      embed = entitlementSummaryEmbed(userId, guildId);
      if (state.status) {embed.setDescription(`${state.status}\n\n${embed.data.description ?? ""}`);}
      rows = [buildSelectRow(menuId("entitlement", "home"), [
        menuOption("Allocate / change", "allocate", "Contribute capacity to this server"),
        menuOption("Remove allocation", "remove", "Remove your capacity from this server")
      ], {placeholder:"Choose an action"})];
    }

    if (state.page === "platforms") {
      const selected = new Set(state.draft.platforms);
      const options = platformOptions().map(option => ({
        ...option,
        default:option.value === "all"
          ? ENTITLEMENT_PLATFORMS.every(platform => selected.has(platform))
          : selected.has(option.value)
      }));
      embed = new discord.EmbedBuilder()
        .setTitle(state.mode === "remove" ? "Remove entitlement allocations" : "Entitlement platforms")
        .setDescription(
          state.mode === "remove"
            ? "Pick the platforms to remove from this server, then review."
            : `Limit: **${formatEntitlementLimit(state.draft.limit)}**\nPick the platforms to allocate to this server, then review.`
        )
        .setColor(0x5865F2)
        .setTimestamp();
      rows = [
        buildSelectRow(menuId("entitlement", "platforms"), options, {placeholder:"Platforms", minValues:0, maxValues:4}),
        buildButtonRow([
          {customId:menuId("entitlement", "continue"), label:"Review", style:"primary"},
          {customId:menuId("entitlement", "cancel"), label:"Cancel", style:"secondary"}
        ])
      ];
    }

    if (state.page === "review") {
      const names = normalizeEntitlementPlatforms(state.draft.platforms).map(platform => notifications.getPlatformName(platform));
      embed = new discord.EmbedBuilder()
        .setTitle(state.mode === "remove" ? "Review removal" : "Review allocation")
        .setDescription(
          `Platforms: **${names.length ? names.join(", ") : "None"}**\n` +
          (state.mode === "remove" ? "Your allocations on this server will be set to 0." : `Limit per platform: **${formatEntitlementLimit(state.draft.limit)}**`)
        )
        .setColor(0x5865F2)
        .setTimestamp();
      const buttons = state.mode === "remove"
        ? [
            {customId:menuId("entitlement", "edit-platforms"), label:"Edit platforms", style:"secondary"},
            {customId:menuId("entitlement", "remove"), label:"Remove", style:"danger"},
            {customId:menuId("entitlement", "cancel"), label:"Cancel", style:"secondary"}
          ]
        : [
            {customId:menuId("entitlement", "modal"), label:"Edit limit", style:"primary"},
            {customId:menuId("entitlement", "platforms"), label:"Edit platforms", style:"secondary"},
            {customId:menuId("entitlement", "allocate"), label:"Apply", style:"success"},
            {customId:menuId("entitlement", "cancel"), label:"Cancel", style:"secondary"}
          ];
      rows = [buildButtonRow(buttons)];
    }

    if (state.page === "view") {
      embed = entitlementSummaryEmbed(userId, guildId);
      rows = [buildButtonRow([
        {customId:menuId("entitlement", "home"), label:"Back", style:"secondary"}
      ])];
    }

    return {embeds:[embed], components:rows, flags:discord.MessageFlags.Ephemeral};
  };

  const openLimitModal = async source => {
    const customId = menuId("entitlement", "modal");
    const currentValue = state.draft.limit === null ? "unlimited" : String(state.draft.limit ?? "");
    const input = new discord.TextInputBuilder()
      .setCustomId("limit")
      .setLabel("Limit, or unlimited")
      .setStyle(discord.TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(20);
    if (currentValue) {input.setValue(currentValue);}
    const submitted = await showConfigModal(source, new discord.ModalBuilder()
      .setCustomId(customId)
      .setTitle("Entitlement allocation")
      .addComponents(new discord.ActionRowBuilder().addComponents(input)), customId);
    if (!submitted) {return false;}

    const parsed = parseEntitlementLimit(submitted.fields.getTextInputValue("limit").trim());
    if (!parsed) {
      await submitted.reply({content:"Enter a whole number of 0 or greater, or **unlimited**.", flags:discord.MessageFlags.Ephemeral});
      return false;
    }
    state.draft.limit = parsed.amount;
    return submitted;
  };

  await interaction.deferReply({flags:discord.MessageFlags.Ephemeral});
  const msg = await interaction.editReply(render());
  const collector = createCommandCollector(msg, {time:300000});

  onCommandComponent(collector, async component => {
    if (component.user.id !== interaction.user.id) {
      await component.reply({content:"Only the person who opened this menu can use it.", flags:discord.MessageFlags.Ephemeral});
      return;
    }
    const action = parseMenuId(component.customId)[1];
    try {
      if (action === "cancel") {
        collector.stop("cancel");
        await component.update({content:"Cancelled.", embeds:[], components:[]});
        return;
      }
      if (action === "home") {
        const choice = component.values?.[0];
        state.status = null;
        if (choice === "allocate") {
          if (!canUse("allocate")) {
            await component.reply({content:"You do not have permission to change allocations.", flags:discord.MessageFlags.Ephemeral});
            return;
          }
          const current = entitlements.getUserAllocation(userId, guildId) ?? {};
          const preferred = current.youtube_limit ?? current.twitch_limit ?? current.kick_limit;
          state.mode = "allocate";
          state.draft = {
            limit:preferred ?? null,
            platforms:ENTITLEMENT_PLATFORMS.filter(platform => current[`${platform}_limit`] === null || Number(current[`${platform}_limit`]) > 0)
          };
          state.page = "modal";
          const submitted = await openLimitModal(component);
          if (!submitted) {return;}
          state.page = "platforms";
          await submitted.update(render());
          return;
        }
        if (choice === "remove") {
          if (!canUse("remove")) {
            await component.reply({content:"You do not have permission to remove allocations.", flags:discord.MessageFlags.Ephemeral});
            return;
          }
          const current = entitlements.getUserAllocation(userId, guildId) ?? {};
          state.mode = "remove";
          state.draft = {
            limit:null,
            platforms:ENTITLEMENT_PLATFORMS.filter(platform => current[`${platform}_limit`] === null || Number(current[`${platform}_limit`]) > 0)
          };
          state.page = "platforms";
          await component.update(render());
          return;
        }
        state.page = "home";
        await component.update(render());
        return;
      }
      if (action === "view") {
        state.page = "view";
        await component.update(render());
        return;
      }
      if (action === "platforms") {
        state.draft.platforms = normalizeEntitlementPlatforms(component.values ?? []);
        await component.update(render());
        return;
      }
      if (action === "edit-platforms") {
        state.page = "platforms";
        await component.update(render());
        return;
      }
      if (action === "modal") {
        if (!canUse("allocate")) {
          await component.reply({content:"You do not have permission to change allocations.", flags:discord.MessageFlags.Ephemeral});
          return;
        }
        const submitted = await openLimitModal(component);
        if (!submitted) {return;}
        await submitted.update(render());
        return;
      }
      if (action === "continue") {
        state.page = "review";
        await component.update(render());
        return;
      }
      if (action === "allocate") {
        if (!canUse("allocate")) {
          await component.reply({content:"You do not have permission to change allocations.", flags:discord.MessageFlags.Ephemeral});
          return;
        }
        await component.deferUpdate();
        const platforms = normalizeEntitlementPlatforms(state.draft.platforms);
        if (!platforms.length) {
          await interaction.editReply({content:"Pick at least one platform.", embeds:[], components:[]});
          collector.stop("error");
          return;
        }
        const lines = [];
        for (const platform of platforms) {
          const result = entitlements.setAllocation(userId, guildId, platform, state.draft.limit);
          if (!result.success) {
            let reason = "BargazBot could not update that allocation.";
            if (result.reason === "no-entitlement") {reason = "you do not have an entitlement for this platform.";}
            if (result.reason === "not-unlimited") {reason = "your entitlement is not unlimited.";}
            if (result.reason === "exceeds-entitlement") {reason = `you can allocate up to **${result.available}** more elsewhere.`;}
            if (result.reason === "allocation-conflict") {reason = "your existing allocations conflict with this entitlement.";}
            lines.push(`**${notifications.getPlatformName(platform)}**: ${reason}`);
            continue;
          }
          lines.push(result.unlimited
            ? `Allocated **unlimited ${notifications.getPlatformName(platform)}** capacity to this server.`
            : `Allocated **${result.amount} ${notifications.getPlatformName(platform)}** slot${result.amount === 1 ? "" : "s"} to this server.`);
        }
        await interaction.editReply({content:lines.join("\n"), embeds:[], components:[]});
        collector.stop("saved");
        return;
      }
      if (action === "remove") {
        if (!canUse("remove")) {
          await component.reply({content:"You do not have permission to remove allocations.", flags:discord.MessageFlags.Ephemeral});
          return;
        }
        await component.deferUpdate();
        const platforms = normalizeEntitlementPlatforms(state.draft.platforms);
        if (!platforms.length) {
          await interaction.editReply({content:"Pick at least one platform.", embeds:[], components:[]});
          collector.stop("error");
          return;
        }
        const lines = platforms.map(platform => {
          const removed = entitlements.removeAllocation(userId, guildId, platform);
          return removed
            ? `Your ${notifications.getPlatformName(platform)} allocation to this server has been set to **0**.`
            : `You did not have a ${notifications.getPlatformName(platform)} allocation in this server.`;
        });
        await interaction.editReply({content:lines.join("\n"), embeds:[], components:[]});
        collector.stop("removed");
      }
    } catch (error) {
      log.error("Entitlement menu error:", error);
      await interaction.editReply({content:"The entitlement menu encountered an error. Nothing was changed.", embeds:[], components:[]}).catch(() => {});
      collector.stop("error");
    }
  });
  collector.on("end", async () => {await interaction.editReply({components:[]}).catch(() => {});});
}

// Formats a permission target for Discord
// type = String, "user" or "role"
// id = String, Discord ID
function permissionTargetMention(type, id) {return type === permissions.PERMISSION_TYPES.ROLE ? `<@&${id}>` : `<@${id}>`;}

// Retrieves a user or role selected for permission management
// interaction = ChatInputCommandInteraction
function getPermissionTarget(interaction) {
  if (interaction.__permissionTarget) {return interaction.__permissionTarget;}
  const everyone = interaction.options.getBoolean("everyone") ?? false;
  const target   = interaction.options.getMentionable("target");
  if (everyone && target) {return {error: "Select either a user/role or @everyone, not both."};}
  if (everyone)           {return {type: permissions.PERMISSION_TYPES.ROLE, id: interaction.guild.id, mention: "@everyone"};}
  if (!target)            {return {error: "You must select a user or role."};}
  const isRole = target instanceof discord.Role;
  const type   = isRole ? permissions.PERMISSION_TYPES.ROLE : permissions.PERMISSION_TYPES.USER;
  return {type, id: target.id, mention: isRole && target.id === interaction.guild.id ? "@everyone" : permissionTargetMention(type, target.id)};
}

// Creates a reusable access-level selection menu
// selected = String, current access level
function buildAccessLevelMenu(selected) {
  return new discord.ActionRowBuilder().addComponents(
    new discord.StringSelectMenuBuilder()
      .setCustomId("permission:level")
      .setPlaceholder("Choose an access level")
      .addOptions([
        {label: "Full Access", value: permissions.ACCESS_LEVELS.FULL, description: "All commands, including permission management", default: selected === permissions.ACCESS_LEVELS.FULL},
        {label: "Configuration Access", value: permissions.ACCESS_LEVELS.CONFIGURATION, description: "All configuration commands except /permissions", default: selected === permissions.ACCESS_LEVELS.CONFIGURATION},
        {label: "Custom Access", value: permissions.ACCESS_LEVELS.CUSTOM, description: "Select individual commands and subcommands", default: selected === permissions.ACCESS_LEVELS.CUSTOM}
      ])
  );
}

// Creates a command-category selection menu
// selected = String, selected command category
function buildCommandCategoryMenu(selected) {
  return new discord.ActionRowBuilder().addComponents(
    new discord.StringSelectMenuBuilder()
      .setCustomId("permission:category")
      .setPlaceholder("Choose a command category")
      .addOptions(Object.keys(permissions.COMMAND_PERMISSIONS).map(command => ({label: `/${command}`, value: command, default: selected === command})))
  );
}

// Creates the subcommand selection menu for one category
// category = String, command category
// selected = Set of Strings, selected command identifiers
function buildCustomCommandMenu(category, selected) {
  return new discord.ActionRowBuilder().addComponents(
    new discord.StringSelectMenuBuilder()
      .setCustomId("permission:commands")
      .setPlaceholder(`Select /${category} subcommands`)
      .setMinValues(0)
      .setMaxValues(permissions.COMMAND_PERMISSIONS[category].length)
      .addOptions(permissions.COMMAND_PERMISSIONS[category].map(subcommand => ({label: `/${category} ${subcommand}`, value: `${category}.${subcommand}`, default: selected.has(`${category}.${subcommand}`)})))
  );
}

// Creates navigation and confirmation buttons
// custom = Boolean, whether Custom Access is selected
function buildPermissionEditorButtons(canDeleteData) {
  return new discord.ActionRowBuilder().addComponents(
    new discord.ButtonBuilder().setCustomId("permission:review")     .setLabel("Review Changes").setStyle(discord.ButtonStyle.Primary),
    new discord.ButtonBuilder().setCustomId("permission:data-delete").setLabel(`Server data: ${canDeleteData ? "Allowed" : "Denied"}`).setStyle(canDeleteData ? discord.ButtonStyle.Success : discord.ButtonStyle.Secondary),
    new discord.ButtonBuilder().setCustomId("permission:cancel")     .setLabel("Cancel").setStyle(discord.ButtonStyle.Secondary)
  );
}

// Formats a saved or proposed permission profile
// profile = Object or null
function formatPermissionProfile(profile) {
  if (!profile) {return "No explicit access";}
  if (profile.accessLevel === permissions.ACCESS_LEVELS.FULL) {return "Full Access";}
  if (profile.accessLevel === permissions.ACCESS_LEVELS.CONFIGURATION) {return "Configuration Access";}
  const selected    = permissions.getProfileCommands(profile);
  const all         = Object.entries(permissions.COMMAND_PERMISSIONS).flatMap(([command, names]) => names.map(name => `${command}.${name}`));
  const missing     = all.filter(command => !selected.includes(command));
  const useMissing  = missing.length > 0 && missing.length < selected.length;
  const shown       = useMissing ? missing : selected;
  const prefix      = useMissing ? "Custom Access — all except " : "Custom Access — only ";
  const description = shown.map(name => `\`/${name.replace(".", " ")}\``).join(", ");
  if (!shown.length)                             {return "Custom Access — none";}
  if (prefix.length + description.length <= 600) {return prefix + description;}
  return `${prefix}${shown.length} commands (${shown.slice(0, 5).map(name => `\`/${name.replace(".", " ")}\``).join(", ")}, and more)`;
}

// Creates the permission editor message
// target = Object, selected user or role
// level = String, access level
// category = String, selected command category
// selected = Set of Strings, selected commands
function buildPermissionEditor(target, level, category, selected, canDeleteData) {
  const profile = {accessLevel: level, commands: [...selected]};
  const embed   = new discord.EmbedBuilder()
    .setTitle(`Edit BargazBot Permissions`)
    .setDescription(`Target: ${target.mention}\n\n**Selected Access:** ${formatPermissionProfile(profile)}\n**Server data deletion:** ${canDeleteData ? "Allowed" : "Denied"}\n\nChoose an access level. For Custom Access, select a category and its allowed subcommands.`);
  const components = [buildAccessLevelMenu(level)];
  if (level === permissions.ACCESS_LEVELS.CUSTOM) {components.push(buildCommandCategoryMenu(category)); components.push(buildCustomCommandMenu(category, selected));}
  components.push(buildPermissionEditorButtons(canDeleteData));
  return {embeds: [embed], components};
}

// Creates a confirmation screen with the permission differences
// target = Object
// oldProfile = Object or null
// newProfile = Object
function buildPermissionReview(target, oldProfile, newProfile) {
  const changes = permissions.comparePermissionProfiles(oldProfile, newProfile);
  const format  = values => values.length ? values.map(value => `\`/${value.replace(".", " ")}\``).join(", ").slice(0, 950) : "None";
  const embed   = new discord.EmbedBuilder()
    .setTitle("Confirm Permission Changes")
    .setDescription(`Target: ${target.mention}\n\n**Before:** ${formatPermissionProfile(oldProfile)}\n**After:** ${formatPermissionProfile(newProfile)}`)
    .addFields(
      {name: "Commands Added", value: format(changes.added)}, {name: "Commands Removed", value: format(changes.removed)},
      {name: "Server Data Deletion", value: `${oldProfile?.canDeleteData ? "Allowed" : "Denied"} → ${newProfile.canDeleteData ? "Allowed" : "Denied"}`}
    );
  const buttons = new discord.ActionRowBuilder().addComponents(
    new discord.ButtonBuilder().setCustomId("permission:save")  .setLabel("Confirm Changes").setStyle(discord.ButtonStyle.Success),
    new discord.ButtonBuilder().setCustomId("permission:back")  .setLabel("Back").setStyle(discord.ButtonStyle.Secondary),
    new discord.ButtonBuilder().setCustomId("permission:cancel").setLabel("Cancel").setStyle(discord.ButtonStyle.Danger)
  );
  return {embeds: [embed], components: [buttons]};
}

// Records which members currently have entitlement allocation access
// guild = Guild
// target = Object, permission target
async function getAllocationAccessSnapshot(guild, target) {
  const members = await guild.members.fetch();
  const affected = [...members.values()].filter(member =>
    !member.user.bot && (target.type === permissions.PERMISSION_TYPES.ROLE ? target.id === guild.id || member.roles.cache.has(target.id) : member.id === target.id)
  ); return affected.map(member => ({member, allowed: permissions.canUseCommand(member, "entitlement", "allocate")}));
}

// Removes allocations only from members who lost effective allocation access
// snapshot = Array, previous permission states
function cleanupRevokedAllocations(snapshot) {
  for (const {member, allowed} of snapshot) {
    if (allowed && !permissions.canUseCommand(member, "entitlement", "allocate")) {entitlements.removeGuildAllocations(member.id, member.guild.id);}
  }
}

// Routes the four permission commands
// interaction = ChatInputCommandInteraction
async function sendPermissionResponse(interaction, payload) {
  if (interaction.replied || interaction.deferred) {return interaction.editReply(payload);}
  return interaction.reply(payload);
}

async function handlePermissions(interaction) {
  if (!await requireCommandAccess(interaction, "permissions", "list")) {return;}
  const state = {page:"home", action:null};
  const render = () => {
    if (state.page === "home") {
      const embed = new discord.EmbedBuilder()
        .setTitle("BargazBot Permissions")
        .setDescription("Choose an action. Target editing keeps the existing review and paginated list.")
        .setTimestamp();
      return {embeds:[embed], components:[buildSelectRow(menuId("permissions","home"), [
        menuOption("Add access", "add", "Grant a user or role access"),
        menuOption("Edit access", "edit", "Change an existing profile"),
        menuOption("Remove access", "remove", "Remove an explicit profile"),
        menuOption("View permissions", "list", "Read-only permission list")
      ], {placeholder:"Choose an action"})]};
    }
    return {content:`Choose a target for **${state.action}**.`, embeds:[], components:[
      buildMentionableRow(menuId("permissions","target"), {placeholder:"Choose a user or role"}),
      buildButtonRow([
        {customId:menuId("permissions","everyone"), label:"@everyone", style:"secondary"},
        {customId:menuId("permissions","back"), label:"Back", style:"secondary"}
      ])
    ]};
  };

  await sendPermissionResponse(interaction, {...render(), flags:discord.MessageFlags.Ephemeral});
  const message = interaction.replied ? await interaction.fetchReply() : null;
  if (!message) {return;}
  const collector = interaction.channel.createMessageComponentCollector({
    filter:item => item.user.id === userId && item.message?.id === message.id,
    time:300000
  });
  onCommandComponent(collector, async component => {
    if (component.user.id !== interaction.user.id) {await component.reply({content:"Only the person who opened this menu can use it.", flags:discord.MessageFlags.Ephemeral}); return;}
    if (state.page === "home") {
      const action = component.values?.[0];
      if (!action) {return;}
      if (action === "list") {collector.stop("list"); await component.update({content:"Opening the permission list…", embeds:[], components:[]}).catch(() => {}); await handlePermissionList(interaction); return;}
      if (!await permissions.canUseCommand(component.member, "permissions", action)) {await component.reply({content:"You do not have permission for that action.", flags:discord.MessageFlags.Ephemeral}); return;}
      state.action = action;
      state.page = "target";
      await component.update(render());
      return;
    }
    if (component.customId.includes("back")) {state.page = "home"; await component.update(render()); return;}
    let target = null;
    if (component.customId.includes("everyone")) {
      target = {type:permissions.PERMISSION_TYPES.ROLE, id:interaction.guild.id, mention:"@everyone"};
    } else {
      const id = component.values?.[0];
      const role = interaction.guild.roles.cache.get(id);
      const member = role ? null : (interaction.guild.members.cache.get(id) ?? await interaction.guild.members.fetch(id).catch(() => null));
      if (role) {target = {type:permissions.PERMISSION_TYPES.ROLE, id, mention:`<@&${id}>`};}
      if (member) {target = {type:permissions.PERMISSION_TYPES.USER, id, mention:`<@${id}>`};}
    }
    if (!target) {await component.reply({content:"Choose a user or role.", flags:discord.MessageFlags.Ephemeral}); return;}
    interaction.__permissionTarget = target;
    collector.stop("editor");
    await component.update({content:"Opening the editor…", embeds:[], components:[]}).catch(() => {});
    if (state.action === "add") {await handlePermissionEditor(interaction, false);}
    if (state.action === "edit") {await handlePermissionEditor(interaction, true);}
    if (state.action === "remove") {await handlePermissionRemove(interaction);}
  });
  collector.on("end", async (_, reason) => {if (reason === "time") {await interaction.editReply({content:"Permission menu expired.", embeds:[], components:[]}).catch(() => {});}});
}

// Opens an interactive editor for a user or role
// interaction = ChatInputCommandInteraction
// editing = Boolean, true for edit and false for add
async function handlePermissionEditor(interaction, editing) {
  const target = getPermissionTarget(interaction);
  if (target.error) {await sendPermissionResponse(interaction, {content: target.error, flags: discord.MessageFlags.Ephemeral}); return;}
  const original = permissions.getPermissionProfile(interaction.guild.id, target.type, target.id);
  if (editing && !original) {await sendPermissionResponse(interaction, {content: `${target.mention} does not have an explicit permission profile. Use \`/permissions add\` first.`, flags: discord.MessageFlags.Ephemeral}); return;}
  if (!editing && original) {await sendPermissionResponse(interaction, {content: `${target.mention} already has a permission profile. Use \`/permissions edit\` instead.`, flags: discord.MessageFlags.Ephemeral}); return;}
  let level          = original?.accessLevel ?? permissions.ACCESS_LEVELS.CONFIGURATION;
  let category       = "notification";
  let selected       = new Set(original?.commands ?? []);
  let canDeleteData  = Boolean(original?.canDeleteData);
  let reviewing      = false;
  await sendPermissionResponse(interaction, {...buildPermissionEditor(target, level, category, selected, canDeleteData), flags: discord.MessageFlags.Ephemeral});
  const message = await interaction.fetchReply();
  const collector = createCommandCollector(message, {time: 300000});
  onCommandComponent(collector, async component => {
    if (component.user.id !== interaction.user.id) {await component.reply({content: "Only the person who opened this editor can use it.", flags: discord.MessageFlags.Ephemeral});return;}
    if (!permissions.canUseCommand(component.member, "permissions", editing ? "edit" : "add")) {await component.update({content: "You no longer have permission to perform this action.", embeds: [], components: []}); collector.stop("denied"); return;}
    try {
      if (component.customId === "permission:cancel")   {await component.update({content: "Permission changes cancelled.", embeds: [], components: []}); collector.stop("cancelled"); return;}
      if (component.customId === "permission:level")    {level = component.values[0]; reviewing = false;}
      if (component.customId === "permission:category") {category = component.values[0]; reviewing = false;}
      if (component.customId === "permission:commands") {
        const prefix                = `${category}.`;
        const previouslyHadAllocate = selected.has("entitlement.allocate");
        const previouslyHadRemove   = selected.has("entitlement.remove");
        selected = new Set([...selected].filter(value => !value.startsWith(prefix)));
        for (const value of component.values) {selected.add(value);}
        if (category === "entitlement") {
          const hasAllocate = selected.has("entitlement.allocate");
          const hasRemove   = selected.has("entitlement.remove");
          if (previouslyHadRemove && !hasRemove) {selected.delete("entitlement.allocate");} else if (hasAllocate && !hasRemove) {selected.add("entitlement.remove");}
        } reviewing = false;
      }
      if (component.customId === "permission:review") {
        if (level === permissions.ACCESS_LEVELS.CUSTOM && selected.size === 0) {await component.reply({content: "Custom Access requires at least one selected command.", flags: discord.MessageFlags.Ephemeral}); return;}
        reviewing = true;
      }
      if (component.customId === "permission:data-delete") {canDeleteData = !canDeleteData; reviewing = false;}
      const proposed = {accessLevel: level, canDeleteData, commands: level === permissions.ACCESS_LEVELS.CUSTOM ? permissions.normalizeCustomCommands([...selected]) : []};
      if (component.customId === "permission:save") {
        if (!reviewing) {await component.reply({content: "Review the changes before confirming.", flags: discord.MessageFlags.Ephemeral}); return;}
        await component.deferUpdate();
        const allocationSnapshot = await getAllocationAccessSnapshot(interaction.guild, target);
        const current = permissions.getPermissionProfile(interaction.guild.id, target.type, target.id);
        if (JSON.stringify(current?.accessLevel) !== JSON.stringify(original?.accessLevel) || Boolean(current?.canDeleteData) !== Boolean(original?.canDeleteData) || JSON.stringify([...(current?.commands ?? [])].sort()) !== JSON.stringify([...(original?.commands ?? [])].sort())) {
          await interaction.editReply({content: "This permission profile changed while you were editing it. Please run the command again.", embeds: [], components: []}); collector.stop("changed"); return;
        }
        permissions.savePermissionProfile(interaction.guild.id, target.type, target.id, proposed.accessLevel, proposed.commands, proposed.canDeleteData); cleanupRevokedAllocations(allocationSnapshot);
        await interaction.editReply({content: `Saved ${formatPermissionProfile(proposed)} for ${target.mention}.`, embeds: [], components: []}); collector.stop("saved");
        await logging.logPermissionChange(interaction.guild, {
          user: interaction.user,
          description: `${interaction.user} ${editing ? "edited" : "added"} BargazBot permissions for ${target.mention}.`,
          fields: [{name: "Previous Access", value: formatPermissionProfile(original).slice(0, 1024)}, {name: "New Access", value: formatPermissionProfile(proposed).slice(0, 1024)}]
        }).catch(error => console.error("Failed to log permission change:", error)); return;
      }
      await component.update(reviewing ? buildPermissionReview(target, original, proposed) : buildPermissionEditor(target, level, category, selected, canDeleteData));
    } catch (error) {console.error("Permission editor error:", error);
      if (!component.replied && !component.deferred) {await component.reply({content: "The permission editor encountered an error.", flags: discord.MessageFlags.Ephemeral}).catch(() => {});}
      collector.stop("error");
      await interaction.editReply({content: "The permission editor encountered an error. No further changes can be made in this session.", embeds: [], components: []}).catch(() => {});
    }
  });
  collector.on("end", async (_, reason) => {if (["saved", "cancelled", "denied", "changed", "error", "shutdown"].includes(reason)) {return;} await interaction.editReply({content: "Permission editor expired. No changes were saved.", embeds: [], components: []}).catch(() => {});});
}

// Removes a permission grant after confirmation
// interaction = ChatInputCommandInteraction
async function handlePermissionRemove(interaction) {
  const target = getPermissionTarget(interaction);
  if (target.error)                                                                            {await sendPermissionResponse(interaction, {content: target.error, flags: discord.MessageFlags.Ephemeral}); return;}
  if (target.type === permissions.PERMISSION_TYPES.ROLE && target.id === interaction.guild.id) {await sendPermissionResponse(interaction, {content: "The @everyone permission profile cannot be removed. Use `/permissions edit` instead.", flags: discord.MessageFlags.Ephemeral}); return;}
  const original = permissions.getPermissionProfile(interaction.guild.id, target.type, target.id);
  if (!original) {await sendPermissionResponse(interaction, {content: `${target.mention} has no explicit permission profile to remove.`, flags: discord.MessageFlags.Ephemeral}); return;}
  const buttons = new discord.ActionRowBuilder().addComponents(
    new discord.ButtonBuilder().setCustomId("permission:remove-confirm").setLabel("Remove Permission").setStyle(discord.ButtonStyle.Danger),
    new discord.ButtonBuilder().setCustomId("permission:remove-cancel") .setLabel("Cancel").setStyle(discord.ButtonStyle.Secondary)
  );
  await sendPermissionResponse(interaction, {
    content: `Remove the explicit **${formatPermissionProfile(original)}** profile from ${target.mention}?\n\nOther applicable role permissions and inherited administrator access will remain.`,
    components: [buttons], flags: discord.MessageFlags.Ephemeral
  });
  const message   = await interaction.fetchReply();
  const collector = createCommandCollector(message, {time: 120000});
  onCommandComponent(collector, async component => {
    if (component.user.id  !== interaction.user.id)                            {await component.reply({content:  "This confirmation belongs to another user.",        flags: discord.MessageFlags.Ephemeral}); return;}
    if (component.customId === "permission:remove-cancel")                     {await component.update({content: "Permission removal cancelled.",                     components: []}); collector.stop("cancelled"); return;}
    if (component.customId !== "permission:remove-confirm")                    {return;}
    if (!permissions.canUseCommand(component.member,"permissions","remove"))   {await component.update({content: "You no longer have permission to remove profiles.", components: []}); collector.stop("denied"); return;}
    try {
      await component.deferUpdate();
      const allocationSnapshot = await getAllocationAccessSnapshot(interaction.guild, target);
      const current = permissions.getPermissionProfile(interaction.guild.id, target.type, target.id);
      if (!current || current.accessLevel !== original.accessLevel || Boolean(current.canDeleteData) !== Boolean(original.canDeleteData) || JSON.stringify([...current.commands].sort()) !== JSON.stringify([...original.commands].sort())) {
        await interaction.editReply({content: "This profile changed while awaiting confirmation. Please run the command again.", components: []}); collector.stop("changed"); return;
      }
      const removed = permissions.removePermission(interaction.guild.id, target.type, target.id);
      if (removed) {cleanupRevokedAllocations(allocationSnapshot);}
      await interaction.editReply({content: removed ? `Removed the explicit permission profile for ${target.mention}.` : "The permission profile could not be removed.", components: []}); collector.stop("completed");
      if (removed) {
        await logging.logPermissionChange(interaction.guild, {user: interaction.user, description: `${interaction.user} removed BargazBot permissions from ${target.mention}.`, fields: [{name: "Previous Access", value: formatPermissionProfile(original).slice(0, 1024)}]
        }).catch(error => console.error("Failed to log permission removal:", error));
      }
    } catch (error) {
      console.error("Permission removal error:", error);
      if (!component.replied && !component.deferred) {await component.reply({content: "Permission removal encountered an error.", flags: discord.MessageFlags.Ephemeral}).catch(() => {});}
      collector.stop("error");
      await interaction.editReply({content: "Permission removal encountered an error. Please check the current permissions before trying again.", components: []}).catch(() => {});
    }
  });
  collector.on("end", async (_, reason) => {if (reason !== "time") {return;} await interaction.editReply({content: "Permission removal confirmation expired.", components: []}).catch(() => {});});
}

// Creates a paginated read-only permission listing
// interaction = ChatInputCommandInteraction
async function handlePermissionList(interaction) {
  if (!interaction.deferred && !interaction.replied) {await interaction.deferReply({flags: discord.MessageFlags.Ephemeral});}
  const entries   = permissions.getPermissions(interaction.guild.id);
  const owner     = await interaction.guild.fetchOwner();
  const inherited = new Map([[owner.id, owner]]);
  try {
    const members = await interaction.guild.members.fetch();
    for (const member of members.values()) {if (permissions.isGuildAdministrator(member)) {inherited.set(member.id, member);}}
  } catch (error) {console.warn("Could not retrieve all server administrators for the permission list:", error);}
  const sorted      = values => values.sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: "base"}));
  const roleEntries = sorted(entries.filter(entry => entry.permission_type === permissions.PERMISSION_TYPES.ROLE).map(entry => ({
    name: interaction.guild.roles.cache.get(entry.target_id)?.name ?? entry.target_id,
    line: `${entry.target_id === interaction.guild.id ? "@everyone" : permissionTargetMention(entry.permission_type, entry.target_id)} — ${formatPermissionProfile(entry)}`
  })));
  const userEntries = sorted(entries.filter(entry => entry.permission_type === permissions.PERMISSION_TYPES.USER).map(entry => ({
    name: interaction.guild.members.cache.get(entry.target_id)?.displayName ?? interaction.client.users.cache.get(entry.target_id)?.username ?? entry.target_id,
    line: `${permissionTargetMention(entry.permission_type, entry.target_id)} — ${formatPermissionProfile(entry)}`
  })));
  const inheritedEntries = sorted([...inherited.values()].map(member => ({
    name: member.displayName,
    line: `${member} — Full Access (${member.id === owner.id ? "Server Owner" : "Administrator"})`
  })));
    const publicCommands = [...permissions.PUBLIC_COMMANDS.map(command => `\`/${command}\``), "`/permissions list`"];
  const pages = {
    all: [
      ...inheritedEntries.map(entry => `**Inherited:** ${entry.line}`),
      ...roleEntries.map(entry      => `**Role:** ${entry.line}`),
      ...userEntries.map(entry      => `**User:** ${entry.line}`),
      `**Public Commands:** ${publicCommands.join(", ")}`
    ],
    inherited: inheritedEntries.map(entry => entry.line),
    roles:     roleEntries.map(entry => entry.line),
    users:     userEntries.map(entry => entry.line),
    public:    publicCommands
  };
  let section    = "all";
  let page       = 0;
  const pageSize = 8;
  const render   = () => {
    const lines      = pages[section];
    const totalPages = Math.max(1, Math.ceil(lines.length / pageSize));
    page = Math.min(page, totalPages - 1);
    const shown = lines.slice(page * pageSize, (page + 1) * pageSize);
    const embed = new discord.EmbedBuilder()
      .setTitle("BargazBot Permissions")
      .setDescription((shown.join("\n\n") || "No entries in this category.").slice(0, 4000))
      .setFooter({text: `Page ${page + 1} of ${totalPages} • Read-only`});
    const menu = new discord.ActionRowBuilder().addComponents(
      new discord.StringSelectMenuBuilder()
        .setCustomId("permission:list-section")
        .setPlaceholder("Choose a category")
        .addOptions([
          {label: "All Permissions",  value: "all",       default: section === "all"},
          {label: "Inherited Access", value: "inherited", default: section === "inherited"},
          {label: "Authorized Roles", value: "roles",     default: section === "roles"},
          {label: "Authorized Users", value: "users",     default: section === "users"},
          {label: "Public Commands",  value: "public",    default: section === "public"}
        ])
    );

    const navigation = new discord.ActionRowBuilder().addComponents(
      new discord.ButtonBuilder().setCustomId("permission:list-prev").setLabel("Previous").setStyle(discord.ButtonStyle.Secondary).setDisabled(page === 0),
      new discord.ButtonBuilder().setCustomId("permission:list-next").setLabel("Next")    .setStyle(discord.ButtonStyle.Secondary).setDisabled(page >= totalPages - 1)
    );
    return {embeds: [embed], components: [menu, navigation]};
  };

  await interaction.editReply(render());
  const message   = await interaction.fetchReply();
  const collector = createCommandCollector(message, {time: 300000});

  onCommandComponent(collector, async component => {
    if (component.user.id !== interaction.user.id)        {await component.reply({content: "This menu belongs to another user.", flags: discord.MessageFlags.Ephemeral}); return;}
    if (component.customId === "permission:list-section") {section = component.values[0]; page = 0;}
    if (component.customId === "permission:list-prev")    {page--;}
    if (component.customId === "permission:list-next")    {page++;}
    await component.update(render());
  });
}

// Routes /notification through an interactive menu
// interaction = ChatInputCommandInteraction
async function handleNotification(interaction) {
  if (!interaction.guild) {
    await interaction.reply({content:"This command can only be used in a Discord server.", flags:discord.MessageFlags.Ephemeral});
    return;
  }

  const member = interaction.member?.roles?.cache
    ? interaction.member
    : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

  if (!permissions.canUseCommand(member, "notification")) {
    await interaction.reply({content:"You do not have permission to use `/notification` in this server.", flags:discord.MessageFlags.Ephemeral});
    return;
  }

  const state = {
    page:        "home",
    groups:       [],
    group:        null,
    groupOptions: null,
    pendingCreate: null,
    pendingChannel: null,
    conflictGroup: null,
    conflictingChannelId: null,
    status:      null,
    action:      null,
    list:        [],
    selection:   null,
    backPage:    "home",
    pendingAdd:  {},
    configTargets: [],
    configValues:  [],
    testTargets: [],
    canUse:      action => permissions.canUseCommand(member, "notification", action)
  };

  if (interaction.options.getSubcommand(false) === "test") {
    state.page = "test";
    state.testTargets = notifications.getTestTargets(interaction.guild.id).map(target => target.value);
  }

  await interaction.deferReply({flags:discord.MessageFlags.Ephemeral});
  const reply = await interaction.editReply(renderNotificationMenu(interaction, state));

  const collector = createCommandCollector(reply, {
    filter: item =>
      item.user.id === interaction.user.id &&
      item.customId.startsWith("notification:"),
    time: 10 * 60 * 1000
  });

  collector.on("end", async () => {
    await interaction.editReply({content:"Notification menu closed.", embeds:[], components:[]}).catch(() => {});
  });

  onCommandComponent(collector, async component =>
    handleNotificationComponent(component, interaction, state, collector)
  );
}


// Builds the destination choices for a notification
function notificationChannelOptions(guild) {
  const channels = [...guild.channels.cache.values()]
    .filter(channel =>
      channel.isTextBased() &&
      !channel.isThread() &&
      [discord.ChannelType.GuildText, discord.ChannelType.GuildAnnouncement].includes(channel.type)
    )
    .slice(0, 24)
    .map(channel => menuOption(
      channel.name,
      channel.id,
      channel.type === discord.ChannelType.GuildAnnouncement ? "Announcement channel" : "Text channel"
    ));

  return [
    menuOption("Default BargazBot channel", "default", "Use the server's notification channel"),
    ...channels
  ];
}


// Renders the current page of the notification menu
function renderNotificationMenu(interaction, state) {
  const hours = getNotificationDedupeHours(interaction.guild.id);
  const embed = new discord.EmbedBuilder()
    .setTitle("BargazBot Notifications")
    .setColor(0x5865F2)
    .setTimestamp();

  let rows = [];

  switch (state.page) {
    case "home": {
      const options = [];

      if (state.canUse("add")) {options.push(menuOption("Add a creator", "add", "Follow a new creator"));}
      if (state.canUse("message")) {options.push(menuOption("Message configs", "configs", "Default, platform, creator, or group messages"));}
      if (state.canUse("edit") || state.canUse("message") || state.canUse("channel") || state.canUse("delete")) {
        options.push(menuOption("Manage a creator", "edit", "Rename, message, channel, refresh, delete"));
      }
      if (state.canUse("refresh")) {options.push(menuOption("Refresh now", "refresh", "Post current content now"));}
      options.push(menuOption("View all", "list", "List configured notifications"));
      options.push(menuOption("Dedupe window", "dedupe", `Currently ${hours} hour(s) — 0 always posts a new message`));
      if (state.canUse("groups")) {
        options.push(menuOption("Announcement groups", "groups", "Combine creators into one announcement"));
      }
      embed.setDescription((state.status ? `${state.status}\n\n` : "") + "Choose an action below.");
      rows = [
        buildSelectRow(menuId("notification", "home"), options, {placeholder:"Choose an action"}),
        buildButtonRow([{customId:menuId("notification","close"),label:"Close",style:"secondary"}])
      ];
      break;
    }

    case "pick": {
      embed.setDescription("Choose a creator notification:");
      rows = [
        buildSelectRow(menuId("notification", "pick"), state.list.map((subscription, index) => menuOption(
          `${subscription.nickname} — ${notifications.getPlatformName(subscription.platform)}`,
          String(index),
          subscription.channelName
        )), {placeholder:"Choose a creator"}),
        buildButtonRow([{customId:menuId("notification","back"),label:"Back",style:"secondary"}])
      ];
      break;
    }

    case "edit": {
      const subscription = state.list[state.selection];
      embed.setDescription(
        `**${subscription.nickname}** — ${notifications.getPlatformName(subscription.platform)}\n` +
        subscription.channelName
      );
      const editOptions = [
        menuOption("Rename",  "rename",  "Change the nickname"),
        menuOption("Message configs", "configs", "Default, platform, creator, or group messages")
      ];

      if (state.canUse("channel")) {
        editOptions.push(menuOption("Channel", "channel", "Change the destination channel"));
      }
      editOptions.push(menuOption("Refresh", "refresh", "Post current content now"));

      if (state.canUse("delete")) {
        editOptions.push(menuOption("Delete", "delete", "Remove this notification"));
      }
      editOptions.push(menuOption("Back", "back", "Choose another creator"));

      rows = [
        buildSelectRow(menuId("notification", "edit"), editOptions, {placeholder:"Choose an edit"}),
        buildButtonRow([{customId:menuId("notification","back"),label:"Back",style:"secondary"}])
      ];
      break;
    }

    case "groups": {
      embed.setTitle("Announcement Groups");
      embed.setDescription((state.status ? `${state.status}\n\n` : "") +
        "Choose a group, or create a new one. Every group needs a channel.");
      rows = [
        buildSelectRow(menuId("notification","groups"), state.groups.map((group, index) => menuOption(
          group.name,
          String(index),
          `${notifications.getGroupMembers(interaction.guild.id, group.groupId).length} creator(s) • ${group.windowMinutes} min`
        )), {placeholder:"Choose a group"}),
        buildButtonRow([
          {customId:menuId("notification","groups","create"),label:"Create group",style:"success"},
          {customId:menuId("notification","groups","back"),label:"Back",style:"secondary"}
        ])
      ];
      break;
    }

    case "group-create-channel": {
      embed.setTitle("Create a group");
      embed.setDescription("Pick where this group's combined announcements go. The server default is allowed.");
      rows = [
        buildSelectRow(menuId("notification","group-create-channel"), notificationChannelOptions(interaction.guild), {placeholder:"Choose a channel"}),
        buildButtonRow([{customId:menuId("notification","group-create-channel","back"),label:"Cancel",style:"secondary"}])
      ];
      break;
    }

    case "group-conflict": {
      embed.setTitle("Channel already in use");
      embed.setDescription(
        `**${state.conflictGroup?.name}** already uses ` +
        `${state.conflictingChannelId ? `<#${state.conflictingChannelId}>` : "the default notification channel"}.\n\n` +
        "Move that group first. Your change is held until both groups use different channels."
      );
      rows = [buildButtonRow([
        {customId:menuId("notification","group-conflict","yes"),label:"Move it first",style:"primary"},
        {customId:menuId("notification","group-conflict","no"),label:"Go back",style:"secondary"}
      ])];
      break;
    }

    case "group": {
      const group = state.group;
      const members = notifications.getGroupMembers(interaction.guild.id, group.groupId);

      embed.setTitle(group.name);
      embed.setDescription(
        `Channel: ${group.discordChannelId ? `<#${group.discordChannelId}>` : "Default notification channel"}\n` +
        `Window: ${group.windowMinutes} minute(s)\n` +
        `Members: ${members.length}\n` +
        `Kinds: ${group.allowedKinds.length ? group.allowedKinds.join(", ") : "Same kind only"}\n` +
        `Multiple posts per channel: ${group.allowMultiplePerChannel ? "On" : "Off"}\n` +
        `Title: ${group.title ?? "Default"}\n` +
        `Details: ${group.details ?? "Default"}\n` +
        `Thumbnail: ${group.thumbnailUrl ?? "Default"}\n` +
        `Mentions: ${group.mentionRoles.length} role(s), ${group.mentionUsers.length} user(s)\n\n` +
        `Placeholders: \`{creators}\`, \`{count}\`, \`{titles}\``
      );

      rows = [
        buildSelectRow(menuId("notification","group"), [
          menuOption("Rename group",       "name",      "Change the group name"),
          menuOption("Announcement title", "title",     "Custom embed title"),
          menuOption("Announcement details","details",  "Custom embed description"),
          menuOption("Thumbnail",          "thumbnail", "Custom thumbnail URL"),
          menuOption("Match window",       "window",    "Minutes to combine creators"),
          menuOption("Destination channel","channel",   "Where combined posts go"),
          menuOption("Allowed content kinds","types",   "Kinds that may combine"),
          menuOption("Multiple posts",     "multi",     "One channel adding several posts"),
          menuOption("Mentions",           "mentions",  "Roles and users to mention"),
          menuOption("Members",            "members",   "Creators in this group"),
          menuOption("Delete group",       "delete",    "Remove this group"),
          menuOption("Back",               "back",      "All groups")
        ], {placeholder:"Group settings"}),
        buildButtonRow([{customId:menuId("notification","group","back"),label:"Back",style:"secondary"}])
      ];
      break;
    }

    case "group-types": {
      const group = state.groupOptions ?? state.group;
      embed.setTitle("Content kinds");
      embed.setDescription("Select the kinds allowed to combine. Select none to only combine identical kinds.");
      rows = [
        buildSelectRow(menuId("notification","group","types"), NOTIFICATION_GROUP_KINDS.map(kind =>
          menuOption(kind, kind, "", group.allowedKinds.includes(kind))
        ), {placeholder:"Choose kinds", minValues:0, maxValues:NOTIFICATION_GROUP_KINDS.length}),
        buildButtonRow([{customId:menuId("notification","group","types","back"),label:"Back",style:"secondary"}])
      ];
      break;
    }

    case "group-channel": {
      embed.setTitle("Group destination channel");
      embed.setDescription("Group settings win over each member's channel for the combined message.");
      rows = [
        buildSelectRow(menuId("notification","group","channel"), notificationChannelOptions(interaction.guild), {placeholder:"Choose a channel"}),
        buildButtonRow([{customId:menuId("notification","group","channel","back"),label:"Back",style:"secondary"}])
      ];
      break;
    }

    case "group-mentions": {
      const options = state.groupOptions ?? state.group;
      embed.setTitle("Group mentions");
      embed.setDescription(
        `Roles: ${options.mentionRoles.length}\n` +
        `Users: ${options.mentionUsers.length}\n` +
        `Creator name on edit: ${options.showCreatorOnEdit ? "On" : "Off"}`
      );
      rows = [
        buildMentionableRow(menuId("notification","group","mentions","roles"), {placeholder:"Roles to mention", maxValues:5}),
        buildMentionableRow(menuId("notification","group","mentions","users"), {placeholder:"Users to mention", maxValues:5}),
        buildButtonRow([
          {
            customId: menuId("notification","group","mentions","toggle"),
            label: `Creator name on edit: ${options.showCreatorOnEdit ? "On" : "Off"}`,
            style: "secondary"
          },
          {customId:menuId("notification","group","mentions","back"),label:"Back",style:"secondary"}
        ])
      ];
      break;
    }

    case "group-members": {
      const selected = new Set(
        notifications.getGroupMembers(interaction.guild.id, state.group.groupId)
          .map(member => `${member.platform}:${member.channelId}`)
      );

      const options = notifications.getGuildSubscriptions(interaction.guild.id)
        .slice(0, 25)
        .map(subscription => menuOption(
          `${subscription.nickname} — ${notifications.getPlatformName(subscription.platform)}`,
          `${subscription.platform}:${subscription.channelId}`,
          subscription.channelName,
          selected.has(`${subscription.platform}:${subscription.channelId}`)
        ));

      embed.setTitle("Group members");
      embed.setDescription("Only creators that actually post appear in the combined message.");

      rows = options.length
        ? [
            buildSelectRow(menuId("notification","group","members"), options, {placeholder:"Choose creators", minValues:0, maxValues:Math.min(options.length,25)}),
            buildButtonRow([{customId:menuId("notification","group","members","back"),label:"Back",style:"secondary"}])
          ]
        : [buildButtonRow([{customId:menuId("notification","group","members","back"),label:"Back",style:"secondary"}])];
      break;
    }

    case "group-delete": {
      embed.setTitle("Delete group");
      embed.setDescription(`Delete **${state.group.name}**? Creator notifications are not deleted.`);
      rows = [buildButtonRow([
        {customId:menuId("notification","group","delete","yes"),label:"Delete",style:"danger"},
        {customId:menuId("notification","group","delete","cancel"),label:"Cancel",style:"secondary"}
      ])];
      break;
    }

    case "config-list": {
      const targets = notifications.listNotificationConfigTargets(interaction.guild.id);

      embed.setTitle("Message configs");
      embed.setDescription((state.status ? `${state.status}\n\n` : "") +
        "Select one config to edit, or select several to edit them together. " +
        "A config you have not customized inherits its settings.");

      rows = [
        buildSelectRow(menuId("notification","config-list"), targets.map(target => menuOption(
          target.label,
          target.value,
          target.config ? "Customized" : "Inherited",
          (state.configTargets ?? []).includes(target.value)
        )), {placeholder:"Choose config(s)", minValues:1, maxValues:Math.min(targets.length,25)}),
        buildButtonRow([{customId:menuId("notification","back"),label:"Back",style:"secondary"}])
      ];
      break;
    }

    case "config-edit": {
      const targets = state.configTargets ?? [];
      const values = state.configValues ?? [];
      const allTargets = notifications.listNotificationConfigTargets(interaction.guild.id);
      const label = targets.length === 1
        ? (allTargets.find(target => target.value === targets[0])?.label ?? targets[0])
        : `${targets.length} configs`;

      embed.setTitle("Edit message config");
      embed.setDescription(
        (state.status ? `${state.status}\n\n` : "") +
        `Editing: **${label}**\n\n` +
        `Custom message: ${configSummary(values, "customMessage")}\n` +
        `Roles mentioned: ${configSummary(values, "mentionRoles")}\n` +
        `Users mentioned: ${configSummary(values, "mentionUsers")}\n` +
        `Creator name on edit: ${configSummary(values, "showCreatorOnEdit")}\n\n` +
        `Placeholders: \`{creator}\`, \`{platform}\`, \`{title}\``
      );

      const deletable = targets.every(value => {
        const {scope} = parseConfigValue(value);
        return scope !== "default" && scope !== "group";
      });

      const options = [
        menuOption("Custom message", "message", "Text shown with the notification"),
        menuOption("Creator name on edit", "toggle", "Append who updated the message")
      ];
      if (deletable) {options.push(menuOption("Reset to inherited", "delete", "Remove these custom configs"));}
      options.push(menuOption("Back", "back", "Choose different configs"));

      rows = [
        buildSelectRow(menuId("notification","config-edit"), options, {placeholder:"Choose a setting"}),
        buildMentionableRow(menuId("notification","config-edit","roles"), {placeholder:"Roles to mention", maxValues:5}),
        buildMentionableRow(menuId("notification","config-edit","users"), {placeholder:"Users to mention", maxValues:5})
      ];
      break;
    }

    case "confirm": {
      const subscription = state.list[state.selection];
      embed.setDescription(`Delete the **${subscription.nickname}** ${notifications.getPlatformName(subscription.platform)} notification?`);
      rows = [buildButtonRow([
        {customId:menuId("notification","confirm","delete"),label:"Delete",style:"danger"},
        {customId:menuId("notification","confirm","cancel"),label:"Cancel",style:"secondary"}
      ])];
      break;
    }

    case "list": {
      const lines = state.list.map(subscription =>
        `**${subscription.nickname}** — ${notifications.getPlatformName(subscription.platform)}\n` +
        `${subscription.channelName}\n` +
        `Destination: ${subscription.discordChannelId ? `<#${subscription.discordChannelId}>` : "Default/fallback channel"}`
      );
      embed.setDescription((lines.join("\n\n") || "No notifications are configured.").slice(0, 4000));
      rows = [buildButtonRow([{customId:menuId("notification","back"),label:"Back",style:"secondary"}])];
      break;
    }

    case "dedupe": {
      const choices = [0,1,3,6,12,24,48,168,720].map(value => menuOption(
        value === 0 ? "Always send a new message" : `${value} hour${value === 1 ? "" : "s"}`,
        String(value),
        value === 24 ? "Default" : "",
        value === hours
      ));
      embed.setDescription(
        "Choose how long a recent notification can be reused for the same stream.\n" +
        "A matching message is only reused if it is still the most recent message in the channel."
      );
      rows = [
        buildSelectRow(menuId("notification","dedupe"), choices, {placeholder:"Choose a window"}),
        buildButtonRow([{customId:menuId("notification","back"),label:"Back",style:"secondary"}])
      ];
      break;
    }

    case "test": {
      const targets = notifications.getTestTargets(interaction.guild.id);
      embed.setTitle("Test notification");
      embed.setDescription("Pick one or more configs, groups, or an entire platform. The test uses the same message and mentions, with no API calls, tracking, or refresh use.");
      rows = [
        buildSelectRow(menuId("notification","test","targets"), targets.map(target => menuOption(
          target.label, target.value, target.groupId ? "Group announcement" : "Notification config"
        )), {placeholder:"Choose target(s)", minValues:1, maxValues:Math.min(targets.length,25)}),
        buildButtonRow([
          {customId:menuId("notification","test","preset"), label:"Use preset data", style:"primary"},
          {customId:menuId("notification","test","latest"), label:"Use latest cached data", style:"secondary"},
          {customId:menuId("notification","back"), label:"Back", style:"secondary"}
        ])
      ];
      break;
    }

    case "add-platform": {
      embed.setDescription("Choose the creator's platform.");
      rows = [buildSelectRow(menuId("notification","add","platform"), [
        menuOption("YouTube","youtube"),
        menuOption("Twitch","twitch"),
        menuOption("Kick","kick")
      ], {placeholder:"Choose a platform"})];
      break;
    }

    case "add-channel": {
      embed.setDescription(`Where should **${state.pendingAdd.nickname}** notifications be sent?`);
      rows = [buildSelectRow(menuId("notification","add","channel"), notificationChannelOptions(interaction.guild), {placeholder:"Choose a channel"})];
      break;
    }
  }

  return {embeds:[embed], components:rows};
}


// Builds the modal used to add a creator
function notificationAddModal(platform) {
  return new discord.ModalBuilder()
    .setCustomId(menuId("notification","add","form"))
    .setTitle(`Add ${notifications.getPlatformName(platform)} creator`)
    .addComponents(
      new discord.ActionRowBuilder().addComponents(new discord.TextInputBuilder()
        .setCustomId("creator")
        .setLabel("Creator URL, handle, or username")
        .setStyle(discord.TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(200)
      ),
      new discord.ActionRowBuilder().addComponents(new discord.TextInputBuilder()
        .setCustomId("nickname")
        .setLabel("Nickname")
        .setStyle(discord.TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100)
      ),
      new discord.ActionRowBuilder().addComponents(new discord.TextInputBuilder()
        .setCustomId("message")
        .setLabel("Custom message (optional)")
        .setStyle(discord.TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(2000)
      )
    );
}


// Builds the modal used to rename a creator
function notificationRenameModal(nickname) {
  return new discord.ModalBuilder()
    .setCustomId(menuId("notification","rename","form"))
    .setTitle("Rename notification")
    .addComponents(
      new discord.ActionRowBuilder().addComponents(new discord.TextInputBuilder()
        .setCustomId("nickname")
        .setLabel("New nickname")
        .setStyle(discord.TextInputStyle.Short)
        .setValue(nickname)
        .setRequired(true)
        .setMaxLength(100)
      )
    );
}

function parseConfigValue(value) {
  const separator = String(value).indexOf(":");
  if (separator < 0) {return {scope:"default", scopeKey:""};}
  return {
    scope:String(value).slice(0, separator),
    scopeKey:String(value).slice(separator + 1)
  };
}

function configSummary(values, key) {
  if (!values.length) {return "—";}
  const first = values[0]?.[key];
  const same = values.every(value => JSON.stringify(value?.[key]) === JSON.stringify(first));
  if (!same) {return "Mixed";}
  if (Array.isArray(first)) {return String(first.length);}
  if (typeof first === "boolean") {return first ? "On" : "Off";}
  return first || "Default";
}

function notificationConfigMessageModal(label, current) {
  return new discord.ModalBuilder()
    .setCustomId(menuId("notification","config","message"))
    .setTitle(`Message — ${label}`.slice(0, 45))
    .addComponents(
      new discord.ActionRowBuilder().addComponents(new discord.TextInputBuilder()
        .setCustomId("message")
        .setLabel("Custom message (blank restores default)")
        .setStyle(discord.TextInputStyle.Paragraph)
        .setValue(current ?? "")
        .setRequired(false)
        .setMaxLength(2000)
      )
    );
}

function notificationGroupFieldModal(field, group) {
  const fields = {
    name:      ["Group name",            "Rename group",                        100,  false],
    title:     ["Announcement title",    "Embed title (supports placeholders)", 200,  true],
    details:   ["Announcement details",  "Embed description",                   2000, true],
    thumbnail: ["Thumbnail URL",         "Image URL",                           200,  true],
    window:    ["Match window (minutes)","1 to 10080",                          10,   false]
  };

  const [label, placeholder, maxLength, clearable] = fields[field];
  const current = field === "window"
    ? String(group.windowMinutes)
    : (group[field] ?? "");

  return new discord.ModalBuilder()
    .setCustomId(menuId("notification","group","field",field))
    .setTitle(`Edit ${label.toLowerCase()}`)
    .addComponents(
      new discord.ActionRowBuilder().addComponents(new discord.TextInputBuilder()
        .setCustomId("value")
        .setLabel(label)
        .setStyle(field === "details" ? discord.TextInputStyle.Paragraph : discord.TextInputStyle.Short)
        .setPlaceholder(placeholder)
        .setValue(current)
        .setRequired(!clearable)
        .setMaxLength(maxLength)
      )
    );
}

function applyHeldGroupChange(guild, state, updatedGroup) {
  if (
    state.pendingChannel &&
    state.pendingChannel.groupId !== updatedGroup.groupId
  ) {
    const {groupId, channelId} = state.pendingChannel;

    if (!notifications.findGroupByChannel(guild.id, channelId, groupId)) {
      notifications.updateGroup(guild.id, groupId, {discordChannelId:channelId});
      state.pendingChannel = null;
      return notifications.findGroup(guild.id, groupId);
    }
  }

  if (state.pendingCreate) {
    const {name, channelId} = state.pendingCreate;

    if (!notifications.findGroupByChannel(guild.id, channelId, null)) {
      const created = notifications.createGroup(guild.id, name, channelId);
      state.pendingCreate = null;
      return created;
    }
  }

  return null;
}

// Shows a modal and waits for its submission
async function showNotificationModal(component, modal, customId) {
  const submitted = component.awaitModalSubmit({
    filter: item => item.customId === customId && item.user.id === component.user.id,
    time: 5 * 60 * 1000
  }).catch(() => null);

  await component.showModal(modal);
  return submitted;
}


// Refreshes the selected creator from inside the menu
async function refreshNotificationFromMenu(component, interaction, state) {
  const subscription = state.list[state.selection];

  await component.deferUpdate().catch(() => {});

  const result = await notifications.refreshSubscription(
    interaction.client,
    interaction.guild.id,
    subscription.nickname,
    subscription.platform
  );

  state.status = result.success
    ? `Refreshed **${subscription.nickname}** — ${result.content?.title ?? "current content"}.`
    : `Refresh failed: ${result.reason}. Your allowance was not used.`;

  state.page = "home";

  await interaction.editReply(renderNotificationMenu(interaction, state)).catch(() => {});
}


// Handles one interaction from the notification menu
async function handleNotificationComponent(component, interaction, state, collector) {
  const parts = parseMenuId(component.customId);
  const page  = parts[1];
  const guild = interaction.guild;
  const refresh = () => component.update(renderNotificationMenu(interaction, state));

  if (page === "close") {
    await component.update({content:"Notification menu closed.", embeds:[], components:[]});
    collector.stop("done");
    return;
  }

  if (page === "back") {
    state.page = state.backPage;
    state.status = null;
    await refresh();
    return;
  }

  if (page === "home") {
    const choice = component.values?.[0];
    state.status = null;

    if (choice === "configs" && state.canUse("message")) {
      state.backPage = "home";
      state.configTargets = [];
      state.configValues = [];
      state.status = null;
      state.page = "config-list";
      await refresh();
      return;
    }

    if (choice === "add") {
      state.page = "add-platform";
    } else if (choice === "list") {
      state.list = notifications.getGuildSubscriptions(guild.id);
      state.page = "list";
    } else if (choice === "dedupe") {
      state.page = "dedupe";
    } else if (choice === "test" && state.canUse("test")) {
      state.testTargets = notifications.getTestTargets(guild.id).map(target => target.value);
      state.page = "test";
    } else if (choice === "groups" && state.canUse("groups")) {
      state.groups = notifications.getGuildGroups(guild.id);
      state.page = state.groups.length ? "groups" : "home";
      if (!state.groups.length) {state.status = "No announcement groups are configured.";}
    } else if (["edit","delete","refresh"].includes(choice) && state.canUse(choice)) {
      state.action = choice;
      state.list = notifications.getGuildSubscriptions(guild.id);
      state.backPage = "home";
      state.page = state.list.length ? "pick" : "home";
      if (!state.list.length) {state.status = "No creator notifications are configured.";}
    }

    await refresh();
    return;
  }

  if (page === "pick") {
    state.selection = Number(component.values?.[0] ?? 0);
    state.backPage = "edit";

    if (state.action === "delete") {
      state.page = "confirm";
      await refresh();
      return;
    }

    if (state.action === "refresh") {
      await refreshNotificationFromMenu(component, interaction, state);
      return;
    }

    state.page = "edit";
    await refresh();
    return;
  }

  if (page === "edit") {
    const choice = component.values?.[0];
    const subscription = state.list[state.selection];

    if (choice === "back") {
      state.page = "pick";
      state.backPage = "home";
      await refresh();
      return;
    }

    if (choice === "rename" && state.canUse("edit")) {
      const customId = menuId("notification","rename","form");
      const submission = await showNotificationModal(component, notificationRenameModal(subscription.nickname), customId);
      if (!submission) {return;}

      const newNickname = submission.fields.getTextInputValue("nickname").trim();
      const result = notifications.editSubscription(guild.id, subscription.nickname, subscription.platform, newNickname);
      state.status = result.success
        ? `Renamed the notification to **${newNickname}**.`
        : `Could not rename: ${result.reason}.`;
      state.list = notifications.getGuildSubscriptions(guild.id);
      state.page = "home";

      await submission.reply({content:state.status, flags:discord.MessageFlags.Ephemeral}).catch(() => {});
      await interaction.editReply(renderNotificationMenu(interaction, state)).catch(() => {});
      return;
    }

    if (choice === "configs" && state.canUse("message")) {
      state.backPage = "edit";
      state.configTargets = [];
      state.configValues = [];
      state.status = null;
      state.page = "config-list";
      await refresh();
      return;
    }

    if (choice === "channel" && state.canUse("channel")) {
      state.page = "channel";
      await refresh();
      return;
    }

    if (choice === "refresh" && state.canUse("refresh")) {
      await refreshNotificationFromMenu(component, interaction, state);
      return;
    }

    if (choice === "delete" && state.canUse("delete")) {
      state.page = "confirm";
      await refresh();
      return;
    }

    await refresh();
    return;
  }

  if (page === "config-list") {
    state.configTargets = component.values ?? [];
    state.configValues = state.configTargets.map(value => {
      const {scope, scopeKey} = parseConfigValue(value);
      return notifications.getNotificationConfig(guild.id, scope, scopeKey) ??
        notifications.emptyNotificationConfig();
    });
    state.status = null;
    state.page = "config-edit";
    await refresh();
    return;
  }

  if (page === "config-edit") {
    const targets = state.configTargets ?? [];

    if (parts[2] === "roles" || parts[2] === "users") {
      const field = parts[2] === "roles" ? "mentionRoles" : "mentionUsers";
      const ids = (component.values ?? []).slice(0, 5);

      state.configValues = targets.map(value => {
        const {scope, scopeKey} = parseConfigValue(value);
        return notifications.setNotificationConfig(guild.id, scope, scopeKey, {[field]:ids});
      });
      state.status = parts[2] === "roles"
        ? `Saved ${ids.length} role mention(s).`
        : `Saved ${ids.length} user mention(s).`;
      await refresh();
      return;
    }

    const choice = component.values?.[0];

    if (choice === "back") {
      state.page = "config-list";
      state.status = null;
      await refresh();
      return;
    }

    if (choice === "message") {
      const first = state.configValues[0] ?? notifications.emptyNotificationConfig();
      const customId = menuId("notification","config","message");
      const submission = await showNotificationModal(
        component,
        notificationConfigMessageModal(`${targets.length} config(s)`, first.customMessage),
        customId
      );
      if (!submission) {return;}

      const customMessage = submission.fields.getTextInputValue("message").trim() || null;

      state.configValues = targets.map(value => {
        const {scope, scopeKey} = parseConfigValue(value);
        return notifications.setNotificationConfig(guild.id, scope, scopeKey, {customMessage});
      });
      state.status = customMessage ? "Custom message saved." : "Custom messages cleared.";

      await submission.reply({content:state.status, flags:discord.MessageFlags.Ephemeral}).catch(() => {});
      await interaction.editReply(renderNotificationMenu(interaction, state)).catch(() => {});
      return;
    }

    if (choice === "toggle") {
      const first = state.configValues[0] ?? notifications.emptyNotificationConfig();
      const showCreatorOnEdit = !first.showCreatorOnEdit;

      state.configValues = targets.map(value => {
        const {scope, scopeKey} = parseConfigValue(value);
        return notifications.setNotificationConfig(guild.id, scope, scopeKey, {showCreatorOnEdit});
      });
      state.status = showCreatorOnEdit
        ? "Creator name on edit is on."
        : "Creator name on edit is off.";
      await refresh();
      return;
    }

    if (choice === "delete") {
      let removed = 0;

      for (const value of targets) {
        const {scope, scopeKey} = parseConfigValue(value);
        if (notifications.deleteNotificationConfig(guild.id, scope, scopeKey)) {removed++;}
      }

      state.configTargets = [];
      state.configValues = [];
      state.status = `Reset ${removed} config(s) to inherited settings.`;
      state.page = "config-list";
      await refresh();
      return;
    }

    await refresh();
    return;
  }

  if (page === "groups") {
    if (parts[2] === "back") {
      state.page = "home";
      state.status = null;
      await refresh();
      return;
    }

    if (parts[2] === "create") {
      state.pendingCreate = {name:"New group", channelId:null};
      state.pendingChannel = null;
      state.group = null;
      state.page = "group-create-channel";
      state.status = null;
      await refresh();
      return;
    }

    const index = Number(component.values?.[0]);
    if (Number.isInteger(index) && state.groups[index]) {
      state.group = state.groups[index];
      state.groupOptions = state.group;
      state.pendingCreate = null;
      state.pendingChannel = null;
      state.status = null;
      state.page = "group";
    }

    await refresh();
    return;
  }

  if (page === "group-create-channel" || page === "group-channel") {
    if (parts[2] === "back" || parts[3] === "back") {
      state.page = page === "group-create-channel" ? "groups" : "group";
      await refresh();
      return;
    }

    const raw = component.values?.[0];
    const channelId = raw === "default" ? null : raw;
    const targetGroupId = page === "group-channel" ? state.group.groupId : null;
    const conflict = notifications.findGroupByChannel(guild.id, channelId, targetGroupId);

    if (conflict) {
      state.conflictGroup = conflict;
      state.conflictingChannelId = channelId;

      if (page === "group-create-channel") {
        state.pendingCreate = {
          name: state.pendingCreate?.name ?? "New group",
          channelId
        };
      } else {
        state.pendingChannel = {groupId:targetGroupId, channelId};
      }

      state.page = "group-conflict";
      await refresh();
      return;
    }

    let updated;

    if (page === "group-create-channel") {
      updated = notifications.createGroup(
        guild.id,
        state.pendingCreate?.name ?? "New group",
        channelId
      );
      state.pendingCreate = null;
      state.status = `Created **${updated.name}**.`;
    } else {
      updated = notifications.updateGroup(guild.id, targetGroupId, {
        discordChannelId:channelId
      });
      state.status = "Group channel updated.";
    }

    const held = applyHeldGroupChange(guild, state, updated);

    state.group = held ?? updated;
    state.groupOptions = state.group;
    state.groups = notifications.getGuildGroups(guild.id);
    state.page = "group";

    await refresh();
    return;
  }

  if (page === "group-conflict") {
    if (parts[2] === "no") {
      const wasCreate = Boolean(state.pendingCreate);
      state.conflictGroup = null;

      if (wasCreate) {
        state.pendingCreate = null;
        state.page = "groups";
        state.status = "Group creation cancelled.";
      } else {
        state.pendingChannel = null;
        state.page = "group";
        state.status = "Channel change cancelled.";
      }

      await refresh();
      return;
    }

    state.group = state.conflictGroup;
    state.groupOptions = state.conflictGroup;
    state.groups = notifications.getGuildGroups(guild.id);
    state.page = "group";
    state.status =
      `**${state.conflictGroup.name}** uses that channel. Change its channel first — ` +
      "the other change is held.";

    await refresh();
    return;
  }

  if (page === "group") {
    const choice = component.values?.[0];

    if (parts[2] === "back" || choice === "back") {
      state.page = "groups";
      state.status = null;
      await refresh();
      return;
    }

    if (choice === "multi") {
      state.group = notifications.updateGroup(guild.id, state.group.groupId, {
        allowMultiplePerChannel: !state.group.allowMultiplePerChannel
      });
      state.groups = notifications.getGuildGroups(guild.id);
      state.status = state.group.allowMultiplePerChannel
        ? "One channel can now add multiple posts to a group announcement."
        : "Each channel can now add only one post to a group announcement.";
      await refresh();
      return;
    }

    if (choice === "types") {
      state.groupOptions = state.group;
      state.page = "group-types";
      await refresh();
      return;
    }

    if (["name","title","details","thumbnail","window"].includes(choice)) {
      const customId = menuId("notification","group","field",choice);
      const submission = await showNotificationModal(
        component,
        notificationGroupFieldModal(choice, state.group),
        customId
      );
      if (!submission) {return;}

      const key = choice === "window" ? "windowMinutes" : choice;
      let value = submission.fields.getTextInputValue("value").trim();

      if (choice === "window") {
        value = Number(value);
      } else if (choice !== "name") {
        value = value || null;
      }

      state.group = notifications.updateGroup(guild.id, state.group.groupId, {[key]:value});
      state.groups = notifications.getGuildGroups(guild.id);
      state.status = `Updated ${choice}.`;

      await submission.reply({content:state.status, flags:discord.MessageFlags.Ephemeral}).catch(() => {});
      await interaction.editReply(renderNotificationMenu(interaction, state)).catch(() => {});
      return;
    }

    if (choice === "channel") {
      state.page = "group-channel";
      await refresh();
      return;
    }

    if (choice === "mentions") {
      state.groupOptions = state.group;
      state.page = "group-mentions";
      await refresh();
      return;
    }

    if (choice === "members") {
      state.page = "group-members";
      await refresh();
      return;
    }

    if (choice === "delete") {
      state.page = "group-delete";
      await refresh();
      return;
    }

    await refresh();
    return;
  }

  if (page === "group-types") {
    if (parts[2] === "back") {
      state.page = "group";
      await refresh();
      return;
    }

    const kinds = (component.values ?? [])
      .filter(kind => NOTIFICATION_GROUP_KINDS.includes(kind));

    state.group = notifications.updateGroup(guild.id, state.group.groupId, {
      allowedKinds:kinds
    });
    state.groupOptions = state.group;
    state.status = kinds.length
      ? `Grouping allowed across: ${kinds.join(", ")}.`
      : "Only identical content kinds will be grouped.";

    await refresh();
    return;
  }

  if (page === "group-mentions") {
    const key = parts[3];

    if (key === "back") {
      state.page = "group";
      await refresh();
      return;
    }

    if (key === "toggle") {
      state.groupOptions = notifications.updateGroup(guild.id, state.group.groupId, {
        showCreatorOnEdit: !state.groupOptions.showCreatorOnEdit
      });
      state.group = state.groupOptions;
      state.status = state.group.showCreatorOnEdit
        ? "Group announcements will show the creator name on edit."
        : "Group announcements will not show the creator name on edit.";
      await refresh();
      return;
    }

    if (key === "roles" || key === "users") {
      state.groupOptions = notifications.updateGroup(guild.id, state.group.groupId, {
        [key === "roles" ? "mentionRoles" : "mentionUsers"]: (component.values ?? []).slice(0, 5)
      });
      state.group = state.groupOptions;
      state.status = key === "roles"
        ? "Saved group role mentions."
        : "Saved group user mentions.";
      await refresh();
      return;
    }

    await refresh();
    return;
  }

  if (page === "group-members") {
    if (parts[3] === "back") {
      state.page = "group";
      await refresh();
      return;
    }

    const members = (component.values ?? []).map(value => {
      const separator = value.indexOf(":");
      return {
        platform: value.slice(0, separator),
        channelId: value.slice(separator + 1)
      };
    });

    notifications.setGroupMembers(guild.id, state.group.groupId, members);
    state.status = `Saved ${members.length} group member(s).`;
    state.page = "group";
    await refresh();
    return;
  }

  if (page === "group-delete") {
    if (parts[3] === "yes") {
      notifications.deleteGroup(guild.id, state.group.groupId);
      state.status = `Deleted the **${state.group.name}** group.`;
      state.groups = notifications.getGuildGroups(guild.id);
      state.group = null;
      state.page = "groups";
      await refresh();
      return;
    }

    state.page = "group";
    await refresh();
    return;
  }

  if (page === "confirm") {
    if (parts[2] === "cancel") {
      state.page = "edit";
      await refresh();
      return;
    }

    if (parts[2] === "delete") {
      const subscription = state.list[state.selection];
      const result = notifications.deleteSubscription(guild.id, subscription.nickname, subscription.platform);
      state.status = result.success
        ? `Deleted the **${subscription.nickname}** notification.`
        : `Could not delete that notification.`;
      state.list = notifications.getGuildSubscriptions(guild.id);
      state.page = "home";
      await refresh();
    }
    return;
  }

  if (page === "channel") {
    const subscription = state.list[state.selection];
    const channelId = component.values?.[0];
    const result = notifications.setSubscriptionChannel(
      guild.id,
      subscription.nickname,
      subscription.platform,
      channelId === "default" ? null : channelId
    );

    state.status = result.success
      ? `Notifications for **${subscription.nickname}** now use ${channelId === "default" ? "the default channel" : `<#${channelId}>`}.`
      : `Could not change the channel: ${result.reason}.`;
    state.page = "home";
    await refresh();
    return;
  }

  if (page === "dedupe") {
    const hours = Number(component.values?.[0] ?? 24);
    setNotificationDedupeHours(guild.id, hours);
    state.status = hours === 0
      ? "Duplicate messages are off — matching streams always post a new message."
      : `Matching streams reuse a recent message for **${hours} hour(s)**.`;
    state.page = "home";
    await refresh();
    return;
  }

  if (page === "add" && parts[2] === "platform") {
    const platform = component.values?.[0];
    state.pendingAdd = {platform};
    const submission = await showNotificationModal(component, notificationAddModal(platform), menuId("notification","add","form"));
    if (!submission) {return;}

    const creator = submission.fields.getTextInputValue("creator").trim();
    const nickname = submission.fields.getTextInputValue("nickname").trim();
    const customMessage = submission.fields.getTextInputValue("message").trim() || null;

    if (!creator || !nickname) {
      await submission.reply({content:"The creator and nickname cannot be empty.", flags:discord.MessageFlags.Ephemeral}).catch(() => {});
      return;
    }

    if (notifications.findGuildSubscription(guild.id, nickname, platform)) {
      state.status = `A notification already uses the nickname **${nickname}**.`;
      state.page = "home";
      await submission.reply({content:state.status, flags:discord.MessageFlags.Ephemeral}).catch(() => {});
      await interaction.editReply(renderNotificationMenu(interaction, state)).catch(() => {});
      return;
    }

    state.pendingAdd = {platform, creator, nickname, customMessage};
    state.page = "add-channel";

    await submission.reply({content:"Choose a destination channel in the menu.", flags:discord.MessageFlags.Ephemeral}).catch(() => {});
    await interaction.editReply(renderNotificationMenu(interaction, state)).catch(() => {});
    return;
  }

  if (page === "add" && parts[2] === "channel") {
    const channelId = component.values?.[0];
    const pending = state.pendingAdd;
    const result = await notifications.addSubscription(
      guild.id,
      pending.platform,
      pending.creator,
      pending.nickname,
      channelId === "default" ? null : channelId,
      pending.customMessage
    );

    if (!result.success) {
      const platformName = notifications.getPlatformName(pending.platform);
      state.status = result.reason === "entitlement-limit"
        ? `No ${platformName} capacity left (${result.usage}/${result.limit}). Use \`/entitlement allocate\`.`
        : result.reason === "already-exists"
          ? `This server already follows that creator on ${platformName}.`
          : `BargazBot could not find that creator on ${platformName}.`;
    } else {
      state.status = `Added **${result.channel.channel_name}** as **${pending.nickname}**.`;
    }

    state.pendingAdd = {};
    state.list = notifications.getGuildSubscriptions(guild.id);
    state.page = "home";
    await refresh();
    return;
  }

  if (page === "test") {
    const useLatest = parts[2] === "latest";
    if (parts[2] !== "preset" && parts[2] !== "latest") {await refresh(); return;}
    const targets = (state.testTargets ?? []).map(value => {
      const found = notifications.getTestTargets(guild.id).find(target => target.value === value);
      return found;
    }).filter(Boolean);
    const lines = [];
    for (const target of targets) {
      const result = await notifications.sendTestNotification(interaction.client, guild.id, target, useLatest);
      lines.push(result.success ? `Sent test for **${target.label}**.` : `Could not send test for **${target.label}**: ${result.reason}.`);
      if (!result.success) {log.warn("Notification test failed:", guild.id, target.value, result.reason);}
    }
    state.testTargets = [];
    state.status = lines.join("\n").slice(0, 4000);
    state.page = "home";
    await interaction.editReply(renderNotificationMenu(interaction, state)).catch(() => {});
    await component.reply({content:"Test notifications were sent.", flags:discord.MessageFlags.Ephemeral}).catch(() => {});
    return;
  }

  if (page === "test" && parts[2] === "targets") {
    state.testTargets = component.values ?? [];
    state.page = "test";
    await component.update(renderNotificationMenu(interaction, state));
    return;
  }

  await refresh();
}

async function showConfigModal(source, modal, customId) {
  const submitted = source.awaitModalSubmit({
    filter: item => item.customId === customId && item.user.id === source.user?.id,
    time: 300000
  }).catch(() => null);
  await source.showModal(modal);
  return submitted;
}

function configChannelOptions(guild, includeNone = false) {
  const options = [...(guild?.channels?.cache?.values() ?? [])]
    .filter(channel =>
      channel.isTextBased() &&
      !channel.isThread() &&
      [discord.ChannelType.GuildText, discord.ChannelType.GuildAnnouncement].includes(channel.type)
    )
    .slice(0, 24)
    .map(channel => menuOption(
      channel.name,
      channel.id,
      channel.type === discord.ChannelType.GuildAnnouncement ? "Announcement channel" : "Text channel"
    ));
  if (includeNone || options.length === 0) {
    options.unshift(menuOption("None", "none", "No channel selected"));
  }
  return options;
}

async function handleInactivity(interaction) {
  if (!interaction.guild) {
    await interaction.reply({content:"This command can only be used in a Discord server.", flags:discord.MessageFlags.Ephemeral});
    return;
  }
  if (!await requireCommandAccess(interaction, "inactivity", "setup")) {return;}

  const selectableChannels = [...interaction.guild.channels.cache.values()].filter(channel =>
    channel.isTextBased() &&
    !channel.isThread() &&
    [discord.ChannelType.GuildText, discord.ChannelType.GuildAnnouncement].includes(channel.type)
  );
  if (!selectableChannels.length) {
    await interaction.reply({content:"This server has no text channels available for an inactivity rule.", flags:discord.MessageFlags.Ephemeral});
    return;
  }

  const guildId = interaction.guild.id;
  const state = {page:"home", action:null, ruleId:null, draft:null, status:null};
  const rules = () => inactivity.getRules(guildId);
  const mentionList = ids => ids?.length ? ids.map(id => `<#${id}>`).join(", ") : "None";

  const defaultDraft = () => ({
    name:"Inactivity rule",
    message:"This channel has been inactive for {duration}.",
    thresholdMinutes:60,
    targets:[],
    includeBots:false,
    enabled:true
  });

  const fromRule = rule => ({
    name:rule.name,
    message:rule.message,
    thresholdMinutes:rule.idleMinutes ?? rule.durationMinutes ?? 60,
    targets:[...(rule.targets ?? [])],
    includeBots:rule.includeBotMessages,
    enabled:rule.enabled
  });

  const render = () => {
    const embed = new discord.EmbedBuilder().setTitle("BargazBot Inactivity Alerts").setColor(0x5865F2).setTimestamp();
    let rows = [];

    if (state.page === "home") {
      const list = rules();
      embed.setDescription(
        (state.status ? `${state.status}\n\n` : "") +
        (list.length
          ? list.map((rule, index) => `**${index + 1}. ${rule.name}** — ${rule.idleMinutes ?? rule.durationMinutes ?? 60} min, ${rule.enabled ? "on" : "off"}`).join("\n")
          : "No inactivity rules are configured.")
      );
      rows = [buildSelectRow(menuId("inactivity", "home"), [
        menuOption("Add rule", "add", "Create a new rule"),
        menuOption("Edit rule", "edit", "Change an existing rule"),
        menuOption("Delete rule", "delete", "Remove a rule")
      ], {placeholder:"Choose an action"})];
    }

    if (state.page === "pick") {
      const list = rules();
      const options = list.length
        ? list.map((rule, index) => menuOption(rule.name, String(index), `${rule.idleMinutes ?? rule.durationMinutes ?? 60} min`))
        : [menuOption("No rules configured", "none")];
      embed.setDescription(state.action === "delete" ? "Choose a rule to delete." : "Choose a rule to edit.");
      rows = [
        buildSelectRow(menuId("inactivity", "pick"), options, {placeholder:"Choose a rule"}),
        buildButtonRow([{customId:menuId("inactivity", "cancel"), label:"Cancel", style:"secondary"}])
      ];
    }

    if (state.page === "pickers") {
      const draft = state.draft;
      const channelOptions = configChannelOptions(interaction.guild)
        .filter(option => option.value !== "none")
        .map(option => ({...option, default:draft.targets.includes(option.value)}));
      embed.setDescription("Select the channels this rule monitors, then review. Everything else is set in the modal.")
        .addFields({name:"Draft", value:`**${draft.name}**\n${draft.thresholdMinutes} min`});
      rows = [
        buildSelectRow(menuId("inactivity", "targets"), channelOptions, {placeholder:"Monitored channels", minValues:1, maxValues:channelOptions.length}),
        buildButtonRow([
          {customId:menuId("inactivity", "continue"), label:"Review", style:"primary"},
          {customId:menuId("inactivity", "text"), label:"Edit details", style:"secondary"},
          {customId:menuId("inactivity", "cancel"), label:"Cancel", style:"secondary"}
        ])
      ];
    }

    if (state.page === "review") {
      const draft = state.draft;
      embed.setDescription(`**${draft.name}**`)
        .addFields(
          {name:"Message", value:draft.message || "No message"},
          {name:"Threshold", value:`${draft.thresholdMinutes} min`, inline:true},
          {name:"Monitored channels", value:mentionList(draft.targets)},
          {name:"Options", value:`Bots: ${draft.includeBots ? "yes" : "no"}\nEnabled: ${draft.enabled ? "on" : "off"}`, inline:true}
        );
      const buttons = [
        {customId:menuId("inactivity", "text"), label:"Edit details", style:"primary"},
        {customId:menuId("inactivity", "pickers"), label:"Edit channels", style:"secondary"},
        {customId:menuId("inactivity", "save"), label:"Save", style:"success"},
        {customId:menuId("inactivity", "cancel"), label:"Cancel", style:"secondary"}
      ];
      if (state.ruleId) {buttons.splice(2, 0, {customId:menuId("inactivity", "delete"), label:"Delete", style:"danger"});}
      rows = [buildButtonRow(buttons)];
    }

    return {embeds:[embed], components:rows, flags:discord.MessageFlags.Ephemeral};
  };

  const openTextModal = async source => {
    const customId = menuId("inactivity", "modal");
    const draft = state.draft;
    const submitted = await showConfigModal(source, new discord.ModalBuilder()
      .setCustomId(customId)
      .setTitle("Inactivity rule details")
      .addComponents(
        new discord.ActionRowBuilder().addComponents(new discord.TextInputBuilder()
          .setCustomId("name")
          .setLabel("Rule name")
          .setStyle(discord.TextInputStyle.Short)
          .setValue(draft.name ?? "")
          .setRequired(true)
          .setMaxLength(100)
        ),
        new discord.ActionRowBuilder().addComponents(new discord.TextInputBuilder()
          .setCustomId("message")
          .setLabel("Alert message")
          .setStyle(discord.TextInputStyle.Paragraph)
          .setValue(draft.message ?? "")
          .setRequired(true)
          .setMaxLength(1000)
        ),
        new discord.ActionRowBuilder().addComponents(new discord.TextInputBuilder()
          .setCustomId("thresholdMinutes")
          .setLabel("Inactive minutes")
          .setStyle(discord.TextInputStyle.Short)
          .setValue(String(draft.thresholdMinutes ?? 60))
          .setRequired(true)
          .setMaxLength(5)
        ),
        new discord.ActionRowBuilder().addComponents(new discord.TextInputBuilder()
          .setCustomId("includeBots")
          .setLabel("Count bot activity (y/n)")
          .setStyle(discord.TextInputStyle.Short)
          .setValue(draft.includeBots ? "y" : "n")
          .setRequired(true)
          .setMaxLength(1)
        ),
        new discord.ActionRowBuilder().addComponents(new discord.TextInputBuilder()
          .setCustomId("enabled")
          .setLabel("Rule enabled (y/n)")
          .setStyle(discord.TextInputStyle.Short)
          .setValue(draft.enabled ? "y" : "n")
          .setRequired(true)
          .setMaxLength(1)
        )
      ), customId);
    if (!submitted) {return null;}

    draft.name = submitted.fields.getTextInputValue("name").trim() || "Inactivity rule";
    draft.message = submitted.fields.getTextInputValue("message").trim() || "This channel has been inactive for {duration}.";
    const minutes = Number(submitted.fields.getTextInputValue("thresholdMinutes").trim());
    draft.thresholdMinutes = Number.isFinite(minutes) && minutes >= 1 ? Math.floor(minutes) : 60;
    const yesNo = value => ["y", "yes"].includes(String(value ?? "").trim().toLowerCase());
    draft.includeBots = yesNo(submitted.fields.getTextInputValue("includeBots"));
    draft.enabled = yesNo(submitted.fields.getTextInputValue("enabled"));

    if (rules().some(rule => rule.ruleId !== state.ruleId && rule.name.trim().toLowerCase() === draft.name.toLowerCase())) {
      await submitted.reply({content:"An inactivity rule with that name already exists. Use another name.", flags:discord.MessageFlags.Ephemeral});
      return null;
    }
    return submitted;
  };

  await interaction.deferReply({flags:discord.MessageFlags.Ephemeral});
  const msg = await interaction.editReply(render());
  const collector = createCommandCollector(msg, {time:300000});

  onCommandComponent(collector, async component => {
    if (component.user.id !== interaction.user.id) {
      await component.reply({content:"Only the person who opened this menu can use it.", flags:discord.MessageFlags.Ephemeral});
      return;
    }
    const action = parseMenuId(component.customId)[1];
    try {
      if (action === "cancel") {
        collector.stop("cancel");
        await component.update({content:"Cancelled.", embeds:[], components:[]});
        return;
      }

      if (action === "home") {
        const choice = component.values?.[0];
        state.status = null;
        if (choice === "add") {
          state.ruleId = null;
          state.draft = defaultDraft();
          const submitted = await openTextModal(component);
          if (!submitted) {return;}
          state.page = "pickers";
          await submitted.update(render());
          return;
        }
        state.action = choice;
        state.page = "pick";
        await component.update(render());
        return;
      }

      if (action === "pick") {
        const value = component.values?.[0];
        if (value === "none") {return;}
        const list = rules();
        const rule = list[Number(value)];
        if (!rule) {return;}
        state.ruleId = rule.ruleId;
        if (state.action === "delete") {
          inactivity.deleteRule(guildId, rule.ruleId);
          state.status = `Deleted **${rule.name}**.`;
          state.page = "home";
          await component.update(render());
          return;
        }
        state.draft = fromRule(rule);
        const submitted = await openTextModal(component);
        if (!submitted) {return;}
        state.page = "pickers";
        await submitted.update(render());
        return;
      }

      if (action === "targets") {
        state.draft.targets = component.values ?? [];
        await component.update(render());
        return;
      }
      if (action === "continue") {
        state.page = "review";
        await component.update(render());
        return;
      }
      if (action === "pickers") {
        state.page = "pickers";
        await component.update(render());
        return;
      }
      if (action === "text") {
        const submitted = await openTextModal(component);
        if (!submitted) {return;}
        await submitted.update(render());
        return;
      }
      if (action === "delete") {
        await component.deferUpdate();
        if (state.ruleId) {inactivity.deleteRule(guildId, state.ruleId);}
        await interaction.editReply({content:"Rule deleted.", embeds:[], components:[]});
        collector.stop("deleted");
        return;
      }
      if (action === "save") {
        const draft = state.draft;
        if (rules().some(rule => rule.ruleId !== state.ruleId && rule.name.trim().toLowerCase() === draft.name.toLowerCase())) {
          await component.reply({content:"An inactivity rule with that name already exists.", flags:discord.MessageFlags.Ephemeral});
          return;
        }
        await component.deferUpdate();
        const payload = {
          name:draft.name,
          message:draft.message,
          thresholdMinutes:draft.thresholdMinutes,
          scope:"channel",
          destinationChannelId:null,
          targets:draft.targets,
          includeBotMessages:draft.includeBots,
          enabled:draft.enabled
        };
        const saved = state.ruleId
          ? inactivity.updateRule(guildId, state.ruleId, payload)
          : inactivity.createRule(guildId, payload);
        if (!saved) {
          await interaction.editReply({content:"That rule no longer exists. Nothing was saved.", embeds:[], components:[]});
          collector.stop("error");
          return;
        }
        await interaction.editReply({content:`Saved **${saved.name}**.`, embeds:[], components:[]});
        collector.stop("saved");
      }
    } catch (error) {
      log.error("Inactivity menu error:", error);
      await interaction.editReply({content:"The inactivity menu encountered an error. Nothing was saved.", embeds:[], components:[]}).catch(() => {});
      collector.stop("error");
    }
  });
  collector.on("end", async () => {await interaction.editReply({components:[]}).catch(() => {});});
}

async function handleTimers(interaction) {
  if (!interaction.guild) {
    await interaction.reply({content:"This command can only be used in a Discord server.", flags:discord.MessageFlags.Ephemeral});
    return;
  }
  if (!await requireCommandAccess(interaction, "timers", "setup")) {return;}

  const guildId = interaction.guild.id;
  const state = {page:"home", section:"timer", action:null, itemId:null, draft:null, status:null};
  const listFor = section => section === "timer" ? timers.getTimers("guild",guildId) : timers.getBirthdayCommands("guild",guildId);
  const mention = id => id ? `<#${id}>` : "Not set";

  const defaultDraft = section => section === "timer"
    ? {name:"Reminder", schedule:"", message:"Reminder: {name}", channelId:null, timeZone:"", enabled:true}
    : {name:"Birthday command", triggerText:"", dateFormat:"MM-DD", message:"Happy birthday, {user}!", channelId:null, timeZone:"", enabled:true};

  const fromItem = (section, item) => section === "timer"
    ? {name:item.name, schedule:item.schedule, message:item.message, channelId:item.channelId, timeZone:item.timeZone ?? "", enabled:item.enabled}
    : {name:item.name, triggerText:item.triggerText, dateFormat:item.dateFormat, message:item.message, channelId:item.channelId, timeZone:item.timeZone ?? "", enabled:item.enabled};

  const render = () => {
    const embed = new discord.EmbedBuilder().setTitle("BargazBot Timers").setColor(0x5865F2).setTimestamp();
    let rows = [];

    if (state.page === "home") {
      const list = listFor(state.section);
      const detail = item => state.section === "timer"
        ? `${item.schedule || "No schedule"} — ${mention(item.channelId)}`
        : `${item.triggerText || "No trigger"} — ${mention(item.channelId)}`;
      embed.setDescription(
        (state.status ? `${state.status}\n\n` : "") +
        (list.length ? list.map((item, index) => `**${index + 1}. ${item.name}** — ${detail(item)}`).join("\n") : "Nothing configured.")
      );
      rows = [
        buildSelectRow(menuId("timers", "section"), [
          menuOption("Timers", "timer", "One-shot and recurring reminders", state.section === "timer"),
          menuOption("Birthday commands", "birthday", "Custom birthday triggers", state.section === "birthday")
        ], {placeholder:"Choose a section"}),
        buildSelectRow(menuId("timers", "home"), [
          menuOption("Add", "add", "Create a new item"),
          menuOption("Edit", "edit", "Change an existing item"),
          menuOption("Delete", "delete", "Remove an item")
        ], {placeholder:"Choose an action"})
      ];
    }

    if (state.page === "pick") {
      const list = listFor(state.section);
      const options = list.length
        ? list.map((item, index) => menuOption(item.name, String(index)))
        : [menuOption("Nothing configured", "none")];
      embed.setDescription(state.action === "delete" ? "Choose an item to delete." : "Choose an item to edit.");
      rows = [
        buildSelectRow(menuId("timers", "pick"), options, {placeholder:"Choose an item"}),
        buildButtonRow([{customId:menuId("timers", "cancel"), label:"Cancel", style:"secondary"}])
      ];
    }

    if (state.page === "pickers") {
      const draft = state.draft;
      const channelOptions = configChannelOptions(interaction.guild, true).map(option => ({
        ...option,
        default:option.value === (draft.channelId ?? "none")
      }));
      embed.setDescription("Choose a destination and status, then continue to review. Nothing is saved yet.")
        .addFields({name:"Draft", value:`**${draft.name}**\n${state.section === "timer" ? draft.schedule || "No schedule" : draft.triggerText || "No trigger"}`});
      rows = [
        buildSelectRow(menuId("timers", "channel"), channelOptions, {placeholder:"Destination channel"}),
        buildSelectRow(menuId("timers", "enabled"), [
          menuOption("Enabled", "on", "This item runs normally", draft.enabled),
          menuOption("Disabled", "off", "Keep this item but do not run it", !draft.enabled)
        ], {placeholder:"Status"}),
        buildButtonRow([
          {customId:menuId("timers", "continue"), label:"Review", style:"primary"},
          {customId:menuId("timers", "cancel"), label:"Cancel", style:"secondary"}
        ])
      ];
    }

    if (state.page === "review") {
      const draft = state.draft;
      const fields = state.section === "timer"
        ? [
            {name:"Schedule", value:draft.schedule || "No schedule"},
            {name:"Message", value:draft.message || "No message"},
            {name:"Timezone", value:draft.timeZone || "Server default", inline:true}
          ]
        : [
            {name:"Trigger", value:draft.triggerText || "No trigger"},
            {name:"Date format", value:draft.dateFormat, inline:true},
            {name:"Message", value:draft.message || "No message"},
            {name:"Timezone", value:draft.timeZone || "Server default", inline:true}
          ];
      fields.push({name:"Channel", value:mention(draft.channelId), inline:true});
      fields.push({name:"Status", value:draft.enabled ? "Enabled" : "Disabled", inline:true});
      embed.setDescription(`**${draft.name}**`).addFields(fields);
      const buttons = [
        {customId:menuId("timers", "text"), label:"Edit text", style:"primary"},
        {customId:menuId("timers", "pickers"), label:"Edit channel", style:"secondary"},
        {customId:menuId("timers", "save"), label:"Save", style:"success"},
        {customId:menuId("timers", "cancel"), label:"Cancel", style:"secondary"}
      ];
      if (state.itemId) {buttons.splice(2, 0, {customId:menuId("timers", "delete"), label:"Delete", style:"danger"});}
      rows = [buildButtonRow(buttons)];
    }

    return {embeds:[embed], components:rows, flags:discord.MessageFlags.Ephemeral};
  };

  const openTextModal = async source => {
    const isTimer = state.section === "timer";
    const draft = state.draft;
    const customId = menuId("timers", "modal");
    const row = (id, label, value, style = discord.TextInputStyle.Short, required = true, max = 200, placeholder = "") => {
      const input = new discord.TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setStyle(style)
        .setRequired(required)
        .setMaxLength(max);
      if (placeholder) {input.setPlaceholder(placeholder);}
      if (value !== undefined && value !== null && String(value) !== "") {input.setValue(String(value));}
      return new discord.ActionRowBuilder().addComponents(input);
    };

    const components = isTimer
      ? [
          row("name", "Name", draft.name, discord.TextInputStyle.Short, true, 100),
          row("schedule", "When it runs", draft.schedule, discord.TextInputStyle.Paragraph, true, 200, "every 30m | daily 09:00 | weekly mon 17:30 | 12-25 09:00 | 2026-12-25 09:00 | cron: * * * * *"),
          row("message", "Message", draft.message, discord.TextInputStyle.Paragraph, true, 1000),
          row("timeZone", "Timezone (optional)", draft.timeZone, discord.TextInputStyle.Short, false, 100)
        ]
      : [
          row("name", "Command name", draft.name, discord.TextInputStyle.Short, true, 100),
          row("triggerText", "Trigger text", draft.triggerText, discord.TextInputStyle.Short, true, 100),
          row("dateFormat", "Date format", draft.dateFormat, discord.TextInputStyle.Short, true, 50),
          row("message", "Message", draft.message, discord.TextInputStyle.Paragraph, true, 1000),
          row("timeZone", "Timezone (optional)", draft.timeZone, discord.TextInputStyle.Short, false, 100)
        ];

    const submitted = await showConfigModal(source, new discord.ModalBuilder()
      .setCustomId(customId)
      .setTitle(isTimer ? "Timer details" : "Birthday command details")
      .addComponents(components), customId);
    if (!submitted) {return false;}

    draft.name = submitted.fields.getTextInputValue("name").trim() || (isTimer ? "Reminder" : "Birthday command");
    draft.message = submitted.fields.getTextInputValue("message").trim() || (isTimer ? "Reminder: {name}" : "Happy birthday, {user}!");
    draft.timeZone = submitted.fields.getTextInputValue("timeZone").trim();
    if (isTimer) {draft.schedule = submitted.fields.getTextInputValue("schedule").trim();}
    else {
      draft.triggerText = submitted.fields.getTextInputValue("triggerText").trim();
      draft.dateFormat = submitted.fields.getTextInputValue("dateFormat").trim() || "MM-DD";
    }
    return submitted;
  };

  await interaction.deferReply({flags:discord.MessageFlags.Ephemeral});
  const msg = await interaction.editReply(render());
  const collector = createCommandCollector(msg, {time:300000});

  onCommandComponent(collector, async component => {
    if (component.user.id !== interaction.user.id) {
      await component.reply({content:"Only the person who opened this menu can use it.", flags:discord.MessageFlags.Ephemeral});
      return;
    }
    const action = parseMenuId(component.customId)[1];
    try {
      if (action === "cancel") {
        collector.stop("cancel");
        await component.update({content:"Cancelled.", embeds:[], components:[]});
        return;
      }
      if (action === "section") {
        state.section = component.values?.[0] === "birthday" ? "birthday" : "timer";
        state.status = null;
        await component.update(render());
        return;
      }
      if (action === "home") {
        state.action = component.values?.[0];
        state.status = null;
        if (state.action === "add") {
          state.itemId = null;
          state.draft = defaultDraft(state.section);
          const submitted = await openTextModal(component);
          if (!submitted) {return;}
          state.page = "pickers";
          await submitted.update(render());
          return;
        }
        state.page = "pick";
        await component.update(render());
        return;
      }
      if (action === "pick") {
        const value = component.values?.[0];
        if (value === "none") {return;}
        const list = listFor(state.section);
        const item = list[Number(value)];
        if (!item) {return;}
        if (state.action === "delete") {
          if (state.section === "timer") {timers.deleteTimer("guild",guildId, item.timerId);}
          else {timers.deleteBirthdayCommand("guild",guildId, item.id);}
          state.status = `Deleted **${item.name}**.`;
          state.page = "home";
          await component.update(render());
          return;
        }
        state.itemId = item.timerId;
        state.draft = fromItem(state.section, item);
        const submitted = await openTextModal(component);
        if (!submitted) {return;}
        state.page = "pickers";
        await submitted.update(render());
        return;
      }
      if (action === "channel") {
        const value = component.values?.[0];
        state.draft.channelId = value && value !== "none" ? value : null;
        await component.update(render());
        return;
      }
      if (action === "enabled") {
        state.draft.enabled = component.values?.[0] === "on";
        await component.update(render());
        return;
      }
      if (action === "continue") {
        state.page = "review";
        await component.update(render());
        return;
      }
      if (action === "pickers") {
        state.page = "pickers";
        await component.update(render());
        return;
      }
      if (action === "text") {
        const submitted = await openTextModal(component);
        if (!submitted) {return;}
        await submitted.update(render());
        return;
      }
      if (action === "delete") {
        await component.deferUpdate();
        if (state.itemId) {
          if (state.section === "timer") {timers.deleteTimer("guild",guildId, state.itemId);}
          else {timers.deleteBirthdayCommand("guild",guildId, state.itemId);}
        }
        await interaction.editReply({content:"Item deleted.", embeds:[], components:[]});
        collector.stop("deleted");
        return;
      }
      if (action === "save") {
        await component.deferUpdate();
        const draft = state.draft;
        const payload = state.section === "timer"
          ? {
              name:draft.name,
              schedule:draft.schedule,
              message:draft.message,
              channelId:draft.channelId,
              timeZone:draft.timeZone || undefined,
              enabled:draft.enabled
            }
          : {
              name:draft.name,
              triggerText:draft.triggerText,
              dateFormat:draft.dateFormat,
              message:draft.message,
              channelId:draft.channelId,
              timeZone:draft.timeZone || undefined,
              enabled:draft.enabled
            };
        let saved = null;
        try {
          saved = state.itemId
            ? (state.section === "timer"
                ? timers.updateTimer("guild",guildId, state.itemId, payload)
                : timers.updateBirthdayCommand("guild",guildId, state.itemId, payload))
            : (state.section === "timer"
                ? timers.createTimer("guild",guildId, payload)
                : timers.createBirthdayCommand("guild",guildId, payload));
        } catch (error) {
          await interaction.editReply({content:`Could not save: ${error.message ?? error}`, embeds:[], components:[]});
          collector.stop("error");
          return;
        }
        if (!saved) {
          await interaction.editReply({content:"That item no longer exists. Nothing was saved.", embeds:[], components:[]});
          collector.stop("error");
          return;
        }
        await interaction.editReply({content:`Saved **${saved.name}**.`, embeds:[], components:[]});
        collector.stop("saved");
      }
    } catch (error) {
      log.error("Timer menu error:", error);
      await interaction.editReply({content:"The timer menu encountered an error. Nothing was saved.", embeds:[], components:[]}).catch(() => {});
      collector.stop("error");
    }
  });
  collector.on("end", async () => {await interaction.editReply({components:[]}).catch(() => {});});
}

async function handleAutopublish(interaction) {
  if (!interaction.guild) {await interaction.reply({content:"This command can only be used in a Discord server.", flags:discord.MessageFlags.Ephemeral}); return;}
  if (!await requireCommandAccess(interaction,"autopublish","setup")) {return;}
  const mode = interaction.options.getString("mode", true);

  if (mode === "list") {
    const channels = autopublish.getChannels(interaction.guild.id);
    const embed = new discord.EmbedBuilder().setTitle("Auto publish channels")
      .setDescription(channels.length ? channels.map(row => `${row.enabled ? "✅" : "❌"} <#${row.channelId}>`).join("\n") : "No announcement channels are configured.")
      .setTimestamp();
    await interaction.reply({embeds:[embed], flags:discord.MessageFlags.Ephemeral});
    return;
  }

  if (mode === "channel") {
    const channels = [...interaction.guild.channels.cache.values()]
      .filter(channel => channel.type === discord.ChannelType.GuildAnnouncement)
      .slice(0, 25);
    if (!channels.length) {await interaction.reply({content:"This server has no announcement channels.", flags:discord.MessageFlags.Ephemeral}); return;}
    const enabled = new Set(autopublish.list(interaction.guild.id).channels);
    const embed = new discord.EmbedBuilder().setTitle("Auto publish channels")
      .setDescription("Choose the announcement channels BargazBot should publish from.");
    const row = buildSelectRow(menuId("autopublish","channels"), channels.map(channel =>
      menuOption(channel.name, channel.id, enabled.has(channel.id) ? "Enabled" : "Disabled", enabled.has(channel.id))
    ), {placeholder:"Choose announcement channels", minValues:0, maxValues:Math.min(channels.length, 25)});

    await interaction.reply({embeds:[embed], components:[row], flags:discord.MessageFlags.Ephemeral});
    const message = await interaction.fetchReply();
    const collector = createCommandCollector(message, {time:300000});
    onCommandComponent(collector, async component => {
      if (component.user.id !== interaction.user.id) {await component.reply({content:"Only you can use this menu.", flags:discord.MessageFlags.Ephemeral}); return;}
      const selected = component.values ?? [];
      autopublish.clearAutopublish(interaction.guild.id);
      for (const channelId of selected) {autopublish.setChannel(interaction.guild.id, channelId, true);}
      await component.update({content:`Auto publish configured for ${selected.length} channel(s).`, embeds:[], components:[]});
      collector.stop("saved");
    });
    return;
  }

  await interaction.deferReply({flags:discord.MessageFlags.Ephemeral});
  const announcementChannels = [...interaction.guild.channels.cache.values()].filter(channel =>
    channel.type === discord.ChannelType.GuildAnnouncement &&
    channel.isTextBased() &&
    !channel.isThread()
  );
  autopublish.setAll(interaction.guild.id, true);
  for (const channel of announcementChannels) {
    autopublish.setChannel(interaction.guild.id, channel.id, true);
  }
  const result = await autopublish.publishAll(interaction.client, interaction.guild.id);
  await interaction.editReply({
    content:`Configured ${announcementChannels.length} announcement channel(s). Published ${result.published} message(s), ${result.failed} failed.`,
    flags:discord.MessageFlags.Ephemeral
  });
}

async function handleSetTimezone(interaction) {
  const isDm = !interaction.guild;
  const scopeKey = isDm ? interaction.user.id : interaction.guild.id;

  const currentValue = () => isDm
    ? (featureSettings.getUserDmSettings(scopeKey).timezone ?? "UTC")
    : (featureSettings.getGuildTimezone(scopeKey) ?? "UTC");

  const saveValue = value => isDm
    ? featureSettings.updateUserDmSetting(scopeKey, {timezone:value}, interaction.user.id)
    : featureSettings.setGuildTimezone(scopeKey, value);

  const requested = interaction.options.getString("timezone")?.trim();

  if (requested) {
    if (!isValidTimezone(requested)) {
      await interaction.reply({content:"That is not a valid IANA timezone name.", flags:discord.MessageFlags.Ephemeral});
      return;
    }
    saveValue(requested);
    await interaction.reply({content:`Timezone set to \`${requested}\`.`, flags:discord.MessageFlags.Ephemeral});
    return;
  }

  const current = currentValue();
  const label = isDm ? "Your BargazBot timezone" : "This server's BargazBot timezone";
  const embed = new discord.EmbedBuilder()
    .setTitle("BargazBot Timezone")
    .setDescription(`${label}: **${current}**\n\nTimers and birthdays use this timezone when the timer has no timezone of its own.`)
    .setTimestamp();

  const choices = dmTimezoneOptions(current === "UTC" ? null : current)
    .map(zone => menuOption(zone, zone, zone === current ? "Current" : ""));
  choices.push(menuOption("UTC (default)", "reset", "Reset to UTC"));

  await interaction.reply({
    embeds:[embed],
    components:[buildSelectRow(menuId("timezone", isDm ? "user" : "guild"), choices, {placeholder:"Choose a timezone"})],
    flags:discord.MessageFlags.Ephemeral
  });

  const message = await interaction.fetchReply();
  const collector = interaction.channel.createMessageComponentCollector({
    filter:item => item.user.id === interaction.user.id && item.message?.id === message.id,
    time:300000
  });

  onCommandComponent(collector, async component => {
    const choice = component.values?.[0];
    const value = choice === "reset" ? "UTC" : choice;
    if (!value || !isValidTimezone(value)) {
      await component.reply({content:"That is not a valid IANA timezone name.", flags:discord.MessageFlags.Ephemeral}).catch(() => {});
      return;
    }
    saveValue(value);
    await component.update({
      embeds:[new discord.EmbedBuilder()
        .setTitle("BargazBot Timezone")
        .setDescription(`${label}: **${value}**`)
        .setTimestamp()],
      components:[]
    });
  });
}

async function handleDm(interaction) {
  if (interaction.guild) {
    await interaction.reply({content:"This command can only be used in a DM with BargazBot.", flags:discord.MessageFlags.Ephemeral});
    return;
  }

  const userId = interaction.user.id;

  const render = (status = null) => {
    const settings = featureSettings.getUserDmSettings(userId);
    const embed = new discord.EmbedBuilder()
      .setTitle("BargazBot Direct Messages")
      .setDescription(
        (status ? `${status}\n\n` : "") +
        `DM Features: **${settings.dmEnabled ? "On" : "Off"}**\n` +
        `Notifications: **${settings.notificationsEnabled ? "On" : "Off"}**\n` +
        `Timers: **${settings.remindersEnabled ? "On" : "Off"}**`
      )
      .setTimestamp();

    return {
      embeds:[embed],
      components:[buildSelectRow(menuId("dm", "home"), [
        menuOption("DM Features", "dm", "Turn all DM features on or off"),
        menuOption("Notifications", "notifications", "Turn DM notifications and /entitlement on or off"),
        menuOption("Timers", "timers", "Turn DM timers on or off")
      ], {placeholder:"Choose a DM feature"})]
    };

  };

  await interaction.deferReply({flags:discord.MessageFlags.Ephemeral});
  await interaction.editReply(render());
  const message = await interaction.fetchReply();
  const collector = createCommandCollector(message, {time:300000});

  onCommandComponent(collector, async component => {
    if (component.user.id !== userId) {
      await component.reply({content:"Only you can use this menu.", flags:discord.MessageFlags.Ephemeral});
      return;
    }

    const choice = component.values?.[0];

    try {
      if (choice === "dm") {
        const current = featureSettings.getUserDmSettings(userId);
        featureSettings.updateUserDmSetting(userId, {dmEnabled:!current.dmEnabled}, userId);
        await component.update(render());
        return;
      }

      if (choice === "notifications") {
        const current = featureSettings.getUserDmSettings(userId);
        const enabled = !current.notificationsEnabled;
        featureSettings.updateUserDmSetting(userId, {notificationsEnabled:enabled}, userId);

        if (enabled) {
          const result = entitlements.autoAllocateDmEntitlements(userId);
          await component.update(render(`Notifications on.\n${result.message}`));
        } else {
          entitlements.removeDmEntitlements(userId);
          await component.update(render("Notifications off. Your DM entitlement allocation was removed."));
        }
        return;
      }

      if (choice === "timers") {
        const current = featureSettings.getUserDmSettings(userId);
        const enabled = !current.remindersEnabled;
        featureSettings.updateUserDmSetting(userId, {
          remindersEnabled:enabled,
          birthdaysEnabled:enabled
        }, userId);
        await component.update(render());
        return;
      }
    } catch (error) {
      log.error("DM menu error:", error);
      await component.reply({content:"The DM menu encountered an error.", flags:discord.MessageFlags.Ephemeral}).catch(() => {});
      collector.stop("error");
    }
  });

  collector.on("end", async () => {
    await interaction.editReply({components:[]}).catch(() => {});
  });
}
