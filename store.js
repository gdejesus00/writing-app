// Local storage for pages, using IndexedDB. Everything here stays on this device.
const DB_NAME = 'writing-app';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function run(storeName, mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = action(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Saving was interrupted.'));
  });
}

export const allPages = async () => (await run('pages', 'readonly', store => store.getAll())) ?? [];
export const putPage = page => run('pages', 'readwrite', store => store.put(page));
export const deletePage = id => run('pages', 'readwrite', store => store.delete(id));
export const getMeta = async key => (await run('meta', 'readonly', store => store.get(key)))?.value;
export const setMeta = (key, value) => run('meta', 'readwrite', store => store.put({ key, value }));
