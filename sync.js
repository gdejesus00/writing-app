// Keeps this device's pages and the "Writing App" folder in Google Drive in step.
// One Drive folder per story, one .md file per page (the plot is plot.md).
//
// Rules that protect your words:
// - A page only takes the Drive version when it hasn't changed on this device since the last sync.
// - If a page changed on both devices, both versions are kept as separate pages.
// - A page missing from Drive's list is only removed here after Drive confirms the file was
//   trashed or deleted, and only if it has no unsynced words. Otherwise it's uploaded again.
// - Removing anything in Drive moves it to the Drive trash, never deletes it for good.
// - When Claude saves a new copy of a file (same name, newer), the app uses the newest one and
//   moves the older copy to the trash, but only if that older copy had no unsynced words here.
import * as drive from './drive.js';

const TEXT_FILE = /\.(md|markdown|txt)$/i;
const baseName = name => name.replace(TEXT_FILE, '');
const lower = value => (value ?? '').trim().toLowerCase();
const noRemote = () => ({ fileId: null, folderId: null, md5: '', name: '', folderName: '' });

export function createSync(host) {
  // host: { getPages, createPage(fields), putPage, removePage, uniqueName, onTaken, onPagesChanged, notify, onState }
  let running = null;
  let rerun = null;
  let status = drive.connected() ? 'pending' : 'off';
  let detail = '';
  let knownFolders = new Map(); // lower-case story name -> Drive folder id, from the last listing

  function setStatus(next, message = '') {
    status = next;
    detail = message;
    host.onState(status, detail);
  }

  // Said once per file, ever (remembered on this device), so a Google Doc left in a story folder isn't nagged about.
  function notifyNative(files) {
    const told = new Set(drive.get('toldNative') ?? []);
    const fresh = files.filter(file => !told.has(file.id));
    if (!fresh.length) return;
    fresh.forEach(file => told.add(file.id));
    drive.set('toldNative', [...told]);
    host.notify(`Skipped ${fresh.map(file => `“${file.name}”`).join(', ')} in Google Drive: it’s a Google Doc, and only Markdown files sync. Ask Claude to save it as a .md file.`);
  }

  function deletes() {
    return drive.get('deletes') ?? [];
  }

  function hasLocalChanges() {
    return deletes().length > 0 || host.getPages().some(page => page.dirty && (page.text.trim() || page.remote?.fileId));
  }

  // Runs a sync. pushOnly skips getting changes from Drive (used when the app is closing).
  function run({ pushOnly = false, keepalive = false } = {}) {
    if (!drive.connected()) {
      setStatus('off');
      return Promise.resolve();
    }
    if (!drive.hasToken()) {
      setStatus('signin');
      return Promise.resolve();
    }
    if (running) {
      rerun = { pushOnly: Boolean(rerun?.pushOnly ?? true) && pushOnly, keepalive };
      return running;
    }
    running = (async () => {
      setStatus('busy');
      try {
        const root = await drive.findOrCreateRoot();
        let needsPull = !pushOnly;
        for (let round = 0; round < 2; round += 1) {
          if (needsPull) await pull(root);
          needsPull = await push(root, keepalive);
          if (!needsPull) break;
        }
        await flushDeletes();
        drive.set('lastSync', Date.now());
        setStatus(hasLocalChanges() ? 'pending' : 'ok');
      } catch (error) {
        if (error instanceof drive.AuthError) setStatus('signin');
        else if (error instanceof drive.OfflineError) setStatus('offline');
        else {
          console.error('Sync failed', error);
          setStatus('error', error.message);
        }
      } finally {
        running = null;
      }
      if (rerun) {
        const next = rerun;
        rerun = null;
        await run(next);
      }
    })();
    return running;
  }

  async function pull(root) {
    const top = await drive.listChildren([root]);
    const folders = top.filter(drive.isFolder);
    knownFolders = new Map();
    for (const folder of folders) if (!knownFolders.has(lower(folder.name))) knownFolders.set(lower(folder.name), folder.id);
    const folderById = new Map(folders.map(folder => [folder.id, folder]));
    const inside = folders.length ? await drive.listChildren(folders.map(folder => folder.id)) : [];
    // Google Docs, Sheets and shortcuts have no file contents to download, so only real files sync.
    // A Google Doc that looks like a page (say, "plot.md") is skipped with a note, once.
    const isNative = file => (file.mimeType ?? '').startsWith('application/vnd.google-apps.');
    notifyNative(inside.filter(file => !drive.isFolder(file) && isNative(file) && TEXT_FILE.test(file.name)));
    const files = inside
      .filter(file => !drive.isFolder(file) && !isNative(file) && TEXT_FILE.test(file.name))
      .map(file => ({ ...file, folderId: file.parents?.find(id => folderById.has(id)) }))
      .filter(file => file.folderId);

    const changed = new Set();
    const added = [];
    const removed = [];
    const pages = host.getPages();

    // A story folder renamed in Drive (and not here) renames the story here.
    for (const page of pages) {
      const folder = page.remote?.folderId && folderById.get(page.remote.folderId);
      if (folder && folder.name !== page.remote.folderName && page.story === page.remote.folderName) {
        page.story = folder.name;
        page.remote.folderName = folder.name;
        changed.add(page);
      }
    }

    // Files with the same name in the same folder: the newest one counts.
    const groups = new Map();
    for (const file of files) {
      const key = `${file.folderId}\n${lower(baseName(file.name))}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(file);
    }
    const seen = new Set(files.map(file => file.id));
    const olderCopies = [];

    for (const group of groups.values()) {
      group.sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''));
      const file = group[0];
      const folder = folderById.get(file.folderId);
      const remote = {
        fileId: file.id, folderId: folder.id, md5: file.md5Checksum ?? '', name: baseName(file.name), folderName: folder.name,
      };
      let page = pages.find(p => p.remote?.fileId === file.id);
      let older = null;
      if (!page) {
        older = group.slice(1).find(copy => pages.some(p => p.remote?.fileId === copy.id)) ?? null;
        if (older) page = pages.find(p => p.remote?.fileId === older.id);
      }
      if (!page) {
        page = pages.find(p => !p.remote?.fileId && p.story === folder.name && lower(p.name) === lower(remote.name));
        if (page) {
          // Made on this device with the same name as a Drive file it has never synced with.
          const text = await drive.download(file.id);
          if (text === null) continue;
          if (!page.text.trim() || page.text === text) {
            take(page, text, remote);
            changed.add(page);
          } else {
            // Different words in both. This device's page gets a new name and Drive's keeps the old one.
            page.name = host.uniqueName(page.story, `${page.name} (this device)`, page);
            page.dirty = true;
            changed.add(page);
            added.push(host.createPage({ story: folder.name, name: remote.name, text, dirty: false, remote }));
            host.notify(`“${remote.name}” was different on this device and in Drive, so both are kept. This device’s words are in “${page.name}”.`);
          }
          continue;
        }
      }
      if (!page) {
        const text = await drive.download(file.id);
        if (text === null) continue;
        added.push(host.createPage({
          story: folder.name, name: host.uniqueName(folder.name, remote.name), text, dirty: false, remote,
        }));
        continue;
      }
      // A rename or move made in Drive (and not here) carries over, whatever else changed.
      if (page.remote.name && remote.name !== page.remote.name && page.name === page.remote.name) {
        page.name = host.uniqueName(folder.name, remote.name, page);
        changed.add(page);
      }
      if (page.remote.folderId && page.remote.folderId !== folder.id && page.story === page.remote.folderName) {
        page.story = folder.name;
        changed.add(page);
      }
      const remoteChanged = remote.md5 !== page.remote.md5 || older !== null;
      if (remoteChanged) {
        const text = await drive.download(file.id);
        if (text === null) continue;
        // Checked again after the download, in case you typed in the meantime.
        if (!page.dirty || page.text === text) {
          take(page, text, remote);
        } else {
          // Changed on both devices: this page keeps your words here (and sends them to Drive next),
          // and the Drive version becomes its own page.
          const copyName = host.uniqueName(page.story, `${page.name} (other device)`);
          const copy = host.createPage({ story: page.story, name: copyName, text, dirty: true, remote: noRemote() });
          added.push(copy);
          // Save the copy before this page is told Drive's version is handled, so a sync that stops
          // partway (or an app that's closed) can never leave Drive's words only in memory.
          await host.putPage(copy);
          page.remote = { ...remote };
          await host.putPage(page);
          host.notify(`“${page.name}” changed on both devices, so both versions are kept. The other one is “${copyName}”.`);
        }
        if (older) olderCopies.push(older.id);
        changed.add(page);
        continue;
      }
      // Same words. Remember Drive's current name and folder as the starting point for next time.
      if (page.remote.name !== remote.name || page.remote.folderId !== folder.id || page.remote.folderName !== folder.name) {
        page.remote = { ...page.remote, name: remote.name, folderId: folder.id, folderName: folder.name };
        changed.add(page);
      }
    }

    // Pages whose file wasn't in the list. Only Drive saying "trashed", "gone" or "moved out of the
    // Writing App folder" counts, checked file by file, so a short or empty list can't remove anything.
    const folderOk = new Map();
    const inStoryFolder = async info => {
      for (const parent of info.parents ?? []) {
        if (folderById.has(parent)) return true;
        if (!folderOk.has(parent)) {
          const folder = await drive.fileInfo(parent);
          folderOk.set(parent, Boolean(folder && !folder.trashed && folder.parents?.includes(root)));
        }
        if (folderOk.get(parent)) return true;
      }
      return false;
    };
    for (const page of pages) {
      const id = page.remote?.fileId;
      if (!id || seen.has(id)) continue;
      const info = await drive.fileInfo(id);
      if (info && !info.trashed && await inStoryFolder(info)) continue; // there, just not listed
      if (!page.dirty) {
        removed.push(page);
      } else {
        page.remote = noRemote();
        changed.add(page);
        host.notify(`“${page.name}” was removed from Drive, but it has new words here, so it was kept and will be saved to Drive again.`);
      }
    }

    for (const page of removed) {
      if (page.dirty) {
        // You typed in it while this sync ran, so keep it and upload it again.
        page.remote = noRemote();
        changed.add(page);
      } else {
        await host.removePage(page);
      }
    }
    for (const page of [...changed, ...added]) if (!removed.includes(page)) await host.putPage(page);
    for (const id of olderCopies) await drive.trash(id).catch(error => console.warn('Couldn’t trash an older copy', error));
    if (changed.size || added.length || removed.length) host.onPagesChanged({ changed: [...changed], added, removed });
  }

  function take(page, text, remote) {
    page.text = text;
    page.name = page.name === remote.name ? page.name : host.uniqueName(remote.folderName, remote.name, page);
    page.story = remote.folderName;
    page.caret = Math.min(page.caret ?? 0, text.length);
    page.remote = remote;
    page.dirty = false;
    host.onTaken?.(page); // shown on screen right away, before you can type again
  }

  async function folderFor(root, story) {
    const known = knownFolders.get(lower(story));
    if (known) return known;
    const top = await drive.listChildren([root]);
    for (const folder of top.filter(drive.isFolder)) if (!knownFolders.has(lower(folder.name))) knownFolders.set(lower(folder.name), folder.id);
    if (knownFolders.has(lower(story))) return knownFolders.get(lower(story));
    const folder = await drive.createFolder(story, root);
    knownFolders.set(lower(story), folder.id);
    return folder.id;
  }

  // Sends changed pages to Drive. Returns true if a page changed in Drive meanwhile, so a pull is needed.
  async function push(root, keepalive) {
    let needsPull = false;
    for (const page of host.getPages()) {
      const tracked = Boolean(page.remote?.fileId);
      if (!page.dirty && tracked) continue;
      if (!tracked && !page.text.trim()) continue; // empty new pages stay here until they have words
      const text = page.text;
      const name = page.name;
      const movedHere = tracked && page.story !== page.remote.folderName;
      const folderId = tracked && !movedHere ? page.remote.folderId : await folderFor(root, page.story);
      let info = null;
      let kept = null; // Drive's name and folder before this push, kept when they changed there and not here
      if (tracked) {
        const now = await drive.fileInfo(page.remote.fileId);
        if (!now || now.trashed) {
          page.remote = noRemote(); // removed in Drive: upload this page as a new file
        } else if ((now.md5Checksum ?? '') !== page.remote.md5) {
          needsPull = true; // changed in Drive since the last sync; the next pull keeps both versions
          continue;
        } else {
          const renamedHere = name !== page.remote.name;
          // Renamed or moved in Drive but not here: leave it, and let the next pull bring the change here.
          if (!renamedHere && baseName(now.name) !== page.remote.name) needsPull = true;
          if (!movedHere && !now.parents?.includes(page.remote.folderId)) needsPull = true;
          kept = { name: renamedHere ? null : page.remote.name, folderId: movedHere ? null : page.remote.folderId };
          const moving = movedHere && !now.parents?.includes(folderId);
          info = await drive.updateFile(page.remote.fileId, {
            name: renamedHere && `${name}.md` !== now.name ? `${name}.md` : undefined,
            text,
            addParent: moving ? folderId : undefined,
            removeParent: moving ? now.parents?.join(',') : undefined,
            keepalive,
          });
        }
      }
      if (!info) {
        info = await drive.createFile(`${name}.md`, folderId, text);
        kept = null;
      }
      page.remote = {
        fileId: info.id,
        folderId: kept?.folderId ?? folderId,
        md5: info.md5Checksum ?? '',
        name: kept?.name ?? baseName(info.name),
        folderName: kept?.folderId ? page.remote.folderName : page.story,
      };
      if (page.text === text && page.name === name) page.dirty = false;
      await host.putPage(page);
    }
    return needsPull;
  }

  async function flushDeletes() {
    for (const id of deletes()) {
      await drive.trash(id); // a missing file (already gone) counts as done
      drive.set('deletes', deletes().filter(other => other !== id));
    }
  }

  // Called when a page is deleted on this device: its Drive file goes to the trash on the next sync.
  function forget(page) {
    const id = page.remote?.fileId;
    if (id) drive.set('deletes', [...new Set([...deletes(), id])]);
  }

  return {
    run,
    forget,
    hasLocalChanges,
    get status() { return status; },
    get detail() { return detail; },
    get busy() { return Boolean(running); },
  };
}
