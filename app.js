// Writing App: a plain-page editor for stories.
// Pages are saved in this browser (IndexedDB) and synced with Google Drive (sync.js):
// a story is a Drive folder and a page is a .md file. The plot is the story's plot.md.
import * as store from './store.js';
import { THEMES, FONTS, SIZES, loadPrefs, savePrefs, applyLook, showingDark, onDeviceThemeChange } from './prefs.js';
import { createDictation, formatDictation } from './dictation.js';
import {
  createReader, splitForReading, sentenceStart, systemVoices, whenVoicesReady, voiceStudioProfiles,
} from './readaloud.js';
import * as grammar from './grammar.js';
import * as plots from './plot.js';
import { HELP, buildRequest, buildPlotRequest, extractPlot, scopeLabel } from './companion.js';
import * as drive from './drive.js';
import { createSync } from './sync.js';

const SAVE_DELAY_MS = 400;
const TYPING_HIDE_MS = 1800;
const TOAST_MS = 6000;
const VOICESTUDIO_CHUNK_WORDS = 45;
const CHECK_DELAY_MS = 700;
const DRIVE_PUSH_DELAY_MS = 15_000;
const RETURN_SYNC_GAP_MS = 20_000;
const SILENT_RETRY_MS = 10 * 60_000;
const CLAUDE_URL = 'https://claude.ai/new';
const APP_VERSION = '2026-11-09 e'; // shown in Settings, so you can tell which version a device is running
const BACKUP_KEY = 'writing-app:unsaved';
const DEFAULT_STORY = 'My story';
const APP_NAME = 'Writing App';
const VOICE_SAMPLE = 'This is how your story will sound when it is read aloud.';

const $ = id => document.getElementById(id);
const editor = $('editor');
const menuButton = $('menu-button');
const dictateButton = $('dictate-button');
const readButton = $('read-button');
const themeButton = $('theme-button');
const panel = $('panel');
const scrim = $('scrim');
const panelTabs = $('panel-tabs');
const tabPages = $('tab-pages');
const tabLook = $('tab-look');
const viewPages = $('view-pages');
const viewLook = $('view-look');
const pageList = $('page-list');
const currentName = $('current-name');
const currentInfo = $('current-info');
const panelNote = $('panel-note');
const themeOptions = $('theme-options');
const followDevice = $('follow-device');
const fontOptions = $('font-options');
const sizeOptions = $('size-options');
const voiceSelect = $('voice-select');
const voiceNote = $('voice-note');
const speedInput = $('speed-input');
const speedValue = $('speed-value');
const voiceTest = $('voice-test');
const statusBar = $('status');
const statusText = $('status-text');
const statusStop = $('status-stop');
const toast = $('toast');
const dialog = $('dialog');
const dialogForm = dialog.querySelector('form');
const dialogTitle = $('dialog-title');
const dialogInput = $('dialog-input');
const dialogOk = $('dialog-ok');
const dialogCancel = $('dialog-cancel');
const claudeButton = $('claude-button');
const syncButton = $('sync-button');
const tabPlot = $('tab-plot');
const viewPlot = $('view-plot');
const marksLayer = $('marks');
const fix = $('fix');
const promptCard = $('prompt-card');
const grammarOn = $('grammar-on');
const driveStatus = $('drive-status');
const clientIdInput = $('client-id');
const claudeDialog = $('claude-dialog');
const sectionDialog = $('section-dialog');
const pasteDialog = $('paste-dialog');

const finePointer = window.matchMedia('(pointer: fine)').matches;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const nativeAutoSize = CSS.supports('field-sizing', 'content');
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const prefs = loadPrefs();
let pages = [];
let current = null;
let unsaved = false;
let saveTimer = 0;
let typingTimer = 0;
let toastTimer = 0;
let toastSerial = 0; // counts messages shown, so a general message never replaces a specific one
let statusOwner = null; // 'dictation' or 'reading' while the status pill is showing
let readingPage = false; // true while the voice reads the page (not the voice test)
let lastReadChunk = null;
let mirror = null;
let marks = [];            // grammar underlines for the open page
let marksText = '';        // the text the underlines were placed on
let checkTimer = 0;
let checkRun = 0;
let fixMark = null;        // the underline the suggestion box is showing
let pushTimer = 0;
let lastPull = 0;
let typedSinceVisible = false;

const sync = createSync({
  getPages: () => pages,
  createPage,
  putPage: page => store.putPage(page),
  removePage: removeSyncedPage,
  uniqueName,
  onTaken: page => {
    if (page === current && editor.value !== page.text) showText(page.text);
  },
  onPagesChanged: onSyncedPages,
  notify: message => showToast(message),
  onState: showSyncState,
});

const dictation = createDictation({
  onFinal: insertDictated,
  onInterim: text => {
    if (statusOwner !== 'dictation') return;
    const shown = text.length > 60 ? `…${text.slice(-60)}` : text; // the end of a long sentence is what's new
    statusText.textContent = shown ? `“${shown}”` : 'Listening…';
  },
  onStart: () => {
    dictateButton.setAttribute('aria-pressed', 'true');
    showStatus('dictation', 'Listening…');
  },
  onStop: () => {
    dictateButton.setAttribute('aria-pressed', 'false');
    hideStatus('dictation');
  },
  onError: code => showToast(dictationMessage(code)),
});

const reader = createReader({
  onChunk: chunk => {
    lastReadChunk = chunk;
    if (readingPage) followAlong(chunk);
  },
  onNotice: message => showToast(message),
  onDone: () => endReading(lastReadChunk?.end),
});

start().catch(error => {
  console.error(error);
  editor.readOnly = true;
  editor.placeholder = 'This browser is blocking storage, so your writing can’t be saved here. Try reopening the app.';
  warn('Your pages couldn’t be loaded. Reopen the app to try again.');
});

async function start() {
  const signInAnswer = drive.finishSignIn();
  applyLook(prefs);
  updateThemeButton();
  navigator.storage?.persist?.()?.catch(() => {});
  pages = await store.allPages();
  await recoverUnsaved();
  if (pages.length === 0) await addPage(DEFAULT_STORY, 'Chapter 1');
  const lastId = await store.getMeta('lastPageId');
  buildLookSettings();
  $('app-version').textContent = `Writing App, version ${APP_VERSION}. Updates arrive by themselves when you open the app with an internet connection.`;
  bindEvents();
  await openPage(pages.find(page => page.id === lastId) ?? sortedPages()[0], { focus: finePointer });
  registerServiceWorker();
  showSyncState(sync.status);
  await afterSignIn(signInAnswer);
}

function bindEvents() {
  editor.addEventListener('input', onInput);
  editor.addEventListener('pointerdown', () => {
    if (reader.active) stopReading();
  });
  // Keep the cursor where it is when a corner button is pressed.
  for (const button of [dictateButton, readButton, themeButton, statusStop, claudeButton, syncButton]) {
    button.addEventListener('pointerdown', event => event.preventDefault());
  }
  fix.addEventListener('pointerdown', event => event.preventDefault());
  menuButton.addEventListener('click', () => openPanel());
  dictateButton.addEventListener('click', toggleDictation);
  readButton.addEventListener('click', toggleReading);
  themeButton.addEventListener('click', toggleLightDark);
  claudeButton.addEventListener('click', () => openClaude());
  syncButton.addEventListener('click', onSyncButton);
  statusStop.addEventListener('click', stopEverything);
  scrim.addEventListener('click', () => closePanel());
  tabPages.addEventListener('click', () => showView('pages'));
  tabPlot.addEventListener('click', () => showView('plot'));
  tabLook.addEventListener('click', () => showView('look'));
  bindGrammar();
  bindPlot();
  bindClaude();
  bindDrive();
  panelTabs.addEventListener('keydown', onTabKey);
  pageList.addEventListener('click', onPickPage);
  $('new-page').addEventListener('click', onNewPage);
  $('new-story').addEventListener('click', onNewStory);
  $('rename-page').addEventListener('click', onRename);
  $('download-page').addEventListener('click', onDownload);
  $('delete-page').addEventListener('click', onDelete);
  themeOptions.addEventListener('change', onThemePicked);
  followDevice.addEventListener('change', onFollowDevice);
  fontOptions.addEventListener('change', event => {
    prefs.font = event.target.value;
    lookChanged();
  });
  sizeOptions.addEventListener('change', event => {
    prefs.size = event.target.value;
    lookChanged();
  });
  voiceSelect.addEventListener('change', () => {
    prefs.voice = voiceSelect.value;
    savePrefs(prefs);
  });
  speedInput.addEventListener('input', onSpeed);
  voiceTest.addEventListener('click', testVoice);
  onDeviceThemeChange(() => {
    if (prefs.mode === 'auto') lookChanged(false);
  });
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('mousemove', stopTyping, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      typedSinceVisible = false;
      refreshFromStore().then(syncOnReturn);
      return;
    }
    dictation?.stop();
    saveNow({ backup: true }).then(() => pushToDrive({ keepalive: true }));
  });
  window.addEventListener('pagehide', () => saveNow({ backup: true }));
  window.addEventListener('online', () => syncOnReturn());
  if (!nativeAutoSize) window.addEventListener('resize', autoSize);
}

// Writing and saving

function onInput() {
  if (reader.active && readingPage) stopReading();
  typedSinceVisible = true;
  current.text = editor.value;
  current.updatedAt = Date.now();
  current.dirty = true;
  unsaved = true;
  autoSize();
  followMarks();
  hideFix();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(), SAVE_DELAY_MS);
  document.body.classList.add('typing');
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, TYPING_HIDE_MS);
}

function stopTyping() {
  document.body.classList.remove('typing');
}

async function saveNow({ backup = false } = {}) {
  clearTimeout(saveTimer);
  if (!current || !unsaved) return;
  const page = current;
  page.caret = editor.selectionStart;
  // A quick synchronous copy, in case the app closes before the database write finishes.
  if (backup) writeBackup(page);
  unsaved = false;
  try {
    await store.putPage(page);
    schedulePush();
  } catch (error) {
    console.error('Save failed', error);
    if (page === current) unsaved = true;
    writeBackup(page);
    warn('Couldn’t save to this device. Download a copy of this page now.');
  }
}

function writeBackup(page) {
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify({ id: page.id, text: page.text, updatedAt: page.updatedAt }));
  } catch {
    // Storage is full or blocked. The database is still the main copy.
  }
}

async function recoverUnsaved() {
  let backup = null;
  try {
    backup = JSON.parse(localStorage.getItem(BACKUP_KEY) ?? 'null');
  } catch {
    backup = null;
  }
  const page = backup && pages.find(p => p.id === backup.id);
  if (page && backup.updatedAt > page.updatedAt && backup.text !== page.text) {
    Object.assign(page, { text: backup.text, updatedAt: backup.updatedAt, dirty: true });
    await store.putPage(page);
  }
  try {
    localStorage.removeItem(BACKUP_KEY);
  } catch {
    // Nothing to clean up.
  }
}

function autoSize() {
  if (nativeAutoSize) return;
  const scrollY = window.scrollY;
  editor.style.height = 'auto';
  editor.style.height = `${editor.scrollHeight}px`;
  window.scrollTo(0, scrollY);
}

// Pages

async function openPage(page, { focus = false } = {}) {
  if (current && current !== page) {
    stopEverything();
    current.caret = editor.selectionStart;
    await saveNow();
  }
  current = page;
  editor.value = page.text;
  autoSize();
  const caret = Math.min(page.caret ?? page.text.length, page.text.length);
  editor.setSelectionRange(caret, caret);
  document.title = `${page.name} · ${APP_NAME}`;
  window.scrollTo(0, 0);
  store.setMeta('lastPageId', page.id).catch(() => {});
  clearMarks();
  scheduleCheck(0);
  renderPromptCard();
  if (focus) editor.focus({ preventScroll: true });
}

// If the app is open in a second window on this device and that window changed this page,
// show its newer words when you come back here (only if nothing here is unsaved).
async function refreshFromStore() {
  if (!current || unsaved) return;
  const saved = (await store.allPages().catch(() => [])).find(page => page.id === current.id);
  if (!saved || unsaved || saved.updatedAt <= current.updatedAt || saved.text === current.text) return;
  Object.assign(current, { text: saved.text, name: saved.name, updatedAt: saved.updatedAt, dirty: saved.dirty, remote: saved.remote });
  showText(current.text);
}

// Puts new text from Drive on screen, keeping the cursor near where it was.
function showText(text) {
  const caret = Math.min(editor.selectionStart, text.length);
  const scrollY = window.scrollY;
  editor.value = text;
  autoSize();
  editor.setSelectionRange(caret, caret);
  window.scrollTo(0, scrollY);
  clearMarks();
  scheduleCheck(0);
}

function createPage({ story, name, text = '', dirty = true, remote = null }) {
  const now = Date.now();
  const page = {
    id: crypto.randomUUID(),
    story,
    name,
    text,
    caret: 0,
    createdAt: now,
    updatedAt: now,
    dirty,
    remote: remote ?? { fileId: null, folderId: null, md5: '', name: '', folderName: '' },
  };
  pages.push(page);
  return page;
}

async function addPage(story, name, text = '') {
  const page = createPage({ story, name: uniqueName(story, name), text });
  await store.putPage(page);
  return page;
}

// A page whose Drive file was trashed on another device (it had no unsynced words here).
async function removeSyncedPage(page) {
  await store.deletePage(page.id);
  pages = pages.filter(p => p !== page);
}

// Pages, apart from each story's plot (which lives in the Plot tab).
function sortedPages() {
  return pages
    .filter(page => !plots.isPlotName(page.name))
    .sort((a, b) => collator.compare(a.story, b.story) || collator.compare(a.name, b.name));
}

function uniqueName(story, name, except = null) {
  const taken = new Set(pages.filter(p => p.story === story && p !== except).map(p => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let n = 2;
  while (taken.has(`${name} ${n}`.toLowerCase())) n += 1;
  return `${name} ${n}`;
}

function nextChapterName(story) {
  const numbers = pages
    .filter(p => p.story === story)
    .map(p => Number(/^chapter (\d+)$/i.exec(p.name)?.[1] ?? 0));
  return `Chapter ${Math.max(0, ...numbers) + 1}`;
}

// Names become Drive file and folder names later, so keep them plain.
function cleanName(value) {
  return (value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.md$/i, '')
    .slice(0, 120)
    .trim();
}

// Menu

function openPanel(view = null) {
  stopEverything();
  hideFix();
  saveNow();
  if (view) showView(view);
  renderPanel();
  if (!viewPlot.hidden) renderPlot();
  if (!viewLook.hidden) {
    syncLookSettings();
    renderDriveSettings();
  }
  editor.blur();
  panel.classList.add('open');
  scrim.classList.add('open');
  menuButton.setAttribute('aria-expanded', 'true');
  const active = pageList.querySelector('[aria-current="page"]');
  active?.scrollIntoView({ block: 'nearest' });
  const target = !viewPages.hidden ? (active ?? $('new-page')) : (!viewPlot.hidden ? tabPlot : tabLook);
  target.focus({ preventScroll: true });
}

function closePanel({ focusEditor = finePointer } = {}) {
  if (!panel.classList.contains('open')) return;
  panel.classList.remove('open');
  scrim.classList.remove('open');
  menuButton.setAttribute('aria-expanded', 'false');
  if (focusEditor) editor.focus({ preventScroll: true });
}

const VIEWS = ['pages', 'plot', 'look'];

function showView(name) {
  const tabs = { pages: tabPages, plot: tabPlot, look: tabLook };
  const views = { pages: viewPages, plot: viewPlot, look: viewLook };
  for (const key of VIEWS) {
    views[key].hidden = key !== name;
    tabs[key].setAttribute('aria-selected', String(key === name));
    tabs[key].tabIndex = key === name ? 0 : -1;
  }
  if (name === 'plot') renderPlot();
  if (name === 'look') {
    syncLookSettings();
    renderDriveSettings();
    refreshVoices();
  }
}

function onTabKey(event) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const now = VIEWS.findIndex(key => !{ pages: viewPages, plot: viewPlot, look: viewLook }[key].hidden);
  const next = VIEWS[(now + (event.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length];
  showView(next);
  ({ pages: tabPages, plot: tabPlot, look: tabLook })[next].focus();
}

function renderPanel() {
  currentName.textContent = current.name;
  currentInfo.textContent = `${current.story} · ${wordCountLabel(current.text)}`;
  if (!panelNote.classList.contains('warn')) panelNote.textContent = storageNote();
  const groups = new Map();
  for (const page of sortedPages()) {
    if (!groups.has(page.story)) groups.set(page.story, []);
    groups.get(page.story).push(page);
  }
  const items = [];
  for (const [story, storyPages] of groups) {
    const heading = document.createElement('h2');
    heading.className = 'story-name';
    heading.textContent = story;
    items.push(heading);
    for (const page of storyPages) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'page-item';
      button.dataset.id = page.id;
      button.textContent = page.name;
      if (page === current) button.setAttribute('aria-current', 'page');
      items.push(button);
    }
  }
  pageList.replaceChildren(...items);
}

function wordCountLabel(text) {
  const count = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
  return `${count.toLocaleString()} ${count === 1 ? 'word' : 'words'}`;
}

async function onPickPage(event) {
  const button = event.target.closest('.page-item');
  const page = button && pages.find(p => p.id === button.dataset.id);
  if (!page) return;
  await openPage(page);
  closePanel();
}

async function onNewPage() {
  const page = await addPage(current.story, nextChapterName(current.story));
  await openPage(page);
  closePanel({ focusEditor: true });
}

async function onNewStory() {
  const story = cleanName(await ask({ title: 'Name your new story', ok: 'Create' }));
  if (!story) return;
  const page = await addPage(story, nextChapterName(story));
  await openPage(page);
  closePanel({ focusEditor: true });
}

async function onRename() {
  let name = cleanName(await ask({ title: 'Rename this page', value: current.name, ok: 'Rename' }));
  if (plots.isPlotName(name) && !plots.isPlotName(current.name)) name = 'Plot notes'; // "plot" is the Plot tab's file
  if (!name || name === current.name) return;
  current.name = uniqueName(current.story, name, current);
  current.dirty = true;
  unsaved = true;
  await saveNow();
  document.title = `${current.name} · ${APP_NAME}`;
  renderPanel();
}

async function onDownload() {
  await saveNow();
  const url = URL.createObjectURL(new Blob([current.text], { type: 'text/markdown;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `${current.name}.md` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function onDelete() {
  const inDrive = Boolean(current.remote?.fileId);
  const confirmed = await ask({
    title: inDrive
      ? `Delete “${current.name}”? It’s removed from this device, and its file moves to your Google Drive trash, where you can get it back for 30 days.`
      : `Delete “${current.name}”? This can’t be undone.`,
    input: false,
    ok: 'Delete',
    danger: true,
  });
  if (!confirmed) return;
  const doomed = current;
  clearTimeout(saveTimer);
  unsaved = false;
  current = null;
  sync.forget(doomed);
  await store.deletePage(doomed.id);
  pages = pages.filter(p => p !== doomed);
  schedulePush(1000);
  const next = sortedPages().find(p => p.story === doomed.story)
    ?? sortedPages()[0]
    ?? (await addPage(DEFAULT_STORY, 'Chapter 1'));
  await openPage(next);
  renderPanel();
}

// Look: themes, fonts, text sizes

function buildLookSettings() {
  themeOptions.replaceChildren(...THEMES.map(theme => {
    const label = Object.assign(document.createElement('label'), { className: 'swatch', title: theme.name });
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'theme', value: theme.id });
    const ring = Object.assign(document.createElement('span'), { className: 'swatch-ring' });
    const chip = Object.assign(document.createElement('span'), { className: 'swatch-chip', textContent: 'Aa' });
    chip.dataset.theme = theme.id;
    ring.append(chip);
    const name = Object.assign(document.createElement('span'), { className: 'swatch-name', textContent: theme.name });
    label.append(input, ring, name);
    return label;
  }));
  fontOptions.replaceChildren(...FONTS.map(font => segment('font', font, { font: font.id })));
  sizeOptions.replaceChildren(...SIZES.map(size => segment('size', size)));
  speedInput.value = String(prefs.speed);
  speedValue.textContent = speedLabel(prefs.speed);
}

function segment(group, option, dataset = {}) {
  const label = Object.assign(document.createElement('label'), { className: 'segment' });
  const input = Object.assign(document.createElement('input'), { type: 'radio', name: group, value: option.id });
  const text = Object.assign(document.createElement('span'), { textContent: option.name });
  Object.assign(text.dataset, dataset);
  label.append(input, text);
  return label;
}

function syncLookSettings() {
  const shown = document.documentElement.dataset.theme;
  for (const input of themeOptions.querySelectorAll('input')) input.checked = input.value === shown;
  followDevice.checked = prefs.mode === 'auto';
  for (const input of fontOptions.querySelectorAll('input')) input.checked = input.value === prefs.font;
  for (const input of sizeOptions.querySelectorAll('input')) input.checked = input.value === prefs.size;
}

function lookChanged(save = true) {
  if (save) savePrefs(prefs);
  applyLook(prefs);
  syncLookSettings();
  updateThemeButton();
  autoSize();
}

function updateThemeButton() {
  const dark = showingDark(prefs);
  themeButton.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  themeButton.title = dark ? 'Light mode' : 'Dark mode';
}

function toggleLightDark() {
  prefs.mode = showingDark(prefs) ? 'light' : 'dark';
  lookChanged();
}

// Picking a theme always shows it right away.
function onThemePicked(event) {
  const theme = THEMES.find(t => t.id === event.target.value);
  if (!theme) return;
  prefs[theme.dark ? 'dark' : 'light'] = theme.id;
  prefs.mode = theme.dark ? 'dark' : 'light';
  lookChanged();
}

function onFollowDevice() {
  prefs.mode = followDevice.checked ? 'auto' : (showingDark(prefs) ? 'dark' : 'light');
  lookChanged();
}

// Dictation

function toggleDictation() {
  if (!dictation) {
    showToast('Dictation isn’t available in this browser. Use the mic key on your keyboard instead, or on Windows press the Windows key + H.');
    return;
  }
  if (dictation.active) {
    dictation.stop();
    return;
  }
  stopReading();
  if (finePointer) editor.focus({ preventScroll: true });
  dictation.start();
}

function insertDictated(raw) {
  const result = formatDictation(editor.value.slice(0, editor.selectionStart), raw);
  if (!result) return;
  if (result.trimBefore) editor.setSelectionRange(editor.selectionStart - result.trimBefore, editor.selectionEnd);
  insertAtCursor(result.text);
}

// insertText keeps Ctrl+Z working. Without focus (on the phone), fall back to setRangeText.
function insertAtCursor(text) {
  if (document.activeElement === editor && document.execCommand(text ? 'insertText' : 'delete', false, text)) return;
  editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end');
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

function dictationMessage(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'The microphone is blocked for this app. Allow it in your browser’s site settings for this app, then tap the mic again.';
    case 'audio-capture':
      return 'No microphone was found.';
    case 'network':
      return 'Dictation needs the internet, because your browser turns speech into text online.';
    case 'language-not-supported':
      return 'Dictation doesn’t support English in this browser.';
    default:
      return 'Dictation stopped unexpectedly. Tap the mic to try again.';
  }
}

// Read aloud

async function toggleReading() {
  if (reader.active || statusOwner === 'reading') {
    stopReading();
    return;
  }
  dictation?.stop();
  await saveNow();
  const range = readRange();
  if (splitForReading(editor.value, range.start, range.end).length === 0) {
    showToast('There’s nothing to read on this page yet.');
    return;
  }
  readButton.setAttribute('aria-pressed', 'true');
  showStatus('reading', 'Getting the voice ready…');
  const voice = await chooseVoice();
  if (statusOwner !== 'reading') return; // stopped while the voice was getting ready
  const groupWords = voice.kind === 'voicestudio' ? VOICESTUDIO_CHUNK_WORDS : 0;
  const chunks = splitForReading(editor.value, range.start, range.end, groupWords);
  readingPage = true;
  lastReadChunk = null;
  statusText.textContent = `Reading aloud · ${voice.name}`;
  reader.start(chunks, voice, prefs.speed);
}

// The selection, or from the sentence at the cursor, or the whole page if the cursor is at the end.
function readRange() {
  const { selectionStart: start, selectionEnd: end, value } = editor;
  if (end > start) return { start, end };
  if (start >= value.trimEnd().length) return { start: 0, end: value.length };
  return { start: sentenceStart(value, start), end: value.length };
}

async function chooseVoice() {
  const choice = prefs.voice;
  if (choice.startsWith('sys:')) {
    await whenVoicesReady();
    const voice = systemVoices().find(v => v.voiceURI === choice.slice(4));
    if (voice) return { kind: 'system', voice, name: shortVoiceName(voice.name) };
  }
  const studio = await voiceStudioProfiles();
  if (studio.status === 'ready' && studio.profiles.length) {
    const profile = studio.profiles.find(p => `vs:${p.id}` === choice)
      ?? studio.profiles.find(p => /clean/i.test(p.name))
      ?? studio.profiles[0];
    return { kind: 'voicestudio', profileId: profile.id, name: profile.name };
  }
  if (studio.status === 'off') showToast('VoiceStudio isn’t open, so the built-in voice is reading. Open VoiceStudio to hear your own voice.');
  if (studio.status === 'starting') showToast('VoiceStudio is still starting, so the built-in voice is reading for now.');
  await whenVoicesReady();
  const voice = systemVoices()[0] ?? null;
  return { kind: 'system', voice, name: voice ? shortVoiceName(voice.name) : 'built-in voice' };
}

function shortVoiceName(name) {
  return name.replace(/\s*Online\s*\(Natural\)/i, '').replace(/\s+-\s+.*$/, '');
}

function followAlong(chunk) {
  if (finePointer) {
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(chunk.start, chunk.end);
  }
  scrollToIndex(chunk.start);
}

// Scrolls so the text at `index` sits in the upper part of the screen.
function scrollToIndex(index) {
  if (!mirror) {
    mirror = Object.assign(document.createElement('div'), { className: 'mirror' });
    mirror.setAttribute('aria-hidden', 'true');
    document.body.append(mirror);
  }
  const style = getComputedStyle(editor);
  for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'tabSize']) {
    mirror.style[property] = style[property];
  }
  mirror.style.width = `${editor.clientWidth}px`;
  mirror.textContent = editor.value.slice(0, index);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.append(marker);
  const y = editor.getBoundingClientRect().top + window.scrollY + marker.offsetTop;
  mirror.textContent = '';
  const top = window.scrollY;
  if (y < top + 96 || y > top + window.innerHeight * 0.7) {
    window.scrollTo({ top: Math.max(0, y - window.innerHeight * 0.3), behavior: reducedMotion ? 'auto' : 'smooth' });
  }
}

function stopReading() {
  if (!reader.active && statusOwner !== 'reading') return;
  reader.stop();
  endReading(lastReadChunk?.start);
}

// Leaves the cursor where reading stopped, so the read button picks up from there.
function endReading(caretAt) {
  readButton.setAttribute('aria-pressed', 'false');
  hideStatus('reading');
  if (readingPage && caretAt !== undefined) editor.setSelectionRange(caretAt, caretAt);
  readingPage = false;
  lastReadChunk = null;
}

async function testVoice() {
  stopEverything();
  voiceTest.disabled = true;
  try {
    readButton.setAttribute('aria-pressed', 'true');
    showStatus('reading', 'Getting the voice ready…');
    const voice = await chooseVoice();
    if (statusOwner !== 'reading') return;
    readingPage = false;
    statusText.textContent = `Testing · ${voice.name}`;
    reader.start(splitForReading(VOICE_SAMPLE, 0, VOICE_SAMPLE.length), voice, prefs.speed);
  } finally {
    voiceTest.disabled = false;
  }
}

async function refreshVoices() {
  voiceSelect.disabled = true;
  voiceNote.textContent = 'Looking for voices…';
  const [studio] = await Promise.all([voiceStudioProfiles(), whenVoicesReady()]);
  const options = [new Option('Automatic: your own voice when VoiceStudio is open', '')];
  if (studio.profiles.length) {
    const group = Object.assign(document.createElement('optgroup'), { label: 'Your voices (VoiceStudio)' });
    for (const profile of studio.profiles) group.append(new Option(profile.name, `vs:${profile.id}`));
    options.push(group);
  }
  const builtIn = systemVoices();
  if (builtIn.length) {
    const group = Object.assign(document.createElement('optgroup'), { label: 'Built-in voices' });
    for (const voice of builtIn) group.append(new Option(shortVoiceName(voice.name), `sys:${voice.voiceURI}`));
    options.push(group);
  }
  voiceSelect.replaceChildren(...options);
  // Keep a saved choice that isn't available right now, so it isn't lost.
  if (prefs.voice && ![...voiceSelect.options].some(option => option.value === prefs.voice)) {
    const label = prefs.voice.startsWith('vs:') ? 'Your saved VoiceStudio voice (open VoiceStudio)' : 'Your saved voice';
    voiceSelect.append(new Option(label, prefs.voice));
  }
  voiceSelect.value = prefs.voice;
  voiceNote.textContent = {
    ready: 'VoiceStudio is open, so your own voices are listed.',
    starting: 'VoiceStudio is starting up. Reopen this tab in a moment to see your voices.',
    off: 'Open VoiceStudio on this PC to read in your own voice.',
    unavailable: 'Your own VoiceStudio voice works when you start the app from the desktop icon on your PC.',
  }[studio.status];
  voiceSelect.disabled = false;
}

function onSpeed() {
  prefs.speed = Number(speedInput.value);
  speedValue.textContent = speedLabel(prefs.speed);
  savePrefs(prefs);
}

function speedLabel(speed) {
  return `${speed.toFixed(2).replace(/0$/, '')}×`;
}

// Status pill and messages

function showStatus(owner, text) {
  statusOwner = owner;
  statusText.textContent = text;
  statusBar.hidden = false;
}

function hideStatus(owner) {
  if (statusOwner !== owner) return;
  statusOwner = null;
  statusBar.hidden = true;
}

function showToast(message) {
  toastSerial += 1;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, TOAST_MS);
}

function stopEverything() {
  dictation?.stop();
  stopReading();
}

// Small dialog for names and confirmations. Resolves to the text, true, or null if cancelled.
// It answers from the submit and cancel events directly, not the dialog's later "close" event.
function ask({ title, value = '', ok = 'OK', danger = false, input = true }) {
  dialogTitle.textContent = title;
  dialogInput.hidden = !input;
  dialogInput.value = value;
  dialogOk.textContent = ok;
  dialogOk.classList.toggle('danger', danger);
  return new Promise(resolve => {
    const finish = answer => {
      dialogForm.removeEventListener('submit', onSubmit);
      dialogCancel.removeEventListener('click', onCancel);
      dialog.removeEventListener('cancel', onCancel);
      if (dialog.open) dialog.close();
      resolve(answer);
    };
    const onSubmit = event => {
      event.preventDefault();
      finish(input ? dialogInput.value : true);
    };
    const onCancel = event => {
      event.preventDefault();
      finish(null);
    };
    dialogForm.addEventListener('submit', onSubmit);
    dialogCancel.addEventListener('click', onCancel);
    dialog.addEventListener('cancel', onCancel);
    dialog.showModal();
    if (input) {
      dialogInput.focus();
      dialogInput.select();
    } else {
      dialogOk.focus();
    }
  });
}

function onKeyDown(event) {
  if (dialog.open || claudeDialog.open || sectionDialog.open || pasteDialog.open) return;
  if ((event.ctrlKey || event.metaKey) && event.key?.toLowerCase() === 's') {
    event.preventDefault();
    saveNow();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    if (!fix.hidden) hideFix();
    else if (dictation?.active || reader.active || statusOwner) stopEverything();
    else if (panel.classList.contains('open')) closePanel();
    else openPanel();
  }
}

function warn(message) {
  panelNote.textContent = message;
  panelNote.classList.add('warn');
  menuButton.classList.add('alert');
  menuButton.setAttribute('aria-label', `Open menu. ${message}`);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.register('sw.js').catch(error => console.warn('Offline support is unavailable:', error));
  // When a new version of the app takes over, load it right away, unless you're in the middle of something.
  if (!hadController) return;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', async () => {
    if (reloaded || unsaved || dictation?.active || reader.active) return;
    reloaded = true;
    await saveNow();
    location.reload();
  });
}

function storageNote() {
  return drive.connected()
    ? 'Saved on this device and in the “Writing App” folder in your Google Drive.'
    : 'Saved in this browser on this device only. Connect Google Drive in Settings so your phone and PC share your pages. Until then, download a copy of anything you can’t lose.';
}

// Spelling and grammar (Harper). The underlines sit in a layer behind the transparent writing area,
// laid out exactly like it, so each underline lands under its word.

function bindGrammar() {
  grammarOn.checked = prefs.grammar;
  editor.spellcheck = !prefs.grammar;
  updateGrammarNote();
  grammarOn.addEventListener('change', () => {
    prefs.grammar = grammarOn.checked;
    savePrefs(prefs);
    editor.spellcheck = !prefs.grammar;
    clearMarks();
    scheduleCheck(0);
  });
  $('grammar-clear').addEventListener('click', async () => {
    await grammar.clearAdded();
    updateGrammarNote();
    scheduleCheck(0);
    showToast('Your added words and ignored suggestions are cleared.');
  });
  editor.addEventListener('click', () => setTimeout(showFixAtCaret, 0));
  document.addEventListener('pointerdown', event => {
    if (!fix.hidden && !fix.contains(event.target) && event.target !== editor) hideFix();
  });
  window.addEventListener('resize', hideFix);
  window.addEventListener('scroll', positionFix, { passive: true });
  $('fix-suggestions').addEventListener('click', onFixPick);
  $('fix-add').addEventListener('click', onFixAdd);
  $('fix-ignore').addEventListener('click', onFixIgnore);
}

function updateGrammarNote() {
  $('grammar-clear').hidden = grammar.addedWords().length === 0;
}

function scheduleCheck(delay = CHECK_DELAY_MS) {
  clearTimeout(checkTimer);
  if (!prefs.grammar) return;
  checkTimer = setTimeout(runCheck, delay);
}

async function runCheck() {
  if (!prefs.grammar || !current) return;
  const run = ++checkRun;
  const page = current;
  const text = editor.value;
  try {
    const found = (await grammar.check(text)).sort((a, b) => a.start - b.start);
    if (run !== checkRun || page !== current || !prefs.grammar) return;
    marks = grammar.shiftMarks(found, text, editor.value); // in case you typed while it checked
    marksText = editor.value;
    if (fixMark) fixMark = marks.find(mark => mark.start === fixMark.start && mark.end === fixMark.end) ?? null;
    renderMarks();
    if (!fixMark) hideFix();
  } catch (error) {
    console.warn('Spelling and grammar checking is unavailable:', error);
    if (run === checkRun) $('grammar-note').textContent = 'The spelling and grammar checker couldn’t start. It downloads once when you’re online, then works offline.';
  }
}

function followMarks() {
  if (!prefs.grammar) return;
  marks = grammar.shiftMarks(marks, marksText, editor.value);
  marksText = editor.value;
  renderMarks();
  scheduleCheck();
}

function clearMarks() {
  marks = [];
  marksText = editor.value;
  renderMarks();
  hideFix();
}

function renderMarks() {
  if (!prefs.grammar) {
    marksLayer.replaceChildren();
    return;
  }
  const text = editor.value;
  const parts = [];
  let at = 0;
  for (const mark of marks) {
    if (mark.start < at || mark.end > text.length) continue;
    if (mark.start > at) parts.push(document.createTextNode(text.slice(at, mark.start)));
    const span = document.createElement('span');
    span.className = mark.spelling ? 'mark spelling' : 'mark';
    span.textContent = text.slice(mark.start, mark.end);
    mark.el = span;
    parts.push(span);
    at = mark.end;
  }
  parts.push(document.createTextNode(`${text.slice(at)}​`));
  marksLayer.replaceChildren(...parts);
}

function showFixAtCaret() {
  const at = editor.selectionStart;
  const mark = prefs.grammar && editor.selectionStart === editor.selectionEnd
    ? marks.find(m => at >= m.start && at <= m.end && m.el?.isConnected)
    : null;
  if (!mark) {
    hideFix();
    return;
  }
  fixMark = mark;
  $('fix-label').textContent = mark.label;
  $('fix-message').textContent = mark.message;
  $('fix-suggestions').replaceChildren(...mark.suggestions.map((suggestion, index) => {
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'fix-pick' });
    button.dataset.index = String(index);
    button.textContent = suggestion.kind === 'remove'
      ? `Remove “${mark.problem.trim()}”`
      : suggestion.kind === 'insert' ? `Add “${suggestion.text}”` : suggestion.text;
    return button;
  }));
  $('fix-add').hidden = !mark.spelling;
  fix.hidden = false;
  positionFix();
}

function positionFix() {
  if (fix.hidden || !fixMark?.el?.isConnected) return;
  const word = fixMark.el.getBoundingClientRect();
  const width = fix.offsetWidth;
  const height = fix.offsetHeight;
  const left = Math.min(Math.max(8, word.left), window.innerWidth - width - 8);
  let top = word.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, word.top - height - 6);
  fix.style.left = `${left}px`;
  fix.style.top = `${top}px`;
}

function hideFix() {
  fix.hidden = true;
  fixMark = null;
}

function onFixPick(event) {
  const button = event.target.closest('button');
  const mark = fixMark;
  const suggestion = button && mark?.suggestions[Number(button.dataset.index)];
  if (!suggestion) return;
  hideFix();
  editor.focus({ preventScroll: true });
  if (suggestion.kind === 'insert') {
    editor.setSelectionRange(mark.end, mark.end);
    insertAtCursor(suggestion.text);
  } else {
    editor.setSelectionRange(mark.start, mark.end);
    insertAtCursor(suggestion.kind === 'remove' ? '' : suggestion.text);
  }
}

async function onFixAdd() {
  const mark = fixMark;
  if (!mark) return;
  hideFix();
  const word = mark.problem.trim();
  marks = marks.filter(m => !(m.spelling && m.problem.trim() === word));
  renderMarks();
  await grammar.addWord(word);
  updateGrammarNote();
  showToast(`“${word}” is in your dictionary now.`);
  scheduleCheck(0);
}

async function onFixIgnore() {
  const mark = fixMark;
  if (!mark) return;
  hideFix();
  marks = marks.filter(m => m !== mark);
  renderMarks();
  await grammar.ignore(mark);
  updateGrammarNote();
}

// Plot planner and the prompt at the top of the page

function plotPageFor(story) {
  return pages.find(page => page.story === story && plots.isPlotName(page.name)) ?? null;
}

function plotFor(story) {
  const page = plotPageFor(story);
  return page ? plots.withIndexes(plots.parsePlot(page.text)) : null;
}

function currentSection() {
  if (!current || plots.isPlotName(current.name)) return null;
  const plot = plotFor(current.story);
  return plot ? plots.sectionForPage(plot, current.name) : null;
}

let promptOpenFor = null; // the page whose full prompt is showing

function renderPromptCard() {
  const plot = current && !plots.isPlotName(current.name) ? plotFor(current.story) : null;
  const section = plot && plots.sectionForPage(plot, current.name);
  promptCard.hidden = !section;
  if (!section) return;
  if (promptOpenFor === null && !current.text.trim()) promptOpenFor = current.id; // open on an empty page
  const open = promptOpenFor === current.id;
  promptCard.dataset.status = section.status;
  $('prompt-where').textContent = `Section ${section.index + 1} · ${section.title}${section.status === 'done' ? ' · done' : ''}`;
  $('prompt-goal').textContent = section.goal || section.prompt.split(/(?<=[.!?])\s/)[0] || 'Tap to see what to write toward.';
  $('prompt-text').textContent = section.prompt || 'This section has no prompt yet. Add one in the Plot tab, or ask Claude to write one with you.';
  $('prompt-toggle').setAttribute('aria-expanded', String(open));
  $('prompt-more').hidden = !open;
  const next = plots.nextSection(plot, section.index);
  $('prompt-done').hidden = section.status === 'done';
  $('prompt-next').hidden = !(section.status === 'done' && next && next.index !== section.index);
  if (next) $('prompt-next').textContent = `Start the next section: ${next.title}`;
  $('prompt-next').dataset.index = next ? String(next.index) : '';
}

async function updatePlot(story, change) {
  let page = plotPageFor(story);
  if (!page) page = await addPage(story, plots.PLOT_NAME, plots.newPlot(story));
  const text = change(page.text);
  if (text === page.text) return page;
  page.text = text;
  page.updatedAt = Date.now();
  page.dirty = true;
  if (page === current) {
    showText(text);
    unsaved = false;
  }
  await store.putPage(page);
  schedulePush();
  renderPromptCard();
  if (!viewPlot.hidden && panel.classList.contains('open')) renderPlot();
  return page;
}

function bindPlot() {
  $('prompt-toggle').addEventListener('click', () => {
    promptOpenFor = promptOpenFor === current.id ? -1 : current.id;
    renderPromptCard();
  });
  $('prompt-done').addEventListener('click', async () => {
    const section = currentSection();
    if (!section) return;
    await updatePlot(current.story, text => plots.setStatus(text, section.index, 'done'));
    const next = plots.nextSection(plotFor(current.story), section.index);
    showToast(next ? `Nice work. Next up: “${next.title}”.` : 'Nice work. That was the last section on your plot.');
  });
  $('prompt-next').addEventListener('click', event => writeSection(Number(event.currentTarget.dataset.index)));
  $('plot-list').addEventListener('click', onPlotListClick);
  $('plot-add').addEventListener('click', () => editSection(null));
  $('plot-claude').addEventListener('click', planWithClaude);
  $('plot-paste').addEventListener('click', pastePlot);
  $('plot-open').addEventListener('click', async () => {
    const page = plotPageFor(current.story) ?? await addPage(current.story, plots.PLOT_NAME, plots.newPlot(current.story));
    await openPage(page);
    closePanel({ focusEditor: true });
  });
}

let openSection = -1; // the section showing its details in the Plot tab

function renderPlot() {
  const story = current.story;
  const plot = plotFor(story);
  const sections = plot?.sections ?? [];
  const done = sections.filter(section => section.status === 'done').length;
  $('plot-story').textContent = story;
  $('plot-info').textContent = sections.length
    ? `${done} of ${sections.length} ${sections.length === 1 ? 'section' : 'sections'} done`
    : 'Plan your story here, one section at a time.';
  $('plot-premise').hidden = !plot?.premise;
  $('plot-premise').textContent = plot?.premise ?? '';
  $('plot-empty').hidden = sections.length > 0;
  $('plot-open').textContent = plotPageFor(story) ? 'Open plot.md' : 'Write plot.md';
  const here = currentSection();
  $('plot-list').replaceChildren(...sections.map(section => {
    const item = document.createElement('li');
    item.className = `plot-item ${section.status}`;
    if (here?.index === section.index) item.classList.add('here');
    const head = Object.assign(document.createElement('button'), { type: 'button', className: 'plot-head' });
    head.dataset.index = String(section.index);
    head.setAttribute('aria-expanded', String(openSection === section.index));
    const status = Object.assign(document.createElement('span'), {
      className: 'plot-status',
      textContent: { done: '✓', writing: '●', todo: '' }[section.status],
    });
    status.setAttribute('aria-label', { done: 'Done', writing: 'Writing', todo: 'To do' }[section.status]);
    const title = Object.assign(document.createElement('span'), { className: 'plot-title', textContent: `${section.index + 1}. ${section.title}` });
    const goal = Object.assign(document.createElement('span'), { className: 'plot-goal', textContent: section.goal });
    head.append(status, title, goal);
    item.append(head);
    if (openSection === section.index) {
      const more = Object.assign(document.createElement('div'), { className: 'plot-more' });
      if (section.prompt) more.append(Object.assign(document.createElement('p'), { className: 'plot-prompt', textContent: section.prompt }));
      if (section.page) more.append(Object.assign(document.createElement('p'), { className: 'plot-page', textContent: `Page: ${section.page}` }));
      const row = Object.assign(document.createElement('div'), { className: 'plot-actions' });
      const actions = [
        ['write', section.page ? 'Write it' : 'Start writing'],
        ['status', section.status === 'done' ? 'Not done yet' : 'Mark done'],
        ['edit', 'Edit'],
      ];
      for (const [action, label] of actions) {
        const button = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
        button.dataset.action = action;
        button.dataset.index = String(section.index);
        if (action === 'write') button.className = 'primary';
        row.append(button);
      }
      more.append(row);
      item.append(more);
    }
    return item;
  }));
}

async function onPlotListClick(event) {
  const button = event.target.closest('button');
  if (!button) return;
  const index = Number(button.dataset.index);
  if (button.classList.contains('plot-head')) {
    openSection = openSection === index ? -1 : index;
    renderPlot();
    return;
  }
  const section = plotFor(current.story)?.sections[index];
  if (!section) return;
  if (button.dataset.action === 'write') await writeSection(index);
  if (button.dataset.action === 'edit') await editSection(index);
  if (button.dataset.action === 'status') {
    await updatePlot(current.story, text => plots.setStatus(text, index, section.status === 'done' ? 'writing' : 'done'));
  }
}

// Opens the page for a section (making it if needed) with its prompt on top.
async function writeSection(index) {
  const story = current.story;
  const section = plotFor(story)?.sections[index];
  if (!section) return;
  const named = section.page && sortedPages().find(p => p.story === story && p.name.toLowerCase() === section.page.toLowerCase());
  const page = named || await addPage(story, section.page || nextChapterName(story));
  if (!section.page) await updatePlot(story, text => plots.setPage(text, index, page.name));
  if (section.status === 'todo') await updatePlot(story, text => plots.setStatus(text, index, 'writing'));
  promptOpenFor = page.id;
  await openPage(page);
  closePanel({ focusEditor: true });
}

function formDialog(element, form, cancel, extra = null) {
  return new Promise(resolve => {
    const finish = answer => {
      form.removeEventListener('submit', onSubmit);
      cancel.removeEventListener('click', onCancel);
      element.removeEventListener('cancel', onCancel);
      extra?.removeEventListener('click', onExtra);
      if (element.open) element.close();
      resolve(answer);
    };
    const onSubmit = event => {
      event.preventDefault();
      finish('ok');
    };
    const onCancel = event => {
      event.preventDefault();
      finish(null);
    };
    const onExtra = event => {
      event.preventDefault();
      finish('extra');
    };
    form.addEventListener('submit', onSubmit);
    cancel.addEventListener('click', onCancel);
    element.addEventListener('cancel', onCancel);
    extra?.addEventListener('click', onExtra);
    element.showModal();
  });
}

async function editSection(index) {
  const story = current.story;
  const section = index === null ? null : plotFor(story)?.sections[index];
  $('section-heading').textContent = section ? `Section ${section.index + 1}` : 'New section';
  $('section-title').value = section?.title ?? '';
  $('section-goal').value = section?.goal ?? '';
  $('section-prompt').value = section?.prompt ?? '';
  $('section-page').value = section?.page ?? '';
  $('section-delete').hidden = !section;
  const answer = await formDialog(sectionDialog, $('section-form'), $('section-cancel'), $('section-delete'));
  if (answer === 'extra' && section) {
    const sure = await ask({ title: `Delete the section “${section.title}” from your plot? Its page stays.`, input: false, ok: 'Delete', danger: true });
    if (sure) await updatePlot(story, text => plots.removeSection(text, section.index));
    openSection = -1;
    return;
  }
  if (answer !== 'ok') return;
  const fields = {
    title: $('section-title').value.trim() || 'New section',
    goal: $('section-goal').value,
    prompt: $('section-prompt').value,
    page: cleanName($('section-page').value),
  };
  await updatePlot(story, text => (section ? plots.updateSection(text, section.index, fields) : plots.addSection(text, fields)));
  if (!section) openSection = (plotFor(story)?.sections.length ?? 1) - 1;
  renderPlot();
}

async function pastePlot() {
  const story = current.story;
  $('paste-story').textContent = story;
  $('paste-input').value = '';
  const answer = await formDialog(pasteDialog, $('paste-form'), $('paste-cancel'));
  if (answer !== 'ok') return;
  const text = extractPlot($('paste-input').value);
  if (!plots.parsePlot(text).sections.length) {
    showToast('That doesn’t look like a plot yet. It needs sections that start with ### (for example “### 1. The letter”). Ask Claude for the plot in the app’s format.');
    return;
  }
  await updatePlot(story, () => text);
  openSection = -1;
  renderPlot();
  showToast(`Your plot for “${story}” is in. Tap a section to start writing it.`);
}

async function planWithClaude() {
  const story = current.story;
  const text = buildPlotRequest({
    story,
    plotText: plotPageFor(story)?.text ?? '',
    pages: sortedPages().filter(page => page.story === story),
  });
  const copied = await sendToClaude(text);
  showToast(copied
    ? 'Copied. Paste it into the new Claude chat and plan your story together. When Claude gives you the plot, copy it and tap “Paste a plot”.'
    : 'Couldn’t copy. Claude is opening anyway.');
}

// Claude: copies a request with your text and plot, then opens Claude (free on your Pro plan).

let claudeHelp = 'check';
let claudeContext = null;

function bindClaude() {
  $('claude-options').replaceChildren(...HELP.map(help => {
    const label = Object.assign(document.createElement('label'), { className: 'claude-option' });
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'help', value: help.id });
    const text = Object.assign(document.createElement('span'), { className: 'claude-name', textContent: help.name });
    const hint = Object.assign(document.createElement('span'), { className: 'claude-hint', textContent: help.hint });
    label.append(input, text, hint);
    return label;
  }));
  $('claude-options').addEventListener('change', event => {
    claudeHelp = event.target.value;
    $('claude-after').hidden = true;
  });
  $('claude-form').addEventListener('submit', event => {
    event.preventDefault();
    handOff('copy');
  });
  $('claude-share').addEventListener('click', () => handOff('share'));
  $('claude-cancel').addEventListener('click', () => claudeDialog.close());
  $('claude-share').hidden = !navigator.share || finePointer;
}

function openClaude() {
  stopEverything();
  hideFix();
  saveNow();
  const selection = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  claudeContext = {
    story: current.story,
    page: current,
    selection,
    plotText: plotPageFor(current.story)?.text ?? '',
    section: currentSection(),
  };
  $('claude-scope').textContent = scopeLabel(claudeContext);
  for (const input of $('claude-options').querySelectorAll('input')) input.checked = input.value === claudeHelp;
  $('claude-after').hidden = true;
  claudeDialog.showModal();
}

async function handOff(how) {
  if (claudeHelp === 'ask' && !$('claude-question').value.trim()) {
    $('claude-question').focus();
    return;
  }
  const text = buildRequest({ helpId: claudeHelp, note: $('claude-question').value, ...claudeContext });
  const copied = await sendToClaude(text, how);
  if (copied === 'shared') {
    claudeDialog.close();
    return;
  }
  $('claude-question').value = '';
  $('claude-after').hidden = false;
  $('claude-after').textContent = copied
    ? 'Copied. In the Claude window, paste it into the new chat (Ctrl+V, or long-press and Paste on your phone), then send it.'
    : 'Your browser blocked copying, so Claude opened without your text. Select your text, copy it, and paste it into Claude.';
}

// Returns 'shared', true (copied) or false.
async function sendToClaude(text, how = 'copy') {
  if (how === 'share' && navigator.share) {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch (error) {
      if (error.name === 'AbortError') return 'shared';
    }
  }
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    copied = copyTheOldWay(text);
  }
  window.open(CLAUDE_URL, '_blank', 'noopener');
  return copied;
}

function copyTheOldWay(text) {
  const area = Object.assign(document.createElement('textarea'), { value: text });
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

// Google Drive

const SYNC_TEXT = {
  off: 'Google Drive isn’t connected. Tap to set it up.',
  ok: 'Your pages are saved in Google Drive.',
  busy: 'Syncing with Google Drive…',
  pending: 'Some changes haven’t gone to Google Drive yet.',
  signin: 'Tap to sign in to Google again and sync.',
  offline: 'You’re offline. Your pages sync when you’re back online.',
  error: 'Google Drive sync hit a problem. Tap to try again.',
};

function bindDrive() {
  clientIdInput.value = drive.clientId();
  clientIdInput.addEventListener('change', () => drive.setClientId(clientIdInput.value));
  $('drive-connect').addEventListener('click', connectDrive);
  $('drive-sync').addEventListener('click', () => onSyncButton());
  $('drive-disconnect').addEventListener('click', disconnectDrive);
}

function showSyncState(state) {
  const shown = state === 'ok' && sync.hasLocalChanges() ? 'pending' : state;
  syncButton.dataset.state = shown;
  syncButton.setAttribute('aria-label', SYNC_TEXT[shown] ?? 'Google Drive');
  syncButton.title = SYNC_TEXT[shown] ?? 'Google Drive';
  if (panel.classList.contains('open') && !viewLook.hidden) renderDriveSettings();
  if (panel.classList.contains('open') && !viewPages.hidden && !panelNote.classList.contains('warn')) panelNote.textContent = storageNote();
}

function renderDriveSettings() {
  const on = drive.connected();
  const last = drive.get('lastSync');
  const builtIn = drive.hasBuiltInClientId();
  const parts = on ? [SYNC_TEXT[syncButton.dataset.state] ?? ''] : [
    builtIn
      ? 'Not connected yet. Tap Connect Google Drive and sign in with your Google account. Do this once on each device.'
      : 'Not connected. Follow “Google sign-in setup.md” in the Writing App folder on your PC to get a Client ID, paste it here, then tap Connect Google Drive. Do this once on each device.',
  ];
  if (on && drive.email()) parts.push(`Signed in as ${drive.email()}.`);
  if (on && last) parts.push(`Last synced ${new Date(last).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`);
  if (on && sync.detail && syncButton.dataset.state === 'error') parts.push(`(${sync.detail})`);
  driveStatus.textContent = parts.join(' ');
  $('client-id-label').hidden = on || builtIn;
  clientIdInput.hidden = on || builtIn;
  $('drive-connect').hidden = on;
  $('drive-sync').hidden = !on;
  $('drive-disconnect').hidden = !on;
}

function clientIdProblem(id) {
  if (/^GOCSPX-/i.test(id)) return 'That’s the client secret, not the Client ID. Don’t use it. The Client ID is the long code that ends in .apps.googleusercontent.com.';
  if (!/^\d+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/i.test(id)) return 'That doesn’t look like a Client ID. It’s a long code that ends in .apps.googleusercontent.com.';
  return '';
}

async function connectDrive() {
  const typed = clientIdInput.value.trim();
  if (typed && !drive.inTestMode()) {
    const problem = clientIdProblem(typed);
    if (problem) {
      showToast(problem);
      clientIdInput.focus();
      return;
    }
  }
  if (typed) drive.setClientId(typed);
  if (!drive.clientId()) {
    showToast('Paste your Client ID first. The steps are in “Google sign-in setup.md”.');
    clientIdInput.focus();
    return;
  }
  if (!(await drive.online())) {
    showToast('You’re offline. Connect to the internet, then try again.');
    return;
  }
  await saveNow({ backup: true });
  if (!drive.signIn()) await afterSignIn({ ok: true, silent: false }); // false: signed in without leaving the page
}

async function afterSignIn(answer) {
  if (answer && !answer.ok && !answer.silent) showToast(signInMessage(answer.error));
  if (answer?.ok) {
    await drive.whoAmI().catch(() => {});
    if (!answer.silent) showToast('Google Drive is connected. Getting your stories…');
  }
  if (!drive.connected()) return;
  if (drive.hasToken()) await runSync();
  else await trySilentSignIn();
}

function signInMessage(error) {
  if (error === 'access_denied') return 'Google sign-in was cancelled, so Google Drive isn’t connected.';
  if (error === 'scope') return 'The app needs permission to see and save your Drive files. Connect again, and leave the Drive box ticked.';
  if (error === 'mismatch') return 'That sign-in couldn’t be checked, so it wasn’t used. Tap the cloud to try again.';
  return `Google sign-in didn’t work (${error}). Check the Client ID in Settings, then try again.`;
}

// Gets a fresh one-hour pass from Google without a tap. Only when the app has just opened or come
// back, you haven't started typing, and it hasn't tried in the last few minutes.
async function trySilentSignIn() {
  if (!drive.connected() || drive.hasToken()) return;
  if (typedSinceVisible || Date.now() - drive.lastSilentTry() < SILENT_RETRY_MS) {
    showSyncState('signin');
    return;
  }
  if (!(await drive.online())) {
    showSyncState('offline');
    return;
  }
  if (typedSinceVisible) return;
  await saveNow({ backup: true });
  if (!drive.signIn({ silent: true })) await runSync(); // false: signed in without leaving the page
}

async function runSync(options = {}) {
  clearTimeout(pushTimer);
  await saveNow();
  await sync.run(options);
  if (!options.pushOnly) lastPull = Date.now();
}

function schedulePush(delay = DRIVE_PUSH_DELAY_MS) {
  if (!drive.connected()) return;
  if (syncButton.dataset.state === 'ok') showSyncState('pending');
  if (!drive.hasToken()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => sync.run({ pushOnly: true }), delay);
}

function pushToDrive({ keepalive = false } = {}) {
  if (drive.connected() && drive.hasToken() && sync.hasLocalChanges()) sync.run({ pushOnly: true, keepalive });
}

function syncOnReturn() {
  if (!drive.connected() || document.visibilityState !== 'visible') return;
  if (Date.now() - lastPull < RETURN_SYNC_GAP_MS) return;
  if (drive.hasToken()) runSync();
  else trySilentSignIn();
}

async function onSyncButton() {
  if (!drive.connected()) {
    openPanel('look');
    $('drive-settings').scrollIntoView({ block: 'start' });
    return;
  }
  if (!drive.hasToken()) {
    if (!(await drive.online())) {
      showToast(SYNC_TEXT.offline);
      return;
    }
    await saveNow({ backup: true });
    if (drive.signIn()) return; // back after Google's sign-in page
  }
  const messagesBefore = toastSerial;
  await runSync();
  if (toastSerial !== messagesBefore) return; // the sync already said something more specific
  const state = syncButton.dataset.state;
  showToast(state === 'error' ? `${SYNC_TEXT.error} ${sync.detail}` : SYNC_TEXT[state]);
}

async function disconnectDrive() {
  const sure = await ask({
    title: 'Disconnect Google Drive on this device? Your pages stay here and in Drive. They just stop syncing on this device.',
    input: false,
    ok: 'Disconnect',
  });
  if (!sure) return;
  clearTimeout(pushTimer);
  drive.disconnect();
  showSyncState('off');
  renderDriveSettings();
  clientIdInput.value = drive.clientId();
}

function onSyncedPages({ removed }) {
  if (!current || removed.includes(current) || !pages.includes(current)) {
    current = null;
    const next = sortedPages()[0];
    (next ? Promise.resolve(next) : addPage(DEFAULT_STORY, 'Chapter 1')).then(page => openPage(page));
  } else {
    document.title = `${current.name} · ${APP_NAME}`;
    if (!current.dirty && editor.value !== current.text) showText(current.text);
    renderPromptCard();
  }
  if (panel.classList.contains('open')) {
    renderPanel();
    if (!viewPlot.hidden) renderPlot();
  }
}
