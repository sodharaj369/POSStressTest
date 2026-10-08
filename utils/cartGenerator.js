'use strict';

/**
 * cartGenerator.js
 *
 * Generates a normalized cart: [{ name: string, qty: number }]
 *
 * All four product config modes are supported.
 * Mode priority: cartProducts > products > productName (legacy)
 *
 * ─────────────────────────────────────────────────────────────
 * MODE A — Legacy (default, backward-compatible)
 * ─────────────────────────────────────────────────────────────
 * Config:
 *   "productName": "Burger,Juice,Cookie"
 * Behavior:
 *   Picks ONE random product. Qty always 1.
 * Result example:
 *   [{ name: "Burger", qty: 1 }]
 *
 * ─────────────────────────────────────────────────────────────
 * MODE B — Random Product + Random Qty
 * ─────────────────────────────────────────────────────────────
 * Config:
 *   "products": [
 *     { "name": "Burger", "qty": [1,2,3] },
 *     { "name": "Juice",  "qty": [1,2]   }
 *   ]
 * Behavior:
 *   Picks ONE random product. Resolves qty from array or fixed value.
 * Result example:
 *   [{ name: "Burger", qty: 3 }]
 *
 * ─────────────────────────────────────────────────────────────
 * MODE C — Randomized Cart Generation
 * ─────────────────────────────────────────────────────────────
 * Config:
 *   "products": ["Burger","Juice","Cookie","Water"],
 *   "maxProductsPerCart": 3,
 *   "maxQtyPerProduct": 3
 * Behavior:
 *   Randomly determines cart size (1 to maxProductsPerCart).
 *   Randomly selects unique products. Randomly assigns qty.
 * Result example:
 *   [{ name: "Burger", qty: 2 }, { name: "Cookie", qty: 1 }]
 *
 * ─────────────────────────────────────────────────────────────
 * MODE D — Explicit Cart (no randomization)
 * ─────────────────────────────────────────────────────────────
 * Config:
 *   "cartProducts": [
 *     { "name": "Burger", "qty": 2 },
 *     { "name": "Juice",  "qty": 1 }
 *   ]
 * Behavior:
 *   Adds ALL listed products in order, exactly as configured.
 * Result example:
 *   [{ name: "Burger", qty: 2 }, { name: "Juice", qty: 1 }]
 */

const { log } = require('./logger');

/**
 * generateCart(config) → [{ name: string, qty: number }]
 * Reads the config object and returns a normalized cart array.
 */
function generateCart(config) {
  // ── MODE D: Explicit cart — add ALL products in order ───────────────────────
  if (config.cartProducts && Array.isArray(config.cartProducts) && config.cartProducts.length > 0) {
    const cart = config.cartProducts.map(p => ({
      name: p.name,
      qty: resolveQty(p.qty)
    }));
    _logCart('Explicit Cart', cart);
    return cart;
  }

  // ── products array (Modes B and C) ──────────────────────────────────────────
  if (config.products && Array.isArray(config.products) && config.products.length > 0) {
    const firstItem = config.products[0];

    // MODE C: products is a string array → randomized cart generation
    if (typeof firstItem === 'string') {
      return _generateRandomCart(config);
    }

    // MODE B: products is an object array → pick ONE random product, resolve qty
    const chosen = config.products[Math.floor(Math.random() * config.products.length)];
    const cart = [{ name: chosen.name, qty: resolveQty(chosen.qty) }];
    _logCart('Random Product + Qty', cart);
    return cart;
  }

  // ── MODE A: legacy productName string ────────────────────────────────────────
  const names = (config.productName || 'test for')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  const name = names[Math.floor(Math.random() * names.length)];
  const cart = [{ name, qty: 1 }];
  _logCart('Legacy (productName)', cart);
  return cart;
}

/**
 * getCartCandidates(config) → [cart, cart, ...]
 * Ordered, de-duplicated list of carts to try for ONE child.
 * First entry is exactly what generateCart() picks (normal flow unchanged).
 * Extra entries are single-product fallbacks from the configured pool, used only
 * when earlier candidates are allergen-restricted. Explicit cart (MODE D) has no fallbacks.
 */
function getCartCandidates(config) {
  const first = generateCart(config);
  const candidates = [first];

  if (config.cartProducts && Array.isArray(config.cartProducts) && config.cartProducts.length > 0) {
    return candidates;
  }

  let pool;
  if (config.products && Array.isArray(config.products) && config.products.length > 0) {
    pool = config.products.map(p => (typeof p === 'string' ? { name: p, qty: 1 } : p));
  } else {
    pool = (config.productName || 'test for')
      .split(',').map(s => s.trim()).filter(s => s.length > 0)
      .map(name => ({ name, qty: 1 }));
  }

  const used = new Set(first.map(i => i.name));
  const rest = pool.filter(p => !used.has(p.name)).sort(() => Math.random() - 0.5);
  for (const p of rest) {
    if (used.has(p.name)) continue;
    used.add(p.name);
    candidates.push([{ name: p.name, qty: resolveQty(p.qty) }]);
  }
  return candidates;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * MODE C implementation: build a randomized cart from a string product pool.
 */
function _generateRandomCart(config) {
  const pool = config.products.map(p => (typeof p === 'string' ? p : p.name));
  const maxProducts = Math.min(config.maxProductsPerCart || 1, pool.length);
  const maxQty     = config.maxQtyPerProduct   || 1;

  // Random cart size between 1 and maxProducts (inclusive)
  const cartSize = Math.floor(Math.random() * maxProducts) + 1;

  // Shuffle pool and pick cartSize unique products
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, cartSize);

  const cart = selected.map(name => ({
    name,
    qty: Math.floor(Math.random() * maxQty) + 1
  }));

  _logCart('Random Cart', cart);
  return cart;
}

/**
 * Resolve a qty value that may be a fixed number or an array of choices.
 */
function resolveQty(qty) {
  if (Array.isArray(qty)) {
    return qty[Math.floor(Math.random() * qty.length)];
  }
  return (typeof qty === 'number' && qty >= 1) ? qty : 1;
}

/**
 * Log the generated cart to the console in a readable format.
 */
function _logCart(mode, cart) {
  log('CART', `Generated Cart [${mode}]`);
  for (const item of cart) {
    log('CART', `  ${item.name} x${item.qty}`);
  }
}

module.exports = { generateCart, getCartCandidates };
