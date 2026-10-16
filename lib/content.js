const fs = require('fs');
const path = require('path');

// The business playbook and the spoken greeting live in plain text files so they
// can be edited without touching any code. They are re-read on every call, so a
// change takes effect on the very next call.
//
// By default the files come from the content/ folder in this project. If a
// CONTENT_DIR environment variable is set (for example to a persistent disk),
// files found there are used first. A future admin page can save edits there.
const REPO_CONTENT_DIR = path.join(__dirname, '..', 'content');
const OVERRIDE_DIR = process.env.CONTENT_DIR || null;

function readContent(filename) {
  const candidates = [];
  if (OVERRIDE_DIR) candidates.push(path.join(OVERRIDE_DIR, filename));
  candidates.push(path.join(REPO_CONTENT_DIR, filename));

  for (const file of candidates) {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch (err) {
      // File not found in this location; try the next one.
    }
  }
  return '';
}

const getPlaybook = () => readContent('playbook.md');
const getGreeting = () => readContent('greeting.txt');

// Spoken to the caller (in a plain phone-system voice) if the assistant breaks
// down mid-call and can't continue.
const DEFAULT_FALLBACK =
  "I'm sorry, I'm having technical trouble and can't help right now. " +
  'Please email Mark at mark at mark holder dot U S, or call back a little later. Goodbye.';
const getFallbackMessage = () => readContent('fallback.txt') || DEFAULT_FALLBACK;

module.exports = { getPlaybook, getGreeting, getFallbackMessage };
