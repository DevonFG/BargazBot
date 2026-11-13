import * as discord          from "discord.js";
import * as channelManager   from "./channelManager.js";
import {createLogger}        from "bargaz/logging.js";
import {isShutdownRequested} from "bargaz/shutdownCoordinator.js";
import {trackBotCallback}    from "./lifecycle.js";
import {getDB, closeDB, initDB}         from "./storage.js";
import {DB_BACKUP_DIR, DB_DIR, DB_PATH} from "./config.js";
import * as permissions      from "./permissions.js";
import * as notifications    from "./notifications.js";
import * as entitlements     from "./entitlements.js";
import fs                    from "node:fs";
import path                  from "node:path";
import Database              from "better-sqlite3";

const logging = createLogger({
  EmbedBuilder: discord.EmbedBuilder,
  getDB,
  getChannel: channelManager.getChannel
});

const commandCollectors = new Set();

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

// Adds supported creator platforms plus an all-platforms entry
// option = SlashCommandStringOption
function addAllPlatformChoices(option) {
  return option.addChoices(
    {name: "All platforms", value: "all"},
    {name: "YouTube",       value: "youtube"},
    {name: "Twitch",        value: "twitch"},
    {name: "Kick",          value: "kick"}
  );
}

const commands = [
  new discord.SlashCommandBuilder()
    .setName("ping")
    .setDescription("Checks whether BargazBot is responding."),
  new discord.SlashCommandBuilder()
    .setName("help")
    .setDescription("Shows information about BargazBot's commands.")
    .addStringOption(option => option
      .setName("command")
      .setDescription("A command to describe in detail.")
      .setRequired(false)
    ),
  //===================================================
  // Creator Notifications
  //===================================================
  new discord.SlashCommandBuilder()
    .setName("notification")
    .setDescription("Manage creator notifications.")
    .addSubcommand(subcommand =>
      subcommand
        .setName("add")
        .setDescription("Add a creator notification.")
        .addStringOption(option =>
          addPlatformChoices(option
            .setName("platform")
            .setDescription("The creator's platform.")
            .setRequired(true)
          )
        )
        .addStringOption(option => option
          .setName("creator")
          .setDescription("The creator's channel URL, handle, or username.")
          .setRequired(true)
        )
        .addStringOption(option => option
          .setName("nickname")
          .setDescription("A nickname used to manage this notification.")
          .setRequired(true)
        )
        .addChannelOption(option => option
          .setName("channel")
          .setDescription("The Discord channel where notifications will be sent.")
          .setRequired(false)
          .addChannelTypes(discord.ChannelType.GuildText, discord.ChannelType.GuildAnnouncement)
        )
        .addStringOption(option => option
          .setName("message")
          .setDescription("Optional custom message sent with this creator's notifications.")
          .setRequired(false)
          .setMaxLength(2000)
        )
    )
    .addSubcommand(subcommand => subcommand
      .setName("delete")
      .setDescription("Delete a creator notification.")
      .addStringOption(option =>
        addPlatformChoices(option
          .setName("platform")
          .setDescription("The notification's platform.")
          .setRequired(true)
        )
      )
      .addStringOption(option => option
        .setName("nickname")
        .setDescription("The notification nickname.")
        .setRequired(true)
      )
    )
    .addSubcommand(subcommand => subcommand
      .setName("edit")
      .setDescription("Rename a creator notification.")
      .addStringOption(option =>
        addPlatformChoices(option
          .setName("platform")
          .setDescription("The notification's platform.")
          .setRequired(true)
        )
      )
      .addStringOption(option => option
        .setName("nickname")
        .setDescription("The notification's current nickname.")
        .setRequired(true)
      )
      .addStringOption(option => option
        .setName("new-nickname")
        .setDescription("The new nickname.")
        .setRequired(true)
      )
    )
    .addSubcommand(subcommand => subcommand
      .setName("message")
      .setDescription("Configure a creator's notification message.")
      .addStringOption(option => addPlatformChoices(option
        .setName("platform")
        .setDescription("The notification's platform.")
        .setRequired(true)
      ))
      .addStringOption(option => option
        .setName("nickname")
        .setDescription("The notification nickname.")
        .setRequired(true)
      )
      .addStringOption(option => option
        .setName("message")
        .setDescription("Custom message, or leave blank to restore the default.")
        .setRequired(false)
        .setMaxLength(2000)
      )
    )
    .addSubcommand(subcommand => subcommand
      .setName("channel")
      .setDescription("Change a creator notification's destination channel.")
      .addStringOption(option => addPlatformChoices(option
        .setName("platform")
        .setDescription("The notification's platform.")
        .setRequired(true)
      ))
      .addStringOption(option => option
        .setName("nickname")
        .setDescription("The notification nickname.")
        .setRequired(true)
      )
      .addChannelOption(option =>option
        .setName("channel")
        .setDescription("The Discord channel where notifications will be sent.")
        .setRequired(true)
        .addChannelTypes(discord.ChannelType.GuildText, discord.ChannelType.GuildAnnouncement)
      )
    )
    .addSubcommand(subcommand => subcommand
      .setName("refresh")
      .setDescription("Refresh information for a creator notification.")
      .addStringOption(option => addPlatformChoices(option
        .setName("platform")
        .setDescription("The notification's platform.")
        .setRequired(true)
      ))
      .addStringOption(option => option
        .setName("nickname")
        .setDescription("The notification nickname.")
        .setRequired(true)
      )
    )
    .addSubcommand(subcommand => subcommand
      .setName("list")
      .setDescription("List this server's creator notifications.")
      .addStringOption(option => addPlatformChoices(option
        .setName("platform")
        .setDescription("Only show notifications from one platform.")
        .setRequired(false)
      ))
    ),
  
  //===================================================
  // Channel Configuration
  //===================================================
  new discord.SlashCommandBuilder()
    .setName("channels")
    .setDescription("Configure the channels used by BargazBot.")
    .addSubcommand(subcommand => subcommand
      .setName("set")
      .setDescription("Change the channel used by a feature.")
      .addStringOption(option => option
        .setName("purpose")
        .setDescription("The feature to configure.")
        .setRequired(true)
        .addChoices(
          {name:"Creator notification fallback", value:"notifications"},
          {name:"Welcome messages",              value:"welcome"},
          {name:"Goodbye messages",              value:"goodbye"},
          {name:"Server logs",                   value:"logs"},
          {name:"BargazBot updates",             value:"updates"},
          {name:"BargazBot status",              value:"status"}
        )
      )
      .addChannelOption(option => option
        .setName("channel")
        .setDescription("The channel to use for this feature.")
        .addChannelTypes(discord.ChannelType.GuildText, discord.ChannelType.GuildAnnouncement)
        .setRequired(true)
      )
    )
    .addSubcommand(subcommand => subcommand
      .setName("list")
      .setDescription("Show the channels currently used by BargazBot.")
    ),

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
          {name:"This server", value:"server"}
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
      .setDescription("Restore this server or the whole database from a backup.")
      .addStringOption(option => option
        .setName("scope")
        .setDescription("Which data to restore.")
        .setRequired(true)
        .addChoices(
          {name:"This server", value:"guild"},
          {name:"All servers", value:"all"}
        )
      )
    ),

  //===================================================
  // Entitlements
  //===================================================
  new discord.SlashCommandBuilder()
    .setName("entitlement")
    .setDescription("Manage your BargazBot entitlement allocation.")
    .addSubcommand(subcommand => subcommand
      .setName("allocate")
      .setDescription("Allocate some of your entitlement to this server.")
      .addStringOption(option => addAllPlatformChoices(option
        .setName("platform")
        .setDescription("The platform to allocate, or all platforms.")
        .setRequired(true)
      ))
      .addStringOption(option => option
        .setName("limit")
        .setDescription('The number of notifications to allocate, or "unlimited".')
        .setRequired(true)
      )
    )
    .addSubcommand(subcommand =>subcommand
      .setName("remove")
      .setDescription("Remove your allocation for a platform from this server.")
      .addStringOption(option => addAllPlatformChoices(option
        .setName("platform")
        .setDescription("The platform allocation to remove, or all platforms.")
        .setRequired(true)
      ))
    )
    .addSubcommand(subcommand => subcommand
      .setName("view")
      .setDescription("View your entitlements and allocations for this server.")
    ),
  //===================================================
  // Permissions
  //===================================================
    new discord.SlashCommandBuilder()
      .setName("permissions")
      .setDescription("Manage access to BargazBot commands.")
      .addSubcommand(subcommand => subcommand
        .setName("add")
        .setDescription("Grant a user or role access to BargazBot.")
        .addMentionableOption(option => option
          .setName("target")
          .setDescription("The user or role to authorize.")
          .setRequired(false))
        .addBooleanOption(option => option
          .setName("everyone")
          .setDescription("Authorize the @everyone role instead.")
          .setRequired(false)))
      .addSubcommand(subcommand => subcommand
        .setName("edit")
        .setDescription("Edit an existing user or role permission profile.")
        .addMentionableOption(option => option
          .setName("target")
          .setDescription("The user or role to edit.")
          .setRequired(false))
        .addBooleanOption(option => option
          .setName("everyone")
          .setDescription("Edit the @everyone role instead.")
          .setRequired(false)))
      .addSubcommand(subcommand => subcommand
        .setName("remove")
        .setDescription("Remove an explicitly assigned user or role permission.")
        .addMentionableOption(option => option
          .setName("target")
          .setDescription("The user or role to remove.")
          .setRequired(true)))
      .addSubcommand(subcommand => subcommand
        .setName("list")
        .setDescription("View inherited, assigned, and public BargazBot permissions."))
];

// Registers BargazBot's slash commands with Discord
// client = Discord Client
export async function registerCommands(client) {
  const commandData = commands.map(command => command.toJSON());
  await client.application.commands.set(commandData);
  console.log(`Registered ${commandData.length} BargazBot commands.`);
}

// Registers BargazBot's slash commands with Discord
// client = Discord Client
export async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) {return;}
  try {
    if (interaction.guild) {channelManager.ensureGuildData(interaction.guild);}
    entitlements.ensureUser(interaction.user);
    switch (interaction.commandName) {
      case "ping":         await handlePing(interaction); break;
      case "help":         await handleHelp(interaction); break;
      case "channels":     await handleChannels(interaction); break;
      case "logging":      await handleLogging(interaction); break;
      case "data":         await handleData(interaction); break;
      case "entitlement":  await handleEntitlement(interaction); break;
      case "permissions":  await handlePermissions(interaction); break;
      case "notification": await handleNotification(interaction); break;
      default: await interaction.reply({content: "BargazBot does not recognize this command.", flags: discord.MessageFlags.Ephemeral});
    }
    if (interaction.guild) {await logging.logCommand(interaction);}
  } catch (error) {
    console.error(`Error handling /${interaction.commandName}:`,error);
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

// Routes channel commands after checking individual access
// interaction = ChatInputCommandInteraction
async function handleChannels(interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (!await requireCommandAccess(interaction, "channels", subcommand)) {return;}
  switch (subcommand) {
    case "set": await handleChannelSet(interaction); break;
    case "list": await handleChannelList(interaction); break;
  }
}

// Sets a server channel for a BargazBot feature
// interaction = ChatInputCommandInteraction
async function handleChannelSet(interaction) {
  const purpose = interaction.options.getString("purpose", true);
  const channel = interaction.options.getChannel("channel", true);
  channelManager.setChannel(interaction.guild.id, purpose, channel.id);
  await logging.logConfigurationChange(interaction.guild,{
    user:interaction.user,
    title:"BargazBot Channel Changed",
    description:`${interaction.user} changed a BargazBot channel setting.`,
    fields: [
        {name:"Purpose",     value:purpose,      inline:true},
        {name:"New Channel", value:`${channel}`, inline: true}
      ]
  });
  await interaction.reply({content:`The **${purpose}** channel has been changed to ${channel}.`, flags:discord.MessageFlags.Ephemeral});
}

// Displays the server's configured BargazBot channels
// interaction = ChatInputCommandInteraction
async function handleChannelList(interaction) {
  const settings = channelManager.getChannelAssignments(interaction.guild.id);
  const formatChannel = channelId => channelId? `<#${channelId}>` : "Not configured";
  const embed =
    new discord.EmbedBuilder()
      .setTitle("BargazBot Channels")
      .addFields(
        {name:"Creator notification fallback", value:formatChannel(settings?.announcement_channel_id)},
        {name:"Welcome messages",              value:formatChannel(settings?.welcome_channel_id)},
        {name:"Goodbye messages",              value:formatChannel(settings?.goodbye_channel_id)},
        {name:"Server logs",                   value:formatChannel(settings?.logs_channel_id)},
        {name:"BargazBot Updates",             value:formatChannel(settings?.updates_channel_id)},
        {name:"Status",                        value:formatChannel(settings?.status_channel_id)}
      )
      .setTimestamp();
  await interaction.reply({embeds: [embed], flags:discord.MessageFlags.Ephemeral});
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
    {name:`Permission profiles (${snapshot.profiles.length})`, value: formatDataList(snapshot.profiles, row => `${formatGuildName(client, row.guild_id)}: ${row.access_level}`), inline:false}
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
      `Permission profiles: **${snapshot.profiles.length}**`
    ].join("\n"))
    .addFields({name:"What happens next", value:"Anything you allocated to a server is withdrawn. Your user id is then kept for **24 hours** so it is not immediately re-collected."})
    .setFooter({text:"This does not delete anything about other people. Backups keep older copies until they rotate."});
}

// Deletes one member's data and starts the 24 hour suppression window
function deleteUserData(userId) {
  const db = getDB();

  db.transaction(() => {
    db.prepare("DELETE FROM guild_permissions WHERE permission_type = 'user' AND target_id = ?").run(userId);
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
  if (interaction.options.getString("scope") === "server") {await handleDataServerDelete(interaction); return;}
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

// Restores one server, or the whole database, from a rotated backup
async function handleDataRestore(interaction) {
  const scope = interaction.options.getString("scope", true);

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

// Routes entitlement commands after checking individual access
// interaction = ChatInputCommandInteraction
async function handleEntitlement(interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (!await requireCommandAccess(interaction, "entitlement", subcommand)) {return;}
  switch (subcommand) {
    case "allocate": await handleEntitlementAllocate(interaction); break;
    case "remove": await handleEntitlementRemove(interaction); break;
    case "view": await handleEntitlementView(interaction); break;
  }
}

// Allocates a user's notification entitlement to the server
// interaction = ChatInputCommandInteraction
async function handleEntitlementAllocate(interaction) {
  const selection = interaction.options.getString("platform", true);
  const platforms = selection === "all" ? ["youtube", "twitch", "kick"] : [selection];
  const limitInput = interaction.options
    .getString("limit",true)
    .trim()
    .toLowerCase();
  let amount;

  if (limitInput === "unlimited") {amount = null;} else {
    amount = Number(limitInput);
    if (!Number.isInteger(amount) || amount < 0) {
      await interaction.reply({
        content:'The limit must be a whole number of 0 or greater, or the word **unlimited**.',
        flags:discord.MessageFlags.Ephemeral
      });
      return;
    }
  }

  const lines = [];

  for (const platform of platforms) {
    const result = entitlements.setAllocation(interaction.user.id, interaction.guild.id, platform, amount);

    if (!result.success) {
      let message;
      switch (result.reason) {
        case "no-entitlement":      message = "you do not currently have a BargazBot entitlement for this platform."; break;
        case "not-unlimited":       message = "your entitlement is not unlimited, so you cannot allocate unlimited capacity."; break;
        case "exceeds-entitlement": message = `that allocation exceeds your available entitlement. You can currently allocate up to **${result.available}** more to this server.`; break;
        case "allocation-conflict": message = "your existing allocations conflict with this entitlement. Please review your allocations."; break;
        default:                    message = "BargazBot could not update that entitlement allocation.";
      }
      lines.push(`**${notifications.getPlatformName(platform)}**: ${message}`);
      continue;
    }

    lines.push(result.unlimited
      ? `Allocated **unlimited ${notifications.getPlatformName(platform)}** creator-notification capacity to this server.`
      : `Allocated **${result.amount} ${notifications.getPlatformName(platform)}** creator-notification slot${result.amount === 1 ? "" : "s"} to this server.`);
  }

  await interaction.reply({content: lines.join("\n"), flags:discord.MessageFlags.Ephemeral});
}

// Removes a user's platform entitlement allocation from the server
// interaction = ChatInputCommandInteraction
async function handleEntitlementRemove(interaction) {
  const selection = interaction.options.getString("platform", true);
  const platforms = selection === "all" ? ["youtube", "twitch", "kick"] : [selection];

  const lines = platforms.map(platform => {
    const removed = entitlements.removeAllocation(interaction.user.id, interaction.guild.id, platform);

    return removed
      ? `Your ${notifications.getPlatformName(platform)} allocation to this server has been set to **0**.`
      : `You did not have an entitlement allocation for ${notifications.getPlatformName(platform)} in this server.`;
  });

  await interaction.reply({content: lines.join("\n"), flags:discord.MessageFlags.Ephemeral});
}

// Displays a user's entitlements and server allocations
// interaction = ChatInputCommandInteraction
async function handleEntitlementView(interaction) {
  const summary = entitlements.getAllocationSummary(interaction.user.id, interaction.guild.id);
  if (!summary.entitlements) {await interaction.reply({content:"You do not currently have a BargazBot entitlement record.", flags:discord.MessageFlags.Ephemeral}); return;}
  const formatEntitlement = value => value === null ? "Unlimited" : String(value);
  const formatAllocation  = value => value === null ? "Unlimited" : String(value ?? 0);
  const allocation = summary.allocation ?? {};
  const embed =
    new discord.EmbedBuilder()
      .setTitle("Your BargazBot Entitlements")
      .setDescription("Entitlements are your total capacity. Allocations are the capacity you have contributed to this server.")
      .addFields(
        { name: "YouTube",
          value:`Entitlement: **${formatEntitlement(summary.entitlements.youtube_limit)}**\n` + `This server: **${formatAllocation(allocation.youtube_limit)}**`,
          inline: true },
        { name: "Twitch",
          value: `Entitlement: **${formatEntitlement(summary.entitlements.twitch_limit)}**\n` + `This server: **${formatAllocation(allocation.twitch_limit)}**`,
          inline: true },
        { name: "Kick", 
          value:`Entitlement: **${formatEntitlement(summary.entitlements.kick_limit)}**\n` + `This server: **${formatAllocation(allocation.kick_limit)}**`,
          inline: true }
      )
      .setTimestamp();
  await interaction.reply({embeds: [embed], flags:discord.MessageFlags.Ephemeral});
}

// Formats a permission target for Discord
// type = String, "user" or "role"
// id = String, Discord ID
function permissionTargetMention(type, id) {return type === permissions.PERMISSION_TYPES.ROLE ? `<@&${id}>` : `<@${id}>`;}

// Retrieves a user or role selected for permission management
// interaction = ChatInputCommandInteraction
function getPermissionTarget(interaction) {
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
async function handlePermissions(interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (!await requireCommandAccess(interaction, "permissions", subcommand)) {return;}
  switch (subcommand) {
    case "add":    await handlePermissionEditor(interaction, false); break;
    case "edit":   await handlePermissionEditor(interaction, true); break;
    case "remove": await handlePermissionRemove(interaction); break;
    case "list":   await handlePermissionList(interaction); break;
  }
}

// Opens an interactive editor for a user or role
// interaction = ChatInputCommandInteraction
// editing = Boolean, true for edit and false for add
async function handlePermissionEditor(interaction, editing) {
  const target = getPermissionTarget(interaction);
  if (target.error) {await interaction.reply({content: target.error, flags: discord.MessageFlags.Ephemeral}); return;}
  const original = permissions.getPermissionProfile(interaction.guild.id, target.type, target.id);
  if (editing && !original) {await interaction.reply({content: `${target.mention} does not have an explicit permission profile. Use \`/permissions add\` first.`, flags: discord.MessageFlags.Ephemeral}); return;}
  if (!editing && original) {await interaction.reply({content: `${target.mention} already has a permission profile. Use \`/permissions edit\` instead.`, flags: discord.MessageFlags.Ephemeral}); return;}
  let level          = original?.accessLevel ?? permissions.ACCESS_LEVELS.CONFIGURATION;
  let category       = "notification";
  let selected       = new Set(original?.commands ?? []);
  let canDeleteData  = Boolean(original?.canDeleteData);
  let reviewing      = false;
  await interaction.reply({...buildPermissionEditor(target, level, category, selected, canDeleteData), flags: discord.MessageFlags.Ephemeral});
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
  if (target.error)                                                                            {await interaction.reply({content: target.error, flags: discord.MessageFlags.Ephemeral}); return;}
  if (target.type === permissions.PERMISSION_TYPES.ROLE && target.id === interaction.guild.id) {await interaction.reply({content: "The @everyone permission profile cannot be removed. Use `/permissions edit` instead.", flags: discord.MessageFlags.Ephemeral}); return;}
  const original = permissions.getPermissionProfile(interaction.guild.id, target.type, target.id);
  if (!original) {await interaction.reply({content: `${target.mention} has no explicit permission profile to remove.`, flags: discord.MessageFlags.Ephemeral}); return;}
  const buttons = new discord.ActionRowBuilder().addComponents(
    new discord.ButtonBuilder().setCustomId("permission:remove-confirm").setLabel("Remove Permission").setStyle(discord.ButtonStyle.Danger),
    new discord.ButtonBuilder().setCustomId("permission:remove-cancel") .setLabel("Cancel").setStyle(discord.ButtonStyle.Secondary)
  );
  await interaction.reply({
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
  await interaction.deferReply({flags: discord.MessageFlags.Ephemeral});
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
  collector.on("end", async () => {await interaction.editReply({components: []}).catch(() => {});});
}

// Routes notification commands after checking individual access
// interaction = ChatInputCommandInteraction
async function handleNotification(interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (!await requireCommandAccess(interaction, "notification", subcommand)) {return;}
  switch (subcommand) {
    case "add":     await handleNotificationAdd(interaction); break;
    case "delete":  await handleNotificationDelete(interaction); break;
    case "edit":    await handleNotificationEdit(interaction); break;
    case "message": await handleNotificationMessage(interaction); break;
    case "channel": await handleNotificationChannel(interaction); break;
    case "refresh": await handleNotificationRefresh(interaction); break;
    case "list":    await handleNotificationList(interaction); break;
  }
}

// Adds a creator notification subscription to the server
// interaction = ChatInputCommandInteraction
async function handleNotificationAdd(interaction) {
  await interaction.deferReply({flags:discord.MessageFlags.Ephemeral});
  const platform            = interaction.options.getString("platform", true);
  const creator             = interaction.options.getString("creator", true);
  const nickname            = interaction.options.getString("nickname", true).trim();
  const notificationChannel = interaction.options.getChannel("channel");
  const customMessage       = interaction.options.getString("message");
  if (!nickname) {await interaction.editReply({content:"The notification nickname cannot be empty."}); return;}
  if (notifications.findGuildSubscription(interaction.guild.id, nickname, platform)) {
    await interaction.editReply({content:`A ${notifications.getPlatformName(platform)} notification already uses the nickname **${nickname}**.`}); return;
  }
  const result = await notifications.addSubscription(interaction.guild.id, platform, creator, nickname, notificationChannel ?.id ?? null, customMessage ?? null);
  if (!result.success) {if (result.reason === "already-exists") {await interaction.editReply({content:"This server is already following that creator on this platform."}); return;}
  if (result.reason === "entitlement-limit") {await interaction.editReply({content:
    `This server has used all of its ` +
    `${notifications.getPlatformName(platform)} creator notification limit ` +
    `(**${result.usage}/${result.limit}**). ` +
    `Use \`/entitlement allocate\` to add more capacity to this server.`
  }); return;}
  await interaction.editReply({content:`BargazBot could not find that ${notifications.getPlatformName(platform)} channel.`}); return;}
  const destination = notificationChannel ? `${notificationChannel}` : "the server's BargazBot notification channel";
  await interaction.editReply({
    content:
      `Added **${result.channel.channel_name}** on ` +
      `**${notifications.getPlatformName(platform)}** ` +
      `with the nickname **${nickname}**.\n` +
      `Destination: ${destination}\n` +
      `Message: ${customMessage ? "Custom" : "BargazBot default"}`
  });
}

// Deletes a creator notification subscription from the server
// interaction = ChatInputCommandInteraction
async function handleNotificationDelete(interaction) {
  const platform = interaction.options.getString("platform", true);
  const nickname = interaction.options.getString("nickname", true);
  const result   = notifications.deleteSubscription(interaction.guild.id, nickname, platform);
  if (!result.success) {
    await interaction.reply({content:`No ${notifications.getPlatformName(platform)} creator notification was found with the nickname **${nickname}**.`, 
    flags:discord.MessageFlags.Ephemeral
    }); return;
  }
  await interaction.reply({
    content:
      `Deleted the **${result.subscription.nickname}** ` +
      `${notifications.getPlatformName(result.subscription.platform)} notification.`,
    flags:discord.MessageFlags.Ephemeral
  });
}

// Changes the nickname of an existing creator notification
// interaction = ChatInputCommandInteraction
async function handleNotificationEdit(interaction) {
  const platform    = interaction.options.getString("platform", true);
  const nickname    = interaction.options.getString("nickname", true);
  const newNickname = interaction.options.getString("new-nickname", true).trim();
  if (!newNickname) {await interaction.reply({content:"The new nickname cannot be empty.", flags:discord.MessageFlags.Ephemeral}); return;}
  const current = notifications.findGuildSubscription(interaction.guild.id, nickname, platform);
  if (!current) {
    await interaction.reply({
      content:`No ${notifications.getPlatformName(platform)} notification was found with the nickname **${nickname}**.`,
      flags:discord.MessageFlags.Ephemeral
    }); return;
  }
  const duplicate = notifications.findGuildSubscription(interaction.guild.id, newNickname, platform);
  if (duplicate && duplicate.channelId !== current.channelId) {
    await interaction.reply({
      content:`A ${notifications.getPlatformName(platform)} notification already uses the nickname **${newNickname}**.`,
      flags:discord.MessageFlags.Ephemeral
    }); return;
  }
  const result = notifications.editSubscription(interaction.guild.id, nickname, platform, newNickname);
  if (!result.success) {
    await interaction.reply({content:result.reason === "nickname-exists"
      ? `A ${notifications.getPlatformName(platform)} notification already uses the nickname **${newNickname}**.`
      : `No ${notifications.getPlatformName(platform)} notification was found with the nickname **${nickname}**.`,
      flags:discord.MessageFlags.Ephemeral
    }); return;
  }
  await interaction.reply({content:`Changed the notification nickname from **${nickname}** to **${newNickname}**.`, flags:discord.MessageFlags.Ephemeral
  });
}

// Updates or resets a creator notification's custom message
// interaction = ChatInputCommandInteraction
async function handleNotificationMessage(interaction) {
  const platform      = interaction.options.getString("platform", true);
  const nickname      = interaction.options.getString("nickname", true);
  const customMessage = interaction.options.getString("message", false);
  const result        = notifications.setSubscriptionMessage(interaction.guild.id, nickname, platform, customMessage);
  if (!result.success) {await interaction.reply({
    content:`No ${notifications.getPlatformName(platform)} notification was found with the nickname **${nickname}**.`,
    flags:discord.MessageFlags.Ephemeral
  }); return;}
  await interaction.reply({content:customMessage === null
    ? `Restored **${nickname}** to BargazBot's default notification message.`
    : `Updated the custom notification message for **${nickname}**.`,
    flags:discord.MessageFlags.Ephemeral
  });
}

// Changes the destination channel for a creator notification
// interaction = ChatInputCommandInteraction
async function handleNotificationChannel(interaction) {
  const platform = interaction.options.getString("platform", true);
  const nickname = interaction.options.getString("nickname", true);
  const channel  = interaction.options.getChannel("channel", true);
  const result   = notifications.setSubscriptionChannel(interaction.guild.id, nickname, platform, channel.id);
  if (!result.success) {await interaction.reply({
    content:`No ${notifications.getPlatformName(platform)} notification was found with the nickname **${nickname}**.`,
    flags:  discord.MessageFlags.Ephemeral
  }); return;}          await interaction.reply({
    content:`Creator notifications for **${nickname}** will now be sent to ${channel}.`,
    flags:  discord.MessageFlags.Ephemeral
  });
}

// Requests a refresh of an existing creator notification
// interaction = ChatInputCommandInteraction

async function handleNotificationRefresh(interaction) {
  const platform = interaction.options.getString("platform",true);
  const nickname = interaction.options.getString("nickname",true);
  const platformName = notifications.getPlatformName(platform);
  await interaction.deferReply({flags:discord.MessageFlags.Ephemeral});
  try {
    const result = await notifications.refreshSubscription(interaction.client,interaction.guild.id,nickname,platform);
    if (!result.success) { let message;
      switch (result.reason) {
        case "not-found":                                                         message = `No ${platformName} notification was found with the nickname **${nickname}**.`; break;
        case "refresh-limit": { const retryAt = Math.ceil(result.retryAt / 1000); message = `You've reached the refresh limit for **${platformName}** (2 successful refreshes per 6 hours).\nYou can refresh again <t:${retryAt}:R>.`; break;}
        case "no-content":                                                        message = `No current content was found for **${nickname}** on ${platformName}. Your refresh allowance was not used.`; break;
        case "guild-unavailable":                                                 message = "BargazBot couldn't access this Discord server. Your refresh allowance was not used."; break;
        case "channel-unavailable":                                               message = "BargazBot couldn't access a notification channel to post the announcement. Your refresh allowance was not used."; break;
        case "refresh-error":                                                     message = `An error occurred while refreshing **${nickname}** on ${platformName}. Please try again later.`; break;
        default:                                                                  message = `Unable to refresh **${nickname}** on ${platformName}.`;
      }
      await interaction.editReply({content:message}); return;
    }
    const content = result.content;
    const remaining = result.remaining;
    const contentName = content.title || "Untitled content";
    await interaction.editReply({
      content:
        `Successfully refreshed **${result.subscription.nickname}** on **${platformName}**.\n` +
        `**Content:** ${contentName}\n` +
        `**Type:** ${content.contentType || "content"}\n` +
        `**Remaining refreshes:** ${remaining} of 2 for ${platformName}.\n` +
        `The notification was posted successfully.`
    });
  } catch (error) {console.error("Notification refresh command failed:",error); await interaction.editReply({content:"An unexpected error occurred while processing the refresh command."});}
}


// Displays the server's configured creator notifications
// interaction = ChatInputCommandInteraction
async function handleNotificationList(interaction) {
  const platform      = interaction.options.getString("platform", false);
  const subscriptions = notifications.getGuildSubscriptions(interaction.guild.id, platform);
  if (!subscriptions.length) {await interaction.reply({
    content: platform ? `No ${notifications.getPlatformName(platform)} creator notifications are configured for this server.` : "No creator notifications are configured for this server.",
    flags:   discord.MessageFlags.Ephemeral
  }); return;}
  const lines =
    subscriptions.map(subscription => {
        const destination = subscription.discordChannelId ? `<#${subscription.discordChannelId}>` : "Default/fallback channel";
        const messageMode = subscription.customMessage ? "Custom message" : "Default message";
        return (
          `**${subscription.nickname}** — ` + `${notifications.getPlatformName(subscription.platform)}\n` +
          `${subscription.channelName}\n`   + `Destination: ${destination} • ${messageMode}`
        );
      }
    );
  const chunks = []; let current = "";
  for (const line of lines) {
    const safeLine = line.slice(0,3900);
    const candidate = current ? `${current}\n\n${safeLine}` : safeLine;
    if (candidate.length > 3900) {if (current) {chunks.push(current);} current = safeLine;} else {current = candidate;}
  }
  if (current) {chunks.push(current);}
  const embeds = chunks.map((description, index) => new discord.EmbedBuilder()
    .setTitle(index === 0 ? "Creator Notifications" : `Creator Notifications (${index + 1})`)
    .setDescription(description)
    .setTimestamp()
  );
  await interaction.reply({embeds, flags:discord.MessageFlags.Ephemeral});
}
