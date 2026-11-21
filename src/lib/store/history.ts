// 转录历史：IndexedDB 持久化
export interface HistoryItem {
  id: string
  createdAt: number
  source: 'live' | 'file'
  /** 展示用引擎名，如 '本地模型' / '在线 · FunAudioLLM/SenseVoiceSmall' */
  engine: string
  durationSec: number
  text: string
}

const DB_NAME = 'vt-db'
const STORE = 'history'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function runTx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode)
      const req = fn(t.objectStore(STORE))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export async function listHistory(): Promise<HistoryItem[]> {
  const items = await runTx<HistoryItem[]>('readonly', (s) => s.getAll())
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

export async function addHistoryItem(item: HistoryItem): Promise<void> {
  await runTx('readwrite', (s) => s.put(item))
}

export async function deleteHistoryItem(id: string): Promise<void> {
  await runTx('readwrite', (s) => s.delete(id))
}

export async function clearHistory(): Promise<void> {
  await runTx('readwrite', (s) => s.clear())
}
