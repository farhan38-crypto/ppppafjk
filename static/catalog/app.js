'use strict';
/* ROYAL TRADING COMPANY — customer catalogue. All text is inserted with textContent (no HTML injection). */
const $ = id => document.getElementById(id);
const rupee = n => '₹' + Math.round(n).toLocaleString('en-IN');
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
let ITEMS = [], INFO = {};
let cart = store.get('rtc_cart', {});        // {itemId: qty}

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2200);
}
function saveCart() {
  // keep only items that still exist
  for (const id of Object.keys(cart)) if (!ITEMS.find(i => i.id == id)) delete cart[id];
  store.set('rtc_cart', cart);
  $('count').textContent = Object.values(cart).reduce((a, b) => a + b, 0);
}

// ------------------------------------------------------------- theme
function themeLabel() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('themeBtn').title = dark ? 'Switch to white' : 'Switch to black';
  $('themeBtn').textContent = dark ? '☀' : '☾';
}
$('themeBtn').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t; try { localStorage.setItem('rtc_theme', t); } catch (e) {} themeLabel();
});
themeLabel();

// ------------------------------------------------------------- catalogue
function card(it) {
  const qty = cart[it.id] || 0;
  const pic = h('div', {class: 'pic'},
    it.image ? h('img', {src: it.image, alt: '', loading: 'lazy', onerror: e => e.target.replaceWith(h('span', {class: 'ph'}, 'RTC'))}) : h('span', {class: 'ph'}, 'RTC'),
    it.save_pct >= 1 ? h('span', {class: 'off'}, `${it.save_pct}% OFF`) : null,
    it.badge ? h('span', {class: 'tag'}, it.badge) : null,
    it.in_stock ? null : h('span', {class: 'oos'}, 'Available on request'));
  const btn = h('button', {class: 'add' + (qty ? ' in' : ''), onclick: () => { cart[it.id] = (cart[it.id] || 0) + 1; saveCart(); render(); toast('Added to cart'); }},
    qty ? `In cart (${qty}) · add more` : 'Add to cart');
  return h('article', {class: 'card'}, pic,
    h('div', {class: 'body'},
      h('div', {class: 'title', title: it.title}, it.title),
      it.compare_price && it.save > 0
        ? h('div', {class: 'amz'}, `Price on ${it.compare_store || 'Amazon'}`, h('span', {class: 'was'}, rupee(it.compare_price)))
        : null,
      h('div', {class: 'ours'}, h('span', {class: 'lbl'}, it.save > 0 ? 'We are giving at' : 'Our price'), h('span', {class: 'price'}, rupee(it.our_price))),
      it.save > 0 ? h('span', {class: 'save'}, `You save ${rupee(it.save)}`) : null,
      btn));
}
function render() {
  const q = $('q').value.trim().toLowerCase(), c = $('cat').value;
  const shown = ITEMS.filter(i => (!q || i.title.toLowerCase().includes(q)) && (!c || i.category === c));
  $('grid').replaceChildren(...shown.map(card));
  $('empty').hidden = shown.length > 0;
}
$('q').addEventListener('input', render);
$('cat').addEventListener('change', render);

async function load() {
  try {
    const [info, items] = await Promise.all([fetch('/api/info').then(r => r.json()), fetch('/api/items').then(r => r.json())]);
    INFO = info; ITEMS = items;
    if (info.tagline) $('tagline').textContent = info.tagline;
    if (info.shop_name) document.title = info.shop_name;
    const cats = [...new Set(items.map(i => i.category).filter(Boolean))].sort();
    $('cat').replaceChildren(h('option', {value: ''}, 'All categories'), ...cats.map(c => h('option', {value: c}, c)));
    $('cat').hidden = cats.length === 0;
    const bits = [];
    if (info.address) bits.push(info.address);
    if (info.phone) bits.push('Call ' + info.phone);
    $('contact').replaceChildren(h('b', {}, info.shop_name || 'Royal Trading Company'), bits.length ? ' · ' + bits.join(' · ') : '');
    saveCart(); render();
  } catch (e) { $('grid').replaceChildren(h('p', {class: 'empty'}, 'Could not load the catalogue. Please refresh.')); }
}

// ------------------------------------------------------------- cart drawer + request
function openDrawer() { $('drawer').classList.add('open'); $('drawer').setAttribute('aria-hidden', 'false'); drawCart(); }
function closeDrawer() { $('drawer').classList.remove('open'); $('drawer').setAttribute('aria-hidden', 'true'); }
$('cartBtn').addEventListener('click', openDrawer);
$('closeCart').addEventListener('click', closeDrawer);
$('drawer').addEventListener('click', e => { if (e.target === $('drawer')) closeDrawer(); });

function drawCart() {
  const lines = Object.entries(cart).map(([id, q]) => ({it: ITEMS.find(i => i.id == id), q})).filter(l => l.it);
  const body = $('cartBody');
  if (!lines.length) { body.replaceChildren(h('p', {class: 'muted'}, 'Your cart is empty.')); return; }
  const total = lines.reduce((a, l) => a + l.q * l.it.our_price, 0);
  const amz = lines.reduce((a, l) => a + l.q * (l.it.save > 0 ? l.it.compare_price : l.it.our_price), 0);
  const step = (id, d) => { cart[id] = Math.max(0, Math.min(20, (cart[id] || 0) + d)); if (!cart[id]) delete cart[id]; saveCart(); drawCart(); render(); };
  const err = h('div', {class: 'err'});
  const form = h('form', {class: 'req', onsubmit: async e => {
      e.preventDefault(); err.textContent = '';
      const btn = form.querySelector('button'); btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const r = await fetch('/api/order', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
          name: form.name.value, phone: form.phone.value, address: form.address.value, note: form.note.value, website: form.website.value,
          items: lines.map(l => ({id: l.it.id, qty: l.q}))})});
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof d.detail === 'string' ? d.detail : (d.detail?.[0]?.msg || 'Please check your details').replace('Value error, ', ''));
        cart = {}; saveCart(); render(); closeDrawer(); store.set('rtc_last', {ref: d.ref, phone: form.phone.value});
        showDone(d.ref, d.total);
      } catch (ex) { err.textContent = ex.message; }
      btn.disabled = false; btn.textContent = 'Send request for bill';
    }},
    h('h2', {}, 'Your details'),
    h('input', {name: 'name', placeholder: 'Your name', required: true, maxlength: 60, autocomplete: 'name'}),
    h('input', {name: 'phone', placeholder: 'Mobile number', required: true, inputmode: 'tel', maxlength: 16, autocomplete: 'tel'}),
    h('input', {name: 'address', placeholder: 'Address (optional)', maxlength: 200, autocomplete: 'street-address'}),
    h('textarea', {name: 'note', placeholder: 'Anything we should know? (optional)', maxlength: 300}),
    h('div', {class: 'hp', 'aria-hidden': 'true'}, h('input', {name: 'website', tabindex: '-1', autocomplete: 'off'})),
    err,
    h('button', {class: 'primary', type: 'submit'}, 'Send request for bill'),
    h('p', {class: 'muted', style: 'font-size:12px;margin:0'}, 'No payment now. We will confirm availability and prepare your bill.'));
  body.replaceChildren(
    ...lines.map(l => h('div', {class: 'line'},
      l.it.image ? h('img', {src: l.it.image, alt: '', onerror: e => { e.target.style.visibility = 'hidden'; }}) : h('span'),
      h('div', {}, h('div', {class: 't'}, l.it.title), h('div', {class: 'muted', style: 'font-size:12px'}, rupee(l.it.our_price) + ' each'),
        h('div', {class: 'qty'}, h('button', {type: 'button', 'aria-label': 'Less', onclick: () => step(l.it.id, -1)}, '−'), h('span', {}, l.q),
          h('button', {type: 'button', 'aria-label': 'More', onclick: () => step(l.it.id, 1)}, '+'))),
      h('b', {}, rupee(l.q * l.it.our_price)))),
    amz > total ? h('div', {class: 'tot'}, h('span', {}, 'On Amazon'), h('s', {}, rupee(amz))) : null,
    amz > total ? h('div', {class: 'tot'}, h('span', {}, 'You save'), h('span', {class: 'deal'}, rupee(amz - total))) : null,
    h('div', {class: 'tot big'}, h('span', {}, 'Total'), h('span', {}, rupee(total))),
    form);
}

// ------------------------------------------------------------- modal: done + tracking
function modal(...kids) { $('modalBody').replaceChildren(...kids); $('modal').classList.add('open'); }
function closeModal() { $('modal').classList.remove('open'); }
$('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
function showDone(ref, total) {
  modal(h('h2', {}, 'Request sent ✓'),
    h('p', {class: 'muted'}, 'Show this reference at the counter, or quote it when we call you.'),
    h('div', {class: 'ref'}, ref),
    h('div', {class: 'tot big'}, h('span', {}, 'Estimated total'), h('span', {}, rupee(total))),
    h('button', {class: 'primary', onclick: closeModal}, 'Done'));
}
$('trackBtn').addEventListener('click', () => {
  const last = store.get('rtc_last', {});
  const err = h('div', {class: 'err'}), out = h('div');
  const f = h('form', {class: 'req', onsubmit: async e => {
      e.preventDefault(); err.textContent = ''; out.replaceChildren();
      try {
        const r = await fetch(`/api/order/${encodeURIComponent(f.ref.value.trim().toUpperCase())}?phone=${encodeURIComponent(f.phone.value)}`);
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || 'Not found');
        const label = {new: 'Received — we are preparing it', billed: 'Bill ready ✓', rejected: 'Could not be fulfilled — please call us'}[d.status] || d.status;
        out.replaceChildren(h('p', {}, h('b', {}, label)),
          ...d.items.map(i => h('div', {class: 'tot'}, h('span', {}, `${i.title} × ${i.qty}`), h('span', {}, rupee(i.qty * i.price)))),
          h('div', {class: 'tot big'}, h('span', {}, 'Total'), h('span', {}, rupee(d.total))));
      } catch (ex) { err.textContent = ex.message; }
    }},
    h('h2', {}, 'Track your request'),
    h('input', {name: 'ref', placeholder: 'Reference e.g. RTC-AB12CD', required: true, value: last.ref || '', maxlength: 12}),
    h('input', {name: 'phone', placeholder: 'Mobile number used', required: true, inputmode: 'tel', value: last.phone || '', maxlength: 16}),
    err, h('button', {class: 'primary', type: 'submit'}, 'Check status'), out,
    h('button', {class: 'link', type: 'button', onclick: closeModal}, 'Close'));
  modal(f);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDrawer(); closeModal(); } });
load();
