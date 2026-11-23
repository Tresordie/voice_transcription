/// <reference types="node" />
import { execFile as execFileCb } from 'node:child_process'
import { existsSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { IncomingMessage } from 'node:http'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 开发服务器内置 CORS 透传代理：/proxy/<target-url>
// 浏览器访问同源 localhost:5173 → 无跨域问题 → 可直连未开放 CORS 的服务商（阿里百炼等）。
// 代理只做透明转发，不存储 API Key 与音频内容。
// 独立部署时等价方案：npm run proxy（见 proxy.mjs）。
function corsProxyPlugin(): Plugin {
  return {
    name: 'dev-cors-proxy',
    configureServer(server) {
      server.middlewares.use('/proxy', async (req, res) => {
        try {
          const target = (req.url || '').replace(/^\//, '')
          if (!/^https?:\/\//.test(target)) {
            res.statusCode = 400
            res.setHeader('content-type', 'text/plain; charset=utf-8')
            res.end('用法: /proxy/<target-url>')
            return
          }
          // 转发请求头（去掉 hop-by-hop 与本机相关头）
          const headers: Record<string, string> = {}
          for (const [k, v] of Object.entries(req.headers)) {
            if (
              ['host', 'connection', 'content-length', 'accept-encoding', 'origin', 'referer'].includes(k)
            ) continue
            if (typeof v === 'string') headers[k] = v
          }
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const body = Buffer.concat(chunks)

          const upstream = await fetch(target, {
            method: req.method,
            headers,
            body: body.length > 0 ? body : undefined,
          })
          res.statusCode = upstream.status
          upstream.headers.forEach((v, k) => {
            if (['content-encoding', 'content-length', 'transfer-encoding'].includes(k)) return
            res.setHeader(k, v)
          })
          // 流式透传（支持 LLM SSE 逐字输出；body 为空时直接结束）
          if (!upstream.body) {
            res.end()
            return
          }
          const reader = upstream.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            res.write(Buffer.from(value))
          }
          res.end()
        } catch (e) {
          res.statusCode = 502
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end(`代理请求失败: ${(e as Error).message}`)
        }
      })
    },
  }
}

// 开发服务器内置 git 备份服务：/backup-api
// 「历史记录」页一键把转录历史 JSON 写入备份仓库 data/history.json，
// 自动 commit + push 到 origin 的全部推送地址（默认 GitHub + Gitee 双端）。
// 备份仓库默认取项目同级 ../voice_transcription_database，可用环境变量
// BACKUP_REPO_PATH 覆盖。仅本机 dev 场景可用；接口不存在时前端自动退回浏览器下载。
function backupPlugin(): Plugin {
  const repoPath =
    process.env.BACKUP_REPO_PATH ||
    path.resolve(process.cwd(), '../voice_transcription_database')
  const dataFile = path.join(repoPath, 'data', 'history.json')

  type GitFail = Error & { stderr?: string }
  const exec = promisify(execFileCb)
  // maxBuffer 需容纳 data/history.json 整文件内容（git show 读取版本内容用）
  const run = (args: string[]) =>
    exec('git', args, { cwd: repoPath, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })

  const isRepo = () => existsSync(path.join(repoPath, '.git'))

  const readBody = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('error', reject)
      req.on('end', () => resolve(Buffer.concat(chunks)))
    })

  /** origin 的全部推送地址（双推配置下为多条；未配置 pushurl 时回落 url） */
  async function pushUrls(): Promise<string[]> {
    try {
      const { stdout } = await run(['config', '--get-all', 'remote.origin.pushurl'])
      const urls = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (urls.length > 0) return urls
    } catch {
      // 回落到 url
    }
    try {
      const { stdout } = await run(['config', '--get', 'remote.origin.url'])
      return stdout.trim() ? [stdout.trim()] : []
    } catch {
      return []
    }
  }

  /** 逐条推送当前分支，回报每个远端的结果（部分失败不影响其余） */
  async function pushBranch(): Promise<{ url: string; ok: boolean; detail?: string }[]> {
    const { stdout } = await run(['rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = stdout.trim() || 'master'
    const results: { url: string; ok: boolean; detail?: string }[] = []
    for (const url of await pushUrls()) {
      try {
        await run(['push', url, branch])
        results.push({ url, ok: true })
      } catch (e) {
        const err = e as GitFail
        const detail = (err.stderr || err.message || '')
          .trim()
          .split(/\r?\n/)
          .slice(-2)
          .join(' ⏎ ')
        results.push({ url, ok: false, detail })
      }
    }
    return results
  }

  /** data/history.json 有变化时提交（仅限该路径，不携带仓库里其他暂存内容） */
  async function commitIfChanged(count?: number): Promise<boolean> {
    await run(['add', 'data/history.json'])
    const { stdout } = await run(['status', '--porcelain', '--', 'data/history.json'])
    if (!stdout.trim()) return false
    const ts = new Date().toLocaleString('zh-CN', { hour12: false })
    const msg = `backup: 历史记录备份 ${ts}${typeof count === 'number' ? ` · ${count} 条` : ''}`
    await run(['commit', '-m', msg, '--', 'data/history.json'])
    return true
  }

  async function statusPayload() {
    const fileExists = existsSync(dataFile)
    const payload: {
      connected: boolean
      repoPath: string
      fileExists: boolean
      fileMtime: string | null
      lastCommit: { hash: string; date: string; message: string } | null
    } = { connected: true, repoPath, fileExists, fileMtime: null, lastCommit: null }
    if (fileExists) {
      payload.fileMtime = (await fsp.stat(dataFile)).mtime.toISOString()
    }
    try {
      const { stdout } = await run(['log', '-1', '--format=%h|%cI|%s', '--', 'data/history.json'])
      const line = stdout.trim()
      if (line) {
        const [hash, date, ...rest] = line.split('|')
        payload.lastCommit = { hash, date, message: rest.join('|') }
      }
    } catch {
      // 尚无涉及该文件的提交
    }
    return payload
  }

  return {
    name: 'dev-backup-service',
    configureServer(server) {
      server.middlewares.use('/backup-api', async (req, res) => {
        const send = (code: number, data: unknown) => {
          res.statusCode = code
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(data))
        }
        const route = (req.url || '').split('?')[0]
        try {
          // GET /status：备份仓库路径、data/history.json 状态、最近提交
          if (req.method === 'GET' && route === '/status') {
            if (!isRepo()) return send(200, { connected: false, repoPath })
            return send(200, await statusPayload())
          }
          // GET /versions：data/history.json 的备份版本列表（最近 50 条提交）
          if (req.method === 'GET' && route === '/versions') {
            if (!isRepo()) return send(500, { ok: false, error: `备份仓库不存在：${repoPath}` })
            try {
              const { stdout } = await run(['log', '--max-count=50', '--format=%h|%cI|%s', '--', 'data/history.json'])
              const versions = stdout
                .split(/\r?\n/)
                .filter(Boolean)
                .map((line) => {
                  const [hash, date, ...rest] = line.split('|')
                  return { hash, date, message: rest.join('|') }
                })
              return send(200, { ok: true, versions })
            } catch {
              return send(200, { ok: true, versions: [] }) // 文件尚无提交历史
            }
          }
          // GET /version?hash=<sha>：读取指定版本的 data/history.json 内容
          if (req.method === 'GET' && route === '/version') {
            if (!isRepo()) return send(500, { ok: false, error: `备份仓库不存在：${repoPath}` })
            const hash = new URL(req.url || '/', 'http://localhost').searchParams.get('hash') || ''
            if (!/^[0-9a-f]{7,40}$/.test(hash)) {
              return send(400, { ok: false, error: '无效的提交哈希' })
            }
            try {
              const { stdout } = await run(['show', `${hash}:data/history.json`])
              return send(200, { ok: true, content: stdout })
            } catch (e) {
              return send(404, { ok: false, error: `该版本不存在此文件：${(e as GitFail).stderr?.trim().split(/\r?\n/)[0] || (e as Error).message}` })
            }
          }
          // POST /save：写入 data/history.json + 自动 commit + push
          // POST /push：手动推送（把已存在的 data/history.json 提交并推送）
          if (req.method === 'POST' && (route === '/save' || route === '/push')) {
            if (!isRepo()) return send(500, { ok: false, error: `备份仓库不存在：${repoPath}` })
            if (route === '/save') {
              const body = (await readBody(req)).toString('utf8')
              let count: number
              try {
                const parsed = JSON.parse(body) as { items?: unknown }
                const items = Array.isArray(parsed) ? parsed : parsed?.items
                if (!Array.isArray(items)) throw new Error('no items')
                count = items.length
              } catch {
                return send(400, { ok: false, error: 'JSON 格式不正确：应为含 items 数组的历史备份' })
              }
              await fsp.mkdir(path.dirname(dataFile), { recursive: true })
              await fsp.writeFile(dataFile, body, 'utf8')
              const committed = await commitIfChanged(count)
              const pushed = await pushBranch()
              return send(200, { ok: true, committed, pushed })
            }
            if (!existsSync(dataFile)) {
              return send(400, { ok: false, error: 'data/history.json 尚不存在，请先「备份并推送」生成' })
            }
            const committed = await commitIfChanged()
            const pushed = await pushBranch()
            return send(200, { ok: true, committed, pushed })
          }
          return send(404, { error: '未知接口' })
        } catch (e) {
          return send(500, { ok: false, error: (e as Error).message })
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), corsProxyPlugin(), backupPlugin()],
  server: {
    host: true,
    // sherpa 运行时为大型二进制文件，无需 HMR 监视；
    // 且 Windows 下文件拷贝期间的锁定会触发 EBUSY 导致 dev 服务器崩溃
    watch: {
      ignored: ['**/public/sherpa/**'],
    },
  },
})
