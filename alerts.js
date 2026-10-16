const { sendEmail, escapeHtml } = require('./emailTranscript');

// Only email about the same kind of problem once per 15 minutes, so an outage
// during a busy hour produces one alert instead of fifty.
const COOLDOWN_MS = 15 * 60 * 1000;
const lastSent = new Map();

/**
 * Turns a raw error into a plain-English explanation and a fix.
 * Returns { key, summary, hint } where key groups repeats of the same problem.
 */
function explain(kind, err) {
  const status = err?.status || err?.response?.status;
  const message = String(err?.message || err || '').slice(0, 300);

  if (kind === 'speech') {
    return {
      key: 'speech',
      summary: 'Speech recognition (Deepgram) had a problem',
      hint: 'Callers may not be heard. Check that DEEPGRAM_API_KEY is correct and that the Deepgram account has credit.'
    };
  }

  if (kind === 'unexpected') {
    return {
      key: 'unexpected',
      summary: 'The phone assistant hit an unexpected error',
      hint: 'The app kept running. If this repeats, send this email to whoever supports the app.'
    };
  }

  // Errors from the voice service (ElevenLabs) come through axios.
  if (err?.isAxiosError) {
    let hint = 'The voice could not be generated, so callers may hear silence or the fallback message.';
    if (status === 401) hint = 'ElevenLabs rejected the API key. Check ELEVENLABS_API_KEY in Railway.';
    else if (status === 402 || status === 429) hint = 'ElevenLabs refused the request. You may be out of credits or over the plan limit; check the ElevenLabs account.';
    else if (!status) hint = 'Could not reach ElevenLabs, or it took too long to answer. This is often temporary.';
    return { key: `voice:${status || 'none'}`, summary: 'The voice service (ElevenLabs) failed', hint };
  }

  // Anything else on the reply path is the AI service (Anthropic).
  let hint = 'The AI could not produce a reply.';
  if (status === 401) hint = 'Anthropic rejected the API key. It may have expired or been deleted. Create a new key and update ANTHROPIC_API_KEY in Railway.';
  else if (status === 400 && /workspace/i.test(message)) hint = 'The Anthropic key is not tied to a workspace. Create a new key with the Default workspace scope and update ANTHROPIC_API_KEY in Railway.';
  else if (status === 402 || status === 403) hint = 'Anthropic refused the request. Check billing and credit balance in the Claude Console.';
  else if (status === 429) hint = 'Anthropic is rate-limiting requests, or the account is out of credit. Check the Claude Console.';
  else if (status >= 500) hint = 'Anthropic is having a temporary outage. It usually clears up on its own.';
  else if (!status) hint = 'Could not reach Anthropic, or it took too long to answer. This is often temporary.';
  return { key: `ai:${status || 'none'}`, summary: 'The AI service (Anthropic) failed', hint };
}

/**
 * Emails the owner about a problem. Never throws and is safe to call without await.
 * Error details are trimmed to a few hundred characters and never include keys.
 */
async function reportProblem(kind, err, details = {}) {
  try {
    const info = explain(kind, err);
    const nowMs = Date.now();
    if (nowMs - (lastSent.get(info.key) || 0) < COOLDOWN_MS) return false;
    lastSent.set(info.key, nowMs);

    const when = new Date(nowMs).toLocaleString('en-US', { timeZone: 'America/Indiana/Indianapolis' });
    const status = err?.status || err?.response?.status;
    const technical = [err?.name, status ? `status ${status}` : null, String(err?.message || err || '').slice(0, 300)]
      .filter(Boolean)
      .join(' | ');

    const html =
      `<h3>Phone assistant problem</h3>` +
      `<p><b>${escapeHtml(info.summary)}</b></p>` +
      `<p>${escapeHtml(info.hint)}</p>` +
      `<table>` +
      `<tr><td style="padding:4px 14px 4px 0"><b>When</b></td><td>${escapeHtml(when)} (Indianapolis time)</td></tr>` +
      (details.callerNumber ? `<tr><td style="padding:4px 14px 4px 0"><b>Caller</b></td><td>${escapeHtml(details.callerNumber)}</td></tr>` : '') +
      `<tr><td style="padding:4px 14px 4px 0;vertical-align:top"><b>Technical detail</b></td><td>${escapeHtml(technical)}</td></tr>` +
      `</table>` +
      `<p style="color:#666">You will not get another email about this same problem for 15 minutes.</p>`;

    return await sendEmail(`Phone assistant problem: ${info.summary}`, html);
  } catch (e) {
    console.error('Could not send problem alert:', e.message);
    return false;
  }
}

module.exports = { reportProblem, explain };
