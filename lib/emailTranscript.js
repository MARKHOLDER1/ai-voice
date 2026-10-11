const axios = require('axios');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL;

// Caller-supplied text ends up in these emails, so make sure it can never be
// interpreted as HTML.
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Sends one email to NOTIFICATION_EMAIL through Resend. Returns true on success,
 * false if Resend isn't configured or the send failed. Never throws, so an email
 * problem can't crash a live call.
 */
async function sendEmail(subject, html) {
  if (!RESEND_API_KEY || !NOTIFICATION_EMAIL) {
    console.log('Resend not configured — skipping email.');
    return false;
  }

  try {
    await axios.post(
      'https://api.resend.com/emails',
      {
        from: 'AI Receptionist <onboarding@resend.dev>',
        to: [NOTIFICATION_EMAIL],
        subject: String(subject).replace(/[\r\n]+/g, ' '),
        html
      },
      {
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return true;
  } catch (err) {
    console.error('Failed to send email:', err.response?.data || err.message);
    return false;
  }
}

/**
 * Turns the raw Claude message history into a clean, readable transcript.
 * Tool-call/tool-result entries are skipped — the email is meant to be a quick
 * read of what was said, not a debug log.
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
 * Emails a transcript of the whole call once it ends.
 */
async function sendTranscriptEmail(messageHistory, callerNumber) {
  const transcript = formatTranscript(messageHistory);
  if (!transcript.trim()) return; // nothing worth emailing (e.g. call with no speech)

  const subject = `Call Transcript${callerNumber ? ' from ' + callerNumber : ''} — ${new Date().toLocaleString()}`;
  const html = `<h3>Call Transcript</h3><p>${escapeHtml(transcript).replace(/\n/g, '<br>')}</p>`;

  if (await sendEmail(subject, html)) {
    console.log('Transcript email sent.');
  }
}

/**
 * Emails Mark a structured message or callback request during the call.
 * Returns true if the email was sent.
 */
async function sendMessageEmail(fields, callerNumber) {
  const f = fields || {};
  const reason = f.reason ? String(f.reason).replace(/_/g, ' ') : '';

  const row = (label, value) =>
    value
      ? `<tr><td style="padding:4px 14px 4px 0;vertical-align:top"><b>${label}</b></td><td>${escapeHtml(value)}</td></tr>`
      : '';

  const subject =
    `${f.urgent ? 'URGENT: ' : ''}Message for Mark from ${f.caller_name || 'a caller'}` +
    `${reason ? ' (' + reason + ')' : ''}`;

  const html =
    `<h3>${f.urgent ? 'URGENT message' : 'Message'} for Mark</h3>` +
    `<table>` +
    row('Name', f.caller_name) +
    row('Callback number', f.callback_number) +
    row('Calling from', callerNumber) +
    row('Email', f.email) +
    row('Company / property', f.company_or_property) +
    row('Reason', reason) +
    row('Preferred callback time', f.preferred_callback_time) +
    row('Details', f.details) +
    `</table>` +
    `<p style="color:#666">Taken by the phone assistant. A full transcript arrives in a separate email when the call ends.</p>`;

  return sendEmail(subject, html);
}

module.exports = { sendTranscriptEmail, sendMessageEmail };
