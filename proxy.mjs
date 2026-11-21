// 可选 CORS 代理：仅当某服务商禁止浏览器直连（CORS 拦截）时使用。
//
// 用法：npm run proxy
// 然后把应用的「Base URL」改为： http://localhost:8787/proxy/<服务商BaseURL>
// 例如：                        http://localhost:8787/proxy/https://api.openai.com/v1
//
// 说明：代理只做透明转发，不存储、不打印任何密钥或音频内容；
// API Key 仍由你的浏览器随请求携带。
import http from 'node:http'

const PORT = Number(process.env.PORT || 8787)

const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-max-age': '86400',
    })
    return res.end()
  }

  const marker = '/proxy/'
  const idx = (req.url || '').indexOf(marker)
  if (idx === -1) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('用法: /proxy/<target-url>')
  }
  const target = req.url.slice(idx + marker.length)
  if (!/^https?:\/\//.test(target)) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('目标地址必须以 http:// 或 https:// 开头')
  }

  try {
    // 转发请求头（去掉 hop-by-hop 与本机相关头）
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (['host', 'connection', 'content-length', 'accept-encoding', 'origin', 'referer'].includes(k)) continue
      headers[k] = v
    }
    const body = await new Promise((resolve) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks)))
    })

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: body.length > 0 ? body : undefined,
    })

    const outHeaders = {}
    upstream.headers.forEach((v, k) => {
      if (['content-encoding', 'content-length', 'transfer-encoding'].includes(k)) return
      outHeaders[k] = v
    })
    outHeaders['access-control-allow-origin'] = '*'

    res.writeHead(upstream.status, outHeaders)
    res.end(Buffer.from(await upstream.arrayBuffer()))
  } catch (e) {
    res.writeHead(502, {
      'content-type': 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*',
    })
    res.end(`代理请求失败: ${e.message}`)
  }
})

server.listen(PORT, () => {
  console.log(`VoiceTrans CORS 代理已启动: http://localhost:${PORT}`)
  console.log(`把应用的 Base URL 设为: http://localhost:${PORT}/proxy/<服务商BaseURL>`)
  console.log(`例如:                    http://localhost:${PORT}/proxy/https://api.openai.com/v1`)
})
