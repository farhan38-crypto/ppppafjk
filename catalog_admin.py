"""Admin side of the customer catalogue: choose what customers see, and handle their order requests.

Public data is written to catalog.db (see catalog_db.py). The link between a catalogue item and an
inventory product lives here in shop.db (table catalog_links) so the public site never sees it.
"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import catalog_db as cdbm
import shop

router = APIRouter(prefix="/api/catalog")
IMG_CACHE = Path(__file__).parent / "catalog_images"

LINK_SCHEMA = """
CREATE TABLE IF NOT EXISTS catalog_links (
  item_id INTEGER PRIMARY KEY, product_id INTEGER REFERENCES products(id), bh_path TEXT);
"""


def init():
    cdbm.init()
    with shop.db() as con:
        con.executescript(LINK_SCHEMA)


def _links() -> dict[int, dict]:
    with shop.db() as con:
        return {r["item_id"]: dict(r) for r in con.execute("SELECT * FROM catalog_links")}


def _products(ids) -> dict[int, dict]:
    if not ids:
        return {}
    with shop.db() as con:
        q = shop.PRODUCT_SELECT + f" WHERE p.id IN ({','.join('?' * len(ids))})"
        return {p["id"]: shop.product_out(con, p) for p in shop.rows(con.execute(q, list(ids)))}


def sync_stock():
    """Copy in-stock yes/no for linked items into the public catalogue (never the quantity)."""
    links = _links()
    prods = _products({l["product_id"] for l in links.values() if l["product_id"]})
    with cdbm.cdb() as con:
        for iid, l in links.items():
            p = prods.get(l["product_id"])
            if p is not None:
                con.execute("UPDATE items SET in_stock=? WHERE id=?", (1 if p["stock"] > 0 else 0, iid))


def amazon_compare(stores: list, fallback_price=None, fallback_site=None) -> tuple[float | None, str | None]:
    """Prefer Amazon's price for the 'price on Amazon' strike-through; else the lowest other store."""
    for s in stores or []:
        if (s.get("site") or "").lower().startswith("amazon") and s.get("price"):
            return s["price"], "Amazon"
    return fallback_price, fallback_site


class ItemIn(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    image: str | None = Field(None, max_length=1000)
    description: str | None = Field(None, max_length=600)
    category: str | None = Field(None, max_length=60)
    our_price: float = Field(gt=0)
    compare_price: float | None = Field(None, ge=0)
    compare_store: str | None = Field(None, max_length=40)
    badge: str | None = Field(None, max_length=30)
    visible: bool = True
    sort: int = 0
    product_id: int | None = None
    bh_path: str | None = Field(None, max_length=300)


def _check_min(product_id, price):
    if not product_id:
        return
    p = _products({product_id}).get(product_id)
    if not p:
        raise HTTPException(400, "Linked inventory product not found")
    if p["min_price"] and price < p["min_price"]:
        raise HTTPException(422, f"₹{price:,.0f} is below your minimum price ₹{p['min_price']:,.0f} for this product")


def _save(iid: int | None, body: ItemIn) -> int:
    _check_min(body.product_id, body.our_price)
    if body.image and not body.image.startswith("https://"):
        raise HTTPException(400, "Picture link must start with https://")
    vals = (body.title.strip(), body.image, body.description, body.category, body.our_price, body.compare_price,
            body.compare_store, body.badge, 1 if body.visible else 0, body.sort)
    with cdbm.cdb() as con:
        if iid:
            old = con.execute("SELECT image FROM items WHERE id=?", (iid,)).fetchone()
            if not old:
                raise HTTPException(404, "Item not found")
            con.execute("UPDATE items SET title=?, image=?, description=?, category=?, our_price=?, compare_price=?, "
                        "compare_store=?, badge=?, visible=?, sort=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", vals + (iid,))
            if old["image"] != body.image:
                _drop_image(iid)
        else:
            iid = con.execute("INSERT INTO items(title, image, description, category, our_price, compare_price, "
                              "compare_store, badge, visible, sort) VALUES (?,?,?,?,?,?,?,?,?,?)", vals).lastrowid
    with shop.db() as con:
        con.execute("INSERT OR REPLACE INTO catalog_links(item_id, product_id, bh_path) VALUES (?,?,?)",
                    (iid, body.product_id, body.bh_path))
    sync_stock()
    return iid


def _drop_image(iid):
    for f in IMG_CACHE.glob(f"{iid}.*"):
        f.unlink(missing_ok=True)


@router.get("/items")
def list_items():
    sync_stock()
    links = _links()
    prods = _products({l["product_id"] for l in links.values() if l["product_id"]})
    with cdbm.cdb() as con:
        items = [dict(r) for r in con.execute("SELECT * FROM items ORDER BY sort, id DESC")]
    for it in items:
        l = links.get(it["id"], {})
        p = prods.get(l.get("product_id"))
        it["product_id"] = l.get("product_id")
        it["bh_path"] = l.get("bh_path")
        it["product"] = {k: p[k] for k in ("id", "name", "stock", "list_price", "min_price", "avg_cost")} if p else None
        it["below_min"] = bool(p and p["min_price"] and it["our_price"] < p["min_price"])
    return items


@router.post("/items")
def create_item(body: ItemIn):
    return {"id": _save(None, body)}


@router.put("/items/{iid}")
def update_item(iid: int, body: ItemIn):
    return {"id": _save(iid, body)}


@router.delete("/items/{iid}")
def delete_item(iid: int):
    with cdbm.cdb() as con:
        con.execute("UPDATE items SET visible=0 WHERE id=?", (iid,))   # keep for old orders' history
        con.execute("DELETE FROM items WHERE id=? AND id NOT IN (SELECT item_id FROM order_items WHERE item_id IS NOT NULL)", (iid,))
    with shop.db() as con:
        con.execute("DELETE FROM catalog_links WHERE item_id=?", (iid,))
    _drop_image(iid)
    return {"ok": True}


@router.post("/from-product/{pid}")
def add_from_inventory(pid: int):
    p = _products({pid}).get(pid)
    if not p:
        raise HTTPException(404, "Product not found")
    price = p["list_price"] or p["min_price"]
    if not price:
        raise HTTPException(400, "Set an asking price for this product first")
    cp, cs = amazon_compare(p.get("market_stores"), p.get("market_low"), p.get("market_site"))
    iid = _save(None, ItemIn(title=p["name"], image=p["image"] if (p["image"] or "").startswith("https://") else None,
                             category=p["category"], our_price=price,
                             compare_price=cp if cp and cp > price else None, compare_store=cs if cp and cp > price else None,
                             product_id=pid, bh_path=p["bh_path"]))
    return {"id": iid}


class InfoIn(BaseModel):
    shop_name: str | None = Field(None, max_length=80)
    tagline: str | None = Field(None, max_length=140)
    phone: str | None = Field(None, max_length=20)
    whatsapp: str | None = Field(None, max_length=20)
    address: str | None = Field(None, max_length=200)
    open: bool | None = None


@router.get("/settings")
def get_info():
    with cdbm.cdb() as con:
        return cdbm.info(con)


@router.put("/settings")
def put_info(body: InfoIn):
    with cdbm.cdb() as con:
        for k, v in body.model_dump(exclude_none=True).items():
            con.execute("INSERT OR REPLACE INTO info(key, value) VALUES (?,?)", (k, ("1" if v else "0") if k == "open" else str(v)))
        return cdbm.info(con)


# ---------------------------------------------------------------- orders
@router.get("/orders")
def list_orders(status: str = ""):
    with cdbm.cdb() as con:
        sql, args = "SELECT o.*, (SELECT COUNT(*) FROM order_items WHERE order_id=o.id) AS lines FROM orders o", []
        if status:
            sql += " WHERE o.status=?"; args.append(status)
        return [dict(r) for r in con.execute(sql + " ORDER BY o.id DESC LIMIT 300", args)]


@router.get("/orders/count")
def count_new():
    with cdbm.cdb() as con:
        return {"new": con.execute("SELECT COUNT(*) FROM orders WHERE status='new'").fetchone()[0]}


@router.get("/orders/{oid}")
def get_order(oid: int):
    with cdbm.cdb() as con:
        o = con.execute("SELECT * FROM orders WHERE id=?", (oid,)).fetchone()
        if not o:
            raise HTTPException(404, "Order not found")
        its = [dict(r) for r in con.execute("SELECT * FROM order_items WHERE order_id=?", (oid,))]
        con.execute("UPDATE orders SET seen=1 WHERE id=?", (oid,))
    links = _links()
    prods = _products({links[i["item_id"]]["product_id"] for i in its
                       if i["item_id"] in links and links[i["item_id"]]["product_id"]})
    for i in its:
        pid = links.get(i["item_id"], {}).get("product_id")
        p = prods.get(pid)
        i["product_id"] = pid
        i["stock"] = p["stock"] if p else None
        i["min_price"] = p["min_price"] if p else None
        i["list_price"] = p["list_price"] if p else None
        i["can_bill"] = bool(p and p["stock"] >= i["qty"])
    return {**dict(o), "items": its}


class StatusIn(BaseModel):
    status: str = Field(pattern="^(new|billed|rejected)$")
    invoice_number: str | None = Field(None, max_length=40)


@router.post("/orders/{oid}/status")
def set_status(oid: int, body: StatusIn):
    with cdbm.cdb() as con:
        if not con.execute("SELECT 1 FROM orders WHERE id=?", (oid,)).fetchone():
            raise HTTPException(404, "Order not found")
        con.execute("UPDATE orders SET status=?, invoice_number=COALESCE(?, invoice_number), seen=1 WHERE id=?",
                    (body.status, body.invoice_number, oid))
    return {"ok": True}
