/// <reference types="node" />
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
          res.end(Buffer.from(await upstream.arrayBuffer()))
        } catch (e) {
          res.statusCode = 502
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end(`代理请求失败: ${(e as Error).message}`)
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), corsProxyPlugin()],
  server: {
    host: true,
  },
})
