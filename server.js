require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const twilio = require('twilio');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

const { getAssistantReply } = require('./lib/claudeAgent');
const { textToSpeechUlaw } = require('./lib/elevenLabsTTS');
const { sendTranscriptEmail } = require('./lib/emailTranscript');
const { getGreeting, getFallbackMessage } = require('./lib/content');
const { speakAndHangUp } = require('./lib/callTransfer');
const { reportProblem } = require('./lib/alerts');
const { createCallSession } = require('./lib/callSession');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

const PORT = process.env.PORT || 3000;
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// Optional settings (set in Railway > Variables):
//   ALLOW_INTERRUPTIONS=false  turns off "caller can talk over the assistant"
//   ENDPOINTING_MS=700         how long a pause (in ms) counts as the caller being done talking
const ALLOW_INTERRUPTIONS = process.env.ALLOW_INTERRUPTIONS !== 'false';
const ENDPOINTING_MS = parseInt(process.env.ENDPOINTING_MS, 10) || 400;

// A bug in one call must never take down every other call. Log it, tell the owner, keep running.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  reportProblem('unexpected', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  reportProblem('unexpected', err);
});

// Railway sits in front of this app as a reverse proxy, terminating HTTPS.
// This tells Express to trust the proxy's headers so Twilio's signature
// check below can correctly reconstruct the original https:// URL.
app.set('trust proxy', true);

app.use(express.urlencoded({ extended: false }));

// --- 1. Twilio calls this webhook when a call comes in ---
// Configure this URL on your Twilio phone number as the "A Call Comes In" webhook.
// twilio.webhook() verifies the request really came from Twilio (checks the
// X-Twilio-Signature header) — without this, anyone who finds this URL could
// send fake call events and rack up API costs.
app.post('/voice', twilio.webhook(process.env.TWILIO_AUTH_TOKEN, { protocol: 'https' }), (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  const stream = connect.stream({
    url: `${process.env.PUBLIC_SERVER_URL.replace(/^http/, 'ws')}/media-stream`
  });
  // Twilio strips query strings from the stream URL, so the shared secret
  // travels as a custom parameter instead and is checked on the 'start' event.
  stream.parameter({ name: 'token', value: process.env.STREAM_SECRET || '' });
  // Pass the caller's number through to the media stream so we can include
  // it in the transcript email later.
  stream.parameter({ name: 'callerNumber', value: req.body.From || '' });
  res.type('text/xml');
  res.send(twiml.toString());
});

app.get('/', (req, res) => {
  res.send('Voice AI receptionist is running.');
});

// --- 2. Handle the live audio stream for each call ---
wss.on('connection', (twilioWs) => {
  console.log('Twilio media stream connected');

  let authenticated = false; // becomes true only after the secret is verified on 'start'
  let deepgramLive = null;
  let session = null;

  const sendToTwilio = (obj) => {
    if (twilioWs.readyState === 1) twilioWs.send(JSON.stringify(obj));
  };

  twilioWs.on('error', (err) => console.error('Twilio socket error:', err.message));

  twilioWs.on('message', (message) => {
    // Ignore anything that isn't valid JSON instead of crashing the whole app.
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (err) {
      return;
    }

    switch (msg.event) {
      case 'start': {
        // Verify the shared secret before doing anything else. Anyone who finds
        // this URL and opens a stream without it gets disconnected immediately,
        // so they can't run up your Deepgram/Claude/ElevenLabs bill.
        if (!process.env.STREAM_SECRET || msg.start?.customParameters?.token !== process.env.STREAM_SECRET) {
          console.warn('Rejected media stream: invalid/missing token');
          twilioWs.close();
          break;
        }
        authenticated = true;

        const streamSid = msg.start.streamSid;
        const callSid = msg.start.callSid;
        const callerNumber = msg.start.customParameters?.callerNumber || null;
        console.log('Stream started:', streamSid, '| callSid:', callSid, '| from:', callerNumber);

        // Live speech recognition for this call
        deepgramLive = deepgram.listen.live({
          model: 'nova-2-phonecall', // tuned for phone audio quality
          encoding: 'mulaw',
          sample_rate: 8000,
          channels: 1,
          smart_format: true,
          interim_results: true,
          endpointing: ENDPOINTING_MS // ms of silence before treating speech as finished
        });

        deepgramLive.on(LiveTranscriptionEvents.Open, () => {
          console.log('Deepgram connection opened');
        });
        deepgramLive.on(LiveTranscriptionEvents.Transcript, (data) => {
          if (session) session.handleTranscript(data);
        });
        deepgramLive.on(LiveTranscriptionEvents.Error, (err) => {
          console.error('Deepgram error:', err);
          reportProblem('speech', err, { callerNumber });
        });

        session = createCallSession({
          send: sendToTwilio,
          sendToDeepgram: (chunk) => {
            if (deepgramLive && deepgramLive.getReadyState() === 1) deepgramLive.send(chunk);
          },
          getReply: getAssistantReply,
          speak: textToSpeechUlaw,
          getGreeting: () =>
            getGreeting() || `Thanks for calling ${process.env.BUSINESS_NAME || 'us'}! How can I help you today?`,
          getFallbackMessage,
          hangUpWithMessage: speakAndHangUp,
          reportProblem,
          emailTranscript: sendTranscriptEmail,
          allowInterruptions: ALLOW_INTERRUPTIONS
        });
        session.start({ streamSid, callSid, callerNumber });
        break;
      }

      case 'media':
        // Forward the caller's audio to speech recognition (only once verified)
        if (authenticated && session) session.handleMedia(msg.media.payload);
        break;

      case 'stop':
        console.log('Stream stopped');
        if (deepgramLive) deepgramLive.finish();
        if (session) session.stop();
        break;
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio media stream closed');
    if (deepgramLive) deepgramLive.finish();
    if (session) session.stop(); // makes sure the transcript is sent even if the line dropped abruptly
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
