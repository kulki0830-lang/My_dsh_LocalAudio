/**
 * dsh-voice — permanent host half, stage P1 (mount scaffold).
 *
 * Scope: prove the bundle-patch mount and the webServer route channel with a
 * single loopback-only ping route. No voice logic, no subprocess, no bridge.
 * P2 ports the full dynamic-plugin host onto this skeleton.
 *
 * Channel contract (confirmed against @linxin666/dsh-ssh): client halves call
 * the host over plain HTTP routes registered on ctx.webServer; each route is
 * `{ kind: 'exact', path, handler(req, res) }`.
 */

/** Stable cordis plugin name. */
const name = 'voice'

/**
 * Services required before this plugin mounts. `webServer` hosts the
 * /api/dsh-voice/* route family; P2 adds 'subprocess'/'timer'/'fs' as the
 * ported logic needs them.
 */
const inject = ['webServer']

/** Route family prefix (protocol.ts from P2 onward lives beside these). */
const API = {
  ping: '/api/dsh-voice/ping',
}

/** One JSON response with no-referrer hygiene (mirrors dsh-ssh routes.ts). */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Loopback fence: LAN-exposed deployments must not serve control routes. */
function isLoopbackRequest(req) {
  const remote = req.socket && req.socket.remoteAddress
  if (!remote) return false
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

/**
 * Mount the P1 surface.
 * @param ctx - host plugin context carrying webServer.
 */
function apply(ctx) {
  const pingRoute = {
    kind: 'exact',
    path: API.ping,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      writeJson(res, 200, { ok: true, plugin: 'dsh-voice', stage: 'P1', now: new Date().toISOString() })
    },
  }
  ctx.effect(() => ctx.webServer.register(pingRoute), 'dsh-voice: ping route')
}

export { API, apply, inject, name }
