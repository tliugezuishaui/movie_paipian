const DB_NAME = 'movie-scheduler';
const STORE_NAME = 'posters';
const DB_VERSION = 1;
const memoryStore = new Map();

function openDatabase() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function savePoster(id, blob) {
  const database = await openDatabase();
  if (!database) {
    memoryStore.set(id, blob);
    return;
  }
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(blob, id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function savePosterDataUrl(id, dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  await savePoster(id, blob);
}

export async function getPoster(id) {
  if (!id) return null;
  const database = await openDatabase();
  if (!database) return memoryStore.get(id) || null;
  const blob = await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return blob;
}

export async function removePoster(id) {
  if (!id) return;
  const database = await openDatabase();
  if (!database) {
    memoryStore.delete(id);
    return;
  }
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}
