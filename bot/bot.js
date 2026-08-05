// popic bot — homework for VIBECODING 2.0
//
//   1. Telegram chat bot connected to the project
//   2. Personal cabinet via the built-in Telegram Mini App  (the visit card)
//   3. Feedback by voice and text                            (Whisper API)
//   4. OCR — send any document, get the text back            (Claude)
//
// Run:  npm install  &&  npm start

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const BOT_TOKEN = requireEnv("BOT_TOKEN");
// The Mini App is the visit card. Telegram requires HTTPS, so this is the
// deployed Vercel URL — a localhost address will not open.
const MINI_APP_URL = process.env.MINI_APP_URL ?? "";

const bot = new Bot(BOT_TOKEN);

// Both SDKs throw the moment they're constructed if their key is missing, so
// they're built on first use instead of at startup. That way the bot runs with
// only a BOT_TOKEN, and just the feature whose key is absent stays switched off.
let claudeClient;
let openaiClient;

function getClaude() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  claudeClient ??= new Anthropic();
  return claudeClient;
}

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return null;
  openaiClient ??= new OpenAI();
  return openaiClient;
}

// Feedback lives in a JSON file for now. Supabase is the intended home for it
// (see the project's stack notes) — swapping this pair of functions is the
// whole migration.
const FEEDBACK_FILE = path.join(process.cwd(), "feedback.json");

async function readFeedback() {
  try {
    return JSON.parse(await fs.readFile(FEEDBACK_FILE, "utf8"));
  } catch {
    return [];
  }
}

async function saveFeedback(entry) {
  const all = await readFeedback();
  all.push(entry);
  await fs.writeFile(FEEDBACK_FILE, JSON.stringify(all, null, 2), "utf8");
  return all.length;
}

// ---------- /start — the cabinet ----------

bot.command("start", async (ctx) => {
  const keyboard = new InlineKeyboard();
  if (MINI_APP_URL) {
    keyboard.webApp("Open my card", MINI_APP_URL).row();
  }

  await ctx.reply(
    [
      "Hi, I'm popic's bot.",
      "",
      "• Open my card — my visit card, right inside Telegram",
      "• Send a text or a voice message — it reaches me as feedback",
      "• Send a photo or a document — I read it and send the text back",
    ].join("\n"),
    { reply_markup: keyboard },
  );
});

bot.command("feedback", async (ctx) => {
  const all = await readFeedback();
  await ctx.reply(`${all.length} message(s) left so far. Add yours — write or record.`);
});

// ---------- voice feedback — Whisper ----------

bot.on("message:voice", async (ctx) => {
  const openai = getOpenAI();
  if (!openai) {
    await ctx.reply(
      "I can't listen to voice yet — no OpenAI key set up. Write it to me instead and it still reaches popic.",
    );
    return;
  }

  const note = await ctx.reply("Listening…");
  try {
    const audio = await fetchTelegramFile(ctx, ctx.message.voice.file_id);

    const transcript = await openai.audio.transcriptions.create({
      // Telegram voice notes are OGG/Opus; Whisper accepts that directly.
      file: await OpenAI.toFile(audio, "voice.ogg", { type: "audio/ogg" }),
      model: "whisper-1",
    });

    const count = await saveFeedback({
      type: "voice",
      from: ctx.from.username ?? String(ctx.from.id),
      text: transcript.text,
      at: new Date().toISOString(),
    });

    await ctx.api.editMessageText(
      ctx.chat.id,
      note.message_id,
      `Got it — feedback #${count}:\n\n"${transcript.text}"`,
    );
  } catch (err) {
    await failed(ctx, note, err, "I couldn't transcribe that.");
  }
});

// ---------- text feedback ----------

bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;

  const count = await saveFeedback({
    type: "text",
    from: ctx.from.username ?? String(ctx.from.id),
    text: ctx.message.text,
    at: new Date().toISOString(),
  });

  await ctx.reply(`Thanks — saved as feedback #${count}.`);
});

// ---------- OCR — Claude reads the document ----------

bot.on(["message:photo", "message:document"], async (ctx) => {
  const claude = getClaude();
  if (!claude) {
    await ctx.reply("I can't read documents yet — no Anthropic key set up.");
    return;
  }

  const note = await ctx.reply("Reading…");
  try {
    const photo = ctx.message.photo?.at(-1);          // largest size Telegram sent
    const doc = ctx.message.document;
    const fileId = photo?.file_id ?? doc.file_id;
    const mime = photo ? "image/jpeg" : (doc.mime_type ?? "application/octet-stream");

    const bytes = await fetchTelegramFile(ctx, fileId);
    const data = Buffer.from(bytes).toString("base64");

    // A PDF goes in as a document block, anything image-shaped as an image block.
    const source = { type: "base64", media_type: mime, data };
    const block =
      mime === "application/pdf"
        ? { type: "document", source }
        : { type: "image", source };

    const response = await claude.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      messages: [
        {
          role: "user",
          content: [
            block,
            {
              type: "text",
              text:
                "Read this document and return its text exactly as written. " +
                "Keep the original language and the layout — headings, lists and " +
                "tables stay recognisable. Return only the text, no commentary.",
            },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      await failed(ctx, note, null, "I can't read that one.");
      return;
    }

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    await ctx.api.deleteMessage(ctx.chat.id, note.message_id);
    for (const chunk of split(text || "(nothing readable in there)")) {
      await ctx.reply(chunk);
    }
  } catch (err) {
    await failed(ctx, note, err, "I couldn't read that.");
  }
});

// ---------- helpers ----------

async function fetchTelegramFile(ctx, fileId) {
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Telegram returned ${res.status} for the file`);
  return res.arrayBuffer();
}

// Telegram rejects anything over 4096 characters, so long documents go out in pieces.
function split(text, limit = 4000) {
  const out = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}

async function failed(ctx, note, err, message) {
  if (err) console.error(err);
  await ctx.api
    .editMessageText(ctx.chat.id, note.message_id, message)
    .catch(() => ctx.reply(message));
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

bot.catch((err) => console.error("Bot error:", err));

bot.start({
  onStart: (me) => {
    console.log(`@${me.username} is running. Ctrl+C to stop.`);
    console.log(`  mini app  ${MINI_APP_URL || "off — set MINI_APP_URL"}`);
    console.log(`  voice     ${process.env.OPENAI_API_KEY ? "on" : "off — set OPENAI_API_KEY"}`);
    console.log(`  ocr       ${process.env.ANTHROPIC_API_KEY ? "on" : "off — set ANTHROPIC_API_KEY"}`);
  },
});
