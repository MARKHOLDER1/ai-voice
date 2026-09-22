const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

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

module.exports = { transferCall };