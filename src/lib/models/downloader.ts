// 模型下载与缓存：Cache API 存储，支持进度回调、多地址回落、取消

export interface DownloadProgress {
  received: number
  total: number
  done: boolean
}

const CACHE_NAME = 'vt-model-cache'

async function getCache(): Promise<Cache> {
  return caches.open(CACHE_NAME)
}

export async function getCachedResponse(url: string): Promise<Response | null> {
  if (!('caches' in window)) return null
  const cache = await getCache()
  return (await cache.match(url)) ?? null
}

// 是否已缓存（按优先级探测任一地址）
export async function isCached(urls: string[]): Promise<boolean> {
  for (const u of urls) {
    if (await getCachedResponse(u)) return true
  }
  return false
}

// 已缓存的字节数（未缓存返回 0）
export async function cachedSize(urls: string[]): Promise<number> {
  for (const u of urls) {
    const r = await getCachedResponse(u)
    if (r) {
      const len = Number(r.headers.get('content-length') || 0)
      if (len > 0) return len
      return (await r.clone().blob()).size
    }
  }
  return 0
}

// 依次尝试 urls 下载（缓存命中直接返回），带进度；成功后写入缓存
export async function downloadWithProgress(
  urls: string[],
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<Response> {
  let lastErr: Error | null = null
  for (const url of urls) {
    try {
      const cached = await getCachedResponse(url)
      if (cached) {
        onProgress({ received: 1, total: 1, done: true })
        return cached
      }
      const res = await fetch(url, { signal })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length') || 0)
      const reader = res.body.getReader()
      const chunks: BlobPart[] = []
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.length
        onProgress({ received, total: total || received, done: false })
      }
      const blob = new Blob(chunks)
      onProgress({ received: blob.size, total: blob.size, done: true })
      const cachedRes = new Response(blob, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(blob.size),
        },
      })
      const cache = await getCache()
      await cache.put(url, cachedRes.clone())
      return cachedRes
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e
      lastErr = e as Error
    }
  }
  throw lastErr ?? new Error('下载失败：所有地址均不可达')
}

export async function deleteCached(urls: string[]): Promise<void> {
  const cache = await getCache()
  await Promise.all(urls.map((u) => cache.delete(u)))
}

// 下载（或读缓存）并转为 blob URL —— 供 emscripten locateFile 使用
export async function cachedBlobUrl(
  urls: string[],
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await downloadWithProgress(urls, onProgress, signal)
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}
