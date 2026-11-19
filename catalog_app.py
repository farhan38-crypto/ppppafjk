"""ROYAL TRADING COMPANY — public customer catalogue (a separate website).

Run:  python catalog_app.py        → http://<this-pc-ip>:8080  (customers on your Wi-Fi)

Security design
---------------
* This program never imports the admin code and never opens shop.db. The only data it can
  read is catalog.db, which holds just the public catalogue (titles, pictures, your price,
  Amazon's price, in stock yes/no) and customers' order requests.
* Prices in an order are always taken from the database, never from what the browser sends.
* Inputs are length-checked; order requests are rate-limited per device; a hidden honeypot
  field silently drops bots.
* Strict security headers (CSP without inline scripts, no framing, no referrer, nosniff).
* Product pictures are served through /img/<id> (only pictures of listed items), so customers'
  browsers never talk to the source websites.
"""
from __future__ import annotations

import hashlib
import re
import secrets
import string
import threading
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field, field_validator

import catalog_db as cdbm

HERE = Path(__file__).parent
STATIC = HERE / "static" / "catalog"
IMG_CACHE = HERE / "catalog_images"
IMG_CACHE.mkdir(exist_ok=True)
SALT = secrets.token_hex(16)          # per-run salt: we store only hashed IPs

app = FastAPI(title="Catalogue", docs_url=None, redoc_url=None, openapi_url=None)
cdbm.init()

CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
       "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; "
       "frame-ancestors 'none'")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    if request.method not in ("GET", "POST", "HEAD"):
        return JSONResponse({"detail": "Method not allowed"}, status_code=405)
    resp = await call_next(request)
    resp.headers["Content-Security-Policy"] = CSP
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    if request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    if "server" in resp.headers:
        del resp.headers["server"]
    return resp


# ---------------------------------------------------------------- pages
@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/assets/{name}")
def asset(name: str):
    if not re.fullmatch(r"[a-z0-9_-]+\.(js|css|svg|png)", name):
        raise HTTPException(404)
    f = STATIC / name
    if not f.is_file():
        raise HTTPException(404)
    return FileResponse(f)


# ---------------------------------------------------------------- public data
@app.get("/api/info")
def shop_info():
    with cdbm.cdb() as con:
        i = cdbm.info(con)
    return {k: i.get(k, "") for k in ("shop_name", "tagline", "phone", "whatsapp", "address", "open")}


@app.get("/api/items")
def items():
    with cdbm.cdb() as con:
        rows = con.execute("SELECT id, title, description, category, our_price, compare_price, compare_store, badge, "
                           "in_stock, image IS NOT NULL AND image<>'' AS has_image FROM items WHERE visible=1 "
                           "ORDER BY sort, id DESC").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["image"] = f"/img/{d['id']}" if d.pop("has_image") else None
        cp = d["compare_price"]
        d["save"] = round(cp - d["our_price"]) if cp and cp > d["our_price"] else 0
        d["save_pct"] = round((cp - d["our_price"]) / cp * 100) if d["save"] else 0
        out.append(d)
    return out


# ---------------------------------------------------------------- images (proxied, allow-listed by item id)
_img_lock = threading.Lock()


@app.get("/img/{item_id}")
def image(item_id: int):
    for ext in ("jpg", "png", "webp", "gif"):
        f = IMG_CACHE / f"{item_id}.{ext}"
        if f.exists():
            return FileResponse(f, headers={"Cache-Control": "public, max-age=86400"})
    with cdbm.cdb() as con:
        row = con.execute("SELECT image FROM items WHERE id=? AND visible=1", (item_id,)).fetchone()
    url = row["image"] if row else None
    if not url or not re.match(r"^https://", url):
        raise HTTPException(404)
    with _img_lock:
        try:
            r = httpx.get(url, timeout=15, follow_redirects=True,
                          headers={"User-Agent": "Mozilla/5.0", "Accept": "image/*"})
        except httpx.HTTPError:
            raise HTTPException(404)
        ctype = r.headers.get("content-type", "").split(";")[0].strip()
        if r.status_code != 200 or ctype not in ("image/jpeg", "image/png", "image/webp", "image/gif") \
                or len(r.content) > 4_000_000:
            raise HTTPException(404)
        ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}[ctype]
        (IMG_CACHE / f"{item_id}.{ext}").write_bytes(r.content)
    return Response(r.content, media_type=ctype, headers={"Cache-Control": "public, max-age=86400"})


# ---------------------------------------------------------------- order requests
class Line(BaseModel):
    id: int = Field(gt=0)
    qty: int = Field(ge=1, le=20)


class OrderIn(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    phone: str = Field(min_length=10, max_length=16)
    address: str = Field("", max_length=200)
    note: str = Field("", max_length=300)
    items: list[Line] = Field(min_length=1, max_length=30)
    website: str = Field("", max_length=100)     # honeypot: real people never fill this

    @field_validator("phone")
    @classmethod
    def phone_ok(cls, v):
        digits = re.sub(r"\D", "", v)
        if not 10 <= len(digits) <= 13:
            raise ValueError("Enter a valid phone number")
        return digits

    @field_validator("name", "address", "note")
    @classmethod
    def clean(cls, v):
        return re.sub(r"[\x00-\x1f<>]", " ", v).strip()


_hits: dict[str, list[float]] = {}


def _rate_limited(key: str, limit: int, window: int) -> bool:
    now = time.time()
    _hits[key] = [t for t in _hits.get(key, []) if now - t < window]
    if len(_hits[key]) >= limit:
        return True
    _hits[key].append(now)
    return False


def _ref() -> str:
    return "RTC-" + "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(6))


@app.post("/api/order")
def place_order(body: OrderIn, request: Request):
    ip = request.client.host if request.client else "?"
    ip_hash = hashlib.sha256((SALT + ip).encode()).hexdigest()[:16]
    if _rate_limited("o:" + ip_hash, 5, 600):
        raise HTTPException(429, "Too many requests from this device. Please try again in a few minutes.")
    if body.website:                       # bot → pretend success, store nothing
        return {"ref": _ref(), "total": 0}
    merged: dict[int, int] = {}
    for l in body.items:
        merged[l.id] = min(20, merged.get(l.id, 0) + l.qty)
    with cdbm.cdb() as con:
        if cdbm.info(con).get("open", "1") != "1":
            raise HTTPException(503, "We're not taking orders right now. Please call us.")
        lines, total = [], 0.0
        for iid, qty in merged.items():
            it = con.execute("SELECT id, title, our_price FROM items WHERE id=? AND visible=1", (iid,)).fetchone()
            if not it:
                raise HTTPException(400, "Some items are no longer available. Please refresh the page.")
            lines.append((it["id"], it["title"], qty, it["our_price"]))
            total += qty * it["our_price"]
        ref = _ref()
        while con.execute("SELECT 1 FROM orders WHERE ref=?", (ref,)).fetchone():
            ref = _ref()
        oid = con.execute("INSERT INTO orders(ref, name, phone, address, note, total, ip_hash) VALUES (?,?,?,?,?,?,?)",
                          (ref, body.name, body.phone, body.address, body.note, round(total, 2), ip_hash)).lastrowid
        for iid, title, qty, price in lines:
            con.execute("INSERT INTO order_items(order_id, item_id, title, qty, price) VALUES (?,?,?,?,?)",
                        (oid, iid, title, qty, price))
    return {"ref": ref, "total": round(total, 2)}


@app.get("/api/order/{ref}")
def order_status(ref: str, phone: str, request: Request):
    ip = request.client.host if request.client else "?"
    if _rate_limited("s:" + ip, 30, 600):
        raise HTTPException(429, "Too many requests. Please wait a bit.")
    if not re.fullmatch(r"RTC-[A-Z0-9]{6}", ref.upper()):
        raise HTTPException(404, "Request not found")
    digits = re.sub(r"\D", "", phone)
    with cdbm.cdb() as con:
        o = con.execute("SELECT id, ref, created_at, status, total FROM orders WHERE ref=? AND phone=?",
                        (ref.upper(), digits)).fetchone()
        if not o:
            raise HTTPException(404, "Request not found — check the reference and phone number")
        its = con.execute("SELECT title, qty, price FROM order_items WHERE order_id=?", (o["id"],)).fetchall()
    return {"ref": o["ref"], "created_at": o["created_at"], "status": o["status"], "total": o["total"],
            "items": [dict(x) for x in its]}


@app.exception_handler(404)
async def not_found(request: Request, exc):
    return JSONResponse({"detail": getattr(exc, "detail", "Not found")}, status_code=404)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080, server_header=False, proxy_headers=False)
