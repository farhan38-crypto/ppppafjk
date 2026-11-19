"""ROYAL TRADING COMPANY — admin app (inventory, billing, finance, catalogue, price tracking).

Run `python app.py`, then open http://127.0.0.1:8000 and log in.
The customer catalogue is a separate program: `python catalog_app.py` (port 8080).
"""
import json
import threading
import time
from collections import OrderedDict
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from pydantic import BaseModel

from buyhatke import Buyhatke, BuyhatkeError, NotLoggedIn
import auth
import catalog_admin
import shop

HERE = Path(__file__).parent
bh = Buyhatke(HERE / "session.json")
app = FastAPI(title="Royal Trading Company", docs_url=None, redoc_url=None, openapi_url=None)
shop.init_db()
auth.init()
catalog_admin.init()
app.include_router(auth.router)
app.include_router(shop.router)
app.include_router(catalog_admin.router)

CSP = ("default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; "
       "script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; "
       "frame-ancestors 'none'; form-action 'self'")
OPEN_PATHS = {"/login", "/static/login.html"}


@app.middleware("http")
async def guard(request: Request, call_next):
    path, method = request.url.path, request.method
    # 1. block cross-site requests that try to change data (CSRF), on top of SameSite=Strict cookies
    if method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if origin and urlparse(origin).netloc != request.headers.get("host"):
            return JSONResponse({"detail": "Cross-site request blocked"}, status_code=403)
    # 2. authentication
    user = None
    if not (path in OPEN_PATHS or auth._match(auth.PUBLIC, method, path)):
        user = auth.current_user(request)
        if not user:
            if path.startswith("/api/"):
                return JSONResponse({"error": "auth", "detail": "Please log in"}, status_code=401)
            return RedirectResponse("/login", status_code=303)
        # 3. role permissions
        if path.startswith("/api/") and not auth.allowed(user["role"], method, path):
            return JSONResponse({"detail": "Your account isn't allowed to do this"}, status_code=403)
    request.state.user = user
    resp = await call_next(request)
    # 4. cashier: strip cost / profit fields from every JSON response
    if user and user["role"] == "cashier" and resp.headers.get("content-type", "").startswith("application/json"):
        body = b"".join([chunk async for chunk in resp.body_iterator])
        try:
            data = auth.scrub(json.loads(body))
            body = json.dumps(data).encode()
        except ValueError:
            pass
        headers = {k: v for k, v in resp.headers.items() if k.lower() != "content-length"}
        resp = Response(body, status_code=resp.status_code, headers=headers, media_type="application/json")
    # 5. keep the public catalogue's in-stock flags current after stock changes
    if method in ("POST", "PUT", "DELETE") and path.startswith("/api/shop/") and resp.status_code < 300:
        try:
            catalog_admin.sync_stock()
        except Exception:
            pass
    # 6. security headers
    resp.headers["Content-Security-Policy"] = CSP
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    if path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.exception_handler(NotLoggedIn)
async def _need_login(_: Request, exc: NotLoggedIn):
    # Buyhatke account (price alerts) — not the app login
    return JSONResponse({"error": "login_required", "detail": str(exc)}, status_code=401)


@app.exception_handler(BuyhatkeError)
async def _bh_error(_: Request, exc: BuyhatkeError):
    return JSONResponse({"error": "buyhatke", "detail": str(exc)}, status_code=502)


@app.exception_handler(httpx.HTTPError)
async def _net_error(_: Request, exc: httpx.HTTPError):
    return JSONResponse({"error": "network", "detail": f"Couldn't reach Buyhatke: {str(exc).splitlines()[0]}"}, status_code=502)


@app.get("/login")
def login_page():
    return FileResponse(HERE / "static" / "login.html")


@app.get("/static/{name}")
def static_file(name: str):
    f = (HERE / "static" / name).resolve()
    if f.parent != (HERE / "static").resolve() or not f.is_file():
        raise HTTPException(404)
    return FileResponse(f)


@app.get("/")
def index():
    return FileResponse(HERE / "static" / "index.html")


# Small in-memory cache so typing (suggestions) and then pressing Enter (full
# results) only hits Buyhatke once per query.
_cache: OrderedDict[str, tuple[float, list]] = OrderedDict()
_cache_lock = threading.Lock()
CACHE_TTL, CACHE_MAX = 600, 200


def cached_search(q: str) -> list:
    key = " ".join(q.lower().split())
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_TTL:
            _cache.move_to_end(key)
            return hit[1]
    items = bh.search(q)
    with _cache_lock:
        _cache[key] = (now, items)
        _cache.move_to_end(key)
        while len(_cache) > CACHE_MAX:
            _cache.popitem(last=False)
    return items


@app.get("/api/search")
def search(q: str):
    if not q.strip():
        raise HTTPException(400, "Empty query")
    return cached_search(q.strip())


@app.get("/api/suggest")
def suggest(q: str, limit: int = 6):
    """Top matches for the search-as-you-type dropdown."""
    q = q.strip()
    if len(q) < 2:
        return []
    keep = ("name", "price", "mrp", "image", "site_image", "path", "brand")
    return [{k: p.get(k) for k in keep} for p in cached_search(q)[:max(1, min(limit, 10))]]


@app.get("/api/product")
def product(path: str | None = None, url: str | None = None):
    return bh.product(path=path, url=url)


class Email(BaseModel):
    email: str


class Otp(BaseModel):
    otp: str


class NewAlert(BaseModel):
    product: dict
    target_price: float


class AlertUpdate(BaseModel):
    alert_id: str | int
    target_price: float


class AlertId(BaseModel):
    alert_id: str | int


@app.get("/api/login/status")
def login_status():
    return bh.login_status()


@app.post("/api/login/send-otp")
def send_otp(body: Email):
    return bh.send_otp(body.email)


@app.post("/api/login/verify-otp")
def verify_otp(body: Otp):
    res = bh.verify_otp(body.otp)
    return {"result": res, "status": bh.login_status()}


@app.post("/api/logout")
def logout():
    bh.logout()
    return {"ok": True}


@app.get("/api/alerts")
def alerts():
    return bh.alerts()


@app.post("/api/alerts")
def set_alert(body: NewAlert):
    return bh.set_alert(body.product, body.target_price)


@app.post("/api/alerts/update")
def update_alert(body: AlertUpdate):
    return bh.update_alert(body.alert_id, body.target_price)


@app.post("/api/alerts/remove")
def remove_alert(body: AlertId):
    return bh.remove_alert(body.alert_id)


# ---- market reference for shop products (Buyhatke = what the same item costs online)
class MarketLink(BaseModel):
    path: str | None = None      # Buyhatke product path to link; omit to refresh the existing link
    url: str | None = None       # or a store link (Amazon/Flipkart/...) to link


@app.post("/api/shop/products/{pid}/market")
def refresh_market(pid: int, body: MarketLink = MarketLink()):
    with shop.db() as con:
        row = con.execute("SELECT bh_path FROM products WHERE id=?", (pid,)).fetchone()
        if not row:
            raise HTTPException(404, "Product not found")
        path = body.path or row["bh_path"]
    if body.url:
        m = shop.market_from_buyhatke(bh.product(url=body.url))
    elif path:
        m = shop.market_from_buyhatke(bh.product(path=path))
    else:
        raise HTTPException(400, "This product isn't linked to an online listing yet")
    with shop.db() as con:
        shop.set_market(con, pid, m)
    return m


@app.post("/api/shop/market/refresh-all")
def refresh_all_markets():
    with shop.db() as con:
        ids = [r["id"] for r in con.execute(
            "SELECT id FROM products WHERE active=1 AND bh_path IS NOT NULL AND bh_path<>''")]
    done, failed = 0, []
    for pid in ids:
        try:
            refresh_market(pid)
            done += 1
        except Exception as e:  # keep going; report which ones failed
            failed.append({"id": pid, "error": str(e).splitlines()[0][:140]})
        time.sleep(0.4)        # be gentle with Buyhatke
    return {"updated": done, "failed": failed}


# ---- catalogue: fetch Amazon's price for a catalogue item from Buyhatke
class CatalogFetch(BaseModel):
    path: str | None = None
    url: str | None = None


@app.post("/api/catalog/lookup")
def catalog_lookup(body: CatalogFetch):
    """Product details + Amazon price for building a catalogue item (nothing is saved)."""
    if not (body.path or body.url):
        raise HTTPException(400, "path or url required")
    p = bh.product(path=body.path, url=body.url)
    m = shop.market_from_buyhatke(p)
    cp, cs = catalog_admin.amazon_compare(m["market_stores"], m["market_low"], m["market_site"])
    return {"title": p["name"], "image": p["image"], "bh_path": p["page"], "compare_price": cp, "compare_store": cs,
            "stores": m["market_stores"], "mrp": p.get("mrp")}


@app.post("/api/catalog/items/{iid}/refresh")
def catalog_refresh(iid: int):
    links = catalog_admin._links()
    path = links.get(iid, {}).get("bh_path")
    if not path:
        raise HTTPException(400, "This item isn't linked to an online listing")
    r = catalog_lookup(CatalogFetch(path=path))
    with catalog_admin.cdbm.cdb() as con:
        con.execute("UPDATE items SET compare_price=?, compare_store=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                    (r["compare_price"], r["compare_store"], iid))
    return r


if __name__ == "__main__":
    import uvicorn
    import webbrowser
    webbrowser.open("http://127.0.0.1:8000")
    uvicorn.run(app, host="127.0.0.1", port=8000, server_header=False)
