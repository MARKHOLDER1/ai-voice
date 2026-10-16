// Runs the conversation side of ONE phone call: when to reply, when to stop
// talking because the caller interrupted, and what to do when something breaks.
//
// Everything this touches in the outside world (Twilio, the AI, the voice, email)
// is passed in, so the logic can be tested without placing real calls.

const BYTES_PER_SECOND = 8000; // 8 kHz mu-law audio is one byte per sample
const CHUNK_BYTES = 320; // 20 ms of audio per message to Twilio
const RETRY_PROMPT = "I'm sorry, I'm having a little trouble. Could you say that again?";

// Sounds that are never a real turn: coughs, "um", "hmm".
const NOISE_WORDS = new Set(['uh', 'um', 'uhh', 'umm', 'er', 'ah', 'hm', 'hmm', 'mm', 'mmm', 'mhm', 'huh']);

// Short acknowledgements. These don't interrupt the assistant, and they are ignored
// while it is talking or thinking, but they count as a real answer when it is waiting.
const BACKCHANNEL_WORDS = new Set([
  'okay', 'ok', 'yeah', 'yes', 'yep', 'right', 'sure', 'alright',
  'uh-huh', 'mm-hmm', 'hello', 'hi', 'hey'
]);

function wordsOf(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9'\- ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createCallSession(deps) {
  const {
    send, // (object) => void: sends one JSON message to Twilio
    sendToDeepgram, // (Buffer) => void: sends caller audio to speech recognition
    getReply, // (history, context) => Promise<string>: the AI's next reply
    speak, // (text) => Promise<Buffer>: mu-law audio of that text
    getGreeting, // () => string
    getFallbackMessage, // () => string
    hangUpWithMessage, // (callSid, message) => Promise<void>
    reportProblem, // (kind, err, details) => void: emails the owner
    emailTranscript, // (history, callerNumber) => Promise<void>
    allowInterruptions = true,
    now = Date.now,
    sleep = defaultSleep,
    log = console
  } = deps;

  let streamSid = null;
  let callSid = null;
  let callerNumber = null;

  const messageHistory = []; // the conversation so far, as the AI sees it
  let thinking = false; // true while we wait for the AI and the voice to produce a reply
  let playbackEndsAt = 0; // when Twilio will finish playing everything we've sent
  let pendingText = ''; // what the caller said while we were thinking
  let consecutiveFailures = 0;
  let gaveUp = false; // the fallback goodbye has been triggered
  let ended = false; // the call is over

  const isPlaying = () => now() < playbackEndsAt;

  // --- Audio out ---------------------------------------------------------

  function playAudio(audioBuffer) {
    if (ended) return;
    for (let i = 0; i < audioBuffer.length; i += CHUNK_BYTES) {
      send({
        event: 'media',
        streamSid,
        media: { payload: audioBuffer.subarray(i, i + CHUNK_BYTES).toString('base64') }
      });
    }
    // Twilio queues what we send and plays it at normal speed, so we can work
    // out when it will finish talking.
    const durationMs = (audioBuffer.length / BYTES_PER_SECOND) * 1000;
    playbackEndsAt = Math.max(now(), playbackEndsAt) + durationMs;
  }

  // Caller started talking over the assistant: tell Twilio to drop what it hasn't played yet.
  function interruptPlayback() {
    if (!isPlaying()) return;
    playbackEndsAt = 0;
    send({ event: 'clear', streamSid });
    log.log('Caller interrupted: stopped playback');
  }

  // --- Failure handling --------------------------------------------------

  // Last resort: say sorry in Twilio's own voice (which works even if our AI,
  // voice, or speech services are down) and hang up.
  async function giveUp() {
    if (gaveUp || ended) return;
    gaveUp = true;
    try {
      await hangUpWithMessage(callSid, getFallbackMessage());
    } catch (err) {
      log.error('Could not play the fallback message:', err);
    }
  }

  async function handleReplyFailure(err) {
    consecutiveFailures += 1;
    log.error('Error generating/playing reply:', err);
    reportProblem('reply', err, { callerNumber });

    // First hiccup: ask them to repeat. Second in a row: apologize and hang up.
    if (consecutiveFailures < 2) {
      try {
        playAudio(await speak(RETRY_PROMPT));
        return;
      } catch (speakErr) {
        log.error('Could not speak the retry prompt:', speakErr);
      }
    }
    await giveUp();
  }

  // --- Conversation ------------------------------------------------------

  async function processTurn(text) {
    thinking = true;
    try {
      messageHistory.push({ role: 'user', content: text });
      const replyText = await getReply(messageHistory, { callSid, callerNumber });
      log.log('Assistant reply:', replyText);

      const audio = await speak(replyText);
      // If the caller kept talking while we were thinking, this reply is out of date.
      // Skip it and answer what they said instead.
      if (!pendingText && !gaveUp) playAudio(audio);
      consecutiveFailures = 0;
    } catch (err) {
      await handleReplyFailure(err);
    } finally {
      thinking = false;
      drainPending();
    }
  }

  function drainPending() {
    if (ended || gaveUp || thinking || !pendingText) return;
    const text = pendingText;
    pendingText = '';
    processTurn(text).catch((err) => log.error('Unexpected error in turn:', err));
  }

  // Called for every piece of speech recognition output (partial and final).
  function handleTranscript(data) {
    if (ended || gaveUp) return;

    const text = (data?.channel?.alternatives?.[0]?.transcript || '').trim();
    if (!text) return;

    const words = wordsOf(text);
    if (words.length === 0) return;
    if (words.every((w) => NOISE_WORDS.has(w))) return; // a cough or an "um"

    // A real interruption is at least two words that aren't just "uh-huh, okay".
    const meaningful =
      words.length >= 2 && !words.every((w) => NOISE_WORDS.has(w) || BACKCHANNEL_WORDS.has(w));

    if (meaningful && allowInterruptions) interruptPlayback();

    if (!data.is_final) return; // wait for the finished version before replying

    // "Okay" or "yeah" while the assistant is mid-sentence or thinking isn't a new question.
    if (!meaningful && (isPlaying() || thinking)) return;

    log.log('Caller said:', text);

    if (thinking) {
      pendingText = `${pendingText} ${text}`.trim();
      return;
    }
    processTurn(text).catch((err) => log.error('Unexpected error in turn:', err));
  }

  // --- Lifecycle ---------------------------------------------------------

  function start(info) {
    streamSid = info.streamSid;
    callSid = info.callSid;
    callerNumber = info.callerNumber || null;

    (async () => {
      thinking = true;
      try {
        // Brief pause: Twilio's audio path isn't always ready the instant the call starts.
        await sleep(500);
        const greeting = getGreeting();
        const audio = await speak(greeting);
        // If the caller already started talking, skip the greeting and answer them.
        if (!pendingText && !ended) {
          messageHistory.push({ role: 'assistant', content: greeting }); // only record what was actually said
          playAudio(audio);
          log.log('Greeting sent successfully, bytes:', audio.length);
        }
      } catch (err) {
        log.error('Error playing greeting:', err);
        reportProblem('greeting', err, { callerNumber });
        await giveUp();
      } finally {
        thinking = false;
        drainPending();
      }
    })();
  }

  function handleMedia(base64Payload) {
    if (ended) return;
    sendToDeepgram(Buffer.from(base64Payload, 'base64'));
  }

  // The call is over. Safe to call more than once; the transcript is only sent once.
  function stop() {
    if (ended) return;
    ended = true;
    emailTranscript(messageHistory, callerNumber);
  }

  return { start, handleMedia, handleTranscript, stop };
}

module.exports = { createCallSession, wordsOf, RETRY_PROMPT };
