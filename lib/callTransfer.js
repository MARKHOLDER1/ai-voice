const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Transfers a live, in-progress call to a human phone number.
 * This works by telling Twilio's REST API to replace the call's current
 * instructions with a new <Dial> — Twilio applies this to the call immediately,
 * even though it's already connected to our media stream.
 */
async function transferCall(callSid, toNumber) {
  if (!callSid) {
    throw new Error('No callSid available — cannot transfer a call without it.');
  }
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you now, please hold.</Say>
  <Dial>${toNumber}</Dial>
</Response>`;

  await client.calls(callSid).update({ twiml });
}

/**
 * Says a message in Twilio's own phone-system voice, then hangs up. Because this
 * runs inside Twilio, it still works when our AI, voice, or speech services are down.
 */
async function speakAndHangUp(callSid, message) {
  if (!callSid) {
    throw new Error('No callSid available — cannot end a call without it.');
  }
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${escapeXml(message)}</Say>
  <Hangup/>
</Response>`;

  await client.calls(callSid).update({ twiml });
}

/**
 * Ends a live call politely (used when the assistant hangs up on an abusive caller).
 */
async function hangUpCall(callSid) {
  return speakAndHangUp(callSid, 'Thank you for calling. Goodbye.');
}

module.exports = { transferCall, hangUpCall, speakAndHangUp };
