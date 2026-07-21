import React, { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

/**
 * Minimal SwagLabs-like flow implementing:
 * - Login
 * - Products + cart
 * - Cart + Checkout (step-by-step with validation) (KAN-2)
 * - Receipt page with refetch on refresh (KAN-3)
 * - Admin orders page with role-based access control (KAN-4)
 *
 * Uses hash-based routing (no extra deps).
 */

const API_BASE = 'http://localhost:4000/api';

function getAuth() {
  const token = localStorage.getItem('token') || '';
  const role = localStorage.getItem('role') || '';
  return { token, role };
}

function setAuth({ token, role }) {
  localStorage.setItem('token', token);
  localStorage.setItem('role', role);
}

function clearAuth() {
  localStorage.removeItem('token');
  localStorage.removeItem('role');
}

function formatMoney(value) {
  const num = typeof value === 'number' ? value : Number(value || 0);
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(
    Number.isFinite(num) ? num : 0
  );
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function validateCheckoutCustomer(customer) {
  const errors = {};
  const required = ['firstName', 'lastName', 'address', 'postalCode'];
  for (const key of required) {
    const val = (customer?.[key] ?? '').toString().trim();
    if (!val) errors[key] = 'Required';
  }
  return errors;
}

function mapBackendErrorsToFieldErrors(errJson) {
  // Try a few common shapes:
  // { errors: { field: "msg" } }
  // { errors: [{ field, message }] }
  // { message, details: [...] }
  // { validationErrors: ... }
  const fieldErrors = {};

  const candidate =
    errJson?.errors ??
    errJson?.validationErrors ??
    errJson?.details ??
    errJson?.error?.details ??
    null;

  if (!candidate) return fieldErrors;

  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      const field = item?.field || item?.path || item?.name;
      const message = item?.message || item?.msg || item?.error || 'Invalid';
      if (field && !fieldErrors[field]) fieldErrors[field] = message;
    }
    return fieldErrors;
  }

  if (typeof candidate === 'object') {
    for (const [k, v] of Object.entries(candidate)) {
      if (typeof v === 'string') fieldErrors[k] = v;
      else if (v && typeof v === 'object' && typeof v.message === 'string') fieldErrors[k] = v.message;
      else fieldErrors[k] = 'Invalid';
    }
  }

  return fieldErrors;
}

function getHashRoute() {
  const hash = window.location.hash || '#/login';
  // Normalize
  if (hash === '#') return '#/login';
  return hash;
}

function navigate(to) {
  if (!to.startsWith('#')) {
    window.location.hash = `#${to.startsWith('/') ? to : `/${to}`}`;
  } else {
    window.location.hash = to;
  }
}

function parseRoute(hash) {
  // Supports:
  // #/login
  // #/products
  // #/cart
  // #/checkout
  // #/receipt/:orderId
  // #/admin/orders
  const clean = (hash || '#/login').replace(/^#/, '');
  const path = clean.startsWith('/') ? clean : `/${clean}`;
  const segments = path.split('/').filter(Boolean);

  const route = {
    path,
    name: segments[0] || 'login',
    segments,
    params: {},
  };

  if (segments[0] === 'receipt' && segments[1]) {
    route.params.orderId = segments[1];
  }

  return route;
}

function request(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
}

function authedRequest(url, token, options = {}) {
  return request(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

function computeCartSummary(cartItems) {
  const subtotal = cartItems.reduce((sum, it) => sum + (Number(it.price) || 0) * (Number(it.quantity) || 0), 0);
  // No tax/shipping specified; keep minimal.
  const total = subtotal;
  const count = cartItems.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
  return { subtotal, total, count };
}

function loadCartFromStorage() {
  const raw = localStorage.getItem('cart');
  const parsed = safeJsonParse(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((it) => ({
      id: it?.id,
      name: it?.name ?? '',
      price: Number(it?.price) || 0,
      quantity: Number(it?.quantity) || 0,
    }))
    .filter((it) => it.id != null && it.quantity > 0);
}

function saveCartToStorage(cart) {
  localStorage.setItem('cart', JSON.stringify(cart));
}

function TopNav({ isAuthed, role, cartCount, onLogout }) {
  return (
    <div className="nav">
      <div className="nav-left">
        <button className="linklike" onClick={() => navigate('/products')} disabled={!isAuthed}>
          Products
        </button>
        <button className="linklike" onClick={() => navigate('/cart')} disabled={!isAuthed}>
          Cart{cartCount > 0 ? ` (${cartCount})` : ''}
        </button>
        <button className="linklike" onClick={() => navigate('/checkout')} disabled={!isAuthed}>
          Checkout
        </button>
        <button className="linklike" onClick={() => navigate('/admin/orders')} disabled={!isAuthed}>
          Admin Orders
        </button>
      </div>
      <div className="nav-right">
        {isAuthed ? (
          <>
            <span className="badge">Role: {role || 'unknown'}</span>
            <button className="btn" onClick={onLogout}>
              Logout
            </button>
          </>
        ) : (
          <button className="btn" onClick={() => navigate('/login')}>
            Login
          </button>
        )}
      </div>
    </div>
  );
}

function LoginPage({ onLoginSuccess }) {
  const [username, setUsername] = useState('standard_user');
  const [password, setPassword] = useState('secret_sauce');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await request(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data?.message || 'Login failed');
        return;
      }

      const token = data?.token;
      const role = data?.role;

      if (!token) {
        setError('Login succeeded but token missing');
        return;
      }

      setAuth({ token, role: role || '' });
      onLoginSuccess({ token, role: role || '' });
      navigate('/products');
    } catch (err) {
      setError(err?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <h1>SwagLabs Clone</h1>
      <p className="muted">Login as <code>standard_user</code> or <code>admin_user</code>.</p>

      <form className="card form" onSubmit={handleSubmit}>
        <div className="field">
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </div>
        <div className="field">
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>

        {error ? <div className="error">{error}</div> : null}

        <button className="btn primary" type="submit" disabled={loading}>
          {loading ? 'Signing in…' : 'Login'}
        </button>
      </form>
    </div>
  );
}

function ProductsPage({ token, cartItems, onAddToCart, onSetCartItemQuantity }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const cartIndex = useMemo(() => {
    const m = new Map();
    for (const it of cartItems) m.set(it.id, it);
    return m;
  }, [cartItems]);

  useEffect(() => {
    let alive = true;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const res = await authedRequest(`${API_BASE}/products`, token, { method: 'GET' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data?.message || 'Failed to load products');
          return;
        }
        if (alive) setProducts(Array.isArray(data) ? data : data?.products || []);
      } catch (err) {
        setError(err?.message || 'Network error');
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => {
      alive = false;
    };
  }, [token]);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Products</h1>
        <button className="btn" onClick={() => navigate('/cart')}>
          Go to Cart
        </button>
      </div>

      {loading ? <div className="muted">Loading…</div> : null}
      {error ? <div className="error">{error}</div> : null}

      <div className="grid">
        {products.map((p) => {
          const id = p.id ?? p.productId ?? p._id;
          const name = p.name ?? p.title ?? 'Product';
          const price = Number(p.price) || 0;
          const inCart = cartIndex.get(id);
          return (
            <div className="card product" key={String(id)}>
              <div className="product-title">{name}</div>
              <div className="muted">{formatMoney(price)}</div>
              <div className="row">
                <button
                  className="btn primary"
                  onClick={() => onAddToCart({ id, name, price })}
                  disabled={!id}
                >
                  Add to cart
                </button>

                <div className="qty">
                  <span className="muted">Qty</span>
                  <input
                    className="qty-input"
                    type="number"
                    min="0"
                    value={inCart?.quantity || 0}
                    onChange={(e) => onSetCartItemQuantity(id, Number(e.target.value || 0))}
                    disabled={!id}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {!loading && !error && products.length === 0 ? (
        <div className="empty">No products found.</div>
      ) : null}
    </div>
  );
}

function CartPage({ cartItems, onSetCartItemQuantity, onRemoveFromCart }) {
  const { subtotal, total, count } = useMemo(() => computeCartSummary(cartItems), [cartItems]);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Cart</h1>
        <button className="btn primary" onClick={() => navigate('/checkout')} disabled={count === 0}>
          Proceed to checkout
        </button>
      </div>

      {cartItems.length === 0 ? (
        <div className="empty">
          Your cart is empty. <button className="linklike" onClick={() => navigate('/products')}>Browse products</button>.
        </div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th align="left">Item</th>
                <th align="right">Price</th>
                <th align="center">Qty</th>
                <th align="right">Line</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cartItems.map((it) => (
                <tr key={String(it.id)}>
                  <td>{it.name}</td>
                  <td align="right">{formatMoney(it.price)}</td>
                  <td align="center">
                    <input
                      className="qty-input"
                      type="number"
                      min="0"
                      value={it.quantity}
                      onChange={(e) => onSetCartItemQuantity(it.id, Number(e.target.value || 0))}
                    />
                  </td>
                  <td align="right">{formatMoney((Number(it.price) || 0) * (Number(it.quantity) || 0))}</td>
                  <td align="right">
                    <button className="btn danger" onClick={() => onRemoveFromCart(it.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="totals">
            <div className="totals-row">
              <span className="muted">Subtotal</span>
              <span>{formatMoney(subtotal)}</span>
            </div>
            <div className="totals-row">
              <span className="muted">Total</span>
              <span className="strong">{formatMoney(total)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CheckoutPage({ token, cartItems, onClearCart }) {
  const [step, setStep] = useState(1);
  const [customer, setCustomer] = useState({
    firstName: '',
    lastName: '',
    address: '',
    postalCode: '',
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [placingOrder, setPlacingOrder] = useState(false);

  const { subtotal, total, count } = useMemo(() => computeCartSummary(cartItems), [cartItems]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function updateCustomer(key, value) {
    setCustomer((c) => ({ ...c, [key]: value }));
    setFieldErrors((e) => {
      if (!e[key]) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  }

  function validateStep1AndProceed() {
    const errors = validateCheckoutCustomer(customer);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setStep(2);
  }

  async function placeOrder() {
    setSubmitError('');
    setFieldErrors({});
    const errors = validateCheckoutCustomer(customer);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setStep(1);
      return;
    }

    if (count === 0) {
      setSubmitError('Your cart is empty.');
      setStep(1);
      return;
    }

    setPlacingOrder(true);
    try {
      const payload = {
        customer: {
          firstName: customer.firstName.trim(),
          lastName: customer.lastName.trim(),
          address: customer.address.trim(),
          postalCode: customer.postalCode.trim(),
        },
        items: cartItems.map((it) => ({
          productId: it.id,
          name: it.name,
          price: it.price,
          quantity: it.quantity,
        })),
      };

      const res = await authedRequest(`${API_BASE}/orders`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const backendFieldErrors = mapBackendErrorsToFieldErrors(data);
        if (Object.keys(backendFieldErrors).length > 0) {
          setFieldErrors(backendFieldErrors);
          setStep(1);
        } else {
          setSubmitError(data?.message || 'Failed to place order');
        }
        return;
      }

      const orderId = data?.orderId ?? data?.id ?? data?._id;
      if (!orderId) {
        setSubmitError('Order placed but orderId missing.');
        return;
      }

      onClearCart();
      navigate(`/receipt/${orderId}`);
    } catch (err) {
      if (!mountedRef.current) return;
      setSubmitError(err?.message || 'Network error');
    } finally {
      if (mountedRef.current) setPlacingOrder(false);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Checkout</h1>
        <div className="muted">Step {step} of 2</div>
      </div>

      {count === 0 ? (
        <div className="empty">
          Your cart is empty. <button className="linklike" onClick={() => navigate('/products')}>Add products</button> to checkout.
        </div>
      ) : null}

      {submitError ? <div className="error">{submitError}</div> : null}

      {step === 1 ? (
        <div className="card form">
          <h2>Step 1: Customer Info</h2>

          <div className="field">
            <label>First Name</label>
            <input value={customer.firstName} onChange={(e) => updateCustomer('firstName', e.target.value)} />
            {fieldErrors.firstName ? <div className="field-error">{fieldErrors.firstName}</div> : null}
          </div>

          <div className="field">
            <label>Last Name</label>
            <input value={customer.lastName} onChange={(e) => updateCustomer('lastName', e.target.value)} />
            {fieldErrors.lastName ? <div className="field-error">{fieldErrors.lastName}</div> : null}
          </div>

          <div className="field">
            <label>Address</label>
            <input value={customer.address} onChange={(e) => updateCustomer('address', e.target.value)} />
            {fieldErrors.address ? <div className="field-error">{fieldErrors.address}</div> : null}
          </div>

          <div className="field">
            <label>Postal Code</label>
            <input value={customer.postalCode} onChange={(e) => updateCustomer('postalCode', e.target.value)} />
            {fieldErrors.postalCode ? <div className="field-error">{fieldErrors.postalCode}</div> : null}
          </div>

          <div className="row">
            <button className="btn" onClick={() => navigate('/cart')}>
              Back to cart
            </button>
            <button className="btn primary" onClick={validateStep1AndProceed}>
              Continue
            </button>
          </div>
        </div>
      ) : (
        <div className="card">
          <h2>Step 2: Review</h2>

          <div className="review-grid">
            <div>
              <div className="muted">Shipping to</div>
              <div className="review-box">
                <div>
                  <span className="strong">
                    {customer.firstName} {customer.lastName}
                  </span>
                </div>
                <div>{customer.address}</div>
                <div>{customer.postalCode}</div>
              </div>

              <div className="muted" style={{ marginTop: 12 }}>
                Items
              </div>
              <div className="review-box">
                {cartItems.map((it) => (
                  <div className="review-line" key={String(it.id)}>
                    <span>
                      {it.name} <span className="muted">x{it.quantity}</span>
                    </span>
                    <span>{formatMoney((Number(it.price) || 0) * (Number(it.quantity) || 0))}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="totals review-box">
              <div className="totals-row">
                <span className="muted">Subtotal</span>
                <span>{formatMoney(subtotal)}</span>
              </div>
              <div className="totals-row">
                <span className="muted">Total</span>
                <span className="strong">{formatMoney(total)}</span>
              </div>
            </div>
          </div>

          <div className="row">
            <button className="btn" onClick={() => setStep(1)} disabled={placingOrder}>
              Back
            </button>
            <button className="btn primary" onClick={placeOrder} disabled={placingOrder}>
              {placingOrder ? 'Placing order…' : 'Place Order'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReceiptPage({ token, orderId }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [order, setOrder] = useState(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const res = await authedRequest(`${API_BASE}/orders/${encodeURIComponent(orderId)}`, token, { method: 'GET' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data?.message || 'Failed to load receipt');
          return;
        }
        if (alive) setOrder(data);
      } catch (err) {
        setError(err?.message || 'Network error');
      } finally {
        if (alive) setLoading(false);
      }
    }
    if (orderId) load();
    return () => {
      alive = false;
    };
  }, [token, orderId]);

  const items = useMemo(() => {
    const raw = order?.items ?? order?.order?.items ?? [];
    return Array.isArray(raw) ? raw : [];
  }, [order]);

  const summary = useMemo(() => {
    const subtotal = items.reduce((sum, it) => {
      const price = Number(it.price) || 0;
      const qty = Number(it.quantity) || 0;
      return sum + price * qty;
    }, 0);
    const total = Number(order?.total) || Number(order?.order?.total) || subtotal;
    return { subtotal, total };
  }, [items, order]);

  const displayOrderId = order?.orderId ?? order?.id ?? order?._id ?? orderId;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Receipt</h1>
        <button className="btn" onClick={() => navigate('/products')}>
          Back to products
        </button>
      </div>

      {loading ? <div className="muted">Loading…</div> : null}
      {error ? <div className="error">{error}</div> : null}

      {!loading && !error && !order ? <div className="empty">No receipt to display.</div> : null}

      {order ? (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <div className="muted">Order ID</div>
              <div className="strong">{String(displayOrderId)}</div>
            </div>
            <div className="muted">
              {order?.createdAt ? `Created: ${new Date(order.createdAt).toLocaleString()}` : null}
            </div>
          </div>

          <h2 style={{ marginTop: 16 }}>Items</h2>
          {items.length === 0 ? (
            <div className="empty">No items.</div>
          ) : (
            <div className="review-box">
              {items.map((it, idx) => (
                <div className="review-line" key={`${String(it.productId ?? it.id ?? idx)}-${idx}`}>
                  <span>
                    {it.name ?? 'Item'} <span className="muted">x{Number(it.quantity) || 0}</span>
                  </span>
                  <span>{formatMoney((Number(it.price) || 0) * (Number(it.quantity) || 0))}</span>
                </div>
              ))}
            </div>
          )}

          <div className="totals" style={{ marginTop: 12 }}>
            <div className="totals-row">
              <span className="muted">Subtotal</span>
              <span>{formatMoney(summary.subtotal)}</span>
            </div>
            <div className="totals-row">
              <span className="muted">Total</span>
              <span className="strong">{formatMoney(summary.total)}</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AdminOrdersPage({ token, role }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [orders, setOrders] = useState([]);

  const isAdmin = role === 'admin' || role === 'admin_user' || role === 'adminUser' || role === 'admin-user';

  useEffect(() => {
    let alive = true;

    async function load() {
      setLoading(true);
      setError('');
      try {
        const res = await authedRequest(`${API_BASE}/admin/orders`, token, { method: 'GET' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data?.message || 'Failed to load admin orders');
          return;
        }
        const list = Array.isArray(data) ? data : data?.orders || [];
        if (alive) setOrders(Array.isArray(list) ? list : []);
      } catch (err) {
        setError(err?.message || 'Network error');
      } finally {
        if (alive) setLoading(false);
      }
    }

    if (isAdmin) load();

    return () => {
      alive = false;
    };
  }, [token, isAdmin]);

  if (!isAdmin) {
    return (
      <div className="page">
        <h1>Admin Orders</h1>
        <div className="card">
          <div className="error">Access denied. Admin role required.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Admin Orders</h1>
        <button className="btn" onClick={() => navigate('/products')}>
          Back to products
        </button>
      </div>

      {loading ? <div className="muted">Loading…</div> : null}
      {error ? <div className="error">{error}</div> : null}

      {!loading && !error && orders.length === 0 ? <div className="empty">No recent orders.</div> : null}

      {orders.length > 0 ? (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th align="left">Order ID</th>
                <th align="left">Created</th>
                <th align="right">Total</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o, idx) => {
                const orderId = o.orderId ?? o.id ?? o._id ?? idx;
                const createdAt = o.createdAt ? new Date(o.createdAt).toLocaleString() : '';
                const total = Number(o.total) || 0;
                return (
                  <tr key={String(orderId)}>
                    <td>{String(orderId)}</td>
                    <td>{createdAt}</td>
                    <td align="right">{formatMoney(total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function RequireAuth({ isAuthed, children }) {
  if (!isAuthed) {
    return (
      <div className="page">
        <div className="card">
          <div className="error">You are not logged in.</div>
          <button className="btn primary" onClick={() => navigate('/login')}>
            Go to login
          </button>
        </div>
      </div>
    );
  }
  return children;
}

function App() {
  const [routeHash, setRouteHash] = useState(getHashRoute());
  const [auth, setAuthState] = useState(() => getAuth());
  const [cart, setCart] = useState(() => loadCartFromStorage());

  const isAuthed = Boolean(auth.token);
  const { subtotal, total, count } = useMemo(() => computeCartSummary(cart), [cart]);

  useEffect(() => {
    function onHashChange() {
      setRouteHash(getHashRoute());
    }
    window.addEventListener('hashchange', onHashChange);
    // Ensure a valid initial route
    if (!window.location.hash) navigate('/login');
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    saveCartToStorage(cart);
  }, [cart]);

  useEffect(() => {
    // Basic route guard: if authed and on login, go to products; if not authed and on protected routes, go login.
    const r = parseRoute(routeHash);
    const isLogin = r.name === 'login';
    const isReceipt = r.name === 'receipt';
    const isProtected = !isLogin; // everything but login is protected
    if (isAuthed && isLogin) navigate('/products');
    if (!isAuthed && isProtected) navigate('/login');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthed]);

  function handleLogout() {
    clearAuth();
    setAuthState({ token: '', role: '' });
    setCart([]);
    localStorage.removeItem('cart');
    navigate('/login');
  }

  function onAddToCart(product) {
    setCart((prev) => {
      const idx = prev.findIndex((p) => p.id === product.id);
      if (idx >= 0) {
        const next = prev.slice();
        next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 };
        return next;
      }
      return [...prev, { id: product.id, name: product.name, price: product.price, quantity: 1 }];
    });
  }

  function onSetCartItemQuantity(productId, quantity) {
    const q = Number(quantity) || 0;
    setCart((prev) => {
      if (q <= 0) return prev.filter((it) => it.id !== productId);
      return prev.map((it) => (it.id === productId ? { ...it, quantity: q } : it));
    });
  }

  function onRemoveFromCart(productId) {
    setCart((prev) => prev.filter((it) => it.id !== productId));
  }

  function onClearCart() {
    setCart([]);
    localStorage.removeItem('cart');
  }

  const route = useMemo(() => parseRoute(routeHash), [routeHash]);

  let content = null;

  if (route.name === 'login') {
    content = <LoginPage onLoginSuccess={(a) => setAuthState(a)} />;
  } else if (route.name === 'products') {
    content = (
      <RequireAuth isAuthed={isAuthed}>
        <ProductsPage
          token={auth.token}
          cartItems={cart}
          onAddToCart={onAddToCart}
          onSetCartItemQuantity={onSetCartItemQuantity}
        />
      </RequireAuth>
    );
  } else if (route.name === 'cart') {
    content = (
      <RequireAuth isAuthed={isAuthed}>
        <CartPage cartItems={cart} onSetCartItemQuantity={onSetCartItemQuantity} onRemoveFromCart={onRemoveFromCart} />
      </RequireAuth>
    );
  } else if (route.name === 'checkout') {
    content = (
      <RequireAuth isAuthed={isAuthed}>
        <CheckoutPage token={auth.token} cartItems={cart} onClearCart={onClearCart} />
      </RequireAuth>
    );
  } else if (route.name === 'receipt') {
    content = (
      <RequireAuth isAuthed={isAuthed}>
        <ReceiptPage token={auth.token} orderId={route.params.orderId} />
      </RequireAuth>
    );
  } else if (route.name === 'admin' && route.segments[1] === 'orders') {
    content = (
      <RequireAuth isAuthed={isAuthed}>
        <AdminOrdersPage token={auth.token} role={auth.role} />
      </RequireAuth>
    );
  } else {
    content = (
      <div className="page">
        <h1>Not Found</h1>
        <div className="card">
          <div className="muted">Unknown route: {route.path}</div>
          <button className="btn primary" onClick={() => navigate(isAuthed ? '/products' : '/login')}>
            Go home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="App">
      <TopNav isAuthed={isAuthed} role={auth.role} cartCount={count} onLogout={handleLogout} />

      <div className="container">
        {isAuthed ? (
          <div className="statusbar">
            <span className="muted">Cart:</span> <span className="strong">{count}</span>
            <span className="sep" />
            <span className="muted">Subtotal:</span> <span className="strong">{formatMoney(subtotal)}</span>
            <span className="sep" />
            <span className="muted">Total:</span> <span className="strong">{formatMoney(total)}</span>
          </div>
        ) : null}

        {content}
      </div>
    </div>
  );
}

export default App;