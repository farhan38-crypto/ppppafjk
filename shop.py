"""Shop management: inventory, purchases (with transport), billing, dues, expenses, reports.

Everything lives in a local SQLite file (shop.db) next to the app.

Money rules
-----------
* Each shipment (one truck load) is a purchase; each product in it is a stock *batch*.
  Landed cost per unit = unit price paid + (that item's share of the truck's transport charge)
  Transport is split across the items of one shipment in proportion to their value —
  a costlier item carries a bigger share.
* Buyhatke is used only as a *market reference*: each product can be linked to a Buyhatke
  listing, and the lowest online price is stored so you can compare your asking price.
* Stock is sold first-in-first-out, so every sale knows exactly what those units cost.
* Minimum selling price per unit = landed cost x (1 + min margin %)   (default 10 %).
  Bills below that are refused.
"""
from __future__ import annotations

import csv
import io
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

DB_PATH = Path(__file__).parent / "shop.db"
_lock = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, sku TEXT, category TEXT, image TEXT,
  mrp REAL, list_price REAL, bh_path TEXT, source_link TEXT,
  reorder_level INTEGER DEFAULT 2, active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, supplier TEXT, transport REAL DEFAULT 0,
  note TEXT, voided INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
  purchase_id INTEGER REFERENCES purchases(id), date TEXT NOT NULL,
  qty INTEGER NOT NULL, qty_left INTEGER NOT NULL,
  unit_cost REAL NOT NULL, transport_per_unit REAL NOT NULL DEFAULT 0, landed_cost REAL NOT NULL);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY, number TEXT UNIQUE, date TEXT NOT NULL, customer_id INTEGER REFERENCES customers(id),
  customer_name TEXT, customer_phone TEXT, customer_address TEXT,
  original_total REAL, discount_total REAL, subtotal REAL, tax_pct REAL DEFAULT 0, tax REAL DEFAULT 0,
  total REAL, cost_total REAL, payment_mode TEXT, note TEXT, voided INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), product_id INTEGER REFERENCES products(id),
  name TEXT, qty INTEGER, original_price REAL, price REAL, discount REAL, line_total REAL, cost REAL, min_price REAL);
CREATE TABLE IF NOT EXISTS invoice_item_batches (
  item_id INTEGER NOT NULL REFERENCES invoice_items(id), batch_id INTEGER NOT NULL REFERENCES batches(id),
  qty INTEGER NOT NULL, landed_cost REAL NOT NULL);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), date TEXT NOT NULL,
  amount REAL NOT NULL, mode TEXT, note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, category TEXT NOT NULL, amount REAL NOT NULL, note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS adjustments (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL, cost REAL NOT NULL, reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_batches_product ON batches(product_id, date, id);
CREATE INDEX IF NOT EXISTS ix_items_invoice ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS ix_pay_invoice ON payments(invoice_id);
"""

DEFAULT_SETTINGS = {
    "shop_name": "Royal Trading Company", "address": "", "phone": "", "gstin": "", "email": "",
    "min_margin_pct": "10", "invoice_prefix": "INV-", "default_tax_pct": "0",
    "invoice_footer": "Thank you for shopping with us!",
}
EXPENSE_CATEGORIES = ["Rent", "Electricity", "Salary", "Transport (other)", "Packaging", "Marketing",
                      "Internet / Phone", "Repairs", "Misc"]


def r2(x) -> float:
    return round(float(x or 0) + 1e-9, 2)


def today() -> str:
    return date.today().isoformat()


@contextmanager
def db():
    with _lock:
        con = sqlite3.connect(DB_PATH)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys = ON")
        try:
            yield con
            con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()


MIGRATIONS = {
    "products": [("market_low", "REAL"), ("market_site", "TEXT"), ("market_link", "TEXT"),
                 ("market_stores", "TEXT"), ("market_checked", "TEXT")],
}


def init_db():
    with db() as con:
        con.executescript(SCHEMA)
        for table, cols in MIGRATIONS.items():
            have = {r["name"] for r in con.execute(f"PRAGMA table_info({table})")}
            for name, typ in cols:
                if name not in have:
                    con.execute(f"ALTER TABLE {table} ADD COLUMN {name} {typ}")
        for k, v in DEFAULT_SETTINGS.items():
            con.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (k, v))
        con.execute("UPDATE settings SET value='Royal Trading Company' WHERE key='shop_name' AND value='My Shop'")


def rows(cur) -> list[dict]:
    return [dict(r) for r in cur.fetchall()]


def settings(con) -> dict:
    return {r["key"]: r["value"] for r in con.execute("SELECT key, value FROM settings")}


def margin(con) -> float:
    try:
        return float(settings(con).get("min_margin_pct", 10)) / 100
    except ValueError:
        return 0.10


# ---------------------------------------------------------------- stock helpers
def fifo_take(con, product_id: int, qty: int) -> list[tuple[int, int, float]]:
    """Which batches `qty` units would come from: [(batch_id, qty, landed_cost)]. Raises if short."""
    out, need = [], qty
    for b in con.execute("SELECT id, qty_left, landed_cost FROM batches WHERE product_id=? AND qty_left>0 "
                         "ORDER BY date, id", (product_id,)):
        if need <= 0:
            break
        take = min(need, b["qty_left"])
        out.append((b["id"], take, b["landed_cost"]))
        need -= take
    if need > 0:
        have = qty - need
        name = con.execute("SELECT name FROM products WHERE id=?", (product_id,)).fetchone()
        raise HTTPException(400, f"Only {have} in stock for “{name['name'] if name else product_id}”")
    return out


def cost_quote(con, product_id: int, qty: int) -> dict:
    take = fifo_take(con, product_id, qty)
    cost = sum(q * c for _, q, c in take)
    unit = cost / qty
    return {"take": take, "cost": r2(cost), "unit_cost": r2(unit),
            "min_price": min_price(unit, margin(con))}


def min_price(unit_cost: float, m: float) -> float:
    """Lowest price per unit that still makes the minimum margin (rounded up to the rupee)."""
    import math
    return float(math.ceil(unit_cost * (1 + m) - 1e-9))


PRODUCT_SELECT = """
SELECT p.*,
  COALESCE((SELECT SUM(qty_left) FROM batches b WHERE b.product_id=p.id), 0) AS stock,
  COALESCE((SELECT SUM(qty_left*landed_cost) FROM batches b WHERE b.product_id=p.id), 0) AS stock_value,
  (SELECT landed_cost FROM batches b WHERE b.product_id=p.id AND qty_left>0 ORDER BY date, id LIMIT 1) AS next_cost,
  (SELECT landed_cost FROM batches b WHERE b.product_id=p.id ORDER BY date DESC, id DESC LIMIT 1) AS last_cost,
  COALESCE((SELECT SUM(ii.qty) FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id
            WHERE ii.product_id=p.id AND i.voided=0), 0) AS sold
FROM products p
"""


def product_out(con, p: dict) -> dict:
    m = margin(con)
    cost = p["next_cost"] if p["next_cost"] is not None else p["last_cost"]
    p["stock_value"] = r2(p["stock_value"])
    p["avg_cost"] = r2(p["stock_value"] / p["stock"]) if p["stock"] else (r2(cost) if cost else None)
    p["min_price"] = min_price(cost, m) if cost else None      # for the next unit sold (FIFO)
    p["low_stock"] = p["active"] == 1 and p["stock"] <= (p["reorder_level"] or 0)
    try:
        p["market_stores"] = json.loads(p.get("market_stores") or "[]")
    except ValueError:
        p["market_stores"] = []
    ask = p.get("list_price")
    p["vs_market"] = r2(ask - p["market_low"]) if ask and p.get("market_low") else None   # + means you're costlier
    p["ask_below_min"] = bool(ask and p["min_price"] and ask < p["min_price"])
    return p


def set_market(con, pid: int, m: dict):
    con.execute("UPDATE products SET market_low=?, market_site=?, market_link=?, market_stores=?, "
                "market_checked=?, bh_path=COALESCE(?, bh_path) WHERE id=?",
                (m.get("market_low"), m.get("market_site"), m.get("market_link"),
                 json.dumps(m.get("market_stores") or []), m.get("market_checked") or datetime.now().isoformat(timespec="minutes"),
                 m.get("bh_path"), pid))


def market_from_buyhatke(bp: dict) -> dict:
    """Lowest online price for the same product, from a Buyhatke product page (see buyhatke.Buyhatke.product)."""
    stores = [{"site": bp.get("site"), "price": bp.get("price"), "link": bp.get("link")}]
    stores += [{"site": c["site"], "price": c["price"], "link": c["link"]} for c in bp.get("compare", [])
               if c.get("exact") and c.get("price")]
    stores = [x for x in stores if x["price"]]
    best: dict[str, dict] = {}
    for x in stores:                         # one (cheapest) entry per store
        if x["site"] not in best or x["price"] < best[x["site"]]["price"]:
            best[x["site"]] = x
    stores = sorted(best.values(), key=lambda x: x["price"])[:8]
    low = stores[0] if stores else {}
    return {"market_low": low.get("price"), "market_site": low.get("site"), "market_link": low.get("link"),
            "market_stores": stores, "bh_path": bp.get("page"),
            "market_checked": datetime.now().isoformat(timespec="minutes")}


# ---------------------------------------------------------------- request models
class SettingsIn(BaseModel):
    shop_name: str | None = None
    address: str | None = None
    phone: str | None = None
    email: str | None = None
    gstin: str | None = None
    min_margin_pct: float | None = Field(None, ge=0, le=500)
    invoice_prefix: str | None = None
    default_tax_pct: float | None = Field(None, ge=0, le=100)
    invoice_footer: str | None = None


class ProductIn(BaseModel):
    name: str
    sku: str | None = None
    category: str | None = None
    image: str | None = None
    mrp: float | None = Field(None, ge=0)
    list_price: float | None = Field(None, ge=0)
    bh_path: str | None = None
    source_link: str | None = None
    reorder_level: int = Field(2, ge=0)
    active: int = 1
    market_low: float | None = None
    market_site: str | None = None
    market_link: str | None = None
    market_stores: list | None = None
    market_checked: str | None = None


class PurchaseItemIn(BaseModel):
    product_id: int | None = None
    product: ProductIn | None = None      # creates/links the product if product_id is missing
    qty: int = Field(gt=0)
    unit_cost: float = Field(ge=0)
    asking_price: float | None = Field(None, ge=0)   # your selling price; saved on the product


class PurchaseIn(BaseModel):
    date: str | None = None
    supplier: str | None = None
    transport: float = Field(0, ge=0)
    note: str | None = None
    items: list[PurchaseItemIn] = Field(min_length=1)


class CustomerIn(BaseModel):
    name: str = "Walk-in customer"
    phone: str | None = None
    address: str | None = None


class InvoiceItemIn(BaseModel):
    product_id: int
    qty: int = Field(gt=0)
    price: float = Field(ge=0)             # selling price per unit (after discount)
    original_price: float | None = Field(None, ge=0)


class InvoiceIn(BaseModel):
    date: str | None = None
    customer: CustomerIn = CustomerIn()
    items: list[InvoiceItemIn] = Field(min_length=1)
    tax_pct: float = Field(0, ge=0, le=100)
    payment_mode: str = "Cash"
    paid: float | None = Field(None, ge=0)   # None = paid in full
    note: str | None = None


class PaymentIn(BaseModel):
    amount: float = Field(gt=0)
    mode: str = "Cash"
    date: str | None = None
    note: str | None = None


class ExpenseIn(BaseModel):
    date: str | None = None
    category: str
    amount: float = Field(gt=0)
    note: str | None = None


class AdjustIn(BaseModel):
    qty: int                 # negative = remove (damaged / lost / personal use)
    reason: str = "Damaged"
    unit_cost: float | None = Field(None, ge=0)   # needed only when adding stock without a purchase


# ---------------------------------------------------------------- routes
router = APIRouter(prefix="/api/shop")


@router.get("/settings")
def get_settings():
    with db() as con:
        return {**settings(con), "expense_categories": EXPENSE_CATEGORIES}


@router.put("/settings")
def put_settings(body: SettingsIn):
    with db() as con:
        for k, v in body.model_dump(exclude_none=True).items():
            con.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", (k, str(v)))
        return settings(con)


# -- products
@router.get("/products")
def list_products(q: str = "", include_inactive: bool = False, in_stock: bool = False):
    with db() as con:
        sql, args = PRODUCT_SELECT + " WHERE 1=1", []
        if not include_inactive:
            sql += " AND p.active=1"
        if q:
            sql += " AND (p.name LIKE ? OR p.sku LIKE ? OR p.category LIKE ?)"
            args += [f"%{q}%"] * 3
        sql += " ORDER BY p.name COLLATE NOCASE"
        out = [product_out(con, p) for p in rows(con.execute(sql, args))]
        return [p for p in out if p["stock"] > 0] if in_stock else out


@router.get("/products/find")
def find_product(bh_path: str = "", name: str = ""):
    """Used by the price-tracker page to see if a product is already in inventory."""
    with db() as con:
        p = None
        if bh_path:
            p = con.execute(PRODUCT_SELECT + " WHERE p.bh_path=?", (bh_path,)).fetchone()
        if not p and name:
            p = con.execute(PRODUCT_SELECT + " WHERE p.name=? COLLATE NOCASE", (name,)).fetchone()
        return product_out(con, dict(p)) if p else None


@router.get("/products/{pid}")
def get_product(pid: int):
    with db() as con:
        p = con.execute(PRODUCT_SELECT + " WHERE p.id=?", (pid,)).fetchone()
        if not p:
            raise HTTPException(404, "Product not found")
        out = product_out(con, dict(p))
        out["batches"] = rows(con.execute(
            "SELECT b.*, pu.supplier FROM batches b LEFT JOIN purchases pu ON pu.id=b.purchase_id "
            "WHERE b.product_id=? ORDER BY b.date DESC, b.id DESC", (pid,)))
        out["sales"] = rows(con.execute(
            "SELECT i.id AS invoice_id, i.number, i.date, i.customer_name, ii.qty, ii.price, ii.line_total, ii.cost, "
            "ii.line_total - ii.cost AS profit FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id "
            "WHERE ii.product_id=? AND i.voided=0 ORDER BY i.date DESC, i.id DESC LIMIT 100", (pid,)))
        out["adjustments"] = rows(con.execute(
            "SELECT * FROM adjustments WHERE product_id=? ORDER BY date DESC, id DESC", (pid,)))
        return out


def _upsert_product(con, body: ProductIn, pid: int | None = None) -> int:
    # on update, only touch the fields the caller actually sent
    d = body.model_dump(exclude_unset=True) if pid else body.model_dump()
    d["name"] = d["name"].strip()
    if not d["name"]:
        raise HTTPException(400, "Product name is required")
    if not pid and d.get("list_price") is None:
        d["list_price"] = d.get("mrp")
    if "market_stores" in d:
        d["market_stores"] = json.dumps(d["market_stores"] or [])
    if d.get("market_low") is not None and not d.get("market_checked"):
        d["market_checked"] = datetime.now().isoformat(timespec="minutes")
    cols = list(d)
    if pid:
        con.execute(f"UPDATE products SET {', '.join(c + '=?' for c in cols)} WHERE id=?", [d[c] for c in cols] + [pid])
        return pid
    cur = con.execute(f"INSERT INTO products({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                      [d[c] for c in cols])
    return cur.lastrowid


@router.post("/products")
def create_product(body: ProductIn):
    with db() as con:
        return {"id": _upsert_product(con, body)}


@router.put("/products/{pid}")
def update_product(pid: int, body: ProductIn):
    with db() as con:
        if not con.execute("SELECT 1 FROM products WHERE id=?", (pid,)).fetchone():
            raise HTTPException(404, "Product not found")
        _upsert_product(con, body, pid)
        return {"id": pid}


@router.delete("/products/{pid}")
def delete_product(pid: int):
    """Deletes a product with no history; otherwise just hides it (archive)."""
    with db() as con:
        used = con.execute("SELECT (SELECT COUNT(*) FROM batches WHERE product_id=?) + "
                           "(SELECT COUNT(*) FROM invoice_items WHERE product_id=?)", (pid, pid)).fetchone()[0]
        if used:
            con.execute("UPDATE products SET active=0 WHERE id=?", (pid,))
            return {"archived": True}
        con.execute("DELETE FROM products WHERE id=?", (pid,))
        return {"deleted": True}


@router.post("/products/{pid}/adjust")
def adjust_stock(pid: int, body: AdjustIn):
    with db() as con:
        if not body.qty:
            raise HTTPException(400, "Quantity can't be 0")
        if body.qty < 0:
            take = fifo_take(con, pid, -body.qty)
            cost = 0.0
            for bid, q, c in take:
                con.execute("UPDATE batches SET qty_left=qty_left-? WHERE id=?", (q, bid))
                cost += q * c
            con.execute("INSERT INTO adjustments(date, product_id, qty, cost, reason) VALUES (?,?,?,?,?)",
                        (today(), pid, body.qty, r2(cost), body.reason))
            return {"written_off": r2(cost)}
        # adding found / opening stock without a purchase bill
        if body.unit_cost is None:
            raise HTTPException(400, "Enter the cost per unit for stock you're adding")
        con.execute("INSERT INTO batches(product_id, date, qty, qty_left, unit_cost, landed_cost) VALUES (?,?,?,?,?,?)",
                    (pid, today(), body.qty, body.qty, body.unit_cost, body.unit_cost))
        con.execute("INSERT INTO adjustments(date, product_id, qty, cost, reason) VALUES (?,?,?,?,?)",
                    (today(), pid, body.qty, 0, body.reason or "Opening stock"))
        return {"added": body.qty}


# -- purchases (stock in)
def allocate_transport(items: list[tuple[int, float]], transport: float) -> list[float]:
    """Split transport over items in proportion to value; returns per-unit transport for each item.
    Falls back to splitting by quantity when everything was free."""
    total_value = sum(q * c for q, c in items)
    total_qty = sum(q for q, _ in items)
    out = []
    for q, c in items:
        share = transport * (q * c / total_value) if total_value else transport * q / total_qty
        out.append(share / q)
    return out


@router.post("/purchases")
def create_purchase(body: PurchaseIn):
    with db() as con:
        d = body.date or today()
        cur = con.execute("INSERT INTO purchases(date, supplier, transport, note) VALUES (?,?,?,?)",
                          (d, body.supplier, body.transport, body.note))
        purchase_id = cur.lastrowid
        per_unit_tr = allocate_transport([(i.qty, i.unit_cost) for i in body.items], body.transport)
        m = margin(con)
        lines = []
        for item, tr in zip(body.items, per_unit_tr):
            pid = item.product_id
            if not pid:
                if not item.product:
                    raise HTTPException(400, "Each item needs a product")
                existing = None
                if item.product.bh_path:
                    existing = con.execute("SELECT id FROM products WHERE bh_path=?", (item.product.bh_path,)).fetchone()
                if not existing:
                    existing = con.execute("SELECT id FROM products WHERE name=? COLLATE NOCASE",
                                           (item.product.name.strip(),)).fetchone()
                pid = existing["id"] if existing else _upsert_product(con, item.product)
                if existing:
                    con.execute("UPDATE products SET active=1 WHERE id=?", (pid,))
                    if item.product.market_low is not None:   # refresh market reference
                        set_market(con, pid, item.product.model_dump(include={
                            "market_low", "market_site", "market_link", "market_stores", "bh_path"}))
            elif not con.execute("SELECT 1 FROM products WHERE id=?", (pid,)).fetchone():
                raise HTTPException(404, f"Product {pid} not found")
            if item.asking_price is not None:
                con.execute("UPDATE products SET list_price=? WHERE id=?", (item.asking_price, pid))
            landed = item.unit_cost + tr
            con.execute("INSERT INTO batches(product_id, purchase_id, date, qty, qty_left, unit_cost, "
                        "transport_per_unit, landed_cost) VALUES (?,?,?,?,?,?,?,?)",
                        (pid, purchase_id, d, item.qty, item.qty, item.unit_cost, tr, landed))
            lines.append({"product_id": pid, "qty": item.qty, "unit_cost": r2(item.unit_cost), "asking_price": item.asking_price,
                          "transport_per_unit": r2(tr), "landed_cost": r2(landed), "min_price": min_price(landed, m)})
        return {"id": purchase_id, "items": lines}


@router.get("/purchases")
def list_purchases(frm: str = "", to: str = ""):
    with db() as con:
        sql = ("SELECT pu.*, COALESCE(SUM(b.qty*b.unit_cost),0) AS goods, COALESCE(SUM(b.qty),0) AS units, "
               "COUNT(b.id) AS lines, GROUP_CONCAT(p.name, ' · ') AS names FROM purchases pu "
               "LEFT JOIN batches b ON b.purchase_id=pu.id LEFT JOIN products p ON p.id=b.product_id WHERE 1=1")
        args = []
        if frm:
            sql += " AND pu.date>=?"; args.append(frm)
        if to:
            sql += " AND pu.date<=?"; args.append(to)
        sql += " GROUP BY pu.id ORDER BY pu.date DESC, pu.id DESC"
        out = rows(con.execute(sql, args))
        for o in out:
            o["goods"] = r2(o["goods"]); o["total"] = r2(o["goods"] + (o["transport"] or 0))
        return out


@router.get("/purchases/{pid}")
def get_purchase(pid: int):
    with db() as con:
        pu = con.execute("SELECT * FROM purchases WHERE id=?", (pid,)).fetchone()
        if not pu:
            raise HTTPException(404, "Purchase not found")
        out = dict(pu)
        out["items"] = rows(con.execute(
            "SELECT b.*, p.name, p.image FROM batches b JOIN products p ON p.id=b.product_id WHERE b.purchase_id=?", (pid,)))
        m = margin(con)
        for i in out["items"]:
            i["min_price"] = min_price(i["landed_cost"], m)
        return out


@router.delete("/purchases/{pid}")
def delete_purchase(pid: int):
    """Undo a purchase entered by mistake — only while none of its stock has been sold or adjusted."""
    with db() as con:
        bad = con.execute("SELECT COUNT(*) FROM batches WHERE purchase_id=? AND qty_left<>qty", (pid,)).fetchone()[0]
        if bad:
            raise HTTPException(400, "Some of this stock was already sold or adjusted, so it can't be deleted.")
        con.execute("DELETE FROM batches WHERE purchase_id=?", (pid,))
        con.execute("DELETE FROM purchases WHERE id=?", (pid,))
        return {"deleted": True}


# -- billing
@router.get("/quote")
def quote(product_id: int, qty: int = 1):
    """Cost and minimum price for selling `qty` units now (used while making a bill)."""
    with db() as con:
        q = cost_quote(con, product_id, qty)
        q.pop("take")
        return q


def _next_number(con) -> str:
    prefix = settings(con).get("invoice_prefix", "INV-")
    n = con.execute("SELECT COUNT(*) FROM invoices").fetchone()[0] + 1
    while True:
        num = f"{prefix}{n:04d}"
        if not con.execute("SELECT 1 FROM invoices WHERE number=?", (num,)).fetchone():
            return num
        n += 1


def _check_items(con, items: list[InvoiceItemIn]) -> list[dict]:
    """Validate stock + minimum margin for every line. Combined qty per product is checked together."""
    m = margin(con)
    totals: dict[int, int] = {}
    for it in items:
        totals[it.product_id] = totals.get(it.product_id, 0) + it.qty
    problems, lines = [], []
    used: dict[int, int] = {}
    for it in items:
        p = con.execute("SELECT * FROM products WHERE id=?", (it.product_id,)).fetchone()
        if not p:
            raise HTTPException(404, f"Product {it.product_id} not found")
        # FIFO slice for this line, after earlier lines of the same product
        before = used.get(it.product_id, 0)
        take_all = fifo_take(con, it.product_id, before + it.qty)
        take, skip = [], before
        for bid, q, c in take_all:
            if skip >= q:
                skip -= q; continue
            take.append((bid, q - skip, c)); skip = 0
        used[it.product_id] = before + it.qty
        cost = sum(q * c for _, q, c in take)
        unit_cost = cost / it.qty
        floor = min_price(unit_cost, m)
        original = it.original_price if it.original_price is not None else (p["list_price"] or p["mrp"] or it.price)
        original = max(original, it.price)
        if it.price < floor:
            problems.append({"product_id": it.product_id, "name": p["name"], "price": it.price,
                             "min_price": floor, "unit_cost": r2(unit_cost)})
        lines.append({"product_id": it.product_id, "name": p["name"], "qty": it.qty,
                      "original_price": r2(original), "price": r2(it.price),
                      "discount": r2((original - it.price) * it.qty), "line_total": r2(it.price * it.qty),
                      "cost": r2(cost), "unit_cost": r2(unit_cost), "min_price": floor, "take": take})
    if problems:
        pct = round(m * 100, 2)
        msg = "; ".join(f"“{x['name']}” can't go below ₹{x['min_price']:,.0f} (your {pct:g}% minimum margin)"
                        for x in problems)
        raise HTTPException(422, {"message": f"Price too low — {msg}", "problems": problems})
    return lines


def _totals(lines, tax_pct):
    original = sum(l["original_price"] * l["qty"] for l in lines)
    subtotal = sum(l["line_total"] for l in lines)
    tax = subtotal * tax_pct / 100
    return {"original_total": r2(original), "discount_total": r2(original - subtotal), "subtotal": r2(subtotal),
            "tax": r2(tax), "total": r2(subtotal + tax), "cost_total": r2(sum(l["cost"] for l in lines))}


@router.post("/invoices/preview")
def preview_invoice(body: InvoiceIn):
    with db() as con:
        lines = _check_items(con, body.items)
        for l in lines:
            l.pop("take")
        t = _totals(lines, body.tax_pct)
        return {"items": lines, **t, "profit": r2(t["subtotal"] - t["cost_total"])}


@router.post("/invoices")
def create_invoice(body: InvoiceIn):
    with db() as con:
        lines = _check_items(con, body.items)
        t = _totals(lines, body.tax_pct)
        paid = t["total"] if body.paid is None else min(r2(body.paid), t["total"])
        c = body.customer
        cust_id = None
        name = (c.name or "").strip() or "Walk-in customer"
        if c.phone:
            row = con.execute("SELECT id FROM customers WHERE phone=?", (c.phone.strip(),)).fetchone()
            if row:
                cust_id = row["id"]
                con.execute("UPDATE customers SET name=?, address=COALESCE(?, address) WHERE id=?",
                            (name, c.address or None, cust_id))
            else:
                cust_id = con.execute("INSERT INTO customers(name, phone, address) VALUES (?,?,?)",
                                      (name, c.phone.strip(), c.address)).lastrowid
        d = body.date or today()
        number = _next_number(con)
        inv_id = con.execute(
            "INSERT INTO invoices(number, date, customer_id, customer_name, customer_phone, customer_address, "
            "original_total, discount_total, subtotal, tax_pct, tax, total, cost_total, payment_mode, note) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (number, d, cust_id, name, c.phone, c.address, t["original_total"], t["discount_total"], t["subtotal"],
             body.tax_pct, t["tax"], t["total"], t["cost_total"], body.payment_mode, body.note)).lastrowid
        for l in lines:
            item_id = con.execute(
                "INSERT INTO invoice_items(invoice_id, product_id, name, qty, original_price, price, discount, "
                "line_total, cost, min_price) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (inv_id, l["product_id"], l["name"], l["qty"], l["original_price"], l["price"], l["discount"],
                 l["line_total"], l["cost"], l["min_price"])).lastrowid
            for bid, q, cost in l["take"]:
                con.execute("UPDATE batches SET qty_left=qty_left-? WHERE id=?", (q, bid))
                con.execute("INSERT INTO invoice_item_batches(item_id, batch_id, qty, landed_cost) VALUES (?,?,?,?)",
                            (item_id, bid, q, cost))
        if paid > 0:
            con.execute("INSERT INTO payments(invoice_id, date, amount, mode) VALUES (?,?,?,?)",
                        (inv_id, d, paid, body.payment_mode))
        return {"id": inv_id, "number": number}


INVOICE_SELECT = """
SELECT i.*, COALESCE((SELECT SUM(amount) FROM payments p WHERE p.invoice_id=i.id), 0) AS paid
FROM invoices i
"""


def invoice_out(i: dict) -> dict:
    i["paid"] = r2(i["paid"])
    i["due"] = 0 if i["voided"] else r2(i["total"] - i["paid"])
    i["profit"] = 0 if i["voided"] else r2(i["subtotal"] - i["cost_total"])
    i["status"] = "void" if i["voided"] else ("paid" if i["due"] <= 0 else ("partial" if i["paid"] > 0 else "due"))
    return i


@router.get("/invoices")
def list_invoices(q: str = "", status: str = "", frm: str = "", to: str = ""):
    with db() as con:
        sql, args = INVOICE_SELECT + " WHERE 1=1", []
        if q:
            sql += " AND (i.number LIKE ? OR i.customer_name LIKE ? OR i.customer_phone LIKE ?)"
            args += [f"%{q}%"] * 3
        if frm:
            sql += " AND i.date>=?"; args.append(frm)
        if to:
            sql += " AND i.date<=?"; args.append(to)
        sql += " ORDER BY i.date DESC, i.id DESC"
        out = [invoice_out(i) for i in rows(con.execute(sql, args))]
        if status == "due":
            out = [i for i in out if i["due"] > 0]
        elif status:
            out = [i for i in out if i["status"] == status]
        return out


@router.get("/invoices/{iid}")
def get_invoice(iid: int):
    with db() as con:
        i = con.execute(INVOICE_SELECT + " WHERE i.id=?", (iid,)).fetchone()
        if not i:
            raise HTTPException(404, "Invoice not found")
        out = invoice_out(dict(i))
        out["items"] = rows(con.execute("SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY id", (iid,)))
        out["payments"] = rows(con.execute("SELECT * FROM payments WHERE invoice_id=? ORDER BY date, id", (iid,)))
        out["shop"] = settings(con)
        return out


@router.post("/invoices/{iid}/payments")
def add_payment(iid: int, body: PaymentIn):
    with db() as con:
        i = con.execute(INVOICE_SELECT + " WHERE i.id=?", (iid,)).fetchone()
        if not i:
            raise HTTPException(404, "Invoice not found")
        i = invoice_out(dict(i))
        if i["voided"]:
            raise HTTPException(400, "This bill was cancelled")
        if body.amount > i["due"] + 0.001:
            raise HTTPException(400, f"Only ₹{i['due']:,.2f} is due on this bill")
        con.execute("INSERT INTO payments(invoice_id, date, amount, mode, note) VALUES (?,?,?,?,?)",
                    (iid, body.date or today(), r2(body.amount), body.mode, body.note))
        return {"ok": True}


@router.post("/invoices/{iid}/void")
def void_invoice(iid: int):
    """Cancel a bill (e.g. customer returned everything): stock goes back to the exact batches it came from."""
    with db() as con:
        i = con.execute("SELECT voided FROM invoices WHERE id=?", (iid,)).fetchone()
        if not i:
            raise HTTPException(404, "Invoice not found")
        if i["voided"]:
            return {"ok": True}
        for b in con.execute("SELECT iib.batch_id, iib.qty FROM invoice_item_batches iib "
                             "JOIN invoice_items ii ON ii.id=iib.item_id WHERE ii.invoice_id=?", (iid,)).fetchall():
            con.execute("UPDATE batches SET qty_left=qty_left+? WHERE id=?", (b["qty"], b["batch_id"]))
        con.execute("UPDATE invoices SET voided=1 WHERE id=?", (iid,))
        con.execute("DELETE FROM payments WHERE invoice_id=?", (iid,))
        return {"ok": True}


# -- customers
@router.get("/customers")
def list_customers(q: str = ""):
    with db() as con:
        sql = ("SELECT c.*, COUNT(i.id) AS bills, COALESCE(SUM(i.total),0) AS spent, "
               "COALESCE(SUM(i.total),0) - COALESCE((SELECT SUM(p.amount) FROM payments p JOIN invoices i2 "
               "ON i2.id=p.invoice_id WHERE i2.customer_id=c.id AND i2.voided=0),0) AS due, MAX(i.date) AS last_bill "
               "FROM customers c LEFT JOIN invoices i ON i.customer_id=c.id AND i.voided=0 WHERE 1=1")
        args = []
        if q:
            sql += " AND (c.name LIKE ? OR c.phone LIKE ?)"; args += [f"%{q}%"] * 2
        sql += " GROUP BY c.id ORDER BY last_bill DESC NULLS LAST, c.name"
        out = rows(con.execute(sql, args))
        for c in out:
            c["spent"] = r2(c["spent"]); c["due"] = r2(c["due"])
        return out


# -- expenses
@router.get("/expenses")
def list_expenses(frm: str = "", to: str = ""):
    with db() as con:
        sql, args = "SELECT * FROM expenses WHERE 1=1", []
        if frm:
            sql += " AND date>=?"; args.append(frm)
        if to:
            sql += " AND date<=?"; args.append(to)
        return rows(con.execute(sql + " ORDER BY date DESC, id DESC", args))


@router.post("/expenses")
def add_expense(body: ExpenseIn):
    with db() as con:
        eid = con.execute("INSERT INTO expenses(date, category, amount, note) VALUES (?,?,?,?)",
                          (body.date or today(), body.category.strip(), r2(body.amount), body.note)).lastrowid
        return {"id": eid}


@router.delete("/expenses/{eid}")
def delete_expense(eid: int):
    with db() as con:
        con.execute("DELETE FROM expenses WHERE id=?", (eid,))
        return {"deleted": True}


# -- reports
def _report(con, frm: str, to: str) -> dict:
    inv = con.execute("SELECT COUNT(*) n, COALESCE(SUM(subtotal),0) sales, COALESCE(SUM(tax),0) tax, "
                      "COALESCE(SUM(total),0) billed, COALESCE(SUM(cost_total),0) cogs, "
                      "COALESCE(SUM(discount_total),0) disc FROM invoices WHERE voided=0 AND date BETWEEN ? AND ?",
                      (frm, to)).fetchone()
    collected = con.execute("SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN invoices i ON i.id=p.invoice_id "
                            "WHERE i.voided=0 AND p.date BETWEEN ? AND ?", (frm, to)).fetchone()[0]
    exp = rows(con.execute("SELECT category, SUM(amount) AS amount FROM expenses WHERE date BETWEEN ? AND ? "
                           "GROUP BY category ORDER BY amount DESC", (frm, to)))
    exp_total = sum(e["amount"] for e in exp)
    loss = con.execute("SELECT COALESCE(SUM(cost),0) FROM adjustments WHERE qty<0 AND date BETWEEN ? AND ?",
                       (frm, to)).fetchone()[0]
    pur = con.execute("SELECT COALESCE(SUM(b.qty*b.unit_cost),0) goods, COALESCE(SUM(b.qty*b.transport_per_unit),0) tr "
                      "FROM batches b JOIN purchases pu ON pu.id=b.purchase_id WHERE pu.date BETWEEN ? AND ?",
                      (frm, to)).fetchone()
    by_product = rows(con.execute(
        "SELECT ii.product_id, ii.name, SUM(ii.qty) qty, SUM(ii.line_total) sales, SUM(ii.cost) cost, "
        "SUM(ii.line_total-ii.cost) profit FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id "
        "WHERE i.voided=0 AND i.date BETWEEN ? AND ? GROUP BY ii.product_id ORDER BY profit DESC", (frm, to)))
    for p in by_product:
        p["margin_pct"] = round((p["profit"] / p["cost"] * 100) if p["cost"] else 0, 1)
        for k in ("sales", "cost", "profit"):
            p[k] = r2(p[k])
    gross = inv["sales"] - inv["cogs"]
    return {
        "from": frm, "to": to, "bills": inv["n"],
        "sales": r2(inv["sales"]), "tax_collected": r2(inv["tax"]), "billed": r2(inv["billed"]),
        "discount_given": r2(inv["disc"]), "cogs": r2(inv["cogs"]), "gross_profit": r2(gross),
        "gross_margin_pct": round(gross / inv["cogs"] * 100, 1) if inv["cogs"] else 0,
        "expenses": r2(exp_total), "expenses_by_category": [{**e, "amount": r2(e["amount"])} for e in exp],
        "stock_loss": r2(loss), "net_profit": r2(gross - exp_total - loss),
        "collected": r2(collected), "purchases_goods": r2(pur["goods"]), "purchases_transport": r2(pur["tr"]),
        "purchases_total": r2(pur["goods"] + pur["tr"]),
        "cash_flow": r2(collected - pur["goods"] - pur["tr"] - exp_total),
        "by_product": by_product,
    }


@router.get("/report")
def report(frm: str = "", to: str = ""):
    frm = frm or date.today().replace(day=1).isoformat()
    to = to or today()
    with db() as con:
        return _report(con, frm, to)


@router.get("/dashboard")
def dashboard():
    t = date.today()
    with db() as con:
        month = _report(con, t.replace(day=1).isoformat(), t.isoformat())
        day = _report(con, t.isoformat(), t.isoformat())
        stock = con.execute("SELECT COALESCE(SUM(qty_left*landed_cost),0) v, COALESCE(SUM(qty_left),0) u "
                            "FROM batches").fetchone()
        products = [product_out(con, p) for p in rows(con.execute(PRODUCT_SELECT + " WHERE p.active=1"))]
        low = sorted([p for p in products if p["low_stock"]], key=lambda p: p["stock"])[:10]
        dues = [i for i in (invoice_out(x) for x in rows(con.execute(INVOICE_SELECT + " WHERE i.voided=0")))
                if i["due"] > 0]
        start = t - timedelta(days=29)
        series = {(start + timedelta(days=k)).isoformat(): {"sales": 0, "profit": 0} for k in range(30)}
        for r in con.execute("SELECT date, SUM(subtotal) s, SUM(subtotal-cost_total) p FROM invoices "
                             "WHERE voided=0 AND date>=? GROUP BY date", (start.isoformat(),)):
            if r["date"] in series:
                series[r["date"]] = {"sales": r2(r["s"]), "profit": r2(r["p"])}
        recent = [invoice_out(i) for i in rows(con.execute(INVOICE_SELECT + " ORDER BY i.id DESC LIMIT 6"))]
        price_flags = [p for p in products if p["stock"] > 0 and (p["ask_below_min"] or (p["vs_market"] or 0) > 0)][:10]
        return {
            "today": {k: day[k] for k in ("bills", "sales", "gross_profit", "collected")},
            "month": {k: month[k] for k in ("bills", "sales", "gross_profit", "net_profit", "expenses",
                                            "purchases_total", "discount_given")},
            "stock_value": r2(stock["v"]), "stock_units": stock["u"], "products": len(products),
            "low_stock": low, "dues_total": r2(sum(i["due"] for i in dues)), "dues_count": len(dues),
            "series": [{"date": k, **v} for k, v in series.items()],
            "top_products": month["by_product"][:5], "recent_invoices": recent, "price_flags": price_flags,
            "margin_pct": round(margin(con) * 100, 2),
        }


# -- exports / backup
EXPORTS = {
    "invoices": "SELECT number, date, customer_name, customer_phone, original_total, discount_total, subtotal, tax, "
                "total, cost_total, subtotal-cost_total AS profit, payment_mode, "
                "(SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.invoice_id=invoices.id) AS paid, "
                "CASE voided WHEN 1 THEN 'cancelled' ELSE '' END AS status FROM invoices ORDER BY date, id",
    "sales_items": "SELECT i.number, i.date, i.customer_name, ii.name, ii.qty, ii.original_price, ii.price, ii.discount, "
                   "ii.line_total, ii.cost, ii.line_total-ii.cost AS profit FROM invoice_items ii "
                   "JOIN invoices i ON i.id=ii.invoice_id WHERE i.voided=0 ORDER BY i.date, i.id",
    "purchases": "SELECT pu.date, pu.supplier, p.name, b.qty, b.unit_cost, b.transport_per_unit, b.landed_cost, "
                 "b.qty*b.landed_cost AS total, b.qty_left FROM batches b JOIN products p ON p.id=b.product_id "
                 "LEFT JOIN purchases pu ON pu.id=b.purchase_id ORDER BY b.date, b.id",
    "expenses": "SELECT date, category, amount, note FROM expenses ORDER BY date, id",
    "stock": "SELECT p.name, p.sku, p.category, p.mrp, p.list_price AS asking_price, p.market_low, p.market_site, "
             "COALESCE(SUM(b.qty_left),0) AS stock, COALESCE(SUM(b.qty_left*b.landed_cost),0) AS stock_value "
             "FROM products p LEFT JOIN batches b ON b.product_id=p.id WHERE p.active=1 GROUP BY p.id ORDER BY p.name",
}


@router.get("/export/{name}.csv")
def export_csv(name: str):
    if name not in EXPORTS:
        raise HTTPException(404, "Unknown export")
    with db() as con:
        cur = con.execute(EXPORTS[name])
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow([c[0] for c in cur.description])
        w.writerows(cur.fetchall())
    return Response(buf.getvalue().encode("utf-8-sig"), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name}-{today()}.csv"'})


@router.get("/backup")
def backup():
    (DB_PATH.parent / "backups").mkdir(exist_ok=True)
    out = DB_PATH.parent / "backups" / f"shop-backup-{datetime.now():%Y%m%d-%H%M%S}.db"
    with _lock:
        src = sqlite3.connect(DB_PATH)
        dst = sqlite3.connect(out)
        src.backup(dst)
        src.close(); dst.close()
    return FileResponse(out, filename=out.name, media_type="application/octet-stream")
