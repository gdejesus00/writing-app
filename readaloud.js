// Read aloud, with two kinds of voice:
// - VoiceStudio: your own cloned voice. The app's local server on this PC forwards
//   /voicestudio/* to VoiceStudio at 127.0.0.1:3900 (see serve.mjs).
// - The browser's built-in voices, which work everywhere, including the phone.
// Text is read in chunks with their places in the page, so the app can follow along.

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

// Where the sentence containing `index` starts.
export function sentenceStart(text, index) {
  for (const { index: start, segment } of segmenter.segment(text)) {
    if (index < start + segment.length) return start;
  }
  return 0;
}

// Splits text[from, to) into chunks of whole sentences. With groupWords, short sentences in the
// same paragraph are joined up to that many words. The first chunk stays one sentence, so the
// voice starts quickly.
export function splitForReading(text, from, to, groupWords = 0) {
  const chunks = [];
  let current = null;
  for (const { index, segment } of segmenter.segment(text.slice(from, to))) {
    const spoken = speakable(segment);
    if (!spoken) continue;
    const start = from + index + (segment.length - segment.trimStart().length);
    const end = from + index + segment.trimEnd().length;
    const words = spoken.split(' ').length;
    const sameParagraph = current && !text.slice(current.end, start).includes('\n');
    if (groupWords && current && chunks.length > 1 && sameParagraph && current.words + words <= groupWords) {
      current.end = end;
      current.spoken += ` ${spoken}`;
      current.words += words;
    } else {
      current = { start, end, spoken, words };
      chunks.push(current);
    }
  }
  return chunks;
}

// Markdown marks are for the page, not the ear.
function speakable(segment) {
  return segment
    .replace(/^[ \t]*(#{1,6}|[-*+]|\d+\.|>)[ \t]+/gm, '')
    .replace(/[*_~`#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function systemVoices() {
  if (!('speechSynthesis' in window)) return [];
  const all = speechSynthesis.getVoices();
  const english = all.filter(voice => /^en([-_]|$)/i.test(voice.lang));
  return (english.length ? english : all)
    .slice()
    .sort((a, b) => voiceScore(b) - voiceScore(a) || a.name.localeCompare(b.name));
}

function voiceScore(voice) {
  return (/natural/i.test(voice.name) ? 4 : 0) + (/^en-US/i.test(voice.lang) ? 2 : 0) + (voice.default ? 1 : 0);
}

export function whenVoicesReady() {
  if (!('speechSynthesis' in window) || speechSynthesis.getVoices().length) return Promise.resolve();
  return new Promise(resolve => {
    speechSynthesis.addEventListener('voiceschanged', () => resolve(), { once: true });
    setTimeout(resolve, 2000);
  });
}

// status: 'ready' (your voices are listed), 'starting' (VoiceStudio is loading),
// 'off' (this PC's server answered, but VoiceStudio isn't running), or
// 'unavailable' (no local server, for example on the phone).
export async function voiceStudioProfiles() {
  try {
    const health = await fetch('voicestudio/health', { cache: 'no-store' });
    if (health.status === 503) return { status: 'starting', profiles: [] };
    if (health.status === 502 || health.status === 504) return { status: 'off', profiles: [] };
    if (!health.ok) return { status: 'unavailable', profiles: [] };
    const response = await fetch('voicestudio/profiles', { cache: 'no-store' });
    if (!response.ok) return { status: 'off', profiles: [] };
    const list = await response.json();
    const profiles = (Array.isArray(list) ? list : [])
      .filter(profile => profile && profile.id != null)
      .map(profile => ({ id: String(profile.id), name: String(profile.name ?? 'Your voice') }));
    return { status: 'ready', profiles };
  } catch {
    return { status: 'unavailable', profiles: [] };
  }
}

async function fetchClip(text, profileId, speed, signal) {
  const form = new FormData();
  form.append('text', text);
  form.append('profile_id', profileId);
  form.append('speed', String(speed));
  const response = await fetch('voicestudio/generate', { method: 'POST', body: form, signal });
  if (!response.ok) throw new Error(`VoiceStudio answered ${response.status}`);
  if (!(response.headers.get('content-type') ?? '').startsWith('audio/')) throw new Error('VoiceStudio did not send audio');
  return URL.createObjectURL(await response.blob());
}

// voice is { kind: 'voicestudio', profileId } or { kind: 'system', voice }.
// onChunk(chunk) fires as each chunk starts. onDone() fires when everything was read.
// stop() ends reading without calling onDone.
export function createReader({ onChunk, onDone, onNotice }) {
  let session = 0;
  let active = false;
  let audio = null;
  let controller = null;
  let utterance = null;

  function stop() {
    session += 1;
    active = false;
    controller?.abort();
    controller = null;
    if (audio) {
      audio.pause();
      audio = null;
    }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    utterance = null;
  }

  async function start(chunks, voice, speed) {
    stop();
    const mine = session;
    const isCurrent = () => session === mine;
    active = true;
    let next = 0;
    let chosen = voice;
    if (chosen.kind === 'voicestudio') {
      try {
        next = await playVoiceStudio(chunks, chosen.profileId, speed, isCurrent, index => { next = index; });
      } catch (error) {
        if (!isCurrent()) return;
        console.warn('VoiceStudio read-aloud failed', error);
        onNotice('Your VoiceStudio voice stopped answering, so the built-in voice is taking over.');
        await whenVoicesReady();
        chosen = { kind: 'system', voice: systemVoices()[0] ?? null };
      }
    }
    if (chosen.kind === 'system' && isCurrent()) await playSystem(chunks.slice(next), chosen.voice, speed, isCurrent);
    if (isCurrent()) {
      active = false;
      onDone();
    }
  }

  // Plays chunk by chunk, asking VoiceStudio for the next clip while the current one plays.
  async function playVoiceStudio(chunks, profileId, speed, isCurrent, reached) {
    controller = new AbortController();
    const { signal } = controller;
    let pending = fetchClip(chunks[0].spoken, profileId, speed, signal);
    for (let i = 0; i < chunks.length; i += 1) {
      reached(i);
      const url = await pending;
      if (!isCurrent()) {
        URL.revokeObjectURL(url);
        return i;
      }
      pending = i + 1 < chunks.length ? fetchClip(chunks[i + 1].spoken, profileId, speed, signal) : null;
      pending?.catch(() => {});
      onChunk(chunks[i]);
      try {
        await playUrl(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (!isCurrent()) return i;
    }
    return chunks.length;
  }

  function playUrl(url) {
    return new Promise((resolve, reject) => {
      const player = new Audio(url);
      audio = player;
      player.onended = () => resolve();
      player.onpause = () => {
        if (!player.ended) resolve();
      };
      player.onerror = () => reject(new Error('The voice clip could not play.'));
      player.play().catch(reject);
    });
  }

  function playSystem(chunks, voice, speed, isCurrent) {
    if (!('speechSynthesis' in window)) {
      onNotice('This browser can’t read aloud.');
      return Promise.resolve();
    }
    return new Promise(resolve => {
      let i = 0;
      const speakNext = () => {
        if (!isCurrent() || i >= chunks.length) {
          resolve();
          return;
        }
        const chunk = chunks[i];
        i += 1;
        const spoken = new SpeechSynthesisUtterance(chunk.spoken);
        if (voice) {
          spoken.voice = voice;
          spoken.lang = voice.lang;
        } else {
          spoken.lang = 'en-US';
        }
        spoken.rate = speed;
        spoken.onstart = () => {
          if (isCurrent()) onChunk(chunk);
        };
        spoken.onend = speakNext;
        spoken.onerror = speakNext;
        // Keep a reference: Chrome can drop the events of an utterance nothing points to.
        utterance = spoken;
        speechSynthesis.speak(spoken);
      };
      speechSynthesis.cancel();
      setTimeout(speakNext, 50);
    });
  }

  return {
    get active() {
      return active;
    },
    start,
    stop,
  };
}
