const axios = require('axios');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL;

/**
 * Turns the raw Claude message history into a clean, readable transcript.
 * Tool-call/tool-result entries (calendar lookups, transfer requests, etc.)
 * are skipped — the email is meant to be a quick read of what was said,
 * not a debug log.
 */
function formatTranscript(messageHistory) {
  const lines = [];
  for (const msg of messageHistory) {
    if (typeof msg.content !== 'string') continue; // skip tool_use/tool_result blocks
    const speaker = msg.role === 'user' ? 'Caller' : 'Assistant';
    lines.push(`${speaker}: ${msg.content}`);
  }
  return lines.join('\n\n');
}

/**
 * Emails a transcript of the call. Silently does nothing if Resend isn't
 * configured yet, so it never crashes a call over a missing email setup.
 */
async function sendTranscriptEmail(messageHistory, callerNumber) {
  if (!RESEND_API_KEY || !NOTIFICATION_EMAIL) {
    console.log('Resend not configured — skipping transcript email.');
    return;
  }

  const transcript = formatTranscript(messageHistory);
  if (!transcript.trim()) return; // nothing worth emailing (e.g. call with no speech)

  const subject = `Call Transcript${callerNumber ? ' from ' + callerNumber : ''} — ${new Date().toLocaleString()}`;
  const html = `<h3>Call Transcript</h3><p>${transcript.replace(/\n/g, '<br>')}</p>`;

  try {
    await axios.post(
      'https://api.resend.com/emails',
      {
        from: 'AI Receptionist <onboarding@resend.dev>',
        to: [NOTIFICATION_EMAIL],
        subject,
        html
      },
      {
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Transcript email sent.');
  } catch (err) {
    console.error('Failed to send transcript email:', err.response?.data || err.message);
  }
}

module.exports = { sendTranscriptEmail };
