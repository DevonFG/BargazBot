import * as discord       from "discord.js";
import * as log           from "./appLogger.js";
import * as guildLogger   from "./guildLogger.js";
import * as channelManager from "./channelManager.js";
import * as featureSettings from "./featureSettings.js";

function visibleChannels(guild, config) {
  if (config.channelIds?.length) {
    return config.channelIds.map(id => guild.channels.cache.get(id)).filter(channel =>
      channel?.isTextBased() && !channel.isThread()
    );
  }
  return [...guild.channels.cache.values()].filter(channel =>
    channel.isTextBased() && !channel.isThread()
  );
}

function everyoneDeny(config) {
  if (config.permissionPreset === "hidden") {return {ViewChannel:false, SendMessages:false};}
  if (config.permissionPreset === "view")   {return {ViewChannel:true, SendMessages:false};}
  return null;
}

export async function applyVerificationPermissions(guild, config = featureSettings.getVerificationConfig(guild.id), enabled = true) {
  const deny = everyoneDeny(config);
  const roleIds = [...new Set([config.roleId, ...(config.roleIds ?? [])].filter(Boolean))];
  let changed = 0;

  for (const channel of visibleChannels(guild, config)) {
    if (channel.id === config.botDetectionChannelId) {continue;}
    if (deny && channel.permissionOverwrites) {
      const value = enabled ? deny : {ViewChannel:null, SendMessages:null};
      await channel.permissionOverwrites.edit(guild.roles.everyone, value).catch(() => {});
      changed++;
    }
    for (const roleId of roleIds) {
      await channel.permissionOverwrites.edit(roleId, enabled
        ? {ViewChannel:true, SendMessages:true, ReadMessageHistory:true}
        : {ViewChannel:null, SendMessages:null, ReadMessageHistory:null}
      ).catch(() => {});
    }
  }
  return changed;
}

export async function setupVerification(guild, patch = {}) {
  const current = featureSettings.getVerificationConfig(guild.id);
  const next = {...current, ...patch};
  let roleId = next.roleId;

  if ((!roleId || roleId === "create") && (next.createRole !== false || roleId === "create")) {
    const role = await guild.roles.create({
      name:"Verified",
      color:0x57F287,
      permissions:[],
      reason:"BargazBot verification setup"
    });
    roleId = role.id;
  }

  if (next.botDetectionChannelId === "create" ||
      (patch.createBotDetectionChannel && !next.botDetectionChannelId)) {
    const channel = await channelManager.ensureNamedChannel(guild, "bot-detection", "bot-detection", {
      topic:"Post a message here to verify.",
      reason:"BargazBot verification setup",
      permissionOverwrites:[
        {id:guild.roles.everyone.id, allow:[
          discord.PermissionFlagsBits.ViewChannel,
          discord.PermissionFlagsBits.SendMessages,
          discord.PermissionFlagsBits.ReadMessageHistory
        ]}
      ]
    });
    next.botDetectionChannelId = channel.id;
    next.channelIds = [...new Set([...(next.channelIds ?? []), channel.id])];
    if (next.explainBot) {await sendBotDetectionMessage(guild);}
  }

  next.roleId = roleId;
  next.roleIds = [...new Set([...(next.roleIds ?? []), roleId].filter(Boolean))];
  featureSettings.updateVerificationConfig(guild.id, next, patch.actorId ?? null);

  if (next.mode === 2) {await applyVerificationPermissions(guild, next, true);}
  guildLogger.logCategoryEvent(guild, "verification", {
    title:"Verification configured",
    description:"BargazBot verification settings were updated.",
    fields:[
      {name:"Mode", value:String(next.mode), inline:true},
      {name:"Role", value:roleId ? `<@&${roleId}>` : "None", inline:true},
      {name:"Bot channel", value:next.botDetectionChannelId ? `<#${next.botDetectionChannelId}>` : "None", inline:true}
    ]
  }).catch(() => {});
  return next;
}

export function buildVerificationPayload(guild) {
  const config = featureSettings.getVerificationConfig(guild.id);
  const embed = new discord.EmbedBuilder()
    .setTitle("Verify with BargazBot")
    .setDescription(config.mode === 2
      ? "Use the button below to verify and unlock the server."
      : "Use the button below to receive the verification role.")
    .setColor(0x57F287)
    .setTimestamp();

  const button = new discord.ButtonBuilder()
    .setCustomId("verify:button")
    .setLabel("Verify")
    .setEmoji("✅")
    .setStyle(discord.ButtonStyle.Primary);

  return {
    embeds:[embed],
    components:[new discord.ActionRowBuilder().addComponents(button)],
    allowedMentions:{parse:[]},
    reactions:["✅"]
  };
}

export async function sendBotDetectionMessage(guild) {
  const channel = await channelManager.getChannel(guild, "bot-detection");
  if (!channel) {return false;}
  const config = featureSettings.getVerificationConfig(guild.id);
  await channel.send({
    content:"This channel is used to detect unverified users. Posting here will trigger the configured verification action.",
    allowedMentions:{parse:[]}
  }).catch(error => log.warn("Verification notice failed:", guild.id, error));
  return Boolean(config.botDetectionChannelId);
}

export async function verifyMember(client, guild, member, options = {}) {
  const config = featureSettings.getVerificationConfig(guild.id);
  if (!config.roleId) {return {success:false, reason:"not-configured"};}

  const roleIds = [...new Set([config.roleId, ...(config.roleIds ?? [])].filter(Boolean))];
  for (const roleId of roleIds) {
    await member.roles.add(roleId, "BargazBot verification").catch(error =>
      log.warn("Verification role add failed:", guild.id, member.id, error)
    );
  }

  const detection = await channelManager.getChannel(guild, "bot-detection");
  if (config.hideAfterVerify && detection) {
    await detection.permissionOverwrites.edit(member.id, {ViewChannel:false}).catch(() => {});
  }
  if (config.deleteTriggerMessage && options.triggerMessageId && detection) {
    await detection.messages.fetch(options.triggerMessageId)
      .then(message => message.delete().catch(() => {}))
      .catch(() => {});
  }

  guildLogger.logCategoryEvent(guild, "verification", {
    title:"Member verified",
    description:`${member.user} completed verification.`,
    user:member.user,
    fields:[{name:"Roles", value:roleIds.map(id => `<@&${id}>`).join(", "), inline:false}]
  }).catch(() => {});
  return {success:true, roleIds};
}

export async function handleBotDetectionMessage(client, message) {
  const guild = message.guild;
  if (!guild || message.author.bot) {return false;}
  if (!featureSettings.isFeatureEnabled(guild.id, "verification")) {return false;}

  const config = featureSettings.getVerificationConfig(guild.id);
  const channel = await channelManager.getChannel(guild, "bot-detection");
  if (!channel || channel.id !== message.channelId) {return false;}

  const member = message.member ?? await guild.members.fetch(message.author.id).catch(() => null);
  if (!member) {return false;}

  if (config.botAction === "ban") {
    await member.ban({reason:"BargazBot bot-detection channel"}).catch(() => {});
  } else {
    await member.kick("BargazBot bot-detection channel").catch(() => {});
  }
  if (config.deleteTriggerMessage) {await message.delete().catch(() => {});}

  guildLogger.logModerationAction(guild, {
    title:"Verification bot detection",
    description:`${message.author} used the bot-detection channel.`,
    user:message.author,
    fields:[
      {name:"Action", value:config.botAction ?? "kick", inline:true},
      {name:"Channel", value:`<#${channel.id}>`, inline:true}
    ]
  }).catch(() => {});
  return true;
}

export async function handleComponent(interaction) {
  if (interaction.customId !== "verify:button") {return false;}
  if (!interaction.guild) {return false;}
  const member = interaction.guild.members.cache.get(interaction.user.id) ??
    await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {return false;}

  await interaction.deferReply({flags:discord.MessageFlags.Ephemeral});
  const result = await verifyMember(interaction.client, interaction.guild, member, {
    triggerMessageId:interaction.message?.id
  });
  await interaction.editReply({content:result.success ? "You are verified." : "Verification is not configured yet."});
  return result.success;
}

export async function disableVerification(guild) {
  const config = featureSettings.getVerificationConfig(guild.id);
  await applyVerificationPermissions(guild, config, false);
  const detection = await channelManager.getChannel(guild, "bot-detection");
  if (detection) {
    await detection.permissionOverwrites.edit(guild.roles.everyone, {ViewChannel:null, SendMessages:null}).catch(() => {});
  }
  return true;
}
