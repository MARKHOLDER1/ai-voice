const axios = require('axios');

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const API_KEY = process.env.ELEVENLABS_API_KEY;

// Optional: set VOICE_SPEED in Railway (between 0.7 and 1.2, normal is 1.0) to make the
// voice talk faster or slower. If it isn't set, the voice uses its normal speed.
const requestedSpeed = parseFloat(process.env.VOICE_SPEED);
const SPEED = Number.isFinite(requestedSpeed) ? Math.min(1.2, Math.max(0.7, requestedSpeed)) : null;

/**
 * Converts text to speech and returns raw mu-law 8kHz audio bytes —
 * the exact format Twilio Media Streams expects, so no audio
 * conversion step is needed on our end.
 */
async function textToSpeechUlaw(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?output_format=ulaw_8000`;

  const response = await axios.post(
    url,
    {
      text,
      model_id: 'eleven_turbo_v2_5', // low-latency model, good fit for phone calls
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        ...(SPEED !== null && { speed: SPEED })
      }
    },
    {
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer',
      timeout: 15000 // don't leave the caller in silence if the voice service stalls
    }
  );

  return Buffer.from(response.data);
}

module.exports = { textToSpeechUlaw };
