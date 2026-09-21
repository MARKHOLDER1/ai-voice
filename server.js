require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const twilio = require('twilio');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

const { getAssistantReply } = require('./lib/claudeAgent');
const { textToSpeechUlaw } = require('./lib/elevenLabsTTS');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

const PORT = process.env.PORT || 3000;
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

app.use(express.urlencoded({ extended: false }));

// --- 1. Twilio calls this webhook when a call comes in ---
// Configure this URL on your Twilio phone number as the "A Call Comes In" webhook.
app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({
    url: `${process.env.PUBLIC_SERVER_URL.replace(/^http/, 'ws')}/media-stream`
  });
  res.type('text/xml');
  res.send(twiml.toString());
});

app.get('/', (req, res) => {
  res.send('Voice AI receptionist is running.');
});

// --- 2. Handle the live audio stream for each call ---
wss.on('connection', (twilioWs) => {
  console.log('Twilio media stream connected');

  let streamSid = null;
  let deepgramLive = null;
  let messageHistory = []; // Claude conversation history for this call
  let isSpeaking = false; // true while we're playing audio back to the caller

  // Set up a live Deepgram transcription session for this call
  deepgramLive = deepgram.listen.live({
    model: 'nova-2-phonecall', // tuned for phone audio quality
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
    smart_format: true,
    interim_results: true,
    endpointing: 400 // ms of silence before treating speech as finished
  });

  deepgramLive.on(LiveTranscriptionEvents.Open, () => {
    console.log('Deepgram connection opened');
  });

  deepgramLive.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (!transcript || !data.is_final || isSpeaking) return;
    if (transcript.trim().length === 0) return;

    console.log('Caller said:', transcript);
    messageHistory.push({ role: 'user', content: transcript });

    try {
      isSpeaking = true;
      const replyText = await getAssistantReply(messageHistory);
      console.log('Assistant reply:', replyText);

      const audioBuffer = await textToSpeechUlaw(replyText);
      sendAudioToTwilio(twilioWs, streamSid, audioBuffer);
    } catch (err) {
      console.error('Error generating/playing reply:', err);
    } finally {
      isSpeaking = false;
    }
  });

  deepgramLive.on(LiveTranscriptionEvents.Error, (err) => {
    console.error('Deepgram error:', err);
  });

  // --- Handle messages coming from Twilio over the WebSocket ---
  twilioWs.on('message', (message) => {
    const msg = JSON.parse(message);

    switch (msg.event) {
   case 'start':
  streamSid = msg.start.streamSid;
  console.log('Stream started:', streamSid);

  (async () => {
    try {
      isSpeaking = true;
      const greeting = `Thanks for calling ${process.env.BUSINESS_NAME || 'us'}! How can I help you today?`;
      messageHistory.push({ role: 'assistant', content: greeting });
      const audioBuffer = await textToSpeechUlaw(greeting);
      sendAudioToTwilio(twilioWs, streamSid, audioBuffer);
    } catch (err) {
      console.error('Error playing greeting:', err);
    } finally {
      isSpeaking = false;
    }
  })();
  break;

      case 'media':
        // Forward the caller's audio chunk to Deepgram for transcription
        if (deepgramLive.getReadyState() === 1) {
          const audioChunk = Buffer.from(msg.media.payload, 'base64');
          deepgramLive.send(audioChunk);
        }
        break;

      case 'stop':
        console.log('Stream stopped');
        deepgramLive.finish();
        break;
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio media stream closed');
    if (deepgramLive) deepgramLive.finish();
  });
});

/**
 * Streams a mu-law audio buffer back to Twilio in the small chunks
 * the Media Streams protocol expects.
 */
function sendAudioToTwilio(ws, streamSid, audioBuffer) {
  const chunkSize = 320; // 20ms of 8kHz mu-law audio per Twilio's recommendation
  for (let i = 0; i < audioBuffer.length; i += chunkSize) {
    const chunk = audioBuffer.slice(i, i + chunkSize);
    ws.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: chunk.toString('base64') }
    }));
  }
}

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
