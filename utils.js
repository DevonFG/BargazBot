import * as discord from "discord.js";

// Sleep function for adding delays when needed
export function sleep(ms) {return new Promise(resolve => setTimeout(resolve, ms));}

// Creates a new timestamp of the current time
export function newTimestamp() {return new Date().toISOString();}

// Converts a JavaScript date object into a readable format
// e.g. "March 21 2026, 9:45 PM PDT"
export function formatTimestamp(date) {return date.toLocaleString("en-US", {month:"long",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit",hour12:true,timeZoneName:"short"});}

// Converts normal text into Discord strikethrough format
export function strikethroughText(text) {return `~~${text}~~`;}

const DISCORD_LIMITS = {customId:100,label:100,value:100,description:100,placeholder:150,options:25,buttons:5};

function clipText(value, max) {return String(value ?? "").slice(0, max);}

// Builds a consistent custom ID, e.g. menuId("notification", "edit", channelId)
export function menuId(...parts) {return clipText(parts.map(part => String(part ?? "").trim()).filter(Boolean).join(":"),DISCORD_LIMITS.customId);}

// Splits a custom ID back into its parts for routing
export function parseMenuId(customId) {return String(customId ?? "").split(":");}

// Builds one select option with Discord's length limits applied
export function menuOption(label, value, description = "", isDefault = false) {
  const option = {label:   clipText(label || "Option", DISCORD_LIMITS.label),value:   clipText(value || "option", DISCORD_LIMITS.value),default: Boolean(isDefault)};
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
  return new discord.ActionRowBuilder().addComponents(new discord.StringSelectMenuBuilder().setCustomId(clipText(customId, DISCORD_LIMITS.customId)).setPlaceholder(clipText(config.placeholder || "Choose an option", DISCORD_LIMITS.placeholder)).setMinValues(minValues).setMaxValues(maxValues).setDisabled(Boolean(config.disabled)).addOptions(choices));
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
  const styles = {primary:discord.ButtonStyle.Primary,secondary: discord.ButtonStyle.Secondary,success:discord.ButtonStyle.Success,danger:discord.ButtonStyle.Danger,link:discord.ButtonStyle.Link};
  const components = (buttons ?? []).slice(0, DISCORD_LIMITS.buttons).map((button, index) => {
    const style = typeof button.style === "number" ? button.style : (styles[button.style] ?? discord.ButtonStyle.Secondary);
    const builder = new discord.ButtonBuilder().setStyle(style);
    if (style === discord.ButtonStyle.Link){builder.setURL(button.url);} else {builder.setCustomId(clipText(button.customId || menuId("button", index), DISCORD_LIMITS.customId));}
    if (button.label){builder.setLabel(clipText(button.label, DISCORD_LIMITS.label));}
    if (button.emoji){builder.setEmoji(button.emoji);}
    if (button.disabled){builder.setDisabled(true);}
    return builder;
  });
  return new discord.ActionRowBuilder().addComponents(...components);
}