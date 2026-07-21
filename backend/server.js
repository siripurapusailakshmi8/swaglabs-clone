const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const products = [
  { id: 1, name: "Sauce Labs Backpack", price: 29.99 },
  { id: 2, name: "Sauce Labs Bike Light", price: 9.99 },
  { id: 3, name: "Sauce Labs Bolt T-Shirt", price: 15.99 }
];

// --- In-memory order storage ---
const ordersById = new Map(); // orderId -> order
const ordersList = []; // most recent appended; can reverse for recent-first output
let orderSeq = 0;

function generateOrderId() {
  orderSeq += 1;
  return `ord_${Date.now()}_${orderSeq}`;
}

// --- Auth helpers ---
const TOKEN_TO_USER = {
  "demo-token": { username: "standard_user", role: "user" },
  "admin-token": { username: "admin_user", role: "admin" }
};

function parseBearerToken(req) {
  const header = req.get('authorization') || req.get('Authorization');
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1]?.trim();
  return token || null;
}

function requireAuth(req, res, next) {
  const token = parseBearerToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const user = TOKEN_TO_USER[token];
  if (!user) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  req.user = user;
  req.token = token;
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }
  return next();
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function roundTo2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function validateOrderPayload(body) {
  const errors = {};

  const customer = body?.customer;
  const items = body?.items;

  if (!customer || typeof customer !== 'object' || Array.isArray(customer)) {
    errors['customer'] = 'Customer is required';
  } else {
    if (!isNonEmptyString(customer.firstName)) errors['customer.firstName'] = 'First name is required';
    if (!isNonEmptyString(customer.lastName)) errors['customer.lastName'] = 'Last name is required';
    if (!isNonEmptyString(customer.address)) errors['customer.address'] = 'Address is required';
    if (!isNonEmptyString(customer.postalCode)) errors['customer.postalCode'] = 'Postal code is required';
  }

  if (!Array.isArray(items) || items.length === 0) {
    errors['items'] = 'At least one item is required';
  } else {
    items.forEach((item, idx) => {
      const base = `items[${idx}]`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors[base] = 'Item must be an object';
        return;
      }
      if (!(Number.isInteger(item.id) || isNonEmptyString(item.id))) errors[`${base}.id`] = 'Item id is required';
      if (!isNonEmptyString(item.name)) errors[`${base}.name`] = 'Item name is required';
      if (!isFiniteNumber(item.price) || item.price < 0) errors[`${base}.price`] = 'Item price must be a non-negative number';
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) errors[`${base}.quantity`] = 'Item quantity must be a positive integer';
    });
  }

  return errors;
}

app.get('/api/products', (req, res) => res.json(products));

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};

  if (username === "standard_user" && password === "secret_sauce") {
    return res.json({ success: true, token: "demo-token", username: "standard_user", role: "user" });
  }

  if (username === "admin_user" && password === "secret_sauce") {
    return res.json({ success: true, token: "admin-token", username: "admin_user", role: "admin" });
  }

  return res.status(401).json({ success: false, message: "Invalid credentials" });
});

// --- Orders endpoints ---

app.post('/api/orders', requireAuth, (req, res) => {
  const body = req.body || {};
  const errors = validateOrderPayload(body);

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ success: false, errors });
  }

  const items = body.items.map((it) => ({
    id: it.id,
    name: String(it.name),
    price: Number(it.price),
    quantity: Number(it.quantity)
  }));

  const subtotal = roundTo2(
    items.reduce((sum, it) => sum + it.price * it.quantity, 0)
  );
  const total = subtotal;

  const order = {
    orderId: generateOrderId(),
    createdAt: new Date().toISOString(),
    customer: {
      firstName: body.customer.firstName.trim(),
      lastName: body.customer.lastName.trim(),
      address: body.customer.address.trim(),
      postalCode: body.customer.postalCode.trim()
    },
    items,
    subtotal,
    total,
    placedBy: {
      username: req.user.username,
      role: req.user.role
    }
  };

  ordersById.set(order.orderId, order);
  ordersList.push(order);

  return res.status(201).json({ success: true, order });
});

app.get('/api/orders/:orderId', requireAuth, (req, res) => {
  const { orderId } = req.params || {};
  const order = ordersById.get(orderId);

  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }

  return res.json({ success: true, order });
});

app.get('/api/admin/orders', requireAuth, requireAdmin, (req, res) => {
  const recent = [...ordersList].reverse().map((o) => ({
    orderId: o.orderId,
    createdAt: o.createdAt,
    total: o.total
  }));

  return res.json(recent);
});

app.listen(4000, () => console.log('Backend running on port 4000'));