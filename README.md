# Voice AI Receptionist

Answers incoming business calls, responds to customer questions, and books appointments — built on Twilio (telephony), Deepgram (speech-to-text), Claude (conversation + scheduling logic), and ElevenLabs (text-to-speech).

## How it works

1. A call comes into your Twilio number → Twilio hits `/voice`, which tells it to open a real-time audio stream to `/media-stream`.
2. Caller audio streams in over that WebSocket → forwarded live to Deepgram for transcription.
3. When Deepgram detects the caller has finished a sentence, the transcript is sent to Claude, along with the running conversation history and two tools: `check_availability` and `book_appointment`.
4. Claude's reply is converted to speech by ElevenLabs (in the exact audio format Twilio needs — no conversion step required) and streamed back to the caller.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Get API keys and fill in `.env`** (copy `.env.example` to `.env`):
   - Anthropic: https://console.anthropic.com
   - Deepgram: https://console.deepgram.com
   - ElevenLabs: https://elevenlabs.io (grab a voice ID from their Voice Library)
   - Twilio: https://console.twilio.com (buy a phone number if you don't have one)

3. **Run locally with a tunnel** (needed because Twilio must reach your server over the public internet):
   ```bash
   npx ngrok http 3000
   ```
   Copy the `https://xxxx.ngrok-free.app` URL into `PUBLIC_SERVER_URL` in your `.env`.

4. **Start the server:**
   ```bash
   npm start
   ```

5. **Point your Twilio number at the app:**
   - Twilio Console → Phone Numbers → your number → "A Call Comes In" → Webhook → `https://xxxx.ngrok-free.app/voice` (HTTP POST)

6. **Call your Twilio number** and talk to it.

## What you still need to customize

- **`lib/claudeAgent.js` → `SYSTEM_PROMPT`**: add your real business info (services, pricing, policies, FAQs).
- **`lib/claudeAgent.js` → `executeTool()`**: replace the `check_availability` and `book_appointment` stubs with real Google Calendar / Calendly API calls.
- **Human transfer**: the `transfer_to_human` tool currently just flags the request — wire it up to Twilio's `<Dial>` verb to actually transfer the call to a real phone number.
- **Voice choice**: pick a voice from ElevenLabs and set `ELEVENLABS_VOICE_ID`.

## Known limitations of this initial scaffold (worth addressing before going live)

- **No interruption/barge-in handling**: right now, if the caller talks while the assistant is speaking, that speech is dropped rather than interrupting the assistant. Real production systems typically stop playback the moment the caller starts talking.
- **No call recording/logging persistence**: conversation history lives in memory only and is lost when the call ends. You'll likely want to log transcripts and bookings somewhere durable.
- **No error fallback**: if the Claude/Deepgram/ElevenLabs calls fail mid-call, the caller currently just hears silence. Add a fallback message ("Sorry, I'm having trouble — let me transfer you") for production use.
- **Latency**: total round-trip (STT → Claude → TTS) should land under ~1-1.5s with this stack, but test under real conditions and tune the Deepgram `endpointing` value if responses feel slow or cut off too eagerly.

## Deploying to production

Once tested, deploy to a small persistent host (this doesn't need much horsepower — it's mostly I/O, relaying audio streams):
- **Railway** or **Render**: easiest, git-push deploys, ~$5-7/month
- **Fly.io**: similar, good for WebSocket-heavy apps
- **A basic VM** (DigitalOcean/AWS Lightsail): more control, ~$5-10/month

Whichever you choose, set `PUBLIC_SERVER_URL` to your real domain and update the Twilio webhook accordingly.
