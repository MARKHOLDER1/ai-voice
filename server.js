require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const twilio = require('twilio');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

const { getAssistantReply } = require('./lib/claudeAgent');
const { textToSpeechUlaw } = require('./lib/elevenLabsTTS');
const { sendTranscriptEmail } = require('./lib/emailTranscript');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

const PORT = process.env.PORT || 3000;
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

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
    url: `${process.env.PUBLIC_SERVER_URL.replace(/^http/, 'ws')}/media-stream?token=${process.env.STREAM_SECRET}`
  });
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
wss.on('connection', (twilioWs, req) => {
  // Reject any connection that doesn't present the shared secret — this stops
  // strangers who guess/find this URL from opening a stream and running up
  // your Deepgram/Claude/ElevenLabs bill without ever placing a real call.
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (token !== process.env.STREAM_SECRET) {
    console.warn('Rejected media stream connection with invalid/missing token');
    twilioWs.close();
    return;
  }

  console.log('Twilio media stream connected');

  let streamSid = null;
  let callSid = null;
  let callerNumber = null;
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
      const replyText = await getAssistantReply(messageHistory, { callSid });
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
        callSid = msg.start.callSid;
        callerNumber = msg.start.customParameters?.callerNumber || null;
        console.log('Stream started:', streamSid, '| callSid:', callSid, '| from:', callerNumber);

        // Greet the caller after a brief pause. Twilio's audio path back to the
        // caller isn't always fully ready the instant 'start' fires, so sending
        // audio immediately can get silently dropped. Waiting ~500ms fixes this.
        (async () => {
          try {
            await new Promise(resolve => setTimeout(resolve, 500));
            isSpeaking = true;
            const greeting = `Thanks for calling ${process.env.BUSINESS_NAME || 'us'}! How can I help you today?`;
            messageHistory.push({ role: 'assistant', content: greeting });
            const audioBuffer = await textToSpeechUlaw(greeting);
            sendAudioToTwilio(twilioWs, streamSid, audioBuffer);
            console.log('Greeting sent successfully, bytes:', audioBuffer.length);
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
        sendTranscriptEmail(messageHistory, callerNumber);
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