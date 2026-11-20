import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { ChannelType } from "discord.js";

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
  eyes: "👀",
};

let client = null;

const config = {
  forumId: process.env.FEEDBACK_FORUM_ID || "",
  dataFile:
    process.env.FEEDBACK_DATA_FILE ||
    path.join(process.cwd(), "data", "feedback.json"),
  baseUrl: (process.env.FEEDBACK_BASE_URL || "https://bargaz.app").replace(
    /\/$/,
    ""
  ),
  resendApiKey: process.env.RESEND_API_KEY || "",
  from: process.env.FEEDBACK_FROM_EMAIL || DEFAULT_FROM,
};

export function initFeedback(discordClient) {
  client = discordClient;
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(config.dataFile, "utf8"));
    return {
      subscriptions: Array.isArray(parsed.subscriptions)
        ? parsed.subscriptions
        : [],
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Unable to read feedback store:", error);
    }
    return { subscriptions: [] };
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  const temp = `${config.dataFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2));
  fs.renameSync(temp, config.dataFile);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char];
  });
}

function normalizeEmoji(raw) {
  const value = String(raw || "").trim();
  if (!value || value.length > 64) return null;

  if (SHORTCODES[value.toLowerCase()]) {
    return SHORTCODES[value.toLowerCase()];
  }

  if (/^<a?:\w{2,32}:\d{17,20}>$/.test(value) || /^\d{17,20}$/.test(value)) {
    return value;
  }

  if (/[\w\s]/.test(value)) return null;
  return value;
}

async function getForum() {
  if (!config.forumId) {
    throw new Error("Feedback forum is not configured.");
  }

  const channel = await client.channels.fetch(config.forumId).catch(() => null);

  if (!channel || channel.type !== ChannelType.GuildForum) {
    throw new Error("Feedback forum channel is unavailable.");
  }

  return channel;
}

async function sendReplyEmail(record, reply) {
  if (!config.resendApiKey || !record.email) return;

  const unsubscribeUrl =
    `${config.baseUrl}/api/feedback/unsubscribe?token=` +
    encodeURIComponent(record.token);
  const threadUrl =
    `https://discord.com/channels/${reply.guildId}/${reply.channelId}`;
  const replyText = escapeHtml(reply.content || "(no text)");
  const author = escapeHtml(reply.author?.tag || "a community member");

  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json",
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
        `,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.error("Resend rejected a feedback reply email:", response.status);
    }
  } catch (error) {
    console.error("Unable to send feedback reply email:", error);
  }
}

export function registerRoutes(app) {
  app.use("/feedback", express.json({ limit: "32kb" }));

  app.get("/feedback/tags", async (req, res) => {
    try {
      const forum = await getForum();
      const tags = forum.availableTags.map((tag) => ({
        id: tag.id,
        name: tag.name,
        emoji: tag.emoji || "",
      }));
      res.json({ tags });
    } catch (error) {
      console.error("Unable to load feedback forum tags:", error);
      res.status(503).json({ error: "Forum tags unavailable", tags: [] });
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
      return res.status(400).json({ error: "Invalid title or message" });
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    try {
      const forum = await getForum();
      const tagId = forum.availableTags.some((item) => item.id === tag)
        ? tag
        : null;

      const thread = await forum.threads.create({
        name: title,
        message: { content: message },
        ...(tagId ? { appliedTags: [tagId] } : {}),
        reason: "Feedback submitted from bargaz.app",
      });

      const reaction = normalizeEmoji(emoji);
      if (reaction) {
        try {
          const starter = (await thread.messages.fetch({ limit: 1 })).first();
          if (starter) await starter.react(reaction);
        } catch (error) {
          console.error("Unable to react to feedback post:", error);
        }
      }

      if (email) {
        const store = readStore();
        store.subscriptions.push({
          token: crypto.randomUUID(),
          email,
          threadId: thread.id,
          createdAt: new Date().toISOString(),
          active: true,
        });
        writeStore(store);
      }

      res.json({
        url: `https://discord.com/channels/${thread.guildId}/${thread.id}`,
      });
    } catch (error) {
      console.error("Unable to post feedback:", error);
      res.status(500).json({ error: "Unable to post feedback" });
    }
  });

  app.get("/feedback/unsubscribe", (req, res) => {
    const token = String(req.query.token || "");

    if (!/^[0-9a-f-]{36}$/i.test(token)) {
      return res.json({ success: false });
    }

    const store = readStore();
    const record = store.subscriptions.find(
      (item) => item.token === token
    );

    if (!record) {
      return res.json({ success: false });
    }

    store.subscriptions = store.subscriptions.filter(
      (item) => item.token !== token
    );
    writeStore(store);

    return res.json({ success: true });
  });
}

export async function handleReply(message) {
  if (!client || message.author.bot) return;

  const channelType = message.channel?.type;
  if (
    channelType !== ChannelType.PublicThread &&
    channelType !== ChannelType.PrivateThread
  ) {
    return;
  }

  const store = readStore();
  const records = store.subscriptions.filter(
    (item) => item.active && item.threadId === message.channelId
  );

  if (records.length === 0) return;

  await Promise.all(
    records.map((record) => sendReplyEmail(record, message))
  );
}