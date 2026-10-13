import { createServer, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import { readAndoc, type AndocPackage } from './package.js'

export interface StandaloneViewerOptions {
  host?: string
  port?: number
}

export interface StandaloneViewerHandle {
  host: string
  port: number
  url: string
  close(): Promise<void>
}

export function standaloneViewerShell(pkg: AndocPackage): string {
  const original = Object.keys(pkg.files).find(name => name.startsWith('sources/original/'))
  const profileNames = (pkg.profiles?.profiles || []).map(profile => profile.id).join(', ') || 'core document'
  return `<!doctype html><html lang="${escapeHtml(pkg.document.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(pkg.document.title)} - ANX Viewer</title><style>
*{box-sizing:border-box}body{margin:0;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#e7e5e4;color:#1c1917}header{height:58px;background:#1c1917;color:#fafaf9;display:flex;align-items:center;gap:12px;padding:0 16px}header b{font-size:16px}.tag{background:#44403c;border-radius:999px;padding:3px 9px;font-size:12px}header span.grow{flex:1}a{color:inherit}header a{background:#fafaf9;color:#1c1917;text-decoration:none;padding:7px 10px;border-radius:5px}iframe{display:block;width:100%;height:calc(100vh - 58px);border:0;background:#fff}
</style></head><body><header><b>${escapeHtml(pkg.document.title)}</b><span class="tag">revision ${pkg.document.revision}</span><span class="tag">${escapeHtml(profileNames)}</span><span class="tag">${pkg.finalizations.length ? `${pkg.finalizations.length} finalization record(s)` : 'unfinalized'}</span><span class="grow"></span><a href="/document.json">Canonical JSON</a>${original ? `<a href="/${encodeURI(original)}" download>Original source</a>` : ''}</header><iframe title="${escapeHtml(pkg.document.title)}" src="/view.html"></iframe></body></html>`
}

export function createStandaloneViewerServer(pkg: AndocPackage): Server {
  return createServer((request, response) => {
    const pathname = safePathname(request.url)
    if (!pathname) return send(response, 400, 'text/plain; charset=utf-8', 'Invalid request path')
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, 'text/plain; charset=utf-8', 'Read-only viewer')
    if (pathname === '/') return send(response, 200, 'text/html; charset=utf-8', standaloneViewerShell(pkg), request.method === 'HEAD')
    if (pathname === '/view.html') return send(response, 200, 'text/html; charset=utf-8', pkg.files['views/document.html']!, request.method === 'HEAD')
    if (pathname === '/document.json') return send(response, 200, 'application/json; charset=utf-8', `${JSON.stringify(pkg.document, null, 2)}\n`, request.method === 'HEAD')
    if (pathname === '/health') return send(response, 200, 'application/json; charset=utf-8', `${JSON.stringify({ ok: true, mode: 'read-only', documentId: pkg.document.documentId, revision: pkg.document.revision })}\n`, request.method === 'HEAD')
    const packagePath = pathname.slice(1)
    const bytes = pkg.files[packagePath]
    if (!bytes || (!packagePath.startsWith('assets/') && !packagePath.startsWith('sources/original/'))) return send(response, 404, 'text/plain; charset=utf-8', 'Not found')
    const mediaType = pkg.manifest.entries.find(entry => entry.path === packagePath)?.mediaType || 'application/octet-stream'
    if (packagePath.startsWith('sources/original/')) response.setHeader('Content-Disposition', `attachment; filename="${path.basename(packagePath).replace(/["\\]/g, '_')}"`)
    return send(response, 200, mediaType, bytes, request.method === 'HEAD')
  })
}

export async function startStandaloneViewer(inputPath: string, options: StandaloneViewerOptions = {}): Promise<StandaloneViewerHandle> {
  const pkg = await readAndoc(inputPath)
  const host = options.host || '127.0.0.1'
  const server = createStandaloneViewerServer(pkg)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 8787, host, () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Standalone viewer did not bind to a TCP port')
  return {
    host,
    port: address.port,
    url: `http://${host}:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

function safePathname(url: string | undefined): string | null {
  try {
    const pathname = decodeURIComponent(new URL(url || '/', 'http://anx.local').pathname)
    if (pathname.includes('\\') || pathname.split('/').includes('..')) return null
    return pathname
  } catch {
    return null
  }
}

function send(response: ServerResponse, status: number, mediaType: string, body: string | Uint8Array, head = false): void {
  const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body)
  response.writeHead(status, { 'Content-Type': mediaType, 'Content-Length': bytes.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' })
  response.end(head ? undefined : bytes)
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
