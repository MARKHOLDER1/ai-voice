const axios = require('axios');

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const API_KEY = process.env.ELEVENLABS_API_KEY;

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
        similarity_boost: 0.75
      }
    },
    {
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer'
    }
  );

  return Buffer.from(response.data);
}

module.exports = { textToSpeechUlaw };
