"""Login, sessions and permissions for the admin app.

* 3 accounts (owner / manager / cashier). Passwords are stored only as scrypt hashes.
* Sessions: random 256-bit token in an HttpOnly, SameSite=Strict cookie; only its SHA-256 is stored.
  Sessions expire after 12 hours, or right away on logout / password change.
* Brute force: 5 wrong passwords lock that account for 15 minutes; 20 failures from one IP in
  15 minutes block that IP.
* Roles:
    owner   – everything, incl. Settings, passwords, backup/exports
    manager – everything except Settings, passwords and backup
    cashier – billing, bills, customers, catalogue orders, stock list.  Never receives cost,
              profit or finance data: those fields are stripped from every response server-side.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import time
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

import shop

COOKIE = "rtc_session"
SESSION_HOURS = 12
MAX_FAILS, LOCK_MIN = 5, 15
IP_MAX_FAILS = 20

# username, role, scrypt hash  (initial accounts — change the passwords after first login)
SEED_USERS = [
    ("rtc.owner.h97g1e", "owner", "scrypt$16384$8$1$50b7fb5541c1abf4ecc8c9b559687aba$2410fdbbe3094d4c8f44ec518a18271731b0ba8ab24a5e6df9e19e8aef4de77e"),
    ("rtc.manager.gty33b", "manager", "scrypt$16384$8$1$5779471a6ce138ac445fe1e5f64d6905$fcc32b19cb837fa2442d0b62002f628dac858d5c92aadaf015716298d4eb734b"),
    ("rtc.cashier.wtet74", "cashier", "scrypt$16384$8$1$7f13ebf76ab544a76733d2909b4129b3$2a59efe3630ba63812c7a9ee0e3f2087c216fe4b9a27e3f7fab4fc7c16a51cab"),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, role TEXT NOT NULL, pw_hash TEXT NOT NULL,
  failed INTEGER DEFAULT 0, locked_until REAL DEFAULT 0, last_login TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires REAL NOT NULL, ip TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS auth_log (
  id INTEGER PRIMARY KEY, at TEXT DEFAULT CURRENT_TIMESTAMP, username TEXT, ip TEXT, ok INTEGER, note TEXT);
"""

ROLES = ("owner", "manager", "cashier")

# Keys that must never reach a cashier (removed recursively from every JSON response)
SECRET_KEYS = {
    "avg_cost", "stock_value", "next_cost", "last_cost", "unit_cost", "landed_cost", "transport_per_unit",
    "cost", "cost_total", "profit", "gross_profit", "net_profit", "cogs", "margin_pct", "gross_margin_pct",
    "purchases_goods", "purchases_transport", "purchases_total", "cash_flow", "stock_loss", "expenses",
    "expenses_by_category", "batches", "adjustments", "transport", "supplier", "goods",
}

# (method, path regex) → minimum roles allowed.  Anything under /api not listed here = owner+manager.
CASHIER_OK = [
    ("GET", r"/api/auth/me"), ("POST", r"/api/auth/logout"), ("POST", r"/api/auth/password"),
    ("GET", r"/api/shop/settings"),
    ("GET", r"/api/shop/products"), ("GET", r"/api/shop/products/find"), ("GET", r"/api/shop/products/\d+"),
    ("GET", r"/api/shop/quote"),
    ("POST", r"/api/shop/invoices/preview"), ("POST", r"/api/shop/invoices"),
    ("GET", r"/api/shop/invoices"), ("GET", r"/api/shop/invoices/\d+"), ("POST", r"/api/shop/invoices/\d+/payments"),
    ("GET", r"/api/shop/customers"),
    ("GET", r"/api/catalog/items"), ("GET", r"/api/catalog/orders.*"), ("POST", r"/api/catalog/orders/\d+/.*"),
    ("GET", r"/api/search"), ("GET", r"/api/suggest"), ("GET", r"/api/product"),
]
OWNER_ONLY = [
    ("PUT", r"/api/shop/settings"), ("GET", r"/api/shop/backup"), ("GET", r"/api/auth/users"),
    ("POST", r"/api/auth/users/.*"), ("GET", r"/api/auth/log"), ("PUT", r"/api/catalog/settings"),
]
PUBLIC = [("POST", r"/api/auth/login"), ("GET", r"/api/auth/me")]


def _match(rules, method, path):
    return any(m == method and re.fullmatch(p, path) for m, p in rules)


def allowed(role: str, method: str, path: str) -> bool:
    if role == "owner":
        return True
    if _match(OWNER_ONLY, method, path):
        return False
    if role == "manager":
        return True
    return _match(CASHIER_OK, method, path)


def scrub(obj):
    """Recursively drop secret keys (for cashier responses)."""
    if isinstance(obj, dict):
        return {k: scrub(v) for k, v in obj.items() if k not in SECRET_KEYS}
    if isinstance(obj, list):
        return [scrub(x) for x in obj]
    return obj


# ---------------------------------------------------------------- passwords
def hash_pw(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt$16384$8$1${salt.hex()}${h.hex()}"


def check_pw(pw: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, h = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(got.hex(), h)
    except Exception:
        return False


_DUMMY = hash_pw(secrets.token_hex(8))   # equalises timing for unknown usernames


def strong_enough(pw: str) -> str | None:
    if len(pw) < 12:
        return "Use at least 12 characters"
    if not (re.search(r"[a-z]", pw) and re.search(r"[A-Z]", pw) and re.search(r"\d", pw) and re.search(r"[^A-Za-z0-9]", pw)):
        return "Mix upper- and lower-case letters, digits and a symbol"
    return None


# ---------------------------------------------------------------- db
def init():
    with shop.db() as con:
        con.executescript(SCHEMA)
        if not con.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
            for u, role, h in SEED_USERS:
                con.execute("INSERT INTO users(username, role, pw_hash) VALUES (?,?,?)", (u, role, h))
        con.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))


def _tok_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "?"


def current_user(request: Request) -> dict | None:
    token = request.cookies.get(COOKIE)
    if not token or len(token) > 200:
        return None
    with shop.db() as con:
        row = con.execute("SELECT u.id, u.username, u.role, s.expires FROM sessions s JOIN users u ON u.id=s.user_id "
                          "WHERE s.token_hash=?", (_tok_hash(token),)).fetchone()
        if not row or row["expires"] < time.time():
            return None
        return {"id": row["id"], "username": row["username"], "role": row["role"]}


_ip_fails: dict[str, list[float]] = {}


def _ip_blocked(ip: str) -> bool:
    now = time.time()
    _ip_fails[ip] = [t for t in _ip_fails.get(ip, []) if now - t < LOCK_MIN * 60]
    return len(_ip_fails[ip]) >= IP_MAX_FAILS


# ---------------------------------------------------------------- routes
router = APIRouter(prefix="/api/auth")


class LoginIn(BaseModel):
    username: str = Field(max_length=80)
    password: str = Field(max_length=200)


class PasswordIn(BaseModel):
    current: str = Field(max_length=200)
    new: str = Field(max_length=200)


class ResetIn(BaseModel):
    new: str = Field(max_length=200)


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response):
    ip = client_ip(request)
    if _ip_blocked(ip):
        raise HTTPException(429, f"Too many failed attempts from this device. Try again in {LOCK_MIN} minutes.")
    uname = body.username.strip()
    error = None                     # raise only after the block, so failure counters are committed
    with shop.db() as con:
        u = con.execute("SELECT * FROM users WHERE username=?", (uname,)).fetchone()
        if u and u["locked_until"] > time.time():
            mins = int((u["locked_until"] - time.time()) // 60) + 1
            con.execute("INSERT INTO auth_log(username, ip, ok, note) VALUES (?,?,0,'locked')", (uname, ip))
            error = (423, f"Account locked after too many wrong passwords. Try again in {mins} min.")
        elif not (check_pw(body.password, u["pw_hash"] if u else _DUMMY) and u is not None):
            _ip_fails.setdefault(ip, []).append(time.time())
            if u:
                failed = u["failed"] + 1
                lock = time.time() + LOCK_MIN * 60 if failed >= MAX_FAILS else 0
                con.execute("UPDATE users SET failed=?, locked_until=? WHERE id=?", (0 if lock else failed, lock, u["id"]))
            con.execute("INSERT INTO auth_log(username, ip, ok) VALUES (?,?,0)", (uname[:80], ip))
            error = (401, "Wrong user ID or password")
    if error:
        if error[0] == 401:
            time.sleep(0.4)
        raise HTTPException(*error)
    with shop.db() as con:
        token = secrets.token_urlsafe(32)
        con.execute("INSERT INTO sessions(token_hash, user_id, expires, ip) VALUES (?,?,?,?)",
                    (_tok_hash(token), u["id"], time.time() + SESSION_HOURS * 3600, ip))
        con.execute("UPDATE users SET failed=0, locked_until=0, last_login=? WHERE id=?",
                    (datetime.now().isoformat(timespec="minutes"), u["id"]))
        con.execute("INSERT INTO auth_log(username, ip, ok) VALUES (?,?,1)", (uname, ip))
    response.set_cookie(COOKIE, token, max_age=SESSION_HOURS * 3600, httponly=True, samesite="strict", path="/")
    return {"username": u["username"], "role": u["role"]}


@router.get("/me")
def me(request: Request):
    u = current_user(request)
    if not u:
        raise HTTPException(401, "Not logged in")
    return u


@router.post("/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        with shop.db() as con:
            con.execute("DELETE FROM sessions WHERE token_hash=?", (_tok_hash(token),))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.post("/password")
def change_password(body: PasswordIn, request: Request, response: Response):
    u = current_user(request)
    if not u:
        raise HTTPException(401, "Not logged in")
    with shop.db() as con:
        row = con.execute("SELECT pw_hash FROM users WHERE id=?", (u["id"],)).fetchone()
        if not check_pw(body.current, row["pw_hash"]):
            raise HTTPException(400, "Current password is wrong")
        if msg := strong_enough(body.new):
            raise HTTPException(400, msg)
        con.execute("UPDATE users SET pw_hash=? WHERE id=?", (hash_pw(body.new), u["id"]))
        con.execute("DELETE FROM sessions WHERE user_id=?", (u["id"],))     # log out everywhere
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/users")
def users():
    with shop.db() as con:
        return shop.rows(con.execute("SELECT id, username, role, last_login, locked_until > ? AS locked FROM users ORDER BY id",
                                     (time.time(),)))


@router.post("/users/{uid}/reset")
def reset_password(uid: int, body: ResetIn):
    if msg := strong_enough(body.new):
        raise HTTPException(400, msg)
    with shop.db() as con:
        con.execute("UPDATE users SET pw_hash=?, failed=0, locked_until=0 WHERE id=?", (hash_pw(body.new), uid))
        con.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
    return {"ok": True}


@router.post("/users/{uid}/unlock")
def unlock(uid: int):
    with shop.db() as con:
        con.execute("UPDATE users SET failed=0, locked_until=0 WHERE id=?", (uid,))
    return {"ok": True}


@router.get("/log")
def auth_log():
    with shop.db() as con:
        return shop.rows(con.execute("SELECT at, username, ip, ok, note FROM auth_log ORDER BY id DESC LIMIT 100"))
