import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import { readAndoc, type AndocPackage } from './package.js'
import { ANX_VIEW_SCRIPT, renderHtml } from './render.js'

export interface StandaloneViewerOptions {
  host?: string
  port?: number
  /** Extra Host header names to accept, for a deliberate non-loopback bind. Loopback names are always accepted. */
  allowedHosts?: string[]
}

export interface StandaloneViewerServerOptions {
  allowedHosts?: string[]
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

// A package is hostile input. Media that the derived view can show inline keeps its
// declared type; everything else is downloaded as opaque bytes, never rendered.
const INLINE_ASSET_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])
const SOURCE_MEDIA_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])

const VIEW_SCRIPT_HASH = createHash('sha256').update(ANX_VIEW_SCRIPT).digest('base64')
/**
 * Policy for the derived view: only the renderer's own constant script may run, in a
 * sandbox with an opaque origin. Downloads stay allowed so the view's link to the
 * retained original source still works.
 */
export const ANX_VIEW_CONTENT_SECURITY_POLICY = `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'sha256-${VIEW_SCRIPT_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-downloads`
const SHELL_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const INERT_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox"

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
</style></head><body><header><b>${escapeHtml(pkg.document.title)}</b><span class="tag">revision ${pkg.document.revision}</span><span class="tag">${escapeHtml(profileNames)}</span><span class="tag">${pkg.finalizations.length ? `${pkg.finalizations.length} finalization record(s)` : 'unfinalized'}</span><span class="grow"></span><a href="/document.json">Canonical JSON</a>${original ? `<a href="/${encodeURI(original)}" download>Original source</a>` : ''}</header><iframe title="${escapeHtml(pkg.document.title)}" src="/view.html" sandbox="allow-scripts allow-downloads"></iframe></body></html>`
}

export function createStandaloneViewerServer(pkg: AndocPackage, options: StandaloneViewerServerOptions = {}): Server {
  // The human view is always rendered here from the validated canonical document.
  // The package's stored views/document.html is a cache written by whoever made the
  // package; it is hash-declared but not otherwise trusted, so it is never served.
  const view = renderHtml(pkg.document)
  const allowedHosts = new Set([...LOOPBACK_HOSTS, ...(options.allowedHosts || []).map(normalizeHostName)])
  return createServer((request, response) => {
    const head = request.method === 'HEAD'
    if (!hostAllowed(request, allowedHosts)) return send(response, 403, 'text/plain; charset=utf-8', 'Host not allowed')
    const pathname = safePathname(request.url)
    if (!pathname) return send(response, 400, 'text/plain; charset=utf-8', 'Invalid request path')
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, 'text/plain; charset=utf-8', 'Read-only viewer')
    if (pathname === '/') return send(response, 200, 'text/html; charset=utf-8', standaloneViewerShell(pkg), head, SHELL_CONTENT_SECURITY_POLICY)
    if (pathname === '/view.html') return send(response, 200, 'text/html; charset=utf-8', view, head, ANX_VIEW_CONTENT_SECURITY_POLICY)
    if (pathname === '/document.json') return send(response, 200, 'application/json; charset=utf-8', `${JSON.stringify(pkg.document, null, 2)}\n`, head)
    if (pathname === '/health') return send(response, 200, 'application/json; charset=utf-8', `${JSON.stringify({ ok: true, mode: 'read-only', documentId: pkg.document.documentId, revision: pkg.document.revision })}\n`, head)
    const packagePath = pathname.slice(1)
    const bytes = pkg.files[packagePath]
    const isSource = packagePath.startsWith('sources/original/')
    if (!bytes || (!packagePath.startsWith('assets/') && !isSource)) return send(response, 404, 'text/plain; charset=utf-8', 'Not found')
    const declared = (pkg.manifest.entries.find(entry => entry.path === packagePath)?.mediaType || '').toLowerCase()
    const inline = !isSource && INLINE_ASSET_MEDIA_TYPES.has(declared)
    const mediaType = inline || (isSource && SOURCE_MEDIA_TYPES.has(declared)) ? declared : 'application/octet-stream'
    if (!inline) response.setHeader('Content-Disposition', `attachment; filename="${path.basename(packagePath).replace(/[^\x20-\x7e]|["\\]/g, '_')}"`)
    return send(response, 200, mediaType, bytes, head)
  })
}

export async function startStandaloneViewer(inputPath: string, options: StandaloneViewerOptions = {}): Promise<StandaloneViewerHandle> {
  const pkg = await readAndoc(inputPath)
  const host = options.host || '127.0.0.1'
  const server = createStandaloneViewerServer(pkg, { allowedHosts: [...(options.allowedHosts || []), ...(options.host ? [options.host] : [])] })
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

function send(response: ServerResponse, status: number, mediaType: string, body: string | Uint8Array, head = false, contentSecurityPolicy = INERT_CONTENT_SECURITY_POLICY): void {
  const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body)
  response.writeHead(status, {
    'Content-Type': mediaType,
    'Content-Length': bytes.length,
    'Content-Security-Policy': contentSecurityPolicy,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  })
  response.end(head ? undefined : bytes)
}

// A page on another site can point its own name at 127.0.0.1 (DNS rebinding) and
// then read this server as same-origin. Requiring a known Host name stops that.
function hostAllowed(request: IncomingMessage, allowedHosts: Set<string>): boolean {
  const header = request.headers.host
  if (!header) return false
  try {
    const url = new URL(`http://${header}`)
    const port = url.port ? Number(url.port) : 80
    return allowedHosts.has(url.hostname.toLowerCase()) && port === request.socket.localPort
  } catch {
    return false
  }
}

function normalizeHostName(value: string): string {
  const name = value.trim().toLowerCase()
  return name.includes(':') && !name.startsWith('[') ? `[${name}]` : name
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
