# 👻 phantom-arsenal

> Advanced Red Team Toolkit — For authorized penetration testing only

---

## Tools

### 🎣 PhishClone (`phisher.py`)
Clone any login page with 100% accuracy and harvest credentials in real-time.

**Features:**
- ✅ Clones any login page (CSS, JS, assets — all preserved)
- ✅ Live keystroke logging via WebSocket (see every key as victim types)
- ✅ Captures credentials + victim IP automatically
- ✅ Saves to `captured_creds.json`
- ✅ Redirects victim to original site after submit (seamless)
- ✅ View all creds at `/creds` endpoint

**Install:**
```bash
pip install websockets
```

**Usage:**
```bash
python3 phisher.py https://target.com/login 8080
```

**Output:**
```
[KEYSTROKE] field=password key=a value=a
[KEYSTROKE] field=password key=b value=ab
[CAPTURED] IP=192.168.1.5 → {"email": "victim@gmail.com", "password": "secret123"}
```

**Endpoints:**
- `http://localhost:8080/` — Cloned login page
- `http://localhost:8080/creds` — All captured credentials (JSON)

---

> ⚠️ For authorized security testing, CTF, and educational use only.
