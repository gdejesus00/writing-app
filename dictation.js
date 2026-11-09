// Dictation through the browser's speech recognition.
// In Edge, Microsoft's online speech service turns your voice into text. In Chrome, Google's does.

const SPOKEN_COMMANDS = new Map([
  ['new paragraph', '\n\n'],
  ['new line', '\n'],
  ['period', '.'],
  ['full stop', '.'],
  ['comma', ','],
  ['question mark', '?'],
  ['exclamation point', '!'],
  ['exclamation mark', '!'],
  ['colon', ':'],
  ['semicolon', ';'],
]);

// Turns one finished phrase into the text to insert, given the text just before the cursor.
// A phrase that is only a command ("new paragraph", "period") becomes that break or mark.
// trimBefore is how many spaces before the cursor to replace, so "word ." becomes "word.".
export function formatDictation(before, raw) {
  let text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const command = SPOKEN_COMMANDS.get(text.toLowerCase().replace(/[.,!?;:]+$/, ''));
  if (command !== undefined) {
    const trimBefore = /^[.,!?;:]$/.test(command) ? (before.match(/[ \t]+$/)?.[0].length ?? 0) : 0;
    return { text: command, trimBefore };
  }
  const atSentenceStart = before.trim() === '' || /[.!?…]["”’)]*\s*$/.test(before) || /\n\s*$/.test(before);
  if (atSentenceStart) text = text[0].toUpperCase() + text.slice(1);
  const needsSpace = before !== '' && !/[\s(“"‘'—–-]$/.test(before);
  return { text: needsSpace ? ` ${text}` : text, trimBefore: 0 };
}

// Phones. Chrome on Android doesn't follow the usual rules: it sends the sentence again with one more
// word each time, marks every version as final, and repeats some. Typed as they come, they pile up.
// So on a phone, each result is treated as the engine's latest guess for the sentence in progress.
// The guess is shown while you speak and typed once, when you pause or the sentence clearly changes.
const QUIET_MS = 1100;   // how long a pause finishes a sentence
const REPEAT_MS = 3000;  // the engine often re-sends a finished sentence once, a moment later

const wordsOf = text => text.toLowerCase().replace(/[^\p{L}\p{N}'’\s]/gu, ' ').split(/\s+/).filter(Boolean);

// True if `next` is the same sentence as `previous`, grown or corrected, and not a new sentence.
export function guessContinues(previous, next) {
  if (!previous) return true;
  const before = wordsOf(previous);
  const after = wordsOf(next);
  if (before.length <= 2) return next.toLowerCase().startsWith(previous.toLowerCase().slice(0, 3));
  let same = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i += 1) if (before[i] === after[i]) same += 1;
  return same >= Math.min(before.length - 2, Math.ceil(before.length * 0.6));
}

// Returns null when this browser has no speech recognition.
export function createDictation({ onFinal, onInterim, onStart, onStop, onError, lang = 'en-US', quietMs = QUIET_MS }) {
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognition) return null;
  const onPhone = /Android/i.test(navigator.userAgent) || Boolean(window.matchMedia?.('(pointer: coarse)').matches);

  let recognition = null;
  let wanted = false;
  let startedAt = 0;
  let quickEnds = 0;
  // Phones only
  let guess = '';      // the latest guess for the sentence in progress, without words already typed
  let latest = '';     // the engine's latest full guess, as it was sent
  let typedBase = '';  // the sentence just typed (lower case), in case the engine keeps growing it
  let typedAt = 0;
  let quietTimer = 0;

  function commitGuess(keepBase) {
    clearTimeout(quietTimer);
    const text = guess.trim();
    guess = '';
    onInterim('');
    if (!text) return;
    typedBase = keepBase ? latest.toLowerCase() : '';
    typedAt = Date.now();
    onFinal(text);
  }

  function onPhoneResult(event) {
    const last = event.results[event.results.length - 1];
    const raw = last?.[0]?.transcript?.trim();
    if (!raw) return;
    const lower = raw.toLowerCase();
    let part = raw;
    if (typedBase && lower.length === raw.length) {
      if (lower.startsWith(`${typedBase} `)) part = raw.slice(typedBase.length).trim();
      else if (lower === typedBase && Date.now() - typedAt < REPEAT_MS) return; // the sentence just typed, sent again
      else typedBase = '';
    }
    if (guess && !guessContinues(guess, part)) commitGuess(false); // a different sentence began
    guess = part;
    latest = raw;
    onInterim(part);
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => commitGuess(true), quietMs);
  }

  function onDesktopResult(event) {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) onFinal(result[0].transcript);
      else interim += result[0].transcript;
    }
    onInterim(interim.trim());
  }

  function begin() {
    recognition = new Recognition();
    clearTimeout(quietTimer);
    guess = '';
    latest = '';
    typedBase = '';
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = onPhone ? onPhoneResult : onDesktopResult;
    recognition.onerror = event => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      wanted = false;
      onError(event.error);
    };
    // The browser ends listening after a silence. Start again while dictation is on,
    // but give up if it keeps ending right away.
    recognition.onend = () => {
      if (onPhone) commitGuess(false);
      onInterim('');
      if (!wanted) {
        recognition = null;
        onStop();
        return;
      }
      quickEnds = Date.now() - startedAt < 2000 ? quickEnds + 1 : 0;
      if (quickEnds >= 3) {
        wanted = false;
        recognition = null;
        onError('keeps-stopping');
        onStop();
        return;
      }
      begin();
    };
    startedAt = Date.now();
    recognition.start();
  }

  return {
    get active() {
      return wanted;
    },
    start() {
      if (wanted) return;
      wanted = true;
      quickEnds = 0;
      try {
        begin();
        onStart();
      } catch {
        wanted = false;
        recognition = null;
        onError('start-failed');
        onStop();
      }
    },
    stop() {
      if (!wanted) return;
      wanted = false;
      if (onPhone) commitGuess(false); // type the sentence in progress before stopping
      try {
        recognition?.stop();
      } catch {
        recognition = null;
        onStop();
      }
    },
  };
}
