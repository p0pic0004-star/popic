# popic bot — VIBECODING 2.0 homework

Covers points 1–4 of the assignment:

| # | Task | Where |
|---|------|-------|
| 1 | Telegram chat bot connected to the project | `bot.js` |
| 2 | Personal cabinet via the Telegram Mini App | the "Open my card" button → the visit card |
| 3 | Feedback by voice and text (Whisper API) | `message:voice` and `message:text` handlers |
| 4 | OCR from Claude — send a document, get text | `message:photo` / `message:document` handler |

Point 5 (install ORCA) is done separately at <https://www.onorca.dev/>.

## Setup

1. **Make the bot.** In Telegram, message [@BotFather](https://t.me/BotFather) → `/newbot`
   → pick a name and a username → copy the token it gives you.

2. **Fill in the config.** Copy `.env.example` to `.env` and paste in:
   - `BOT_TOKEN` — from BotFather
   - `MINI_APP_URL` — the visit card's public HTTPS address (the Vercel one).
     Telegram refuses `http://` and `localhost`, so the card has to be deployed first.
   - `ANTHROPIC_API_KEY` — <https://console.anthropic.com> (pays for OCR)
   - `OPENAI_API_KEY` — <https://platform.openai.com> (pays for Whisper)

3. **Run it.**

   ```bash
   npm install
   npm start
   ```

   The bot answers only while this stays running. Closing the terminal stops it —
   that is what Render is for later.

## Try it

Open the bot in Telegram and `/start`. Then:

- tap **Open my card** — the visit card opens inside Telegram
- send a normal message — it's stored as feedback
- hold the mic and record — Whisper transcribes it, then it's stored
- send a photo of a page or a PDF — Claude reads it and sends the text back

Feedback lands in `feedback.json` next to the bot. `/feedback` shows how many
have come in.

## What to change next

- **Storage.** `feedback.json` is a placeholder — `readFeedback` and `saveFeedback`
  in `bot.js` are the only two functions that touch it, so moving to Supabase means
  rewriting those two and nothing else.
- **Hosting.** Render runs the bot around the clock so it doesn't die with the terminal.
  Start command `npm start`, and the four `.env` values go in as environment variables.

`.env` and `feedback.json` are gitignored — the keys must never be committed.
