// Spelling and grammar checking with Harper (https://writewithharper.com).
// Harper runs on this device in a background worker, so your writing never leaves it.
// The engine (about 20 MB) downloads the first time it's needed, then works offline.
const HARPER = './vendor/harper-3.0.0/';
const WORDS_KEY = 'writing-app:words';
const IGNORED_KEY = 'writing-app:ignored-lints';

let linterPromise = null;

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is full or blocked. The words still apply until the app closes.
  }
}

function getLinter() {
  linterPromise ??= (async () => {
    const [{ WorkerLinter, Dialect }, { slimBinary: binary }] = await Promise.all([
      import(`${HARPER}index.js`),
      import(`${HARPER}slimBinary.js`),
    ]);
    const linter = new WorkerLinter({ binary, dialect: Dialect.American });
    await linter.setup();
    const words = readJson(WORDS_KEY, []);
    if (words.length) await linter.importWords(words);
    const ignored = readJson(IGNORED_KEY, null);
    if (ignored) await linter.importIgnoredLints(JSON.stringify(ignored));
    return linter;
  })();
  linterPromise.catch(() => {
    linterPromise = null; // try again next time, for example once the device is back online
  });
  return linterPromise;
}

const KIND_NAMES = {
  Spelling: 'Spelling',
  Typo: 'Typo',
  Agreement: 'Grammar',
  Grammar: 'Grammar',
  WordOrder: 'Grammar',
  BoundaryError: 'Grammar',
  Punctuation: 'Punctuation',
  Capitalization: 'Capitalization',
  Repetition: 'Repeated word',
  Redundancy: 'Wordiness',
  Readability: 'Readability',
  Style: 'Style',
  WordChoice: 'Word choice',
  Usage: 'Usage',
  Eggcorn: 'Word choice',
  Malapropism: 'Word choice',
};

// Checks the text. Resolves to [{ start, end, kind, label, spelling, message, problem, suggestions }].
// start and end are positions in the JavaScript string, so they can be used with the textarea directly.
export async function check(text) {
  const linter = await getLinter();
  const lints = await linter.lint(text, { language: 'markdown' });
  return lints.map(lint => {
    const span = lint.span();
    const kind = lint.lint_kind();
    return {
      lint, // kept for "Ignore", with the text it came from
      source: text,
      start: span.start,
      end: span.end,
      kind,
      label: KIND_NAMES[kind] ?? 'Suggestion',
      spelling: kind === 'Spelling' || kind === 'Typo',
      message: lint.message().replace(/`([^`]*)`/g, '“$1”'), // Harper marks words with Markdown backticks
      problem: lint.get_problem_text(),
      suggestions: lint.suggestions().slice(0, 4).map(suggestion => ({
        // 0 replace, 1 remove, 2 insert after (Harper's SuggestionKind)
        kind: ['replace', 'remove', 'insert'][suggestion.kind()] ?? 'replace',
        text: suggestion.get_replacement_text(),
      })),
    };
  }).filter(mark => mark.end > mark.start);
}

export async function addWord(word) {
  const clean = word.trim();
  if (!clean) return;
  const words = readJson(WORDS_KEY, []);
  if (!words.includes(clean)) words.push(clean);
  writeJson(WORDS_KEY, words);
  const linter = await getLinter();
  await linter.importWords([clean]);
}

export async function ignore(mark) {
  if (!mark.lint) return;
  const linter = await getLinter();
  await linter.ignoreLint(mark.source, mark.lint);
  writeJson(IGNORED_KEY, JSON.parse(await linter.exportIgnoredLints()));
}

export function addedWords() {
  return readJson(WORDS_KEY, []);
}

export async function clearAdded() {
  writeJson(WORDS_KEY, []);
  writeJson(IGNORED_KEY, []);
  if (!linterPromise) return;
  const linter = await getLinter();
  await linter.clearWords();
  await linter.clearIgnoredLints();
}

// Moves marks to follow an edit, so underlines stay put while you type between checks.
// Marks touching the edited stretch are dropped until the next check.
export function shiftMarks(marks, before, after) {
  if (!marks.length || before === after) return marks;
  let prefix = 0;
  const shortest = Math.min(before.length, after.length);
  while (prefix < shortest && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < shortest - prefix
    && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) suffix += 1;
  const editEnd = before.length - suffix; // end of the changed stretch in the old text
  const delta = after.length - before.length;
  return marks.flatMap(mark => {
    if (mark.end < prefix) return [mark];
    if (mark.start > editEnd) return [{ ...mark, start: mark.start + delta, end: mark.end + delta }];
    return [];
  });
}
