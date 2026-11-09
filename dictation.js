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

// Returns null when this browser has no speech recognition.
export function createDictation({ onFinal, onInterim, onStart, onStop, onError, lang = 'en-US' }) {
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognition) return null;

  let recognition = null;
  let wanted = false;
  let startedAt = 0;
  let quickEnds = 0;

  function begin() {
    recognition = new Recognition();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = event => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) onFinal(result[0].transcript);
        else interim += result[0].transcript;
      }
      onInterim(interim.trim());
    };
    recognition.onerror = event => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      wanted = false;
      onError(event.error);
    };
    // The browser ends listening after a silence. Start again while dictation is on,
    // but give up if it keeps ending right away.
    recognition.onend = () => {
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
      try {
        recognition?.stop();
      } catch {
        recognition = null;
        onStop();
      }
    },
  };
}
