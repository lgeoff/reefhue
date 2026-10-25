// Taking files from the picker safely on Android.
//
// Chrome on Android gets gallery photos from content providers that may
// report a changing modification time or a size that doesn't match the bytes
// (Android removes location data from photos it hands to apps, and the
// system photo picker serves a proxy). Chrome then refuses to read the file
// (NotReadableError / ERR_UPLOAD_FILE_CHANGED), and asking for .size,
// .lastModified or .slice() first makes that far more likely
// (crbug.com/40123366). So, on Android, every picked file is copied into the
// origin-private file system the moment it is picked, by streaming its bytes,
// before anything else touches it. The app then works on that stable copy.
// Elsewhere files are used as they are.

const ANDROID = /Android/i.test(navigator.userAgent);
const early = new WeakMap();
let dirPromise = null;

function pickedDir() {
  dirPromise ||= navigator.storage.getDirectory().then((root) => root.getDirectoryHandle('picked', { create: true }));
  return dirPromise;
}

/** Remove copies left from earlier visits. */
export async function clearPicked() {
  if (!ANDROID || !navigator.storage?.getDirectory) return;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('picked', { recursive: true }).catch(() => {});
    dirPromise = null;
  } catch { /* storage unavailable */ }
}

let seq = 0;
async function copy(file, type, name) {
  const dir = await pickedDir();
  const handle = await dir.getFileHandle(`${Date.now()}-${++seq}`, { create: true });
  const writable = await handle.createWritable();
  await file.stream().pipeTo(writable);
  const f = await handle.getFile();
  return new File([f], name, { type });
}

/**
 * Call synchronously in the change/drop handler, before touching the files.
 * Only name and type are read here: they don't trigger Chrome's checks.
 */
export function takeFiles(files) {
  if (!ANDROID) return;
  for (const f of files) {
    const name = f.name, type = f.type;
    let p;
    if (navigator.storage?.getDirectory && 'createWritable' in (globalThis.FileSystemFileHandle?.prototype || {})) {
      p = copy(f, type, name).catch(async (e) => {
        // no OPFS writes: hold the bytes in memory instead
        console.warn('copy to private storage failed, reading into memory', name, e?.name || e);
        return new File([await f.arrayBuffer()], name, { type });
      });
    } else {
      p = f.arrayBuffer().then((b) => new File([b], name, { type }));
    }
    early.set(f, p);
    p.catch(() => {});
  }
}

/** The stable copy of a picked file (or the file itself where none is made). */
export function stableFile(file) {
  return early.get(file) || Promise.resolve(file);
}

export const usesCopies = ANDROID;
