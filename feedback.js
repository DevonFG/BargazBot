import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import * as discord from "discord.js";
import * as log from "./appLogger.js";
import { getDB } from "./storage.js";

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "donotreply@bargaz.app";

const SHORTCODES = {
  bug: "🐛",
  sparkles: "✨",
  bulb: "💡",
  warning: "⚠️",
  rocket: "🚀",
  heart: "❤️",
  tada: "🎉",
  eyes: "👀"
};

const FEEDBACK_CATEGORIES = [
  {value: "bug",        label: "Bug Report",     description: "Something is broken"},
  {value: "suggestion", label: "Suggestion",     description: "An idea to improve Bargaz"},
  {value: "question",   label: "Question",       description: "Ask the team something"},
  {value: "other",      label: "Something Else", description: "Anything else"}
];

const CATEGORY_EMOJI = {
  bug: "🐛",
  suggestion: "💡",
  question: "❓",
  other: "✉️"
};

let client = null;

const config = {
  forumId: process.env.FEEDBACK_FORUM_ID || "",
  dataFile: process.env.FEEDBACK_DATA_FILE || path.join(process.cwd(), "data", "feedback.json"),
  baseUrl: (process.env.FEEDBACK_BASE_URL || "https://bargaz.app").replace(/\/$/, ""),
  resendApiKey: process.env.RESEND_API_KEY || "",
  from: process.env.FEEDBACK_FROM_EMAIL || DEFAULT_FROM
};

/*
=====================================================
Storage
=====================================================
*/

function ensureFeedbackTables() {
  const db = getDB();
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      user_id TEXT,
      guild_id TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      thread_id TEXT,
      reply_method TEXT NOT NULL DEFAULT 'email',
      email TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const columns = db.prepare("PRAGMA table_info(feedback_submissions)").all().map(column => column.name);
  if (!columns.includes("reply_method")) {
    db.exec("ALTER TABLE feedback_submissions ADD COLUMN reply_method TEXT NOT NULL DEFAULT 'email'");
  }
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(config.dataFile, "utf8"));
    return {
      subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : []
    };
  } catch (error) {
    if (error.code !== "ENOENT") {log.error("BargazBot unable to read feedback store:", error);}
    return {subscriptions: []};
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(config.dataFile), {recursive: true});
  const temp = `${config.dataFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2));
  fs.renameSync(temp, config.dataFile);
}

function createSubmission(data) {
  ensureFeedbackTables();
  const token = crypto.randomUUID();
  const result = getDB().prepare(`
    INSERT INTO feedback_submissions (
      token, user_id, guild_id, title, content, thread_id, reply_method, email, active, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
  `).run(
    token,
    data.userId ?? null,
    data.guildId ?? null,
    data.title,
    data.content,
    data.threadId ?? null,
    data.replyMethod ?? "email",
    data.email ?? null
  );
  log.info("BargazBot feedback submission recorded:", result.lastInsertRowid, data.replyMethod ?? "email");
  return {id: Number(result.lastInsertRowid), token};
}

function getSubmissionsByThread(threadId) {
  ensureFeedbackTables();
  return getDB().prepare(`
    SELECT * FROM feedback_submissions
    WHERE thread_id = ? AND active = 1
  `).all(threadId);
}

function getActiveDmSubmission(userId) {
  ensureFeedbackTables();
  return getDB().prepare(`
    SELECT * FROM feedback_submissions
    WHERE user_id = ? AND reply_method = 'dm' AND active = 1
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId) ?? null;
}

function closeDmSubmission(userId) {
  ensureFeedbackTables();
  getDB().prepare(`
    UPDATE feedback_submissions
    SET active = 0
    WHERE user_id = ? AND reply_method = 'dm' AND active = 1
  `).run(userId);
  log.info("BargazBot feedback DM conversation closed:", userId);
}

export function clearFeedbackDmData(userId) {
  if (!userId) {return;}
  ensureFeedbackTables();
  getDB().prepare(`
    UPDATE feedback_submissions
    SET active = 0, thread_id = NULL
    WHERE user_id = ? AND reply_method = 'dm'
  `).run(userId);
  log.info("BargazBot feedback DM data cleared:", userId);
}

/*
=====================================================
Discord Helpers
=====================================================
*/

export function initFeedback(discordClient) {
  client = discordClient;
  ensureFeedbackTables();
  client.on("interactionCreate", handleFeedbackInteraction);
}

async function getForum() {
  if (!config.forumId) {throw new Error("Feedback forum is not configured.");}
  const channel = await client.channels.fetch(config.forumId).catch(() => null);
  if (!channel || channel.type !== discord.ChannelType.GuildForum) {
    throw new Error("Feedback forum channel is unavailable.");
  }
  return channel;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function normalizeEmoji(raw) {
  const value = String(raw || "").trim();
  if (!value || value.length > 64) {return null;}
  if (SHORTCODES[value.toLowerCase()]) {return SHORTCODES[value.toLowerCase()];}
  if (/^<a?:\w{2,32}:\d{17,20}>$/.test(value) || /^\d{17,20}$/.test(value)) {return value;}
  if (/[\w\s]/.test(value)) {return null;}
  return value;
}

/*
=====================================================
Feedback Popup
=====================================================
*/

export async function openFeedbackMenu(interaction) {
  const categories = FEEDBACK_CATEGORIES.map(item => ({
    label: item.label,
    value: item.value,
    description: item.description,
    emoji: CATEGORY_EMOJI[item.value]
  }));
  const row = new discord.ActionRowBuilder().addComponents(
    new discord.StringSelectMenuBuilder()
      .setCustomId("feedback:category")
      .setPlaceholder("Choose a feedback category")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(categories)
  );
  await interaction.reply({
    content: "Select a category, then describe your feedback in the popup.",
    components: [row],
    flags: discord.MessageFlags.Ephemeral
  });
}

function buildFeedbackModal(category) {
  const label = FEEDBACK_CATEGORIES.find(item => item.value === category)?.label ?? "Feedback";
  return new discord.ModalBuilder()
    .setCustomId(`feedback:modal:${category}`)
    .setTitle("Submit Feedback")
    .addComponents(
      new discord.ActionRowBuilder().addComponents(
        new discord.TextInputBuilder()
          .setCustomId("feedback:title")
          .setLabel("Title")
          .setPlaceholder("Short summary (max 100 characters)")
          .setStyle(discord.TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true)
      ),
      new discord.ActionRowBuilder().addComponents(
        new discord.TextInputBuilder()
          .setCustomId("feedback:message")
          .setLabel(`Your ${label.toLowerCase()}`)
          .setPlaceholder("Tell us more (max 2000 characters)")
          .setStyle(discord.TextInputStyle.Paragraph)
          .setMaxLength(2000)
          .setRequired(true)
      ),
      new discord.ActionRowBuilder().addComponents(
        new discord.TextInputBuilder()
          .setCustomId("feedback:method")
          .setLabel("Reply delivery (dm or email)")
          .setPlaceholder("dm — replies sent here in Discord; email — replies sent to your email")
          .setStyle(discord.TextInputStyle.Short)
          .setMaxLength(254)
          .setRequired(false)
      )
    );
}

async function submitDiscordFeedback(interaction, category, title, message, replyInput) {
  const methodInput = String(replyInput || "dm").trim().toLowerCase();
  const wantsEmail = methodInput.startsWith("email");
  const replyMethod = wantsEmail ? "email" : "dm";
  let email = null;
  if (wantsEmail) {
    email = methodInput.split(/\s+/)[1] || "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      await interaction.reply({
        content: "That email address does not look valid. Run the feedback popup again and enter a valid email, or leave the field blank for Discord DM replies.",
        flags: discord.MessageFlags.Ephemeral
      });
      return;
    }
  }

  try {
    const forum = await getForum();
    const tagId = forum.availableTags.find(tag => tag.name.toLowerCase() === category)?.id ?? null;
    const thread = await forum.threads.create({
      name: title,
      message: {
        content: message,
        ...(CATEGORY_EMOJI[category] ? {embeds: []} : {})
      },
      ...(tagId ? {appliedTags: [tagId]} : {}),
      reason: `Feedback submitted from Discord by ${interaction.user.id}`
    });
    const reaction = CATEGORY_EMOJI[category] || normalizeEmoji(category);
    if (reaction) {
      try {
        const starter = (await thread.messages.fetch({limit: 1})).first();
        if (starter) {await starter.react(reaction);}
      } catch (error) {
        log.error("BargazBot unable to react to feedback post:", error);
      }
    }

    const submission = createSubmission({
      userId: interaction.user.id,
      guildId: interaction.guild?.id ?? null,
      title,
      content: message,
      threadId: thread.id,
      replyMethod,
      email: wantsEmail ? email : null
    });

    if (wantsEmail) {
      const store = readStore();
      store.subscriptions.push({
        token: submission.token,
        email,
        threadId: thread.id,
        createdAt: new Date().toISOString(),
        active: true
      });
      writeStore(store);
    }

    await interaction.reply({
      content: wantsEmail
        ? `Thanks for the feedback! You'll get email replies at ${email}. Use the unsubscribe link in any reply to stop them.`
        : "Thanks for the feedback! You'll get replies here in Discord. Reply with `done` to end this conversation.",
      flags: discord.MessageFlags.Ephemeral
    });
  } catch (error) {
    log.error("BargazBot unable to post Discord feedback:", error);
    await interaction.reply({
      content: "Sorry, feedback could not be submitted right now. Please try again later.",
      flags: discord.MessageFlags.Ephemeral
    }).catch(() => {});
  }
}

async function handleFeedbackInteraction(interaction) {
  if (!interaction.isStringSelectMenu() || interaction.customId !== "feedback:category") {return;}
  const category = interaction.values[0];
  await interaction.showModal(buildFeedbackModal(category));
}

export async function handleFeedbackModal(interaction) {
  if (!interaction.isModalSubmit() || !interaction.customId.startsWith("feedback:modal:")) {return;}
  const category = interaction.customId.slice("feedback:modal:".length);
  const title = interaction.fields.getTextInputValue("feedback:title").trim();
  const message = interaction.fields.getTextInputValue("feedback:message").trim();
  const method = interaction.fields.getTextInputValue("feedback:method");
  await submitDiscordFeedback(interaction, category, title, message, method);
}

/*
=====================================================
Reply Delivery
=====================================================
*/

async function sendReplyEmail(record, reply) {
  if (!config.resendApiKey || !record.email) {return;}
  const unsubscribeUrl = `${config.baseUrl}/api/feedback/unsubscribe?token=` + encodeURIComponent(record.token);
  const threadUrl = `https://discord.com/channels/${reply.guildId}/${reply.channelId}`;
  const replyText = escapeHtml(reply.content || "(no text)");
  const author = escapeHtml(reply.author?.tag || "a community member");

  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: config.from,
        to: record.email,
        subject: "New reply to your Bargaz feedback",
        html: `
          <p>Someone replied to your feedback post.</p>
          <p><strong>${author}</strong> said:</p>
          <blockquote>${replyText}</blockquote>
          <p><a href="${threadUrl}">View the reply on Discord</a></p>
          <p>
            If the feedback forum has been deleted, no further replies will be
            sent. You can also stop these emails at any time with the link
            below.
          </p>
          <p><a href="${unsubscribeUrl}">Unsubscribe from reply emails</a></p>
        `
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {log.error("BargazBot Resend rejected a feedback reply email:", response.status);}
  } catch (error) {
    log.error("BargazBot unable to send feedback reply email:", error);
  }
}

async function forwardToForumThread(message, submission) {
  if (!submission.thread_id || !client) {return;}
  try {
    const thread = await client.channels.fetch(submission.thread_id).catch(() => null);
    if (!thread) {
      closeDmSubmission(message.author.id);
      log.warn("BargazBot feedback forum thread unavailable for DM reply:", submission.thread_id);
      return;
    }
    await thread.send({
      content: `**Reply from ${message.author.tag ?? message.author.id}:** ${message.content}`,
      allowedMentions: {parse: []}
    });
  } catch (error) {
    log.error("BargazBot unable to forward feedback DM reply to forum:", error);
  }
}

export async function handleReply(message) {
  if (!client || message.author.bot) {return;}

  const channelType = message.channel?.type;

  if (channelType === discord.ChannelType.DM) {
    const submission = getActiveDmSubmission(message.author.id);
    if (!submission) {return;}
    const text = String(message.content || "").trim().toLowerCase();
    if (["done", "stop", "end", "close", "cancel"].includes(text)) {
      closeDmSubmission(message.author.id);
      await message.reply("Thanks! This feedback conversation is closed.").catch(() => {});
      return;
    }
    await forwardToForumThread(message, submission);
    return;
  }

  if (channelType !== discord.ChannelType.PublicThread && channelType !== discord.ChannelType.PrivateThread) {return;}

  const records = getSubmissionsByThread(message.channelId);
  const store = readStore();
  const emailRecords = store.subscriptions.filter(item => item.active && item.threadId === message.channelId);
  if (records.length === 0 && emailRecords.length === 0) {return;}

  const jobs = [];
  for (const record of records) {
    if (record.reply_method !== "dm" || !record.user_id) {continue;}
    jobs.push(sendDmReply(record.user_id, message).catch(error =>
      log.error("BargazBot feedback DM reply failed:", record.user_id, error)
    ));
  }
  for (const record of emailRecords) {
    jobs.push(sendReplyEmail(record, message));
  }
  await Promise.all(jobs);
}

async function sendDmReply(userId, message) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) {return;}
  const threadUrl = `https://discord.com/channels/${message.guildId}/${message.channelId}`;
  await user.send({
    content: `A new reply to your feedback from **${message.author.tag ?? "a community member"}**:\n\n${message.content}\n\nView it on Discord: ${threadUrl}\n\nReply with \`done\` to end this conversation.`,
    allowedMentions: {parse: []}
  });
}

/*
=====================================================
HTTP Routes
=====================================================
*/

export function registerRoutes(app) {
  app.use("/feedback", express.json({limit: "32kb"}));

  app.get("/feedback/tags", async (req, res) => {
    try {
      const forum = await getForum();
      const tags = forum.availableTags.map(tag => ({id: tag.id, name: tag.name, emoji: tag.emoji || ""}));
      res.json({tags});
    } catch (error) {
      log.error("BargazBot unable to load feedback forum tags:", error);
      res.status(503).json({error: "Forum tags unavailable", tags: []});
    }
  });

  app.post("/feedback", async (req, res) => {
    const body = req.body || {};
    const title = String(body.title || "").trim();
    const message = String(body.message || "").trim();
    const tag = String(body.tag || "").trim();
    const emoji = String(body.emoji || "").trim();
    const email = String(body.email || "").trim();

    if (!title || title.length > 100 || !message || message.length > 2000) {
      return res.status(400).json({error: "Invalid title or message"});
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({error: "Invalid email address"});
    }

    try {
      const forum = await getForum();
      const tagId = forum.availableTags.some(item => item.id === tag) ? tag : null;
      const thread = await forum.threads.create({
        name: title,
        message: {content: message},
        ...(tagId ? {appliedTags: [tagId]} : {}),
        reason: "Feedback submitted from bargaz.app"
      });

      const reaction = normalizeEmoji(emoji);
      if (reaction) {
        try {
          const starter = (await thread.messages.fetch({limit: 1})).first();
          if (starter) {await starter.react(reaction);}
        } catch (error) {
          log.error("BargazBot unable to react to feedback post:", error);
        }
      }

      if (email) {
        const submission = createSubmission({
          title,
          content: message,
          threadId: thread.id,
          replyMethod: "email",
          email
        });
        const store = readStore();
        store.subscriptions.push({
          token: submission.token,
          email,
          threadId: thread.id,
          createdAt: new Date().toISOString(),
          active: true
        });
        writeStore(store);
      }

      res.json({url: `https://discord.com/channels/${thread.guildId}/${thread.id}`});
    } catch (error) {
      log.error("BargazBot unable to post feedback:", error);
      res.status(500).json({error: "Unable to post feedback"});
    }
  });

  app.get("/feedback/unsubscribe", (req, res) => {
    const token = String(req.query.token || "");
    if (!/^[0-9a-f-]{36}$/i.test(token)) {return res.json({success: false});}

    const store = readStore();
    const record = store.subscriptions.find(item => item.token === token);
    if (!record) {return res.json({success: false});}

    store.subscriptions = store.subscriptions.filter(item => item.token !== token);
    writeStore(store);

    ensureFeedbackTables();
    getDB().prepare("UPDATE feedback_submissions SET active = 0 WHERE token = ?").run(token);
    log.info("BargazBot feedback email subscription removed:", token);
    return res.json({success: true});
  });
}