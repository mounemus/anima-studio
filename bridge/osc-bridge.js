#!/usr/bin/env node
/**
 * Anima Studio — OSC bridge (WebSocket ↔ UDP/OSC relay).
 *
 * Browsers can't speak UDP, so this tiny relay lets Anima (in the browser) talk
 * OSC to Resolume / TouchDesigner / Ableton / QLab, etc.:
 *
 *   Anima ──WebSocket(binary OSC)──► bridge ──UDP──► Resolume/TD   (OUT)
 *   Anima ◄─WebSocket(binary OSC)── bridge ◄─UDP── Resolume/TD     (IN)
 *
 * SETUP
 *   1. Install the one dependency:   npm install ws
 *   2. Run it:                       node osc-bridge.js
 *   3. In Anima → onglet "Sens" → OSC → connect to  ws://localhost:8080,
 *      cochez IN et/ou OUT.
 *   4. In your VJ tool:
 *      - to RECEIVE from Anima  → listen for OSC on UDP port 7000 (OSC_SEND_PORT)
 *      - to SEND to Anima       → send OSC to   UDP port 7001 (OSC_RECV_PORT)
 *
 * Ports are overridable via env vars, e.g.:
 *   WS_PORT=8080 OSC_HOST=127.0.0.1 OSC_SEND_PORT=7000 OSC_RECV_PORT=7001 node osc-bridge.js
 */
const dgram = require('dgram')
let WebSocketServer
try { ({ WebSocketServer } = require('ws')) }
catch { console.error('Missing dependency. Run:  npm install ws'); process.exit(1) }

const WS_PORT       = +(process.env.WS_PORT       || 8080)
const OSC_HOST      =   process.env.OSC_HOST      || '127.0.0.1'
const OSC_SEND_PORT = +(process.env.OSC_SEND_PORT || 7000)  // Anima → tool
const OSC_RECV_PORT = +(process.env.OSC_RECV_PORT || 7001)  // tool  → Anima

const udpOut = dgram.createSocket('udp4')
const udpIn  = dgram.createSocket('udp4')
const wss    = new WebSocketServer({ port: WS_PORT })

wss.on('connection', (ws) => {
  console.log('[bridge] browser connected')
  ws.on('message', (data) => {
    // Binary OSC packet from Anima → forward to the VJ tool over UDP.
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    udpOut.send(buf, OSC_SEND_PORT, OSC_HOST)
  })
  ws.on('close', () => console.log('[bridge] browser disconnected'))
})

udpIn.on('message', (msg) => {
  // OSC from the VJ tool → broadcast to every connected browser as binary.
  wss.clients.forEach((c) => { if (c.readyState === 1) c.send(msg) })
})
udpIn.on('error', (e) => console.error('[bridge] UDP in error:', e.message))
udpIn.bind(OSC_RECV_PORT)

console.log(`[bridge] WebSocket :${WS_PORT}`)
console.log(`[bridge]   OUT → UDP ${OSC_HOST}:${OSC_SEND_PORT}   (point your tool's OSC input here)`)
console.log(`[bridge]   IN  ← UDP :${OSC_RECV_PORT}              (send OSC here to reach Anima)`)
