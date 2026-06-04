import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CheckCircle2,
  Cpu,
  Download,
  KeyRound,
  Loader2,
  LogOut,
  MemoryStick,
  Rocket,
  Save,
  Search,
  ShieldCheck,
  Video
} from "lucide-react";
import "./styles.css";

const apiBase = import.meta.env.DEV ? "http://localhost:4177" : location.origin;

const segments = {
  memory: { label: "זיכרונות", icon: MemoryStick },
  gpu: { label: "כרטיסי מסך", icon: Video },
  cpu: { label: "מעבדים", icon: Cpu }
};

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, { credentials: "include", ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

function App() {
  const [auth, setAuth] = useState({ checked: false, authenticated: false });
  const [loginDraft, setLoginDraft] = useState({ username: "", password: "" });
  const [loginStatus, setLoginStatus] = useState("");
  const [config, setConfig] = useState({ suppliers: [] });
  const [supplierId, setSupplierId] = useState("morlevi");
  const [segment, setSegment] = useState("gpu");
  const [products, setProducts] = useState([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("טוען הגדרות ספקים...");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastFetch, setLastFetch] = useState(null);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      const data = await api("/api/auth/status");
      setAuth({ checked: true, authenticated: data.authenticated === true });
      if (data.authenticated) await loadConfig();
    } catch (error) {
      setAuth({ checked: true, authenticated: false });
      setLoginStatus(error.message);
    }
  }

  async function login(event) {
    event.preventDefault();
    setLoginStatus("מתחבר...");
    try {
      await api("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginDraft)
      });
      setAuth({ checked: true, authenticated: true });
      setLoginDraft({ username: "", password: "" });
      setLoginStatus("");
      await loadConfig();
    } catch (error) {
      setLoginStatus(error.message);
    }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    setAuth({ checked: true, authenticated: false });
    setConfig({ suppliers: [] });
    setProducts([]);
    setStatus("נותקת מהמערכת");
  }

  async function loadConfig() {
    try {
      const data = await api("/api/suppliers/config");
      setConfig(data);
      setStatus("המערכת מוכנה לשליפת מחירים");
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function saveConfig() {
    setIsSaving(true);
    setStatus("שומר הגדרות...");
    try {
      const payload = {
        suppliers: config.suppliers.map((supplier) => ({
          ...supplier,
          password: supplier.password || (supplier.hasPassword ? "__KEEP__" : "")
        }))
      };
      const saved = await api("/api/suppliers/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      setConfig(saved);
      setStatus("ההגדרות נשמרו");
    } catch (error) {
      setStatus(error.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function fetchPrices() {
    setIsLoading(true);
    setProducts([]);
    setStatus("מתחבר לספק ושולף מחירון...");
    try {
      const result = await api("/api/suppliers/fetch-prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId, segment })
      });
      setProducts(result.products || []);
      setLastFetch(result.fetchedAt);
      setStatus(`נשלפו ${result.count || 0} מוצרים מ${result.supplierLabel}`);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setIsLoading(false);
    }
  }

  const supplier = config.suppliers.find((item) => item.id === supplierId);
  const selectedCanFetch = supplier?.capabilities?.implemented?.includes(segment);
  const filteredProducts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return products;
    return products.filter((product) => [
      product.title,
      product.sku,
      product.manufacturerSku,
      product.stock
    ].join(" ").toLowerCase().includes(needle));
  }, [products, query]);

  function updateSupplier(id, patch) {
    setConfig((current) => ({
      suppliers: current.suppliers.map((item) => item.id === id ? { ...item, ...patch } : item)
    }));
  }

  function updateSupplierSegments(id, key, value) {
    setConfig((current) => ({
      suppliers: current.suppliers.map((item) => item.id === id
        ? { ...item, segments: { ...item.segments, [key]: value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) } }
        : item)
    }));
  }

  function exportCsv() {
    const rows = [
      ["ספק", "סגמנט", "מק\"ט מור לוי", "מק\"ט יצרן", "שם מוצר", "מלאי", "מחיר", "קישור"],
      ...filteredProducts.map((product) => [
        supplier?.label || "",
        segments[segment].label,
        product.sku || "",
        product.manufacturerSku || "",
        product.title || "",
        product.stock || "",
        product.price ?? "",
        product.url || ""
      ])
    ];
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `supplier-prices-${supplierId}-${segment}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function supplierOptionLabel(item) {
    const suffix = item.capabilities?.canFetch ? "" : " - אין שליפה עדיין";
    return `${item.label}${suffix}`;
  }

  if (!auth.checked) {
    return (
      <main className="login-shell" dir="rtl">
        <section className="login-card">
          <Loader2 className="spin" />
          <strong>טוען מערכת...</strong>
        </section>
      </main>
    );
  }

  if (!auth.authenticated) {
    return (
      <main className="login-shell" dir="rtl">
        <form className="login-card" onSubmit={login}>
          <div className="login-mark">
            <ShieldCheck />
          </div>
          <h1>כניסה למערכת מחירונים</h1>
          <p>הכניסה מוגבלת למשתמשים מורשים בלבד.</p>
          <label>
            שם משתמש
            <input
              value={loginDraft.username}
              onChange={(event) => setLoginDraft((current) => ({ ...current, username: event.target.value }))}
              autoComplete="username"
              autoFocus
            />
          </label>
          <label>
            סיסמה
            <input
              value={loginDraft.password}
              onChange={(event) => setLoginDraft((current) => ({ ...current, password: event.target.value }))}
              type="password"
              autoComplete="current-password"
            />
          </label>
          {loginStatus && <div className="login-status">{loginStatus}</div>}
          <button className="launch" type="submit">
            <KeyRound />
            כניסה
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="app" dir="rtl">
      <aside className="sidebar">
        <div className="brand">
          <ShieldCheck />
          <div>
            <strong>מערכת מחירוני ספקים</strong>
            <span>מור לוי עכשיו, ספקים נוספים בהמשך</span>
          </div>
        </div>

        <section className="launch-panel">
          <label>
            ספק
            <select value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
              {config.suppliers.map((item) => (
                <option value={item.id} key={item.id}>{supplierOptionLabel(item)}</option>
              ))}
            </select>
          </label>

          <div className="segment-grid">
            {Object.entries(segments).map(([key, meta]) => {
              const Icon = meta.icon;
              return (
                <button
                  className={segment === key ? "segment active" : "segment"}
                  onClick={() => setSegment(key)}
                  key={key}
                >
                  <Icon />
                  {meta.label}
                </button>
              );
            })}
          </div>

          <div className={selectedCanFetch ? "fetch-note ready" : "fetch-note"}>
            {selectedCanFetch ? "חיבור שליפה פעיל לסגמנט הנבחר" : supplier?.capabilities?.note || "אין חיבור שליפה פעיל"}
          </div>

          <button className="launch" onClick={fetchPrices} disabled={isLoading || !supplier?.enabled || !selectedCanFetch}>
            {isLoading ? <Loader2 className="spin" /> : <Rocket />}
            שיגור
          </button>
        </section>

        <section className="status-card">
          <CheckCircle2 />
          <div>
            <strong>{status}</strong>
            <span>{lastFetch ? `עדכון אחרון: ${new Date(lastFetch).toLocaleString("he-IL")}` : "עדיין לא בוצעה שליפה"}</span>
          </div>
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>מחירים עדכניים לפי סגמנט</h1>
            <p>בחר ספק וסגמנט, לחץ שיגור, והמערכת תתחבר עם פרטי המשתמש השמורים ותציג את המחירון בטבלה.</p>
          </div>
          <div className="top-actions">
            <button onClick={logout}>
              <LogOut />
              יציאה
            </button>
            <button onClick={exportCsv} disabled={!filteredProducts.length}>
              <Download />
              ייצוא CSV
            </button>
          </div>
        </header>

        <section className="toolbar">
          <label>
            חיפוש בתוצאות
            <div className="search-box">
              <Search />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="דגם, מק״ט או מלאי" />
            </div>
          </label>
          <div className="metric">
            <span>תוצאות</span>
            <strong>{filteredProducts.length}</strong>
          </div>
          <div className="metric">
            <span>סגמנט</span>
            <strong>{segments[segment].label}</strong>
          </div>
        </section>

        <section className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>מוצר</th>
                <th>מק"ט מור לוי</th>
                <th>מק"ט יצרן</th>
                <th>מלאי</th>
                <th>מחיר</th>
              </tr>
            </thead>
            <tbody>
              {filteredProducts.map((product) => (
                <tr key={product.id}>
                  <td>
                    <a href={product.url} target="_blank" rel="noreferrer">{product.title}</a>
                  </td>
                  <td>{product.sku || "-"}</td>
                  <td>{product.manufacturerSku || "-"}</td>
                  <td><span className={product.stock?.includes("זמין") ? "stock yes" : "stock"}>{product.stock || "-"}</span></td>
                  <td className="price">{product.priceText || formatPrice(product.price)}</td>
                </tr>
              ))}
              {!filteredProducts.length && (
                <tr>
                  <td colSpan="5" className="empty">אין עדיין תוצאות להצגה.</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="settings">
          <div className="section-title">
            <KeyRound />
            <h2>הגדרות ספקים וסיסמאות</h2>
            <button onClick={saveConfig} disabled={isSaving}>
              {isSaving ? <Loader2 className="spin" /> : <Save />}
              שמירה
            </button>
          </div>

          <div className="supplier-grid">
            {config.suppliers.map((item) => (
              <SupplierCard
                key={item.id}
                supplier={item}
                onChange={(patch) => updateSupplier(item.id, patch)}
                onSegmentsChange={(key, value) => updateSupplierSegments(item.id, key, value)}
              />
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

function SupplierCard({ supplier, onChange, onSegmentsChange }) {
  return (
    <article className="supplier-card">
      <div className="supplier-head">
        <div>
          <strong>{supplier.label}</strong>
          <span className={supplier.capabilities?.canFetch ? "adapter-badge ready" : "adapter-badge"}>
            {supplier.capabilities?.canFetch ? "שליפה פעילה" : "ממתין לחיבור"}
          </span>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={Boolean(supplier.enabled)} onChange={(event) => onChange({ enabled: event.target.checked })} />
          פעיל
        </label>
      </div>
      <label>
        כתובת אתר
        <input value={supplier.baseUrl || ""} onChange={(event) => onChange({ baseUrl: event.target.value })} placeholder="https://example.co.il" />
      </label>
      <label>
        כתובת כניסה
        <input value={supplier.loginUrl || ""} onChange={(event) => onChange({ loginUrl: event.target.value })} placeholder="https://example.co.il/login" />
      </label>
      <label>
        שם משתמש
        <input value={supplier.username || ""} onChange={(event) => onChange({ username: event.target.value })} placeholder="email@example.com" />
      </label>
      <label>
        סיסמה
        <input
          value={supplier.password || ""}
          onChange={(event) => onChange({ password: event.target.value })}
          placeholder={supplier.hasPassword ? "סיסמה שמורה, הקלד חדשה כדי להחליף" : "הקלד סיסמה"}
          type="password"
        />
      </label>
      <div className="segment-paths">
        {Object.entries(segments).map(([key, meta]) => (
          <label key={key}>
            {meta.label} - כתובות קטגוריה
            <textarea
              value={(supplier.segments?.[key] || []).join("\n")}
              onChange={(event) => onSegmentsChange(key, event.target.value)}
              placeholder="/Cat/82"
            />
          </label>
        ))}
      </div>
    </article>
  );
}

function formatPrice(value) {
  if (!Number.isFinite(Number(value))) return "-";
  return new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 0 }).format(value);
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll("\"", "\"\"")}"`;
}

createRoot(document.getElementById("root")).render(<App />);
