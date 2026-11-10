// Google Drive: sign-in and file calls. Used by sync.js.
//
// Sign-in sends the app to Google's sign-in page and back again (OAuth for client-side web apps).
// That works the same in an installed phone app as on the PC, and once you've approved the app,
// a fresh one-hour pass can be fetched without a tap when the app opens.
import { GOOGLE_CLIENT_ID } from './config.js';

const SCOPE = 'https://www.googleapis.com/auth/drive';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const STATE_KEY = 'writing-app:drive';
const RETURN_KEY = 'writing-app:oauth-return';
const TEST_API_KEY = 'writing-app:drive-test-api'; // developer testing only: a stand-in for Drive
const FOLDER = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,parents,modifiedTime,md5Checksum,trashed';
export const ROOT_NAME = 'Writing App';

export class AuthError extends Error {}
export class OfflineError extends Error {}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

let state = load();

function save() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // Storage is blocked. Sync works until the app closes.
  }
}

function testApi() {
  try {
    return localStorage.getItem(TEST_API_KEY) || '';
  } catch {
    return '';
  }
}

const api = () => testApi() || 'https://www.googleapis.com';

export const inTestMode = () => Boolean(testApi());

// True when a Client ID is built into the app (config.js), so nothing has to be pasted on each device.
export const hasBuiltInClientId = () => Boolean(GOOGLE_CLIENT_ID.trim());

export function clientId() {
  return (state.clientId || GOOGLE_CLIENT_ID || '').trim();
}

export function setClientId(value) {
  state.clientId = (value ?? '').trim();
  save();
}

export const connected = () => Boolean(state.connected);
export const hasToken = () => Boolean(state.token && state.expiresAt - 60_000 > Date.now());
export const email = () => state.email ?? '';
export const lastSilentTry = () => state.silentAt ?? 0;

export function get(key) {
  return state[key];
}

export function set(key, value) {
  state[key] = value;
  save();
}

export function disconnect() {
  const keep = { clientId: state.clientId };
  state = keep;
  save();
}

function redirectUri() {
  const url = new URL('./', location.href);
  url.search = '';
  url.hash = '';
  return url.href;
}

// Leaves the app for Google's sign-in page. `silent` asks Google to come straight back
// without showing anything, which only works after you've approved the app once.
export function signIn({ silent = false } = {}) {
  if (testApi()) {
    Object.assign(state, { connected: true, token: 'test-token', expiresAt: Date.now() + 3_600_000 });
    save();
    return false; // signed in on the spot, no page change
  }
  const id = clientId();
  if (!id) throw new Error('Add your Client ID first.');
  const nonce = crypto.randomUUID();
  // Kept in two places: an installed phone app can come back from Google in a fresh browser tab,
  // which can't see sessionStorage. Without either, the answer can't be checked and is refused.
  const marker = JSON.stringify({ nonce, silent, at: Date.now() });
  for (const storage of [sessionStorage, localStorage]) {
    try {
      storage.setItem(RETURN_KEY, marker);
    } catch {
      // The other one may still work.
    }
  }
  if (silent) {
    state.silentAt = Date.now();
    save();
  }
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state: nonce,
  });
  if (silent) params.set('prompt', 'none');
  if (state.email) params.set('login_hint', state.email);
  location.assign(`${AUTH_URL}?${params}`);
  return true;
}

// Reads Google's answer when the app comes back from the sign-in page.
// Returns null if this load isn't a return from sign-in, or { ok, silent, error }.
export function finishSignIn() {
  if (!location.hash || !/(access_token|error)=/.test(location.hash)) return null;
  const answer = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  let expected = null;
  for (const storage of [sessionStorage, localStorage]) {
    try {
      const found = JSON.parse(storage.getItem(RETURN_KEY) ?? 'null');
      storage.removeItem(RETURN_KEY);
      if (!expected && found && Date.now() - found.at < 20 * 60_000) expected = found;
    } catch {
      // Try the other one.
    }
  }
  if (!expected || answer.get('state') !== expected.nonce) return { ok: false, silent: false, error: 'mismatch' };
  if (answer.get('error')) return { ok: false, silent: expected.silent, error: answer.get('error') };
  const token = answer.get('access_token');
  const seconds = Number(answer.get('expires_in')) || 3600;
  const granted = answer.get('scope') ?? '';
  if (!token) return { ok: false, silent: expected.silent, error: 'no-token' };
  if (granted && !granted.split(' ').includes(SCOPE)) return { ok: false, silent: expected.silent, error: 'scope' };
  Object.assign(state, { connected: true, token, expiresAt: Date.now() + seconds * 1000 });
  save();
  return { ok: true, silent: expected.silent };
}

// True if Google can be reached right now. Used before leaving the app to sign in,
// so the app never sends you to a page that can't load.
export async function online() {
  if (navigator.onLine === false) return false;
  try {
    await fetch(`${api()}/generate_204`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    return false;
  }
}

// Drive calls

async function call(path, { method = 'GET', query = {}, body, headers = {}, keepalive = false, raw = false, upload = false } = {}) {
  if (!hasToken()) throw new AuthError('Signed out');
  const url = new URL(`${api()}${upload ? '/upload' : ''}/drive/v3/${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${state.token}`, ...headers },
      body,
      keepalive: keepalive && (!body || body.length < 60_000),
      cache: 'no-store',
    });
  } catch (error) {
    throw new OfflineError(error.message);
  }
  if (response.status === 401) {
    state.token = '';
    save();
    throw new AuthError('Signed out');
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`Google Drive said ${response.status}`);
    error.status = response.status;
    error.detail = detail.slice(0, 300);
    throw error;
  }
  return raw ? response.text() : response.json();
}

const quote = value => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// Every file and folder directly inside these folders, following every page of results.
export async function listChildren(folderIds) {
  const files = [];
  for (let i = 0; i < folderIds.length; i += 40) {
    const parents = folderIds.slice(i, i + 40).map(id => `${quote(id)} in parents`).join(' or ');
    let pageToken = '';
    do {
      const query = {
        q: `(${parents}) and trashed = false`,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: '1000',
        orderBy: 'modifiedTime desc',
      };
      if (pageToken) query.pageToken = pageToken;
      const result = await call('files', { query });
      if (!result || !Array.isArray(result.files)) throw new Error('Google Drive sent a list the app couldn’t read.');
      files.push(...result.files);
      pageToken = result.nextPageToken ?? '';
    } while (pageToken);
  }
  return files;
}

export const isFolder = file => file.mimeType === FOLDER;

export async function fileInfo(id) {
  return call(`files/${encodeURIComponent(id)}`, { query: { fields: FILE_FIELDS } });
}

export async function download(id) {
  const text = await call(`files/${encodeURIComponent(id)}`, { query: { alt: 'media' }, raw: true });
  return text === null ? null : text.replace(/\r\n/g, '\n');
}

export async function findOrCreateRoot() {
  const known = state.rootId && await fileInfo(state.rootId);
  if (known && !known.trashed) return known.id;
  const result = await call('files', {
    query: {
      q: `name = ${quote(ROOT_NAME)} and mimeType = ${quote(FOLDER)} and 'root' in parents and trashed = false`,
      fields: 'files(id,name)',
      orderBy: 'createdTime',
    },
  });
  const id = result?.files?.[0]?.id ?? (await createFolder(ROOT_NAME, 'root')).id;
  set('rootId', id);
  return id;
}

export async function createFolder(name, parent) {
  return call('files', {
    method: 'POST',
    query: { fields: FILE_FIELDS },
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
  });
}

function multipart(metadata, text) {
  const boundary = `writing-app-${crypto.randomUUID()}`;
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: text/markdown; charset=UTF-8',
    '',
    text,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return { body, type: `multipart/related; boundary=${boundary}` };
}

export async function createFile(name, parent, text) {
  const { body, type } = multipart({ name, parents: [parent], mimeType: 'text/markdown' }, text);
  return call('files', {
    method: 'POST', upload: true, body,
    query: { uploadType: 'multipart', fields: FILE_FIELDS },
    headers: { 'Content-Type': type },
  });
}

// Changes a file's text, and its name or folder if those changed. Returns the new file info.
export async function updateFile(id, { name, text, addParent, removeParent, keepalive = false }) {
  const query = { fields: FILE_FIELDS };
  if (addParent) query.addParents = addParent;
  if (removeParent) query.removeParents = removeParent;
  const metadata = name ? { name } : {};
  if (text === undefined) {
    return call(`files/${encodeURIComponent(id)}`, {
      method: 'PATCH', query, keepalive,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
  }
  const { body, type } = multipart(metadata, text);
  return call(`files/${encodeURIComponent(id)}`, {
    method: 'PATCH', upload: true, keepalive, body,
    query: { ...query, uploadType: 'multipart' },
    headers: { 'Content-Type': type },
  });
}

export async function renameFolder(id, name) {
  return call(`files/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    query: { fields: FILE_FIELDS },
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

// Moves a file to the Drive trash, where it stays recoverable for 30 days. Nothing is deleted for good.
export async function trash(id) {
  return call(`files/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    query: { fields: 'id,trashed' },
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

export async function whoAmI() {
  const about = await call('about', { query: { fields: 'user(emailAddress,displayName)' } });
  if (about?.user?.emailAddress) set('email', about.user.emailAddress);
  return about?.user ?? null;
}
