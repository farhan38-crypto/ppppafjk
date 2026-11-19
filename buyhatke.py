"""Unofficial client for buyhatke.com.

Buyhatke has no public API. This talks to the same endpoints its website uses:
  * search / product pages are server-rendered (SvelteKit); their data is embedded
    in the HTML as a JS expression, which we evaluate in a sandboxed V8 isolate
    (mini-racer: no file/network access) to turn it into plain JSON.
  * login is email + OTP on ext1.buyhatke.com/spend-apis/login/*  (cookie session)
  * price alerts live on ext1.buyhatke.com/spend-apis/paapis/*     (needs login)
These are undocumented and may change without notice.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from urllib.parse import quote, urlencode

import httpx
from py_mini_racer import MiniRacer

SITE = "https://buyhatke.com"
EXT = "https://ext1.buyhatke.com/spend-apis"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


class NotLoggedIn(Exception):
    pass


class BuyhatkeError(Exception):
    pass


# ---------------------------------------------------------------- page parsing
def extract_kit_data(html: str) -> str:
    """Return the source text of the `data: [...]` array passed to kit.start()."""
    start = html.find("kit.start(")
    if start < 0:
        raise BuyhatkeError("Page format changed: no SvelteKit data found")
    i = html.find("data: [", start)
    if i < 0:
        raise BuyhatkeError("Page format changed: no data array found")
    i += len("data: ")
    depth, j, in_str = 0, i, None
    while j < len(html):
        ch = html[j]
        if in_str:
            if ch == "\\":
                j += 2
                continue
            if ch == in_str:
                in_str = None
        elif ch in "\"'`":
            in_str = ch
        elif ch in "[{(":
            depth += 1
        elif ch in "]})":
            depth -= 1
            if depth == 0:
                return html[i:j + 1]
        j += 1
    raise BuyhatkeError("Page format changed: unterminated data array")


_js_lock = threading.Lock()


def eval_js_data(expr: str):
    """Evaluate the embedded data expression in a fresh sandboxed isolate."""
    with _js_lock:
        ctx = MiniRacer()
        out = ctx.eval(f"JSON.stringify(({expr}))")
    return json.loads(out)


def page_data(html: str) -> dict:
    """The route's own data is the last entry with type == 'data'."""
    nodes = eval_js_data(extract_kit_data(html))
    for node in reversed(nodes):
        if isinstance(node, dict) and node.get("type") == "data":
            return node.get("data") or {}
    return {}


# ---------------------------------------------------------------- client
class Buyhatke:
    def __init__(self, session_file: str | Path = "session.json"):
        self.session_file = Path(session_file)
        self.http = httpx.Client(
            headers={"User-Agent": UA, "Accept-Language": "en-IN,en;q=0.9",
                     "Origin": SITE, "Referer": SITE + "/"},
            follow_redirects=True, timeout=30)
        self._load_cookies()

    # -- cookie persistence (so you stay logged in between runs)
    def _load_cookies(self):
        if self.session_file.exists():
            try:
                for c in json.loads(self.session_file.read_text()):
                    self.http.cookies.set(c["name"], c["value"], domain=c["domain"], path=c.get("path", "/"))
            except Exception:
                pass

    def _save_cookies(self):
        cookies = [{"name": c.name, "value": c.value, "domain": c.domain, "path": c.path}
                   for c in self.http.cookies.jar]
        self.session_file.write_text(json.dumps(cookies, indent=1))

    def _get_html(self, url: str) -> tuple[str, str]:
        r = self.http.get(url, headers={"Accept": "text/html"})
        if r.status_code == 403:
            raise BuyhatkeError("Buyhatke blocked the request (403, likely bot protection). Try again later.")
        r.raise_for_status()
        return r.text, str(r.url)

    def _ext(self, path: str, form: dict | None = None, *, json_body: dict | None = None, get=False):
        url = f"{EXT}/{path}"
        if get:
            r = self.http.get(url, params=form)
        elif json_body is not None:
            r = self.http.post(url, json=json_body)
        else:
            r = self.http.post(url, content=urlencode(form or {}),
                               headers={"Content-Type": "application/x-www-form-urlencoded"})
        if r.status_code == 429:
            raise BuyhatkeError("Too many attempts — Buyhatke rate-limited this. Wait a bit and retry.")
        r.raise_for_status()
        data = r.json()
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and data.get("status") == 0 and "login" in str(data.get("err", "")).lower():
            raise NotLoggedIn(data.get("err"))
        return data

    # -- search
    def search(self, query: str) -> list[dict]:
        html, _ = self._get_html(f"{SITE}/search?product={quote(query)}")
        data = page_data(html)
        items = data.get("SearchProductsList") or _find_product_list(data)
        out = []
        for p in items:
            out.append({
                "name": p.get("prod"),
                "price": p.get("price"),
                "mrp": p.get("mrp"),
                "image": p.get("image"),
                "site_image": p.get("siteImage"),
                "site_pos": p.get("pos"),
                "internal_pid": p.get("internalPid"),
                "rating": p.get("rating"),
                "rating_count": p.get("rating_count"),
                "brand": p.get("brandName"),
                "store_link": p.get("link"),
                # buyhatke ignores the slug; only "<pos>-<internalPid>" matters
                "path": f"/item-price-in-india-{p.get('pos')}-{p.get('internalPid')}",
            })
        return out

    # -- product (by buyhatke path, or by a store URL like amazon/flipkart)
    def product(self, path: str | None = None, url: str | None = None) -> dict:
        if url:
            target = f"{SITE}/{url}"
        elif path:
            target = f"{SITE}/{path.lstrip('/')}"
        else:
            raise ValueError("path or url required")
        html, final_url = self._get_html(target)
        d = page_data(html)
        pd = d.get("productData")
        if not pd:
            raise BuyhatkeError("Buyhatke doesn't track this product (or the link isn't supported).")
        stats = {k: pd.get(k) for k in ("avg", "avg1mon", "maxall", "min", "min6", "yearavg", "stable_days", "pnt")}
        compare = [{
            "name": x.get("prod"), "price": x.get("price"), "mrp": x.get("mrpFloat"),
            "site": x.get("site_name"), "site_image": x.get("site_image") or x.get("site_logo"),
            "link": x.get("link"), "image": x.get("image"), "updated": x.get("last_updated"),
            "exact": bool(x.get("perfect")),
        } for x in (d.get("dealsData") or {}).get("dealsList", [])]
        compare.sort(key=lambda x: x["price"] or 1e18)
        coupons = [{"code": c.get("code"), "title": c.get("title_new") or c.get("desc"),
                    "desc": c.get("desc_new") or c.get("desc"), "valid_till": c.get("valid_till"),
                    "votes": c.get("netvotes")} for c in (d.get("coupons") or []) if c.get("code")]
        return {
            "page": final_url.replace(SITE, ""),
            "name": pd.get("name"), "image": pd.get("image"), "link": pd.get("link"),
            "price": pd.get("cur_price"), "mrp": pd.get("mrpFloat"),
            "site": pd.get("site_name"), "site_logo": pd.get("site_logo"),
            "site_pos": pd.get("site_pos"), "pid": pd.get("pid"),
            "in_stock": pd.get("inStock"), "rating": pd.get("rating"),
            "rating_count": pd.get("ratingCount"), "brand": pd.get("brand"),
            "stats": stats,
            "history": (d.get("predictedData") or {}).get("history", []),
            "compare": compare,
            "coupons": coupons,
        }

    # -- login (email OTP)
    def login_status(self) -> dict:
        r = self._ext("login/loggedIn", {"platform": 0}, get=True)
        data = (r or {}).get("data") or {}
        return {"logged_in": bool(data.get("logged")), "email": data.get("email_id") or data.get("email"),
                "image": data.get("image")}

    def send_otp(self, email: str) -> dict:
        r = self._ext("login/send-otp", json_body={"email": email})
        self._save_cookies()
        return r

    def verify_otp(self, otp: str) -> dict:
        r = self._ext("login/verify-otp", json_body={"otp": otp})
        self._save_cookies()
        return r

    def logout(self):
        try:
            self._ext("login/logout", get=True)
        finally:
            self.http.cookies.clear()
            self._save_cookies()

    # -- price alerts (login required)
    def alerts(self) -> list:
        r = self._ext("paapis/getPriceAlert", {})
        if isinstance(r, dict):
            if r.get("status") == 0:
                raise BuyhatkeError(r.get("err") or r.get("msg") or "Failed to load alerts")
            r = r.get("data") or []
        return r

    def set_alert(self, product: dict, target_price: float) -> dict:
        return self._check(self._ext("paapis/setPriceAlert", {
            "prod": product["name"], "price": product["price"], "price_set": _num(target_price),
            "image": product.get("image") or "", "url": product["link"],
            "pos": product["site_pos"], "pid": product["pid"], "sitepos": product["site_pos"],
        }))

    def update_alert(self, alert_id, target_price: float) -> dict:
        return self._check(self._ext("paapis/updatePriceAlert",
                                     {"link_id": alert_id, "price_not": _num(target_price), "platform": 0}))

    def remove_alert(self, alert_id) -> dict:
        return self._check(self._ext("paapis/removePriceAlert", {"link_id": alert_id}))

    @staticmethod
    def _check(r):
        if isinstance(r, dict) and r.get("status") == 0:
            raise BuyhatkeError(r.get("err") or r.get("msg") or "Request failed")
        return r


def _num(x):
    return int(x) if float(x).is_integer() else x


def _find_product_list(data) -> list[dict]:
    """Search page data shape isn't fixed; find the largest list of objects with 'prod' + 'price'."""
    best: list = []

    def walk(o):
        nonlocal best
        if isinstance(o, list):
            if o and all(isinstance(x, dict) and "prod" in x and "price" in x for x in o[:5]):
                if len(o) > len(best):
                    best = o
            for x in o:
                walk(x)
        elif isinstance(o, dict):
            for v in o.values():
                walk(v)

    walk(data)
    return best
