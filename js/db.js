// IndexedDB storage for diary entries (photos are kept on the device only).

const DB_NAME = 'feeltr';
const STORE = 'photos';
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('createdAt', 'createdAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let result;
    const req = fn(tx.objectStore(STORE));
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const db = {
  put: (photo) => run('readwrite', (s) => s.put(photo)),
  get: (id) => run('readonly', (s) => s.get(id)),
  remove: (id) => run('readwrite', (s) => s.delete(id)),
  // Newest first.
  all: async () => (await run('readonly', (s) => s.index('createdAt').getAll())).reverse(),
  count: () => run('readonly', (s) => s.count()),
  async latest() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).index('createdAt').openCursor(null, 'prev');
      req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
      req.onerror = () => reject(req.error);
    });
  },
  async update(id, patch) {
    const photo = await this.get(id);
    if (!photo) return;
    Object.assign(photo, patch);
    await this.put(photo);
  },
};
