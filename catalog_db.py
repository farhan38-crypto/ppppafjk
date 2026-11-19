"""Customer catalogue database (catalog.db) — shared by the admin app and the public catalogue site.

This file holds ONLY what customers are allowed to see (titles, pictures, your price, the
Amazon comparison price, in-stock yes/no) plus the order requests customers send.
Costs, stock counts, profits and everything else stay in shop.db, which the public
catalogue server never opens.
"""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

CATALOG_DB = Path(__file__).parent / "catalog.db"
_lock = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, image TEXT, description TEXT, category TEXT,
  our_price REAL NOT NULL, compare_price REAL, compare_store TEXT, badge TEXT,
  in_stock INTEGER DEFAULT 1, visible INTEGER DEFAULT 1, sort INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT, note TEXT,
  status TEXT DEFAULT 'new', invoice_number TEXT, total REAL, ip_hash TEXT, seen INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), item_id INTEGER,
  title TEXT, qty INTEGER, price REAL);
CREATE TABLE IF NOT EXISTS info (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS ix_orders_status ON orders(status, id);
"""

DEFAULT_INFO = {"shop_name": "Royal Trading Company", "tagline": "Genuine products. Prices that beat Amazon.",
                "phone": "", "whatsapp": "", "address": "", "open": "1"}


@contextmanager
def cdb():
    with _lock:
        con = sqlite3.connect(CATALOG_DB)
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


def init():
    with cdb() as con:
        con.executescript(SCHEMA)
        for k, v in DEFAULT_INFO.items():
            con.execute("INSERT OR IGNORE INTO info(key, value) VALUES (?,?)", (k, v))


def info(con) -> dict:
    return {r["key"]: r["value"] for r in con.execute("SELECT key, value FROM info")}
