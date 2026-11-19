/* Shop manager: purchase cart → inventory, billing with a minimum-margin floor, dues, expenses, finance.
   Relies on helpers from index.html: $, esc, inr, go, view, store, current, showProduct. */
'use strict';

const S = {settings: null, cats: []};
const inr2 = n => n == null ? '–' : (n < 0 ? '−₹' : '₹') + Math.abs(Number(n)).toLocaleString('en-IN', {minimumFractionDigits: 0, maximumFractionDigits: 2});
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {day: 'numeric', month: 'short', year: 'numeric'}) : '';
const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const marginPct = () => num(S.settings?.min_margin_pct ?? 10);
const floorPrice = cost => Math.ceil(cost * (1 + marginPct() / 100) - 1e-9);

// API wrapper that understands the shop's structured errors
async function sapi(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? {'Content-Type': 'application/json'} : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && data.error === 'auth') { location.href = '/login' + location.hash; throw new Error('Please log in'); }
  if (!r.ok) {
    const d = data.detail;
    const msg = typeof d === 'string' ? d : (d?.message || (Array.isArray(d) ? d.map(x => `${x.loc?.slice(-1)[0]}: ${x.msg}`).join(', ') : 'Something went wrong'));
    const e = new Error(msg); e.data = d; throw e;
  }
  return data;
}

function toast(msg, bad) {
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.toggle('bad', !!bad); t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), bad ? 5000 : 2600);
}
const fail = e => toast(e.message, true);

async function loadSettings() {
  const s = await sapi('/api/shop/settings');
  S.cats = s.expense_categories; S.settings = s;
}

// ================================================================ purchase cart (localStorage)
const cart = {
  get items() { return store.get('hk_cart', []); },
  save(items) { store.set('hk_cart', items); updateCartBadge(); },
  add(item) {
    const items = this.items;
    const key = item.product_id ? 'id:' + item.product_id : (item.bh_path ? 'bh:' + item.bh_path : 'n:' + item.name.toLowerCase());
    const ex = items.find(i => i.key === key);
    if (ex) ex.qty += item.qty || 1; else items.push({key, qty: 1, ...item});
    this.save(items);
  },
  clear() { this.save([]); },
};
function updateCartBadge() {
  const n = cart.items.reduce((a, i) => a + (num(i.qty) || 0), 0);
  const b = $('cartBadge'); if (b) { b.textContent = n; b.style.display = n ? '' : 'none'; }
}

// Same split as the server: transport shared by value (falls back to qty)
function splitTransport(items, transport) {
  const tv = items.reduce((a, i) => a + num(i.qty) * num(i.unit_cost), 0);
  const tq = items.reduce((a, i) => a + num(i.qty), 0);
  return items.map(i => {
    const q = num(i.qty) || 1;
    const share = tv ? transport * num(i.qty) * num(i.unit_cost) / tv : (tq ? transport * num(i.qty) / tq : 0);
    return share / q;
  });
}

// ================================================================ routing
const SHOP_TABS = [
  ['shop', 'Dashboard'], ['orders', 'Orders'], ['bill', 'New bill'], ['bills', 'Bills'], ['inv', 'Inventory'],
  ['catalogue', 'Catalogue'], ['cart', 'New shipment'], ['purchases', 'Shipments'], ['finance', 'Finance'],
  ['customers', 'Customers'], ['settings', 'Settings'],
];
const CASHIER_TABS = ['orders', 'bill', 'bills', 'inv', 'catalogue', 'customers', 'settings'];
window.ME = null;
const isCashier = () => ME && ME.role === 'cashier';
const isOwner = () => ME && ME.role === 'owner';
function tabAllowed(r) { return !isCashier() || CASHIER_TABS.includes(r); }
function shopNav(name) {
  const nav = $('shopnav');
  if (!nav) return;
  const inShop = SHOP_TABS.some(t => t[0] === name) || ['b', 'pi', 'pu', 'o'].includes(name);
  nav.classList.add('on');                       // menu stays visible on every page
  $('tabShop')?.classList.toggle('on', inShop);
  const map = {b: 'bills', pi: 'inv', pu: 'purchases', o: 'orders'};
  nav.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.r === (map[name] || name)));
}
window.shopRoute = function (name, arg) {
  shopNav(name);
  const R = {
    shop: dashboard, bill: () => newBill(arg), bills: () => billsPage(arg), b: () => invoicePage(arg),
    inv: inventoryPage, pi: () => productPage(arg), cart: cartPage, purchases: purchasesPage, pu: () => purchasePage(arg),
    finance: financePage, customers: customersPage, settings: settingsPage,
    orders: ordersPage, o: () => orderPage(arg), catalogue: catalogPage,
  };
  if (!R[name]) return false;
  const tab = {b: 'bills', pi: 'inv', pu: 'purchases', o: 'orders'}[name] || name;
  if (ME && !tabAllowed(tab)) { go('bill'); return true; }
  window.scrollTo(0, 0);
  (async () => { try { if (!S.settings) await loadSettings(); await R[name](); } catch (e) { view.innerHTML = `<div class="msg">${esc(e.message)}</div>`; } })();
  return true;
};

// ================================================================ dashboard
async function dashboard() {
  view.innerHTML = '<div class="msg">Loading…</div>';
  const d = await sapi('/api/shop/dashboard');
  const max = Math.max(1, ...d.series.map(s => s.sales));
  view.innerHTML = `
    <div class="toolbar"><h2>${esc(S.settings.shop_name)}</h2>
      <button onclick="go('bill')">+ New bill</button><button class="ghost" onclick="go('cart')">New shipment</button>
      <button class="ghost" onclick="openExpense()">+ Expense</button></div>
    <div class="kpis">
      ${kpi('Today’s sales', inr(d.today.sales), `${d.today.bills} bill${d.today.bills === 1 ? '' : 's'} · profit ${inr(d.today.gross_profit)}`)}
      ${kpi('This month sales', inr(d.month.sales), `${d.month.bills} bills · ${inr(d.month.discount_given)} discount given`)}
      ${kpi('Gross profit (month)', inr(d.month.gross_profit), 'sales − cost incl. transport', d.month.gross_profit >= 0 ? 'pos' : 'neg')}
      ${kpi('Net profit (month)', inr(d.month.net_profit), `after ${inr(d.month.expenses)} expenses`, d.month.net_profit >= 0 ? 'pos' : 'neg')}
      ${kpi('Stock value', inr(d.stock_value), `${d.stock_units} units · ${d.products} products`)}
      ${kpi('Money to collect', inr(d.dues_total), `${d.dues_count} unpaid bill${d.dues_count === 1 ? '' : 's'}`, d.dues_total ? 'neg' : '', "go('bills','due')")}
    </div>
    <div class="cols3 section">
      <div class="glass card"><div class="row" style="justify-content:space-between"><h3>Last 30 days</h3>
        <span class="legend"><span><i style="background:var(--acc)"></i>Sales</span><span><i style="background:var(--good)"></i>Profit</span></span></div>
        <div class="bars">${d.series.map(s => `<div data-t="${fmtDate(s.date)}: ${inr(s.sales)} / profit ${inr(s.profit)}">
          <i style="height:${s.sales / max * 140}px"></i></div>`).join('')}</div>
        <div class="bars" style="height:50px;padding-top:0;margin-top:-1px">${d.series.map(s => `<div data-t="profit ${inr(s.profit)}"><i class="p" style="height:${Math.max(0, s.profit) / max * 140}px"></i></div>`).join('')}</div>
        <div class="row hint" style="justify-content:space-between"><span>${fmtDate(d.series[0].date)}</span><span>Today</span></div>
      </div>
      <div class="glass card"><h3>Low stock</h3>${d.low_stock.length ? `<table class="t">${d.low_stock.map(p => `
        <tr class="click" onclick="go('pi','${p.id}')"><td>${esc(p.name)}</td><td class="n"><span class="pill low">${p.stock} left</span></td></tr>`).join('')}</table>
        <button class="ghost" style="margin-top:8px" onclick="restockLow()">Add all to next shipment</button>` : '<div class="hint">Everything is stocked above its reorder level.</div>'}</div>
    </div>
    <div class="cols2 section">
      <div class="glass card"><h3>Recent bills</h3>${d.recent_invoices.length ? invTable(d.recent_invoices, true) : '<div class="hint">No bills yet.</div>'}</div>
      <div class="glass card"><h3>Best sellers this month</h3>${d.top_products.length ? `<table class="t">
        <tr><th>Product</th><th class="n">Sold</th><th class="n">Profit</th></tr>
        ${d.top_products.map(p => `<tr class="click" onclick="go('pi','${p.product_id}')"><td>${esc(p.name)}</td><td class="n">${p.qty}</td>
          <td class="n pos">${inr(p.profit)} <span class="hint">(${p.margin_pct}%)</span></td></tr>`).join('')}</table>` : '<div class="hint">No sales this month yet.</div>'}</div>
    </div>
    ${d.price_flags.length ? `<div class="glass card section"><h3>Check these prices</h3><table class="t">
      <tr><th>Product</th><th class="n">Your asking</th><th class="n">Min. price</th><th class="n">Lowest online</th><th>Issue</th></tr>
      ${d.price_flags.map(p => `<tr class="click" onclick="go('pi','${p.id}')"><td>${esc(p.name)}</td><td class="n">${inr(p.list_price)}</td>
        <td class="n">${inr(p.min_price)}</td><td class="n">${inr(p.market_low)} <span class="hint">${esc(p.market_site || '')}</span></td>
        <td>${p.ask_below_min ? '<span class="pill low">below your minimum</span> ' : ''}${p.vs_market > 0 ? `<span class="pill due">${inr(p.vs_market)} above online</span>` : ''}</td></tr>`).join('')}
    </table></div>` : ''}`;
  window._lowStock = d.low_stock;
}
function kpi(l, v, s, cls = '', click = '') {
  return `<div class="glass kpi"${click ? ` style="cursor:pointer" onclick="${click}"` : ''}><div class="l">${l}</div><div class="v ${cls}">${v}</div><div class="s">${s}</div></div>`;
}
function restockLow() {
  (window._lowStock || []).forEach(p => cart.add({product_id: p.id, name: p.name, image: p.image, mrp: p.mrp,
    unit_cost: '', asking_price: p.list_price, market_low: p.market_low, market_site: p.market_site,
    qty: Math.max(1, (p.reorder_level || 2) * 2 - p.stock)}));
  toast('Low-stock items added to the next shipment'); go('cart');
}

// ================================================================ product page hook (price tracker → cart)
// Watches the main view: whenever a Buyhatke product page renders, add the "my inventory" panel.
// Buyhatke is only a market reference — you buy from your own suppliers.
function marketFromPage(p) {
  const stores = [{site: p.site, price: p.price, link: p.link}]
    .concat((p.compare || []).filter(c => c.exact && c.price).map(c => ({site: c.site, price: c.price, link: c.link})))
    .filter(x => x.price);
  const best = {};
  stores.forEach(x => { if (!best[x.site] || x.price < best[x.site].price) best[x.site] = x; });
  const list = Object.values(best).sort((a, b) => a.price - b.price).slice(0, 8);
  return {market_low: list[0]?.price ?? null, market_site: list[0]?.site ?? null, market_link: list[0]?.link ?? null, market_stores: list};
}
async function injectCartPanel() {
  const p = current;
  const btnRow = view.querySelector('#target')?.parentElement;
  if (!p || !p.name || !btnRow || view.querySelector('.inv-note')) return;
  const m = marketFromPage(p);
  const box = document.createElement('div');
  box.className = 'inv-note';
  box.innerHTML = `<div class="row" style="flex-wrap:wrap;justify-content:space-between">
      <span>Lowest online: <b>${inr(m.market_low)}</b> on ${esc(m.market_site || '')}</span>
      <span class="row"><span class="hint" id="invState">Checking your inventory…</span>
      <button class="ghost owner-only" onclick="catalogueFromPage()">＋ Catalogue</button>
      <button id="invBtn" class="owner-only" onclick="addCurrentToShipment()">＋ Add to my inventory</button></span></div>`;
  btnRow.after(box);
  try {
    const ex = await sapi('/api/shop/products/find?' + new URLSearchParams({bh_path: p.page || '', name: p.name}));
    window._pageInv = ex;
    if (ex) {
      const diff = ex.list_price && m.market_low ? ex.list_price - m.market_low : null;
      $('invState').innerHTML = `In your inventory: <b>${ex.stock}</b> · you ask <b>${inr(ex.list_price)}</b>` +
        (diff == null ? '' : diff > 0 ? ` · <span class="neg">${inr(diff)} above ${esc(m.market_site)}</span>` : ` · <span class="pos">${inr(-diff)} cheaper than ${esc(m.market_site)}</span>`) +
        ` · <a href="#pi:${ex.id}">open</a>`;
      $('invBtn').textContent = '＋ Add stock';
      if (p.page && !ex.bh_path) sapi(`/api/shop/products/${ex.id}/market`, {body: {path: p.page}}).catch(() => {});
    } else $('invState').textContent = '';
  } catch (e) { $('invState').textContent = ''; }
}
new MutationObserver(() => { if (view.querySelector('#target') && !view.querySelector('.inv-note')) injectCartPanel(); })
  .observe(view, {childList: true, subtree: true});
window.addCurrentToShipment = function () {
  const p = current, ex = window._pageInv;
  const m = marketFromPage(p);
  if (ex && ex.name) cart.add({product_id: ex.id, name: ex.name, image: ex.image, mrp: ex.mrp, unit_cost: '', asking_price: ex.list_price, ...m, bh_path: p.page});
  else cart.add({name: p.name, image: p.image, mrp: p.mrp || null, bh_path: p.page, unit_cost: '', asking_price: '', ...m});
  toast('Added to your next shipment — enter your cost and asking price there');
  updateCartBadge();
};
window.addCurrentToCart = window.addCurrentToShipment;

// ================================================================ shipment (one truck load) → inventory
function cartPage() {
  const items = cart.items;
  const st = store.get('hk_cart_meta', {supplier: '', transport: 0, date: today(), note: ''});
  view.innerHTML = `
    <div class="toolbar"><h2>New shipment</h2>
      <button class="ghost" onclick="shipmentPickStock()">+ Existing product</button>
      <button class="ghost" onclick="cartAddManual()">+ New product</button>
      ${items.length ? `<button class="ghost" onclick="if(confirm('Clear this shipment?')){cart.clear();cartPage()}">Clear</button>` : ''}</div>
    <div class="glass card">
      ${items.length ? `<div class="table-wrap"><table class="t" id="cartT">
        <tr><th></th><th>Product</th><th class="n">Qty</th><th class="n">Your cost / unit</th><th class="n">Transport share / unit</th>
          <th class="n">Landed / unit</th><th class="n">Min. price</th><th class="n">Your asking price</th><th class="n">Market (online)</th><th></th></tr>
        ${items.map((i, k) => `<tr>
          <td>${i.image ? `<img class="thumb" src="${esc(i.image)}" alt="">` : ''}</td>
          <td>${i.product_id ? `<b>${esc(i.name)}</b><div class="hint">in inventory</div>` : `<input type="text" value="${esc(i.name)}" onchange="cartSet(${k},'name',this.value)" style="min-width:200px"><div class="hint">new product</div>`}</td>
          <td class="n"><input class="q" type="number" min="1" value="${i.qty}" oninput="cartSet(${k},'qty',this.value)"></td>
          <td class="n"><input type="number" min="0" step="0.01" value="${i.unit_cost ?? ''}" placeholder="₹" oninput="cartSet(${k},'unit_cost',this.value)"></td>
          <td class="n" id="tr${k}"></td><td class="n" id="lc${k}"></td><td class="n" id="mp${k}"></td>
          <td class="n"><input type="number" min="0" step="1" value="${i.asking_price ?? ''}" placeholder="₹" oninput="cartSet(${k},'asking_price',this.value)"><div id="aw${k}"></div></td>
          <td class="n">${i.market_low ? `<b>${inr(i.market_low)}</b><div class="hint">${esc(i.market_site || '')}</div>` : '<span class="hint">—</span>'}</td>
          <td><button class="ghost" style="padding:4px 10px" onclick="cartDel(${k})">✕</button></td></tr>`).join('')}
      </table></div>
      <div class="form section">
        <label><span>Supplier / bought from</span><input type="text" id="cSup" value="${esc(st.supplier)}" placeholder="e.g. Delhi wholesaler" oninput="cartMeta()"></label>
        <label><span>Truck / transportation charge (total ₹)</span><input type="number" id="cTr" min="0" step="0.01" value="${st.transport || ''}" placeholder="0" oninput="cartMeta();cartCalc()"></label>
        <label><span>Date received</span><input type="date" id="cDate" value="${esc(st.date || today())}" oninput="cartMeta()"></label>
        <label><span>Note</span><input type="text" id="cNote" value="${esc(st.note)}" placeholder="optional — bill no., truck no." oninput="cartMeta()"></label>
      </div>
      <div class="row section" style="justify-content:space-between;flex-wrap:wrap;gap:12px">
        <div class="hint" style="max-width:560px">Everything here came in one truck. The transport charge is shared by value: a costlier item carries a bigger share.
          Min. price = landed cost + ${marginPct()}%.</div>
        <div class="row"><b id="cTotal"></b><button onclick="receiveStock()">Add shipment to inventory</button></div>
      </div>` : `<div class="empty">No items in this shipment yet.<br><br>
        Search a product above and press <b>＋ Add to my inventory</b> to bring in its market prices,<br>
        or add an <a href="javascript:shipmentPickStock()">existing product</a> / a <a href="javascript:cartAddManual()">new product</a>.</div>`}
    </div>`;
  if (items.length) cartCalc();
}
window.cartSet = (k, f, v) => { const items = cart.items; items[k][f] = f === 'name' ? v : (v === '' ? '' : num(v)); cart.save(items); cartCalc(); };
window.cartDel = k => { const items = cart.items; items.splice(k, 1); cart.save(items); cartPage(); };
window.cartMeta = () => store.set('hk_cart_meta', {supplier: $('cSup').value, transport: num($('cTr').value), date: $('cDate').value, note: $('cNote').value});
function cartCalc() {
  const items = cart.items, tr = num($('cTr')?.value);
  const per = splitTransport(items, tr);
  let goods = 0;
  items.forEach((i, k) => {
    const hasCost = i.unit_cost !== '' && i.unit_cost != null;
    const landed = num(i.unit_cost) + per[k];
    goods += num(i.qty) * num(i.unit_cost);
    $('tr' + k).textContent = hasCost ? inr2(+per[k].toFixed(2)) : '–';
    $('lc' + k).innerHTML = hasCost ? `<b>${inr2(+landed.toFixed(2))}</b>` : '–';
    const mp = floorPrice(landed);
    $('mp' + k).innerHTML = hasCost ? `<b class="pos">${inr(mp)}</b>` : '–';
    const ask = num(i.asking_price), w = [];
    if (hasCost && ask && ask < mp) w.push(`<div class="warn">below your min ${inr(mp)}</div>`);
    if (ask && i.market_low && ask > i.market_low) w.push(`<div class="warn">${inr(ask - i.market_low)} above online</div>`);
    else if (ask && i.market_low) w.push(`<div class="hint pos">${inr(i.market_low - ask)} cheaper than online</div>`);
    $('aw' + k).innerHTML = w.join('');
  });
  $('cTotal').textContent = `Goods ${inr2(goods)} + transport ${inr2(tr)} = ${inr2(goods + tr)} `;
}
window.cartAddManual = function () {
  const name = prompt('New product name');
  if (!name || !name.trim()) return;
  cart.add({name: name.trim(), unit_cost: '', asking_price: '', mrp: null});
  cartPage();
};
window.shipmentPickStock = async function () {
  const list = await sapi('/api/shop/products');
  if (!list.length) return toast('No products yet — add a new one', true);
  const q = prompt('Which product? Type part of its name:\n\n' + list.slice(0, 25).map(p => '• ' + p.name).join('\n'));
  if (!q) return;
  const hit = list.filter(p => p.name.toLowerCase().includes(q.toLowerCase()));
  if (!hit.length) return toast('No product matches “' + q + '”', true);
  const p = hit[0];
  cart.add({product_id: p.id, name: p.name, image: p.image, mrp: p.mrp, unit_cost: '', asking_price: p.list_price,
    market_low: p.market_low, market_site: p.market_site});
  cartPage();
};
window.receiveStock = async function () {
  const items = cart.items;
  const bad = items.find(i => !num(i.qty) || num(i.qty) < 1 || i.unit_cost === '' || i.unit_cost == null || !String(i.name || '').trim());
  if (bad) return toast(`Enter your cost and quantity for “${bad.name || 'every item'}”`, true);
  const per = splitTransport(items, num($('cTr').value));
  const low = items.filter((i, k) => num(i.asking_price) && num(i.asking_price) < floorPrice(num(i.unit_cost) + per[k]));
  if (low.length && !confirm(`${low.length} asking price(s) are below your ${marginPct()}% minimum. Bills can't go below the minimum anyway. Continue?`)) return;
  const body = {
    supplier: $('cSup').value || null, transport: num($('cTr').value), date: $('cDate').value || today(), note: $('cNote').value || null,
    items: items.map(i => ({
      qty: Math.round(num(i.qty)), unit_cost: num(i.unit_cost),
      asking_price: i.asking_price === '' || i.asking_price == null ? null : num(i.asking_price),
      ...(i.product_id ? {product_id: i.product_id} : {product: {name: i.name.trim(), image: i.image || null, mrp: i.mrp || null,
        bh_path: i.bh_path || null, source_link: null,
        market_low: i.market_low ?? null, market_site: i.market_site ?? null, market_link: i.market_link ?? null, market_stores: i.market_stores ?? null}}),
    })),
  };
  try {
    const r = await sapi('/api/shop/purchases', {body});
    cart.clear(); store.set('hk_cart_meta', {supplier: '', transport: 0, date: today(), note: ''});
    toast('Shipment added to inventory ✓'); go('pu', String(r.id));
  } catch (e) { fail(e); }
};

// ================================================================ inventory
async function inventoryPage() {
  const q = store.get('hk_inv_q', '');
  view.innerHTML = `<div class="toolbar"><h2>Inventory</h2>
      <input type="text" id="invQ" placeholder="Search name, SKU, category" value="${esc(q)}">
      <label class="row hint"><input type="checkbox" id="invLow"> Low stock only</label>
      <label class="row hint"><input type="checkbox" id="invAll"> Show archived</label>
      <button class="ghost owner-only" onclick="newProductForm()">+ New product</button>
      <button class="ghost owner-only" id="mktAll" onclick="refreshAllMarket()">↻ Market prices</button>
      <button class="ghost owner-only" onclick="location.href='/api/shop/export/stock.csv'">Export</button></div>
    <div class="glass card" id="invList"><div class="hint">Loading…</div></div>`;
  const load = async () => {
    store.set('hk_inv_q', $('invQ').value);
    const list = await sapi('/api/shop/products?' + new URLSearchParams({q: $('invQ').value, include_inactive: $('invAll').checked}));
    const shown = $('invLow').checked ? list.filter(p => p.low_stock) : list;
    const tv = shown.reduce((a, p) => a + p.stock_value, 0);
    $('invList').innerHTML = shown.length ? `<div class="table-wrap"><table class="t">
      <tr><th></th><th>Product</th><th class="n">In stock</th><th class="n secret">Avg. cost</th><th class="n">Min. price</th>
        <th class="n">Asking price</th><th class="n">Market (online)</th><th class="n secret">Stock value</th><th class="n">Sold</th><th></th></tr>
      ${shown.map(p => `<tr class="click" onclick="go('pi','${p.id}')">
        <td>${p.image ? `<img class="thumb" src="${esc(p.image)}" alt="">` : ''}</td>
        <td>${esc(p.name)}${p.active ? '' : ' <span class="pill">archived</span>'}<div class="hint">${esc([p.sku, p.category].filter(Boolean).join(' · '))}</div></td>
        <td class="n">${p.low_stock ? `<span class="pill low">${p.stock}</span>` : p.stock}</td>
        <td class="n secret">${inr2(p.avg_cost)}</td><td class="n pos">${inr(p.min_price)}</td>
        <td class="n"><b>${inr(p.list_price)}</b>${p.ask_below_min ? '<div class="warn">below min</div>' : ''}</td>
        <td class="n">${marketCell(p)}</td>
        <td class="n secret">${inr(p.stock_value)}</td><td class="n">${p.sold}</td>
        <td class="n" onclick="event.stopPropagation()">${p.stock ? `<button class="ghost" style="padding:4px 10px" onclick="sellNow(${p.id})">Sell</button>` : ''}
          <button class="ghost owner-only" style="padding:4px 10px" onclick="cart.add({product_id:${p.id},name:${esc(JSON.stringify(p.name))},image:${esc(JSON.stringify(p.image || ''))},mrp:${p.mrp || 'null'},unit_cost:'',asking_price:${p.list_price || 'null'},market_low:${p.market_low || 'null'},market_site:${esc(JSON.stringify(p.market_site || ''))}});toast('Added to next shipment');updateCartBadge()">Restock</button></td>
      </tr>`).join('')}
      <tr><td></td><td><b>${shown.length} products</b></td><td class="n"><b>${shown.reduce((a, p) => a + p.stock, 0)}</b></td><td class="secret"></td><td></td><td></td><td></td><td class="n secret"><b>${inr(tv)}</b></td><td></td><td></td></tr>
    </table></div>` : `<div class="empty">No products yet. Search a product and press <b>＋ Add to my inventory</b>, or use <b>+ New product</b>.</div>`;
  };
  let t; $('invQ').oninput = () => { clearTimeout(t); t = setTimeout(load, 200); };
  $('invLow').onchange = load; $('invAll').onchange = load;
  await load();
}
function marketCell(p) {
  if (!p.market_low) return '<span class="hint">not linked</span>';
  const d = p.vs_market;
  return `${inr(p.market_low)}<div class="hint">${esc(p.market_site || '')}</div>` +
    (d == null ? '' : d > 0 ? `<div class="warn">you +${inr(d)}</div>` : `<div class="hint pos">you −${inr(-d)}</div>`);
}
window.refreshAllMarket = async function () {
  const b = $('mktAll'); b.disabled = true; b.textContent = 'Checking online prices…';
  try {
    const r = await sapi('/api/shop/market/refresh-all', {body: {}});
    toast(`Updated ${r.updated} product(s)` + (r.failed.length ? `, ${r.failed.length} failed` : ''), r.failed.length > 0);
    inventoryPage();
  } catch (e) { fail(e); b.disabled = false; b.textContent = '↻ Market prices'; }
};
window.sellNow = id => { store.set('hk_bill_add', id); go('bill'); };

function productFields(p = {}) {
  return `<div class="form">
    <label class="wide"><span>Name</span><input type="text" id="pfName" value="${esc(p.name || '')}"></label>
    <label><span>SKU / code</span><input type="text" id="pfSku" value="${esc(p.sku || '')}"></label>
    <label><span>Category</span><input type="text" id="pfCat" value="${esc(p.category || '')}"></label>
    <label><span>MRP (₹)</span><input type="number" id="pfMrp" min="0" step="0.01" value="${p.mrp ?? ''}"></label>
    <label><span>Your asking price (₹) — shown as original price on bills</span><input type="number" id="pfList" min="0" step="0.01" value="${p.list_price ?? ''}"></label>
    <label><span>Low-stock alert at</span><input type="number" id="pfRe" min="0" value="${p.reorder_level ?? 2}"></label>
    <label class="wide"><span>Image URL</span><input type="text" id="pfImg" value="${esc(p.image || '')}"></label>
  </div>`;
}
function readProductFields(p = {}) {
  return {name: $('pfName').value.trim(), sku: $('pfSku').value || null, category: $('pfCat').value || null,
    mrp: $('pfMrp').value === '' ? null : num($('pfMrp').value), list_price: $('pfList').value === '' ? null : num($('pfList').value),
    reorder_level: Math.round(num($('pfRe').value)), image: $('pfImg').value || null, active: 1};
}
window.newProductForm = function () {
  view.innerHTML = `<div class="toolbar"><h2>New product</h2></div><div class="glass card">${productFields()}
    <div class="form section">
      <label><span>Opening stock (qty)</span><input type="number" id="pfQty" min="0" value="0"></label>
      <label><span>Your cost / unit (₹)</span><input type="number" id="pfCost" min="0" step="0.01"></label>
      <label><span>Transport for this stock (₹ total)</span><input type="number" id="pfTr" min="0" step="0.01" value="0"></label>
      <label><span>Supplier</span><input type="text" id="pfSup"></label></div>
    <div class="row section"><button onclick="saveNewProduct()">Save</button><button class="ghost" onclick="history.back()">Cancel</button></div></div>`;
};
window.saveNewProduct = async function () {
  const p = readProductFields();
  if (!p.name) return toast('Enter a product name', true);
  const qty = Math.round(num($('pfQty').value));
  try {
    if (qty > 0) {
      if ($('pfCost').value === '') return toast('Enter what you paid per unit', true);
      const r = await sapi('/api/shop/purchases', {body: {supplier: $('pfSup').value || null, transport: num($('pfTr').value),
        items: [{qty, unit_cost: num($('pfCost').value), product: p}]}});
      go('pi', String(r.items[0].product_id));
    } else {
      const r = await sapi('/api/shop/products', {body: p}); go('pi', String(r.id));
    }
    toast('Product saved ✓');
  } catch (e) { fail(e); }
};

async function productPage(id) {
  const p = await sapi('/api/shop/products/' + id);
  p.batches = p.batches || []; p.adjustments = p.adjustments || [];
  view.innerHTML = `
    <div class="toolbar"><h2>${esc(p.name)}</h2>
      ${p.stock ? `<button onclick="sellNow(${p.id})">Sell</button>` : ''}
      <button class="ghost owner-only" onclick="addToCatalogue(${p.id})">＋ Catalogue</button>
      <button class="ghost owner-only" onclick='cart.add({product_id:${p.id},name:${JSON.stringify(p.name).replace(/'/g, "&#39;")},image:${JSON.stringify(p.image || '').replace(/'/g, "&#39;")},mrp:${p.mrp || 'null'},unit_cost:"",asking_price:${p.list_price || 'null'},market_low:${p.market_low || 'null'}});toast("Added to next shipment")'>Restock</button>
      ${p.bh_path ? `<button class="ghost" onclick="go('p','${esc(p.bh_path)}')">Price history</button>` : ''}</div>
    <div class="kpis">
      ${kpi('In stock', p.stock, p.low_stock ? '<span class="neg">low stock</span>' : `alert at ${p.reorder_level}`)}
      <div class="secret">${kpi('Avg. landed cost', inr2(p.avg_cost), 'incl. transport')}</div>
      ${kpi('Sell at least', inr(p.min_price), `next unit, +${marginPct()}%`, 'pos')}
      ${kpi('Your asking price', inr(p.list_price), p.ask_below_min ? '<span class="neg">below your minimum!</span>' : (p.mrp ? `MRP ${inr(p.mrp)}` : ''))}
      ${kpi('Lowest online', p.market_low ? inr(p.market_low) : '—', p.market_low ? `${esc(p.market_site || '')}${p.vs_market != null ? ` · you ${p.vs_market > 0 ? '+' : '−'}${inr(Math.abs(p.vs_market))}` : ''}` : 'not linked', p.vs_market > 0 ? 'neg' : '')}
      <div class="secret">${kpi('Stock value', inr(p.stock_value), `${p.sold} sold so far`)}</div>
      <div class="secret">${kpi('Profit earned', inr(p.sales.reduce((a, s) => a + (s.profit || 0), 0)), `${p.sales.length} sale(s)`, 'pos')}</div>
    </div>
    <div class="cols2 section">
      <div class="glass card secret"><h3>Stock batches</h3>${(p.batches || []).length ? `<div class="table-wrap"><table class="t">
        <tr><th>Date</th><th>From</th><th class="n">Qty</th><th class="n">Left</th><th class="n">Paid</th><th class="n">+Transport</th><th class="n">Landed</th></tr>
        ${p.batches.map(b => `<tr${b.purchase_id ? ` class="click" onclick="go('pu','${b.purchase_id}')"` : ''}><td>${fmtDate(b.date)}</td><td>${esc(b.supplier || (b.purchase_id ? '' : 'Adjustment'))}</td>
          <td class="n">${b.qty}</td><td class="n">${b.qty_left}</td><td class="n">${inr2(b.unit_cost)}</td><td class="n">${inr2(b.transport_per_unit)}</td><td class="n"><b>${inr2(b.landed_cost)}</b></td></tr>`).join('')}
      </table></div>` : '<div class="hint">No stock received yet.</div>'}</div>
      <div class="glass card"><h3>Sales</h3>${p.sales.length ? `<div class="table-wrap"><table class="t">
        <tr><th>Bill</th><th>Customer</th><th class="n">Qty</th><th class="n">Price</th><th class="n secret">Profit</th></tr>
        ${p.sales.map(s => `<tr class="click" onclick="go('b','${s.invoice_id}')"><td>${esc(s.number)}<div class="hint">${fmtDate(s.date)}</div></td><td>${esc(s.customer_name)}</td>
          <td class="n">${s.qty}</td><td class="n">${inr(s.price)}</td><td class="n pos secret">${inr(s.profit)}</td></tr>`).join('')}
      </table></div>` : '<div class="hint">Not sold yet.</div>'}</div>
    </div>
    <div class="glass card section"><div class="row" style="justify-content:space-between;flex-wrap:wrap">
        <h3>Market comparison</h3><span class="row">
        ${p.bh_path ? `<button class="ghost owner-only" id="mktBtn" onclick="refreshMarket(${p.id})">↻ Refresh</button>` : ''}
        <button class="ghost owner-only" onclick="linkMarket(${p.id})">${p.bh_path ? 'Change listing' : 'Link to online listing'}</button></span></div>
      ${p.market_stores.length ? `<div class="table-wrap"><table class="t">
        <tr><th>Store</th><th class="n">Online price</th><th class="n">Your asking price</th><th class="n">Difference</th><th></th></tr>
        ${p.market_stores.map(m => `<tr><td>${esc(m.site)}</td><td class="n">${inr(m.price)}</td><td class="n">${inr(p.list_price)}</td>
          <td class="n">${p.list_price ? (p.list_price > m.price ? `<span class="neg">you +${inr(p.list_price - m.price)}</span>` : `<span class="pos">you −${inr(m.price - p.list_price)}</span>`) : ''}</td>
          <td class="n">${m.link ? `<a href="${esc(m.link)}" target="_blank" rel="noopener">view</a>` : ''}</td></tr>`).join('')}
      </table></div><div class="hint section">Checked ${esc((p.market_checked || '').replace('T', ' '))}</div>`
      : `<div class="hint">Link this product to its Buyhatke listing to compare your price with Amazon, Flipkart and others.</div>`}
      <div id="linkBox"></div></div>
    <div class="cols2 section">
      <div class="glass card owner-only"><h3>Edit details</h3>${productFields(p)}
        <div class="row section"><button onclick="saveProduct(${p.id})">Save changes</button>
          <button class="ghost" onclick="deleteProduct(${p.id})">${p.batches.length || p.sold ? 'Archive' : 'Delete'}</button></div></div>
      <div class="glass card owner-only"><h3>Adjust stock</h3>
        <div class="hint">Remove damaged, lost or personally used units (their cost counts as a loss), or add opening stock you didn’t buy through a purchase.</div>
        <div class="form section">
          <label><span>Change (−2 removes 2)</span><input type="number" id="adjQ" value="-1"></label>
          <label><span>Reason</span><select id="adjR"><option>Damaged</option><option>Lost / stolen</option><option>Personal use</option><option>Returned to supplier</option><option>Opening stock</option><option>Count correction</option></select></label>
          <label><span>Cost / unit (only when adding)</span><input type="number" id="adjC" min="0" step="0.01" value="${p.avg_cost ?? ''}"></label>
        </div><div class="row section"><button class="ghost" onclick="adjustStock(${p.id})">Apply</button></div>
        ${p.adjustments.length ? `<table class="t section">${p.adjustments.map(a => `<tr><td>${fmtDate(a.date)}</td><td>${esc(a.reason)}</td><td class="n">${a.qty > 0 ? '+' : ''}${a.qty}</td><td class="n">${a.cost ? '−' + inr2(a.cost) : ''}</td></tr>`).join('')}</table>` : ''}
      </div>
    </div>`;
  window._prod = p;
}
window.refreshMarket = async id => {
  const b = $('mktBtn'); if (b) { b.disabled = true; b.textContent = 'Checking…'; }
  try { await sapi(`/api/shop/products/${id}/market`, {body: {}}); toast('Market prices updated ✓'); productPage(id); } catch (e) { fail(e); if (b) { b.disabled = false; b.textContent = '↻ Refresh'; } }
};
window.linkMarket = function (id) {
  $('linkBox').innerHTML = `<div class="row section"><input type="text" id="lkQ" placeholder="Search the same product online, or paste an Amazon / Flipkart link" value="${esc(window._prod.name)}">
    <button onclick="linkSearch(${id})">Search</button></div><div id="lkRes" class="section"></div>`;
  $('lkQ').onkeydown = e => { if (e.key === 'Enter') linkSearch(id); };
  $('lkQ').focus();
};
window.linkSearch = async function (id) {
  const q = $('lkQ').value.trim(); if (!q) return;
  $('lkRes').innerHTML = '<div class="hint">Searching Buyhatke…</div>';
  try {
    if (/^https?:\/\//i.test(q)) { await sapi(`/api/shop/products/${id}/market`, {body: {url: q}}); toast('Linked ✓'); return productPage(id); }
    const list = (await sapi('/api/search?q=' + encodeURIComponent(q))).slice(0, 8);
    $('lkRes').innerHTML = list.length ? `<table class="t">${list.map((x, i) => `<tr><td><img class="thumb" src="${esc(x.image)}" alt=""></td>
      <td>${esc(x.name)}</td><td class="n">${inr(x.price)}</td><td class="n"><button class="ghost" style="padding:4px 10px" onclick="linkPick(${id}, ${i})">This one</button></td></tr>`).join('')}</table>`
      : '<div class="hint">No results.</div>';
    window._lk = list;
  } catch (e) { $('lkRes').innerHTML = `<div class="warn">${esc(e.message)}</div>`; }
};
window.linkPick = async function (id, i) {
  $('lkRes').innerHTML = '<div class="hint">Fetching prices from all stores…</div>';
  try { await sapi(`/api/shop/products/${id}/market`, {body: {path: window._lk[i].path}}); toast('Linked ✓'); productPage(id); } catch (e) { fail(e); }
};
window.saveProduct = async id => {
  const body = readProductFields(window._prod);
  if (!body.name) return toast('Name is required', true);
  try { await sapi('/api/shop/products/' + id, {method: 'PUT', body}); toast('Saved ✓'); productPage(id); } catch (e) { fail(e); }
};
window.deleteProduct = async id => {
  if (!confirm('Remove this product? If it has history it will be archived (hidden), not deleted.')) return;
  try { const r = await sapi('/api/shop/products/' + id, {method: 'DELETE'}); toast(r.archived ? 'Archived' : 'Deleted'); go('inv'); } catch (e) { fail(e); }
};
window.adjustStock = async id => {
  const qty = Math.round(num($('adjQ').value));
  if (!qty) return toast('Enter a quantity', true);
  try {
    await sapi(`/api/shop/products/${id}/adjust`, {body: {qty, reason: $('adjR').value, unit_cost: qty > 0 ? num($('adjC').value) : null}});
    toast('Stock updated ✓'); productPage(id);
  } catch (e) { fail(e); }
};

// ================================================================ purchases
async function purchasesPage() {
  const list = await sapi('/api/shop/purchases');
  view.innerHTML = `<div class="toolbar"><h2>Shipments</h2><button onclick="go('cart')">+ New shipment</button>
    <button class="ghost" onclick="location.href='/api/shop/export/purchases.csv'">Export</button></div>
    <div class="glass card">${list.length ? `<div class="table-wrap"><table class="t">
      <tr><th>Date</th><th>Supplier</th><th>Items</th><th class="n">Units</th><th class="n">Goods</th><th class="n">Transport</th><th class="n">Total</th></tr>
      ${list.map(p => `<tr class="click" onclick="go('pu','${p.id}')"><td>${fmtDate(p.date)}</td><td>${esc(p.supplier || '—')}</td>
        <td class="mute" style="max-width:340px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.names || 'Opening stock')}</td>
        <td class="n">${p.units}</td><td class="n">${inr2(p.goods)}</td><td class="n">${inr2(p.transport)}</td><td class="n"><b>${inr2(p.total)}</b></td></tr>`).join('')}
    </table></div>` : '<div class="empty">No purchases yet.</div>'}</div>`;
}
async function purchasePage(id) {
  const p = await sapi('/api/shop/purchases/' + id);
  const goods = p.items.reduce((a, i) => a + i.qty * i.unit_cost, 0);
  view.innerHTML = `<div class="toolbar"><h2>Shipment #${p.id}</h2>
      <button class="ghost" onclick="deletePurchase(${p.id})">Delete shipment</button></div>
    <div class="kpis">${kpi('Date', fmtDate(p.date), esc(p.supplier || ''))}${kpi('Goods', inr2(goods), `${p.items.reduce((a, i) => a + i.qty, 0)} units`)}
      ${kpi('Truck / transport', inr2(p.transport), 'shared by item value')}${kpi('Total paid', inr2(goods + (p.transport || 0)), esc(p.note || ''))}</div>
    <div class="glass card section"><div class="table-wrap"><table class="t">
      <tr><th></th><th>Product</th><th class="n">Qty</th><th class="n">Paid / unit</th><th class="n">Transport / unit</th><th class="n">Landed / unit</th><th class="n">Min. sell price</th><th class="n">Left</th></tr>
      ${p.items.map(i => `<tr class="click" onclick="go('pi','${i.product_id}')"><td>${i.image ? `<img class="thumb" src="${esc(i.image)}" alt="">` : ''}</td><td>${esc(i.name)}</td>
        <td class="n">${i.qty}</td><td class="n">${inr2(i.unit_cost)}</td><td class="n">${inr2(i.transport_per_unit)}</td>
        <td class="n"><b>${inr2(i.landed_cost)}</b></td><td class="n pos"><b>${inr(i.min_price)}</b></td><td class="n">${i.qty_left}</td></tr>`).join('')}
    </table></div></div>`;
}
window.deletePurchase = async id => {
  if (!confirm('Delete this purchase and remove its stock? Only possible if none of it was sold.')) return;
  try { await sapi('/api/shop/purchases/' + id, {method: 'DELETE'}); toast('Purchase deleted'); go('purchases'); } catch (e) { fail(e); }
};

// ================================================================ new bill
const bill = {lines: [], stock: []};
async function newBill() {
  bill.stock = await sapi('/api/shop/products?in_stock=true');
  const pre = store.get('hk_bill_add', null);
  bill.lines = [];
  if (pre) { store.set('hk_bill_add', null); const p = bill.stock.find(x => x.id === pre); if (p) addLine(p, false); }
  const draft = store.get('hk_bill_draft', null);
  bill.order = null;
  if (draft) {
    store.set('hk_bill_draft', null);
    bill.order = draft;
    draft.lines.forEach(d => {
      const p = bill.stock.find(x => x.id === d.product_id);
      if (!p) return;
      addLine(p, false);
      const l = bill.lines.find(x => x.id === p.id);
      l.qty = Math.min(p.stock, d.qty); l.price = d.price;
    });
  }
  const taxDefault = num(S.settings.default_tax_pct);
  view.innerHTML = `
    <div class="toolbar"><h2>New bill</h2><label class="row hint owner-only"><input type="checkbox" id="hideProfit" ${store.get('hk_hide_profit', false) ? 'checked' : ''}
      onchange="store.set('hk_hide_profit',this.checked);document.body.classList.toggle('privacy',this.checked)"> Blur my cost & profit (customer can see screen)</label></div>
    <div class="glass card">
      <div class="form">
        <label class="picker"><span>Customer phone</span><input type="text" id="bPhone" placeholder="optional — remembers the customer" autocomplete="off" inputmode="tel">
          <div class="menu" id="custMenu"></div></label>
        <label><span>Customer name</span><input type="text" id="bName" placeholder="Walk-in customer"></label>
        <label><span>Address</span><input type="text" id="bAddr" placeholder="optional"></label>
        <label><span>Date</span><input type="date" id="bDate" value="${today()}"></label>
      </div>
    </div>
    <div class="glass card section">
      <div class="picker"><input type="text" id="prodQ" placeholder="🔎 Add product — type to search your stock" autocomplete="off"><div class="menu" id="prodMenu"></div></div>
      <div class="table-wrap section"><table class="t" id="billT"></table></div>
    </div>
    <div class="cols2 section">
      <div class="glass card"><div class="form">
        <label><span>Payment mode</span><select id="bMode"><option>Cash</option><option>UPI</option><option>Card</option><option>Bank transfer</option><option>Credit (pay later)</option></select></label>
        <label><span>Amount received now (₹)</span><input type="number" id="bPaid" min="0" step="0.01" placeholder="full amount"></label>
        <label><span>GST / tax % (added on top)</span><input type="number" id="bTax" min="0" max="100" step="0.01" value="${taxDefault}"></label>
        <label class="wide"><span>Note on bill</span><input type="text" id="bNote" placeholder="optional — warranty, serial no., etc."></label>
      </div></div>
      <div class="glass card"><div class="sum" id="bSum"></div>
        <div class="row section" style="justify-content:flex-end"><span class="warn" id="bErr"></span><button id="bSave" onclick="saveBill()">Save & print bill</button></div></div>
    </div>`;
  document.body.classList.toggle('privacy', store.get('hk_hide_profit', false));
  setupProductPicker(); setupCustomerPicker(); renderBill();
  if (bill.order) {
    $('bName').value = bill.order.customer.name || ''; $('bPhone').value = bill.order.customer.phone || '';
    $('bAddr').value = bill.order.customer.address || '';
    if (bill.order.note) $('bNote').value = bill.order.note;
    view.querySelector('.toolbar h2').textContent = `New bill — order ${bill.order.ref}`;
    bill.lines.forEach(quoteLine);
  }
  $('bMode').onchange = () => { if ($('bMode').value.startsWith('Credit')) $('bPaid').value = 0; renderBill(); };
  $('bPaid').oninput = renderBill; $('bTax').oninput = renderBill;
  setTimeout(() => (bill.lines.length ? $('bPhone') : $('prodQ')).focus(), 50);
}
function addLine(p, render = true) {
  const ex = bill.lines.find(l => l.id === p.id);
  if (ex) { if (ex.qty < p.stock) ex.qty++; else toast(`Only ${p.stock} in stock`, true); }
  else bill.lines.push({id: p.id, name: p.name, stock: p.stock, qty: 1, original: p.list_price || p.mrp || p.min_price,
    price: Math.max(p.list_price || p.mrp || 0, p.min_price || 0), cost: null, min: p.min_price});
  if (render) { renderBill(); quoteLine(bill.lines.find(l => l.id === p.id)); }
}
async function quoteLine(l) {
  if (!l) return;
  // combined quantity of this product across lines (only one line per product here)
  try { const q = await sapi(`/api/shop/quote?product_id=${l.id}&qty=${l.qty}`); l.cost = q.unit_cost; l.min = q.min_price; renderBill(); }
  catch (e) { toast(e.message, true); }
}
function renderBill() {
  const T = $('billT'); if (!T) return;
  if (!bill.lines.length) { T.innerHTML = '<tr><td class="empty">No items yet — search above to add products from your stock.</td></tr>'; }
  else T.innerHTML = `<tr><th>Product</th><th class="n">Qty</th><th class="n">Original price</th><th class="n">Discount %</th><th class="n">Selling price</th>
      <th class="n">Amount</th><th class="n secret">Cost / min</th><th></th></tr>` +
    bill.lines.map((l, k) => {
      const low = l.min != null && l.price < l.min;
      const disc = l.original ? Math.round((1 - l.price / l.original) * 1000) / 10 : 0;
      return `<tr><td>${esc(l.name)}<div class="hint">${l.stock} in stock</div></td>
        <td class="n"><input class="q" type="number" min="1" max="${l.stock}" value="${l.qty}" onchange="lineSet(${k},'qty',this.value)"></td>
        <td class="n"><input type="number" min="0" step="0.01" value="${l.original ?? ''}" onchange="lineSet(${k},'original',this.value)"></td>
        <td class="n"><input class="q" type="number" min="0" max="100" step="0.1" value="${disc}" onchange="lineSet(${k},'disc',this.value)"></td>
        <td class="n"><input type="number" min="0" step="0.01" value="${l.price}" onchange="lineSet(${k},'price',this.value)" style="${low ? 'border-color:var(--bad)' : ''}">
          ${low ? `<div class="warn">min ${inr(l.min)}</div>` : ''}</td>
        <td class="n"><b>${inr2(l.price * l.qty)}</b></td>
        <td class="n secret hint">${l.cost != null ? inr2(l.cost) : '…'} / <b class="pos">${inr(l.min)}</b></td>
        <td><button class="ghost" style="padding:4px 10px" onclick="bill.lines.splice(${k},1);renderBill()">✕</button></td></tr>`;
    }).join('');
  const original = bill.lines.reduce((a, l) => a + Math.max(l.original || 0, l.price) * l.qty, 0);
  const sub = bill.lines.reduce((a, l) => a + l.price * l.qty, 0);
  const tax = sub * num($('bTax').value) / 100, total = sub + tax;
  const cost = bill.lines.reduce((a, l) => a + (l.cost || 0) * l.qty, 0);
  const paid = $('bPaid').value === '' ? total : Math.min(num($('bPaid').value), total);
  $('bSum').innerHTML = `<span>Original price</span><span>${inr2(original)}</span>
    <span>Discount</span><span class="pos">− ${inr2(original - sub)}</span>
    ${tax ? `<span>Subtotal</span><span>${inr2(sub)}</span><span>Tax (${num($('bTax').value)}%)</span><span>${inr2(tax)}</span>` : ''}
    <span class="big">Total</span><span class="big">${inr2(total)}</span>
    <span>Received</span><span>${inr2(paid)}</span>
    ${total - paid > 0.001 ? `<span class="neg">Due (credit)</span><span class="neg">${inr2(total - paid)}</span>` : ''}
    <span class="secret hint">Your profit</span><span class="secret ${sub - cost >= 0 ? 'pos' : 'neg'}"><b>${inr2(sub - cost)}</b></span>`;
  const bad = bill.lines.filter(l => l.min != null && l.price < l.min);
  $('bErr').textContent = bad.length ? `${bad.length} item(s) below your ${marginPct()}% minimum` : '';
  $('bSave').disabled = !bill.lines.length || bad.length > 0;
}
window.lineSet = (k, f, v) => {
  const l = bill.lines[k];
  if (f === 'qty') { l.qty = Math.max(1, Math.min(l.stock, Math.round(num(v)))); renderBill(); return quoteLine(l); }
  if (f === 'original') l.original = num(v);
  if (f === 'disc') l.price = Math.round(l.original * (1 - Math.min(100, num(v)) / 100) * 100) / 100;
  if (f === 'price') l.price = num(v);
  renderBill();
};
function setupProductPicker() {
  const inp = $('prodQ'), menu = $('prodMenu');
  let act = 0, res = [];
  const draw = () => {
    const q = inp.value.trim().toLowerCase();
    res = bill.stock.filter(p => !q || p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q)).slice(0, 12);
    menu.innerHTML = res.length ? res.map((p, i) => `<div class="opt${i === act ? ' active' : ''}" data-i="${i}">
      ${p.image ? `<img class="thumb" src="${esc(p.image)}" alt="">` : ''}<div class="grow"><div class="t1">${esc(p.name)}</div>
      <div class="hint">${p.stock} in stock · list ${inr(p.list_price)} · <span class="secret">min ${inr(p.min_price)}</span></div></div></div>`).join('')
      : `<div class="hint" style="padding:10px">${bill.stock.length ? 'No match in stock' : 'Nothing in stock — receive stock first.'}</div>`;
    menu.classList.add('open');
  };
  const pick = i => { if (res[i]) { addLine(res[i]); inp.value = ''; menu.classList.remove('open'); inp.focus(); } };
  inp.oninput = () => { act = 0; draw(); };
  inp.onfocus = draw;
  inp.onkeydown = e => {
    if (e.key === 'ArrowDown') { act = Math.min(act + 1, res.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { act = Math.max(act - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { pick(act); e.preventDefault(); }
    else if (e.key === 'Escape') menu.classList.remove('open');
  };
  menu.onmousedown = e => { const o = e.target.closest('.opt'); if (o) { e.preventDefault(); pick(+o.dataset.i); } };
  inp.onblur = () => setTimeout(() => menu.classList.remove('open'), 120);
}
function setupCustomerPicker() {
  const inp = $('bPhone'), menu = $('custMenu');
  let t;
  inp.oninput = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = inp.value.trim(); if (q.length < 2) return menu.classList.remove('open');
      const list = (await sapi('/api/shop/customers?q=' + encodeURIComponent(q))).slice(0, 8);
      if (!list.length) return menu.classList.remove('open');
      menu.innerHTML = list.map((c, i) => `<div class="opt" data-i="${i}"><div class="grow"><div class="t1">${esc(c.name)}</div>
        <div class="hint">${esc(c.phone || '')}${c.due > 0 ? ` · <span class="neg">owes ${inr(c.due)}</span>` : ''}</div></div></div>`).join('');
      menu.classList.add('open');
      menu.onmousedown = e => { const o = e.target.closest('.opt'); if (!o) return; e.preventDefault(); const c = list[+o.dataset.i];
        inp.value = c.phone || ''; $('bName').value = c.name; $('bAddr').value = c.address || ''; menu.classList.remove('open');
        if (c.due > 0) toast(`${c.name} already owes ${inr(c.due)} from earlier bills`); };
    }, 200);
  };
  inp.onblur = () => setTimeout(() => menu.classList.remove('open'), 120);
}
window.saveBill = async function () {
  const sub = bill.lines.reduce((a, l) => a + l.price * l.qty, 0);
  const total = sub * (1 + num($('bTax').value) / 100);
  const paidRaw = $('bPaid').value;
  if (paidRaw !== '' && num(paidRaw) < total - 0.001 && !$('bPhone').value.trim() && !confirm('This bill has money due but no customer phone. Save anyway?')) return;
  $('bSave').disabled = true;
  try {
    const r = await sapi('/api/shop/invoices', {body: {
      date: $('bDate').value || today(), tax_pct: num($('bTax').value), payment_mode: $('bMode').value,
      paid: paidRaw === '' ? null : num(paidRaw), note: $('bNote').value || null,
      customer: {name: $('bName').value.trim() || 'Walk-in customer', phone: $('bPhone').value.trim() || null, address: $('bAddr').value.trim() || null},
      items: bill.lines.map(l => ({product_id: l.id, qty: l.qty, price: l.price, original_price: l.original})),
    }});
    if (bill.order) { await sapi(`/api/catalog/orders/${bill.order.id}/status`, {body: {status: 'billed', invoice_number: r.number}}).catch(() => {}); bill.order = null; refreshOrderBadge(); }
    toast(`Bill ${r.number} saved ✓`);
    store.set('hk_print_next', r.id);
    go('b', String(r.id));
  } catch (e) {
    if (e.data?.problems) e.data.problems.forEach(p => { const l = bill.lines.find(x => x.id === p.product_id); if (l) { l.min = p.min_price; l.cost = p.unit_cost; } });
    renderBill(); fail(e);
  }
};

// ================================================================ bills list + invoice
function invTable(list, compact) {
  return `<div class="table-wrap"><table class="t">
    <tr><th>Bill</th><th>Customer</th>${compact ? '' : '<th>Date</th>'}<th class="n">Total</th>${compact ? '' : '<th class="n">Profit</th><th class="n">Due</th>'}<th>Status</th></tr>
    ${list.map(i => `<tr class="click" onclick="go('b','${i.id}')"><td>${esc(i.number)}${compact ? `<div class="hint">${fmtDate(i.date)}</div>` : ''}</td>
      <td>${esc(i.customer_name)}<div class="hint">${esc(i.customer_phone || '')}</div></td>${compact ? '' : `<td>${fmtDate(i.date)}</td>`}
      <td class="n">${inr2(i.total)}</td>${compact ? '' : `<td class="n secret ${i.profit >= 0 ? 'pos' : 'neg'}">${inr2(i.profit)}</td><td class="n ${i.due ? 'neg' : ''}">${i.due ? inr2(i.due) : '—'}</td>`}
      <td><span class="pill ${i.status}">${i.status === 'void' ? 'cancelled' : i.status}</span></td></tr>`).join('')}</table></div>`;
}
async function billsPage(filter) {
  view.innerHTML = `<div class="toolbar"><h2>Bills</h2>
    <input type="text" id="blQ" placeholder="Bill no., customer or phone" value="">
    <select id="blS"><option value="">All</option><option value="due" ${filter === 'due' ? 'selected' : ''}>Unpaid / partly paid</option><option value="paid">Paid</option><option value="void">Cancelled</option></select>
    <input type="date" id="blF"><input type="date" id="blT">
    <button onclick="go('bill')">+ New bill</button>
    <button class="ghost owner-only" onclick="location.href='/api/shop/export/invoices.csv'">Export</button></div>
    <div class="glass card" id="blList">Loading…</div>`;
  const load = async () => {
    const list = await sapi('/api/shop/invoices?' + new URLSearchParams({q: $('blQ').value, status: $('blS').value, frm: $('blF').value, to: $('blT').value}));
    const live = list.filter(i => i.status !== 'void');
    $('blList').innerHTML = list.length ? invTable(list) + `<div class="row section hint" style="justify-content:flex-end;gap:18px">
      <span>${live.length} bills</span><span>Total ${inr2(live.reduce((a, i) => a + i.total, 0))}</span>
      <span class="secret">Profit ${inr2(live.reduce((a, i) => a + i.profit, 0))}</span><span class="neg">Due ${inr2(live.reduce((a, i) => a + i.due, 0))}</span></div>`
      : '<div class="empty">No bills found.</div>';
  };
  let t; $('blQ').oninput = () => { clearTimeout(t); t = setTimeout(load, 200); };
  ['blS', 'blF', 'blT'].forEach(id => $(id).onchange = load);
  await load();
}
async function invoicePage(id) {
  const i = await sapi('/api/shop/invoices/' + id);
  const s = i.shop;
  const saved = i.discount_total;
  view.innerHTML = `
    <div class="toolbar no-print"><h2>Bill ${esc(i.number)}</h2>
      <button onclick="window.print()">🖨 Print / Save PDF</button>
      ${i.customer_phone ? `<button class="ghost" onclick="shareBill()">Share on WhatsApp</button>` : ''}
      ${i.due > 0 ? `<button class="ghost" onclick="recordPayment(${i.id}, ${i.due})">Record payment</button>` : ''}
      ${i.voided ? '' : `<button class="ghost owner-only" onclick="voidBill(${i.id})">Cancel bill</button>`}
      <button class="ghost" onclick="go('bill')">+ New bill</button></div>
    <div class="paper">
      <div class="hdr"><div><h1>${esc(s.shop_name)}</h1>
          <div class="muted">${esc(s.address)}</div><div class="muted">${[s.phone && 'Ph: ' + s.phone, s.email].filter(Boolean).map(esc).join(' · ')}</div>
          ${s.gstin ? `<div class="muted">GSTIN: ${esc(s.gstin)}</div>` : ''}</div>
        <div style="text-align:right"><div style="font-size:18px;font-weight:800">${i.tax ? 'TAX INVOICE' : 'INVOICE'}</div>
          <div><b>${esc(i.number)}</b></div><div class="muted">${fmtDate(i.date)}</div>
          ${i.voided ? '<div class="stamp" style="color:#dc2626;margin-top:6px">CANCELLED</div>' : i.status === 'paid' ? '<div class="stamp" style="color:#15803d;margin-top:6px">PAID</div>' : ''}</div></div>
      <div style="margin-bottom:12px"><div class="muted">Bill to</div><b>${esc(i.customer_name)}</b>
        ${i.customer_phone ? `<div>${esc(i.customer_phone)}</div>` : ''}${i.customer_address ? `<div class="muted">${esc(i.customer_address)}</div>` : ''}</div>
      <table style="width:100%">
        <tr><th>#</th><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Original price</th><th style="text-align:right">Discount</th><th style="text-align:right">Our price</th><th style="text-align:right">Amount</th></tr>
        ${i.items.map((it, k) => `<tr><td>${k + 1}</td><td>${esc(it.name)}</td><td style="text-align:right">${it.qty}</td>
          <td style="text-align:right">${it.original_price > it.price ? `<span class="strike">${inr2(it.original_price)}</span>` : inr2(it.original_price)}</td>
          <td style="text-align:right">${it.discount > 0 ? `${Math.round((1 - it.price / it.original_price) * 100)}%` : '—'}</td>
          <td style="text-align:right">${inr2(it.price)}</td><td style="text-align:right"><b>${inr2(it.line_total)}</b></td></tr>`).join('')}
      </table>
      <table class="tot" style="margin:12px 0 0 auto;min-width:280px">
        <tr><td>Total original price</td><td style="text-align:right">${inr2(i.original_total)}</td></tr>
        <tr><td>Discount</td><td style="text-align:right" class="save">− ${inr2(i.discount_total)}</td></tr>
        ${i.tax ? `<tr><td>Subtotal</td><td style="text-align:right">${inr2(i.subtotal)}</td></tr><tr><td>Tax @ ${i.tax_pct}%</td><td style="text-align:right">${inr2(i.tax)}</td></tr>` : ''}
        <tr><td style="font-size:18px"><b>Grand total</b></td><td style="text-align:right;font-size:18px"><b>${inr2(i.total)}</b></td></tr>
        <tr><td>Paid (${esc(i.payment_mode || '')})</td><td style="text-align:right">${inr2(i.paid)}</td></tr>
        ${i.due > 0 ? `<tr><td style="color:#dc2626"><b>Balance due</b></td><td style="text-align:right;color:#dc2626"><b>${inr2(i.due)}</b></td></tr>` : ''}
      </table>
      ${saved > 0 ? `<div class="save" style="text-align:right;margin-top:8px">You saved ${inr2(saved)} on this bill!</div>` : ''}
      ${i.note ? `<div style="margin-top:12px" class="muted">Note: ${esc(i.note)}</div>` : ''}
      <div style="margin-top:22px;text-align:center" class="muted">${esc(s.invoice_footer || '')}</div>
    </div>
    <div class="glass card section no-print">
      <h3 class="secret">For you only (not printed)</h3>
      <div class="kpis secret"><div class="secret">${kpi('Cost incl. transport', inr2(i.cost_total), '')}</div><div class="secret">${kpi('Profit', inr2(i.profit), i.cost_total ? `${Math.round(i.profit / i.cost_total * 1000) / 10}% on cost` : '', i.profit >= 0 ? 'pos' : 'neg')}</div></div>
      ${i.payments.length ? `<h3 class="section">Payments</h3><table class="t">${i.payments.map(p => `<tr><td>${fmtDate(p.date)}</td><td>${esc(p.mode || '')}</td><td>${esc(p.note || '')}</td><td class="n">${inr2(p.amount)}</td></tr>`).join('')}</table>` : ''}
    </div>`;
  window._inv = i;
  if (store.get('hk_print_next', null) == i.id) { store.set('hk_print_next', null); setTimeout(() => window.print(), 300); }
}
window.shareBill = function () {
  const i = window._inv, s = i.shop;
  const lines = i.items.map(it => `• ${it.name} × ${it.qty} — ₹${it.line_total.toLocaleString('en-IN')}`).join('\n');
  const msg = `*${s.shop_name}*\nBill ${i.number} · ${fmtDate(i.date)}\n\n${lines}\n\nOriginal price: ₹${i.original_total.toLocaleString('en-IN')}\nDiscount: −₹${i.discount_total.toLocaleString('en-IN')}\n*Total: ₹${i.total.toLocaleString('en-IN')}*` +
    (i.due > 0 ? `\nPaid: ₹${i.paid.toLocaleString('en-IN')}\n*Due: ₹${i.due.toLocaleString('en-IN')}*` : '\nPaid in full ✓') + `\n\n${s.invoice_footer || ''}`;
  let ph = (i.customer_phone || '').replace(/\D/g, ''); if (ph.length === 10) ph = '91' + ph;
  window.open(`https://wa.me/${ph}?text=${encodeURIComponent(msg)}`, '_blank');
};
window.recordPayment = async (id, due) => {
  const v = prompt(`Amount received (due ${inr2(due)})`, due);
  if (v == null || !num(v)) return;
  const mode = prompt('Payment mode (Cash / UPI / Card / Bank)', 'Cash') || 'Cash';
  try { await sapi(`/api/shop/invoices/${id}/payments`, {body: {amount: num(v), mode}}); toast('Payment recorded ✓'); invoicePage(id); } catch (e) { fail(e); }
};
window.voidBill = async id => {
  if (!confirm('Cancel this bill? All its items go back into stock and it stops counting in sales.')) return;
  try { await sapi(`/api/shop/invoices/${id}/void`, {body: {}}); toast('Bill cancelled, stock restored'); invoicePage(id); } catch (e) { fail(e); }
};

// ================================================================ customers
async function customersPage() {
  const list = await sapi('/api/shop/customers');
  view.innerHTML = `<div class="toolbar"><h2>Customers</h2></div><div class="glass card">${list.length ? `<div class="table-wrap"><table class="t">
    <tr><th>Name</th><th>Phone</th><th class="n">Bills</th><th class="n">Total bought</th><th class="n">Owes you</th><th>Last bill</th></tr>
    ${list.map(c => `<tr class="click" onclick="go('bills','');setTimeout(()=>{$('blQ').value=${esc(JSON.stringify(c.phone || c.name))};$('blQ').oninput()},50)">
      <td>${esc(c.name)}</td><td>${esc(c.phone || '')}</td><td class="n">${c.bills}</td><td class="n">${inr2(c.spent)}</td>
      <td class="n ${c.due > 0 ? 'neg' : ''}"><b>${c.due > 0 ? inr2(c.due) : '—'}</b></td><td>${fmtDate(c.last_bill)}</td></tr>`).join('')}
  </table></div>` : '<div class="empty">Customers are saved automatically when you enter a phone number on a bill.</div>'}</div>`;
}

// ================================================================ finance
async function financePage() {
  const t = today(), y = t.slice(0, 4), m = t.slice(0, 7);
  const lm = new Date(t); lm.setDate(0);
  const lmEnd = lm.toISOString().slice(0, 10), lmStart = lmEnd.slice(0, 8) + '01';
  const fyStart = (+t.slice(5, 7) >= 4 ? y : y - 1) + '-04-01';
  const r0 = store.get('hk_fin_range', {frm: m + '-01', to: t});
  view.innerHTML = `<div class="toolbar"><h2>Finance</h2>
      <select id="fPre"><option value="">Custom</option><option value="${t}|${t}">Today</option><option value="${m}-01|${t}">This month</option>
        <option value="${lmStart}|${lmEnd}">Last month</option><option value="${fyStart}|${t}">This financial year</option><option value="2000-01-01|${t}">All time</option></select>
      <input type="date" id="fF" value="${r0.frm}"><input type="date" id="fT" value="${r0.to}">
      <button class="ghost" onclick="openExpense()">+ Expense</button></div>
    <div id="fBody">Loading…</div>`;
  const load = async () => {
    const frm = $('fF').value, to = $('fT').value; store.set('hk_fin_range', {frm, to});
    const [r, ex] = await Promise.all([sapi(`/api/shop/report?frm=${frm}&to=${to}`), sapi(`/api/shop/expenses?frm=${frm}&to=${to}`)]);
    $('fBody').innerHTML = `
      <div class="kpis">
        ${kpi('Sales', inr2(r.sales), `${r.bills} bills${r.tax_collected ? ` · +${inr(r.tax_collected)} tax` : ''}`)}
        ${kpi('Cost of goods sold', inr2(r.cogs), 'incl. transport')}
        ${kpi('Gross profit', inr2(r.gross_profit), `${r.gross_margin_pct}% on cost`, r.gross_profit >= 0 ? 'pos' : 'neg')}
        ${kpi('Expenses', inr2(r.expenses), r.stock_loss ? `+ ${inr(r.stock_loss)} stock loss` : 'rent, bills, salary…')}
        ${kpi('Net profit', inr2(r.net_profit), 'what you actually earned', r.net_profit >= 0 ? 'pos' : 'neg')}
        ${kpi('Discount given', inr2(r.discount_given), 'below original prices')}
      </div>
      <div class="cols2 section">
        <div class="glass card"><h3>Profit & loss</h3><table class="t">
          <tr><td>Sales (before tax)</td><td class="n">${inr2(r.sales)}</td></tr>
          <tr><td>− Cost of goods sold (purchase price + transport)</td><td class="n">${inr2(r.cogs)}</td></tr>
          <tr><td><b>Gross profit</b></td><td class="n"><b>${inr2(r.gross_profit)}</b></td></tr>
          ${r.expenses_by_category.map(e => `<tr><td class="mute">− ${esc(e.category)}</td><td class="n mute">${inr2(e.amount)}</td></tr>`).join('')}
          ${r.stock_loss ? `<tr><td class="mute">− Damaged / lost stock</td><td class="n mute">${inr2(r.stock_loss)}</td></tr>` : ''}
          <tr><td><b>Net profit</b></td><td class="n ${r.net_profit >= 0 ? 'pos' : 'neg'}"><b>${inr2(r.net_profit)}</b></td></tr>
        </table></div>
        <div class="glass card"><h3>Cash in & out</h3><table class="t">
          <tr><td>Money received from customers</td><td class="n pos">+ ${inr2(r.collected)}</td></tr>
          <tr><td>Stock bought</td><td class="n neg">− ${inr2(r.purchases_goods)}</td></tr>
          <tr><td>Transportation on purchases</td><td class="n neg">− ${inr2(r.purchases_transport)}</td></tr>
          <tr><td>Expenses</td><td class="n neg">− ${inr2(r.expenses)}</td></tr>
          <tr><td><b>Net cash flow</b></td><td class="n ${r.cash_flow >= 0 ? 'pos' : 'neg'}"><b>${inr2(r.cash_flow)}</b></td></tr>
        </table><div class="hint section">Cash flow is lower than profit when you buy stock you haven’t sold yet, or customers still owe you.</div></div>
      </div>
      <div class="glass card section"><h3>Profit by product</h3>${r.by_product.length ? `<div class="table-wrap"><table class="t">
        <tr><th>Product</th><th class="n">Sold</th><th class="n">Sales</th><th class="n">Cost</th><th class="n">Profit</th><th class="n">Margin</th></tr>
        ${r.by_product.map(p => `<tr class="click" onclick="go('pi','${p.product_id}')"><td>${esc(p.name)}</td><td class="n">${p.qty}</td><td class="n">${inr2(p.sales)}</td>
          <td class="n">${inr2(p.cost)}</td><td class="n ${p.profit >= 0 ? 'pos' : 'neg'}">${inr2(p.profit)}</td><td class="n">${p.margin_pct}%</td></tr>`).join('')}
      </table></div>` : '<div class="hint">No sales in this period.</div>'}</div>
      <div class="glass card section"><div class="row" style="justify-content:space-between"><h3>Expenses</h3><button class="ghost" onclick="openExpense()">+ Add</button></div>
        ${ex.length ? `<table class="t">${ex.map(e => `<tr><td>${fmtDate(e.date)}</td><td>${esc(e.category)}</td><td class="mute">${esc(e.note || '')}</td>
          <td class="n">${inr2(e.amount)}</td><td class="n"><button class="ghost" style="padding:3px 9px" onclick="delExpense(${e.id})">✕</button></td></tr>`).join('')}</table>`
          : '<div class="hint">No expenses recorded in this period.</div>'}</div>
      <div class="glass card section"><h3>Export & backup</h3><div class="row" style="flex-wrap:wrap">
        ${[['invoices', 'Bills'], ['sales_items', 'Items sold'], ['purchases', 'Shipments'], ['expenses', 'Expenses'], ['stock', 'Stock']].map(([k, l]) =>
          `<button class="ghost" onclick="location.href='/api/shop/export/${k}.csv'">${l} (Excel CSV)</button>`).join('')}
        <button onclick="location.href='/api/shop/backup'">Download full backup</button></div>
        <div class="hint section">All your data is in <code>shop.db</code> in the app folder. Keep a backup somewhere safe (Google Drive, pen drive).</div></div>`;
  };
  $('fPre').onchange = () => { const v = $('fPre').value; if (!v) return; const [a, b] = v.split('|'); $('fF').value = a; $('fT').value = b; load(); };
  $('fF').onchange = load; $('fT').onchange = load;
  window._finReload = load;
  await load();
}
window.openExpense = function () {
  let m = $('expModal');
  if (!m) { m = document.createElement('div'); m.className = 'modal-bg'; m.id = 'expModal'; document.body.appendChild(m); }
  m.innerHTML = `<div class="modal glass"><h2>Add expense</h2>
    <label class="fl"><span>Category</span><input type="text" id="eCat" list="eCats" placeholder="Rent, Electricity…"><datalist id="eCats">${S.cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
    <label class="fl"><span>Amount (₹)</span><input type="number" id="eAmt" min="0" step="0.01"></label>
    <label class="fl"><span>Date</span><input type="date" id="eDate" value="${today()}"></label>
    <label class="fl"><span>Note</span><input type="text" id="eNote" placeholder="optional"></label>
    <div class="err" id="eErr"></div>
    <button onclick="saveExpense()">Save</button><button class="ghost" onclick="$('expModal').classList.remove('open')">Cancel</button></div>`;
  requestAnimationFrame(() => { m.classList.add('open'); $('eCat').focus(); });
};
window.saveExpense = async () => {
  if (!$('eCat').value.trim() || !num($('eAmt').value)) { $('eErr').textContent = 'Enter a category and amount'; return; }
  try {
    await sapi('/api/shop/expenses', {body: {category: $('eCat').value.trim(), amount: num($('eAmt').value), date: $('eDate').value, note: $('eNote').value || null}});
    $('expModal').classList.remove('open'); toast('Expense saved ✓');
    if (window._finReload && $('fBody')) window._finReload(); else if (location.hash === '#shop') dashboard();
  } catch (e) { $('eErr').textContent = e.message; }
};
window.delExpense = async id => { if (!confirm('Delete this expense?')) return; await sapi('/api/shop/expenses/' + id, {method: 'DELETE'}); window._finReload(); };

// ================================================================ catalogue (admin)
async function catalogPage() {
  const [items, info] = await Promise.all([sapi('/api/catalog/items'), isCashier() ? Promise.resolve(null) : sapi('/api/catalog/settings')]);
  const host = location.hostname === 'localhost' ? '127.0.0.1' : location.hostname;
  view.innerHTML = `
    <div class="toolbar"><h2>Customer catalogue</h2>
      <span class="owner-only row"><button onclick="catAddFromInventory()">＋ From inventory</button>
      <button class="ghost" onclick="catAddOnline()">＋ From Amazon / online</button>
      <button class="ghost" onclick="catEdit()">＋ Manual item</button></span></div>
    <div class="glass card"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:10px">
      <div><b>Customer website:</b> <code>http://${esc(host === '127.0.0.1' ? 'YOUR-PC-IP' : host)}:8080</code>
        <div class="hint">Separate website, run by <code>catalog_app.py</code>. It only ever sees the items below: titles, pictures, your price and the Amazon price. Never your costs, stock counts or bills.</div></div>
      ${info ? `<label class="row hint"><input type="checkbox" id="catOpen" ${info.open === '1' ? 'checked' : ''}> Taking orders</label>` : ''}</div>
      ${info ? `<div class="form section owner-only">
        <label><span>Headline on the catalogue</span><input type="text" id="ciTag" maxlength="140" value="${esc(info.tagline)}"></label>
        <label><span>Phone shown to customers</span><input type="text" id="ciPhone" maxlength="20" value="${esc(info.phone)}"></label>
        <label class="wide"><span>Address shown to customers</span><input type="text" id="ciAddr" maxlength="200" value="${esc(info.address)}"></label>
        <div><button class="ghost" onclick="catSaveInfo()">Save catalogue details</button></div></div>` : ''}
    </div>
    <div class="glass card section" id="catEditor" style="display:none"></div>
    <div class="glass card section">${items.length ? `<div class="table-wrap"><table class="t">
      <tr><th></th><th>Item</th><th class="n">Amazon price</th><th class="n">Your price</th><th class="n">Customer saves</th><th>Stock</th><th>Shown</th><th></th></tr>
      ${items.map(i => `<tr>
        <td>${i.image ? `<img class="thumb" src="${esc(i.image)}" alt="">` : ''}</td>
        <td>${esc(i.title)}${i.badge ? ` <span class="pill">${esc(i.badge)}</span>` : ''}
          <div class="hint">${i.product ? `linked to inventory · ${i.product.stock} in stock · min ${inr(i.product.min_price)}` : 'not in inventory (available on request)'}</div>
          ${i.below_min ? '<div class="warn">below your minimum price — billing will be blocked</div>' : ''}</td>
        <td class="n">${i.compare_price ? `<s>${inr(i.compare_price)}</s><div class="hint">${esc(i.compare_store || '')}</div>` : '—'}</td>
        <td class="n"><b>${inr(i.our_price)}</b></td>
        <td class="n">${i.compare_price > i.our_price ? `<span class="pos">${inr(i.compare_price - i.our_price)} (${Math.round((1 - i.our_price / i.compare_price) * 100)}%)</span>` : '<span class="warn">not cheaper</span>'}</td>
        <td>${i.in_stock ? '<span class="pill paid">in stock</span>' : '<span class="pill">on request</span>'}</td>
        <td>${i.visible ? 'Yes' : '<span class="hint">hidden</span>'}</td>
        <td class="n owner-only"><button class="ghost" style="padding:4px 10px" onclick="catEdit(${i.id})">Edit</button>
          ${i.bh_path ? `<button class="ghost" style="padding:4px 10px" title="Fetch Amazon's current price" onclick="catRefresh(${i.id}, this)">↻</button>` : ''}
          <button class="ghost" style="padding:4px 10px" onclick="catDelete(${i.id})">✕</button></td></tr>`).join('')}
    </table></div>` : '<div class="empty">Nothing in the catalogue yet. Add items from your inventory or straight from Amazon.</div>'}</div>`;
  window._cat = items;
  const pre = store.get('hk_cat_preset', null);       // picked on a price-tracker product page
  if (pre && !isCashier()) { store.set('hk_cat_preset', null); catEdit(null, pre); }
  if ($('catOpen')) $('catOpen').onchange = async () => { await sapi('/api/catalog/settings', {method: 'PUT', body: {open: $('catOpen').checked}}).catch(fail); toast($('catOpen').checked ? 'Taking orders' : 'Orders paused'); };
}
window.catSaveInfo = async () => {
  try { await sapi('/api/catalog/settings', {method: 'PUT', body: {tagline: $('ciTag').value, phone: $('ciPhone').value, address: $('ciAddr').value}}); toast('Saved ✓'); }
  catch (e) { fail(e); }
};
window.catEdit = function (id, preset) {
  const it = id ? window._cat.find(x => x.id === id) : (preset || {});
  const box = $('catEditor'); box.style.display = '';
  box.innerHTML = `<h3>${id ? 'Edit catalogue item' : 'New catalogue item'}</h3>
    <div class="form">
      <label class="wide"><span>Title customers see</span><input type="text" id="ceTitle" maxlength="160" value="${esc(it.title || '')}"></label>
      <label><span>Your price (₹)</span><input type="number" id="cePrice" min="1" step="1" value="${it.our_price ?? ''}"></label>
      <label><span>Amazon price (₹, shown crossed out)</span><input type="number" id="ceCmp" min="0" step="1" value="${it.compare_price ?? ''}"></label>
      <label><span>Compared with</span><input type="text" id="ceStore" maxlength="40" value="${esc(it.compare_store || 'Amazon')}"></label>
      <label><span>Badge (optional)</span><input type="text" id="ceBadge" maxlength="30" placeholder="e.g. Bestseller" value="${esc(it.badge || '')}"></label>
      <label><span>Category</span><input type="text" id="ceCat" maxlength="60" value="${esc(it.category || '')}"></label>
      <label><span>Link to inventory product</span><select id="ceProd"><option value="">— not in inventory —</option></select></label>
      <label class="wide"><span>Picture link (https://…)</span><input type="text" id="ceImg" maxlength="1000" value="${esc(it.image || '')}"></label>
      <label class="wide"><span>Short description (optional)</span><input type="text" id="ceDesc" maxlength="600" value="${esc(it.description || '')}"></label>
      <label class="row hint"><input type="checkbox" id="ceVis" ${it.visible === 0 ? '' : 'checked'}> Show to customers</label>
    </div>
    <div class="row section"><button onclick="catSave(${id || 'null'})">Save</button><button class="ghost" onclick="$('catEditor').style.display='none'">Cancel</button>
      <span class="hint" id="ceHint"></span></div>`;
  box.dataset.bh = it.bh_path || '';
  sapi('/api/shop/products').then(list => {
    $('ceProd').innerHTML = '<option value="">— not in inventory —</option>' + list.map(p =>
      `<option value="${p.id}" ${p.id === it.product_id ? 'selected' : ''}>${esc(p.name)} (${p.stock} in stock, min ${inr(p.min_price)})</option>`).join('');
  });
  const hint = () => { const a = num($('ceCmp').value), b = num($('cePrice').value);
    $('ceHint').textContent = a && b ? (a > b ? `Customers see: “Price on ${$('ceStore').value || 'Amazon'} ${inr(a)}” cut → “We are giving at ${inr(b)}”, saving ${inr(a - b)}` : 'Your price isn’t below the Amazon price — no “price cut” banner will show') : ''; };
  ['ceCmp', 'cePrice', 'ceStore'].forEach(k => $(k).oninput = hint); hint();
  box.scrollIntoView({behavior: 'smooth'});
};
window.catSave = async function (id) {
  const body = {title: $('ceTitle').value.trim(), our_price: num($('cePrice').value), compare_price: $('ceCmp').value === '' ? null : num($('ceCmp').value),
    compare_store: $('ceStore').value || null, badge: $('ceBadge').value || null, category: $('ceCat').value || null,
    image: $('ceImg').value.trim() || null, description: $('ceDesc').value || null, visible: $('ceVis').checked,
    product_id: $('ceProd').value ? +$('ceProd').value : null, bh_path: $('catEditor').dataset.bh || null};
  if (!body.title || !body.our_price) return toast('Enter a title and your price', true);
  try { await sapi('/api/catalog/items' + (id ? '/' + id : ''), {method: id ? 'PUT' : 'POST', body}); toast('Catalogue updated ✓'); catalogPage(); }
  catch (e) { fail(e); }
};
window.catDelete = async id => { if (!confirm('Remove this item from the customer catalogue?')) return; await sapi('/api/catalog/items/' + id, {method: 'DELETE'}).catch(fail); catalogPage(); };
window.catRefresh = async (id, btn) => { btn.disabled = true; btn.textContent = '…';
  try { const r = await sapi(`/api/catalog/items/${id}/refresh`, {body: {}}); toast(r.compare_price ? `Amazon price now ${inr(r.compare_price)}` : 'Amazon price not found'); catalogPage(); }
  catch (e) { fail(e); btn.disabled = false; btn.textContent = '↻'; } };
window.addToCatalogue = async function (pid) {
  try { await sapi('/api/catalog/from-product/' + pid, {body: {}}); toast('Added to the customer catalogue ✓'); go('catalogue'); } catch (e) { fail(e); }
};
window.catAddFromInventory = async function () {
  const list = (await sapi('/api/shop/products')).filter(p => !window._cat.some(c => c.product_id === p.id));
  const box = $('catEditor'); box.style.display = '';
  box.innerHTML = `<h3>Add from inventory</h3>${list.length ? `<table class="t">${list.map(p => `<tr><td>${p.image ? `<img class="thumb" src="${esc(p.image)}" alt="">` : ''}</td>
    <td>${esc(p.name)}<div class="hint">${p.stock} in stock · asking ${inr(p.list_price)}${p.market_low ? ` · online ${inr(p.market_low)} (${esc(p.market_site || '')})` : ''}</div></td>
    <td class="n"><button class="ghost" style="padding:4px 10px" onclick="addToCatalogue(${p.id})">Add</button></td></tr>`).join('')}</table>`
    : '<div class="hint">All inventory products are already in the catalogue.</div>'}
    <div class="row section"><button class="ghost" onclick="$('catEditor').style.display='none'">Close</button></div>`;
};
window.catAddOnline = function () {
  const box = $('catEditor'); box.style.display = '';
  box.innerHTML = `<h3>Add from Amazon / online</h3><div class="row"><input type="text" id="coQ" placeholder="Search a product or paste an Amazon / Flipkart link">
    <button onclick="catOnlineSearch()">Search</button></div><div id="coRes" class="section"></div>`;
  $('coQ').onkeydown = e => { if (e.key === 'Enter') catOnlineSearch(); }; $('coQ').focus();
};
window.catOnlineSearch = async function () {
  const q = $('coQ').value.trim(); if (!q) return;
  $('coRes').innerHTML = '<div class="hint">Searching…</div>';
  try {
    if (/^https?:\/\//i.test(q)) return catOnlinePick({url: q});
    const list = (await sapi('/api/search?q=' + encodeURIComponent(q))).slice(0, 10);
    window._co = list;
    $('coRes').innerHTML = list.length ? `<table class="t">${list.map((x, i) => `<tr><td><img class="thumb" src="${esc(x.image)}" alt=""></td><td>${esc(x.name)}</td>
      <td class="n">${inr(x.price)}</td><td class="n"><button class="ghost" style="padding:4px 10px" onclick="catOnlinePick({path: window._co[${i}].path})">Use this</button></td></tr>`).join('')}</table>` : '<div class="hint">No results.</div>';
  } catch (e) { $('coRes').innerHTML = `<div class="warn">${esc(e.message)}</div>`; }
};
window.catOnlinePick = async function (ref) {
  $('coRes').innerHTML = '<div class="hint">Getting Amazon and other store prices…</div>';
  try {
    const r = await sapi('/api/catalog/lookup', {body: ref});
    catEdit(null, {title: r.title, image: r.image, compare_price: r.compare_price, compare_store: r.compare_store || 'Amazon', bh_path: r.bh_path});
    if (!r.compare_price) toast('Amazon price not found for this product — you can type it in', true);
  } catch (e) { $('coRes').innerHTML = `<div class="warn">${esc(e.message)}</div>`; }
};
window.catalogueFromPage = function () {
  const p = current, m = marketFromPage(p);
  const amz = (m.market_stores || []).find(x => (x.site || '').toLowerCase().startsWith('amazon'));
  store.set('hk_cat_preset', {title: p.name, image: p.image, compare_price: amz ? amz.price : m.market_low,
    compare_store: amz ? 'Amazon' : m.market_site, bh_path: p.page});
  go('catalogue');
};

// ================================================================ customer orders (from the catalogue website)
async function ordersPage() {
  const f = store.get('hk_orders_f', 'new');
  const list = await sapi('/api/catalog/orders' + (f ? '?status=' + f : ''));
  view.innerHTML = `<div class="toolbar"><h2>Customer orders</h2>
    <select id="ordF"><option value="new" ${f === 'new' ? 'selected' : ''}>New</option><option value="billed" ${f === 'billed' ? 'selected' : ''}>Billed</option>
      <option value="rejected" ${f === 'rejected' ? 'selected' : ''}>Rejected</option><option value="" ${f === '' ? 'selected' : ''}>All</option></select></div>
    <div class="glass card">${list.length ? `<div class="table-wrap"><table class="t">
      <tr><th>Ref</th><th>Customer</th><th>Received</th><th class="n">Items</th><th class="n">Total</th><th>Status</th></tr>
      ${list.map(o => `<tr class="click" onclick="go('o','${o.id}')"><td><b>${esc(o.ref)}</b>${o.seen ? '' : ' <span class="badge">new</span>'}</td>
        <td>${esc(o.name)}<div class="hint">${esc(o.phone)}</div></td><td>${esc((o.created_at || '').replace('T', ' ').slice(0, 16))}</td>
        <td class="n">${o.lines}</td><td class="n">${inr(o.total)}</td>
        <td><span class="pill ${o.status === 'billed' ? 'paid' : o.status === 'new' ? 'due' : 'void'}">${esc(o.status)}</span>${o.invoice_number ? ` <span class="hint">${esc(o.invoice_number)}</span>` : ''}</td></tr>`).join('')}
    </table></div>` : `<div class="empty">No ${f || ''} orders.</div>`}</div>`;
  $('ordF').onchange = () => { store.set('hk_orders_f', $('ordF').value); ordersPage(); };
  refreshOrderBadge();
}
async function orderPage(id) {
  const o = await sapi('/api/catalog/orders/' + id);
  const ok = o.items.every(i => i.can_bill);
  let ph = (o.phone || '').replace(/\D/g, ''); if (ph.length === 10) ph = '91' + ph;
  view.innerHTML = `<div class="toolbar"><h2>Order ${esc(o.ref)}</h2>
      ${o.status === 'new' ? `<button onclick="orderToBill(${o.id})" ${ok ? '' : 'disabled'}>Create bill</button>
        <button class="ghost" onclick="orderStatus(${o.id}, 'rejected')">Reject</button>` : `<button class="ghost" onclick="orderStatus(${o.id}, 'new')">Re-open</button>`}
      <a href="https://wa.me/${esc(ph)}" target="_blank" rel="noopener"><button class="ghost">WhatsApp</button></a>
      <a href="tel:${esc(o.phone)}"><button class="ghost">Call</button></a></div>
    <div class="kpis">${kpi('Customer', esc(o.name), esc(o.phone))}${kpi('Status', esc(o.status), o.invoice_number ? 'bill ' + esc(o.invoice_number) : esc((o.created_at || '').slice(0, 16)))}
      ${kpi('Total asked', inr(o.total), `${o.items.length} item(s)`)}</div>
    ${o.address || o.note ? `<div class="glass card section">${o.address ? `<div><b>Address:</b> ${esc(o.address)}</div>` : ''}${o.note ? `<div><b>Note:</b> ${esc(o.note)}</div>` : ''}</div>` : ''}
    <div class="glass card section"><table class="t">
      <tr><th>Item</th><th class="n">Qty</th><th class="n">Catalogue price</th><th class="n">Amount</th><th>Availability</th></tr>
      ${o.items.map(i => `<tr><td>${esc(i.title)}</td><td class="n">${i.qty}</td><td class="n">${inr(i.price)}</td><td class="n">${inr(i.qty * i.price)}</td>
        <td>${i.product_id == null ? '<span class="warn">not linked to inventory — link it in Catalogue, or receive stock</span>'
          : i.can_bill ? `<span class="pos">✓ ${i.stock} in stock</span>` : `<span class="warn">only ${i.stock} in stock</span>`}</td></tr>`).join('')}
    </table>${ok ? '' : '<div class="hint section">You can bill once every item is linked to inventory and in stock.</div>'}</div>`;
  window._order = o;
  refreshOrderBadge();
}
window.orderToBill = function () {
  const o = window._order;
  store.set('hk_bill_draft', {id: o.id, ref: o.ref, note: o.note ? `Order ${o.ref}: ${o.note}` : `Order ${o.ref}`,
    customer: {name: o.name, phone: o.phone, address: o.address},
    lines: o.items.map(i => ({product_id: i.product_id, qty: i.qty, price: i.price}))});
  go('bill');
};
window.orderStatus = async (id, status) => {
  if (status === 'rejected' && !confirm('Reject this order? The customer will see it as “could not be fulfilled”.')) return;
  try { await sapi(`/api/catalog/orders/${id}/status`, {body: {status}}); toast('Order updated'); orderPage(id); } catch (e) { fail(e); }
};
async function refreshOrderBadge() {
  try {
    const {new: n} = await sapi('/api/catalog/orders/count');
    const b = $('ordBadge'); if (b) { b.textContent = n; b.style.display = n ? '' : 'none'; }
    if (n > (refreshOrderBadge.last ?? n)) toast(`🛎 New customer order (${n} waiting)`);
    refreshOrderBadge.last = n;
  } catch (e) {}
}

// ================================================================ settings
async function settingsPage() {
  await loadSettings();
  const s = S.settings;
  const shopSec = isOwner() ? `<div class="glass card"><h3>Your shop (printed on bills)</h3><div class="form">
      <label><span>Shop name</span><input type="text" id="sName" value="${esc(s.shop_name)}"></label>
      <label><span>Phone</span><input type="text" id="sPhone" value="${esc(s.phone)}"></label>
      <label><span>Email</span><input type="text" id="sEmail" value="${esc(s.email)}"></label>
      <label><span>GSTIN (optional)</span><input type="text" id="sGst" value="${esc(s.gstin)}"></label>
      <label class="wide"><span>Address</span><input type="text" id="sAddr" value="${esc(s.address)}"></label>
      <label class="wide"><span>Bill footer</span><input type="text" id="sFoot" value="${esc(s.invoice_footer)}"></label></div></div>
    <div class="glass card section"><h3>Rules</h3><div class="form">
      <label><span>Minimum profit margin % (on cost incl. transport)</span><input type="number" id="sMargin" min="0" step="0.5" value="${esc(s.min_margin_pct)}"></label>
      <label><span>Bill number prefix</span><input type="text" id="sPrefix" value="${esc(s.invoice_prefix)}"></label>
      <label><span>Default GST / tax % on bills</span><input type="number" id="sTax" min="0" step="0.01" value="${esc(s.default_tax_pct)}"></label></div>
      <div class="hint section">With ${esc(s.min_margin_pct)}%: an item that cost ₹1,000 + ₹50 transport can’t be billed below ₹${floorPrice(1050).toLocaleString('en-IN')}.</div>
      <div class="row section"><button onclick="saveSettings()">Save settings</button></div></div>` : '';
  view.innerHTML = `<div class="toolbar"><h2>Settings</h2></div>${shopSec}
    <div class="glass card section"><h3>My account</h3>
      <div class="hint">Signed in as <b>${esc(ME.username)}</b> (${esc(ME.role)}).</div>
      <div class="form section">
        <label><span>Current password</span><input type="password" id="pwCur" autocomplete="current-password"></label>
        <label><span>New password (12+ chars, upper, lower, digit, symbol)</span><input type="password" id="pwNew" autocomplete="new-password"></label>
        <label><span>Repeat new password</span><input type="password" id="pwNew2" autocomplete="new-password"></label></div>
      <div class="row section"><button class="ghost" onclick="changePw()">Change password</button><span class="hint">You'll be signed out everywhere.</span></div></div>
    ${isOwner() ? `<div class="glass card section" id="usersBox"><h3>Accounts</h3><div class="hint">Loading…</div></div>` : ''}`;
  if (isOwner()) loadUsers();
}
async function loadUsers() {
  const [users, log] = await Promise.all([sapi('/api/auth/users'), sapi('/api/auth/log')]);
  $('usersBox').innerHTML = `<h3>Accounts</h3><table class="t">
    <tr><th>User ID</th><th>Role</th><th>Last sign-in</th><th></th></tr>
    ${users.map(u => `<tr><td><code>${esc(u.username)}</code></td><td>${esc(u.role)}</td><td>${esc((u.last_login || '—').replace('T', ' '))}${u.locked ? ' <span class="pill low">locked</span>' : ''}</td>
      <td class="n">${u.locked ? `<button class="ghost" style="padding:4px 10px" onclick="unlockUser(${u.id})">Unlock</button>` : ''}
        ${u.username !== ME.username ? `<button class="ghost" style="padding:4px 10px" onclick="resetUser(${u.id}, '${esc(u.username)}')">Set new password</button>` : ''}</td></tr>`).join('')}
  </table>
  <h3 class="section">Recent sign-in attempts</h3><div class="table-wrap" style="max-height:260px;overflow:auto"><table class="t">
    ${log.map(l => `<tr><td>${esc(l.at)}</td><td><code>${esc(l.username || '')}</code></td><td>${esc(l.ip || '')}</td>
      <td>${l.ok ? '<span class="pos">signed in</span>' : `<span class="neg">${l.note === 'locked' ? 'blocked (locked)' : 'wrong password'}</span>`}</td></tr>`).join('')}</table></div>`;
}
window.changePw = async () => {
  if ($('pwNew').value !== $('pwNew2').value) return toast('New passwords don’t match', true);
  try { await sapi('/api/auth/password', {body: {current: $('pwCur').value, new: $('pwNew').value}}); alert('Password changed. Please sign in again.'); location.href = '/login'; }
  catch (e) { fail(e); }
};
window.resetUser = async (id, name) => {
  const pw = prompt(`New password for ${name}\n(12+ chars with upper, lower, digit and symbol)`);
  if (!pw) return;
  try { await sapi(`/api/auth/users/${id}/reset`, {body: {new: pw}}); toast('Password set — that account was signed out'); loadUsers(); } catch (e) { fail(e); }
};
window.unlockUser = async id => { await sapi(`/api/auth/users/${id}/unlock`, {body: {}}).catch(fail); toast('Unlocked'); loadUsers(); };
window.saveSettings = async () => {
  try {
    await sapi('/api/shop/settings', {method: 'PUT', body: {shop_name: $('sName').value, phone: $('sPhone').value, email: $('sEmail').value,
      gstin: $('sGst').value, address: $('sAddr').value, invoice_footer: $('sFoot').value,
      min_margin_pct: num($('sMargin').value), invoice_prefix: $('sPrefix').value || 'INV-', default_tax_pct: num($('sTax').value)}});
    toast('Settings saved ✓'); settingsPage();
  } catch (e) { fail(e); }
};

// ================================================================ boot
(async function boot() {
  try { ME = await sapi('/api/auth/me'); } catch (e) { location.href = '/login'; return; }
  document.body.classList.add('role-' + ME.role);
  const nav = document.createElement('div');
  nav.className = 'shopnav on'; nav.id = 'shopnav';
  nav.innerHTML = `<div class="in">${SHOP_TABS.filter(([r]) => tabAllowed(r)).map(([r, l]) => `<button data-r="${r}" onclick="go('${r}')">${l}${
    r === 'cart' ? '<span class="badge" id="cartBadge2"></span>' : r === 'orders' ? '<span class="badge" id="ordBadge" style="display:none"></span>' : ''}</button>`).join('')}</div>`;
  document.querySelector('header').after(nav);
  // user chip with sign-out
  const u = document.createElement('button');
  u.className = 'ghost userchip'; u.title = 'Signed in as ' + ME.username;
  u.innerHTML = `<span class="who">${esc(ME.role)}</span> Sign out`;
  u.onclick = async () => { await fetch('/api/auth/logout', {method: 'POST'}); location.href = '/login'; };
  $('themeBtn').after(u);
  if (isCashier()) { ['tabAlerts', 'authBtn', 'tabShop'].forEach(id => { const el = $(id); if (el) el.style.display = 'none'; }); }
  updateCartBadge();
  const b2 = () => { const n = cart.items.reduce((a, i) => a + (num(i.qty) || 0), 0); const b = $('cartBadge2'); if (b) { b.textContent = n; b.style.display = n ? '' : 'none'; } };
  const orig = updateCartBadge; updateCartBadge = () => { orig(); b2(); }; b2();
  const fit = () => { nav.style.top = document.querySelector('header').offsetHeight + 'px'; };
  fit(); addEventListener('resize', fit);
  refreshOrderBadge(); setInterval(refreshOrderBadge, 30000);
  loadSettings().catch(() => {});
  // first screen after sign-in
  const name = location.hash.slice(1).split(':')[0];
  if (!name) go(isCashier() ? 'bill' : 'shop');
  else route();
})();
