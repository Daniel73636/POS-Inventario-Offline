"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Product = {
  id: string; name: string; barcode: string; priceCents: number; costCents: number;
  taxRateBp: number; stock: number; unit: string;
};
type Line = { product: Product; qty: number };

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4003";

function money(cents: number) {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(cents);
}

function loadLocal<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export default function PosPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [scan, setScan] = useState("");
  const [active, setActive] = useState(0);
  const [payOpen, setPayOpen] = useState(false);
  const [cash, setCash] = useState("");
  const [syncState, setSyncState] = useState<"offline" | "pending" | "synced">("offline");
  const [pending, setPending] = useState(0);
  const [msg, setMsg] = useState("");
  const [device, setDevice] = useState<{ deviceId: string; token: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const cached = loadLocal<Product[]>("pos.products", []);
    if (cached.length) setProducts(cached);
    const d = loadLocal<{ deviceId: string; token: string } | null>("pos.device", null);
    setDevice(d);
    setPending(loadLocal<unknown[]>("pos.events", []).filter((e: any) => !e.syncedAt).length);
    bootstrap(d);
  }, []);

  async function bootstrap(existing: { deviceId: string; token: string } | null) {
    try {
      let token = existing?.token;
      if (!token) {
        const res = await fetch(`${API}/v1/devices/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "DEMO", name: "Caja Web" }),
        });
        const data = await res.json();
        const next = { deviceId: data.deviceId, token: data.token };
        localStorage.setItem("pos.device", JSON.stringify(next));
        setDevice(next);
        token = data.token;
        if (data.snapshot?.products) {
          setProducts(data.snapshot.products);
          localStorage.setItem("pos.products", JSON.stringify(data.snapshot.products));
        }
      } else {
        const res = await fetch(`${API}/v1/products`);
        const data = await res.json();
        setProducts(data.products || []);
        localStorage.setItem("pos.products", JSON.stringify(data.products || []));
      }
      setSyncState("synced");
      await syncNow(token!);
    } catch {
      setSyncState(pending > 0 ? "pending" : "offline");
      setMsg("Sin conexión: vendiendo offline con catálogo local");
    }
  }

  const total = useMemo(() => lines.reduce((s, l) => s + l.product.priceCents * l.qty, 0), [lines]);
  const items = useMemo(() => lines.reduce((s, l) => s + l.qty, 0), [lines]);

  function addProduct(p: Product) {
    setLines((prev) => {
      const i = prev.findIndex((l) => l.product.id === p.id);
      if (i >= 0) {
        const copy = [...prev];
        copy[i] = { ...copy[i]!, qty: copy[i]!.qty + 1 };
        setActive(i);
        return copy;
      }
      setActive(prev.length);
      return [...prev, { product: p, qty: 1 }];
    });
    setMsg("");
  }

  function onScanSubmit(e: React.FormEvent) {
    e.preventDefault();
    const code = scan.trim();
    if (!code) return;
    const p = products.find((x) => x.barcode === code || x.name.toLowerCase().includes(code.toLowerCase()));
    if (!p) {
      setMsg("Producto no encontrado");
      setScan("");
      return;
    }
    addProduct(p);
    setScan("");
  }

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "F12") { ev.preventDefault(); if (lines.length) setPayOpen(true); }
      if (ev.key === "F9") { ev.preventDefault(); setLines([]); }
      if (ev.key === "Escape") setPayOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lines.length]);

  async function syncNow(token: string) {
    const events = loadLocal<any[]>("pos.events", []);
    const pendingEvents = events.filter((e) => !e.syncedAt);
    setPending(pendingEvents.length);
    if (!pendingEvents.length) { setSyncState("synced"); return; }
    setSyncState("pending");
    try {
      const res = await fetch(`${API}/v1/sync/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ events: pendingEvents }),
      });
      if (!res.ok) throw new Error("sync fail");
      const now = new Date().toISOString();
      const next = events.map((e) => (e.syncedAt ? e : { ...e, syncedAt: now }));
      localStorage.setItem("pos.events", JSON.stringify(next));
      setPending(0);
      setSyncState("synced");
    } catch {
      setSyncState("pending");
    }
  }

  function completeSale() {
    const cashCents = Number(cash || total);
    if (cashCents < total) { setMsg("Efectivo insuficiente"); return; }
    const event = {
      id: crypto.randomUUID(),
      deviceId: device?.deviceId || "local",
      seq: (loadLocal<any[]>("pos.events", []).length + 1),
      type: "SaleCompleted",
      occurredAt: new Date().toISOString(),
      payload: {
        totalCents: total,
        changeCents: cashCents - total,
        items: lines.map((l) => ({
          productId: l.product.id,
          name: l.product.name,
          qty: l.qty,
          baseQty: l.qty,
          unitPriceCents: l.product.priceCents,
          lineTotalCents: l.product.priceCents * l.qty,
        })),
        payments: [{ method: "cash", amountCents: cashCents }],
      },
      syncedAt: null as string | null,
    };
    const events = [...loadLocal<any[]>("pos.events", []), event];
    localStorage.setItem("pos.events", JSON.stringify(events));
    setPending(events.filter((e) => !e.syncedAt).length);
    setLines([]);
    setPayOpen(false);
    setCash("");
    setMsg(`Venta OK · cambio ${money(cashCents - total)}`);
    if (device?.token) syncNow(device.token);
    inputRef.current?.focus();
  }

  const change = Math.max(0, Number(cash || 0) - total);

  return (
    <div className="shell">
      <section className="left">
        <form onSubmit={onScanSubmit}>
          <input
            ref={inputRef}
            className="scan"
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            placeholder="Escanea o busca (Enter)…"
            autoFocus
          />
        </form>
        {msg && <p style={{ color: "var(--warn)" }}>{msg}</p>}
        <table className="table">
          <thead>
            <tr><th>Cant</th><th>Producto</th><th>P.unit</th><th>Importe</th></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.product.id} className={i === active ? "active" : ""} onClick={() => setActive(i)}>
                <td>
                  <button className="btn ghost" onClick={() => setLines((prev) => prev.map((x, idx) => idx === i ? { ...x, qty: Math.max(1, x.qty - 1) } : x))}>-</button>
                  {" "}{l.qty}{" "}
                  <button className="btn ghost" onClick={() => setLines((prev) => prev.map((x, idx) => idx === i ? { ...x, qty: x.qty + 1 } : x))}>+</button>
                </td>
                <td>{l.product.name}</td>
                <td>{money(l.product.priceCents)}</td>
                <td>{money(l.product.priceCents * l.qty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="quick">
          {products.slice(0, 9).map((p) => (
            <button key={p.id} onClick={() => addProduct(p)}>{p.name}<div style={{ color: "var(--muted)", fontSize: "0.8rem" }}>{money(p.priceCents)}</div></button>
          ))}
        </div>
      </section>

      <aside className="right">
        <div style={{ color: "var(--muted)" }}>Total</div>
        <div className="total">{money(total)}</div>
        <p>{items} artículo(s)</p>
        <button className="btn pay" disabled={!lines.length} onClick={() => setPayOpen(true)}>Cobrar (F12)</button>
        <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.75rem" }}>
          <button className="btn ghost" onClick={() => setLines([])}>Suspender / Limpiar (F9)</button>
          <button className="btn ghost" onClick={() => device?.token && syncNow(device.token)}>Sincronizar ahora</button>
        </div>
        <div className="status">
          <span>Sync: {syncState}{pending ? ` (${pending})` : ""}</span>
          <span>Red: {typeof navigator !== "undefined" && navigator.onLine ? "online" : "offline"}</span>
          <span>Cajero demo</span>
        </div>
      </aside>

      {payOpen && (
        <div className="modal" onClick={() => setPayOpen(false)}>
          <div className="box" onClick={(e) => e.stopPropagation()}>
            <h2>Cobrar</h2>
            <p>Total <strong>{money(total)}</strong></p>
            <label>Efectivo recibido</label>
            <input className="scan" value={cash} onChange={(e) => setCash(e.target.value)} inputMode="numeric" autoFocus placeholder={String(total)} />
            <div style={{ display: "flex", gap: "0.5rem", margin: "0.75rem 0", flexWrap: "wrap" }}>
              {[total, 5000, 10000, 20000, 50000].map((v) => (
                <button key={v} className="btn ghost" onClick={() => setCash(String(v))}>{money(v)}</button>
              ))}
            </div>
            <div>Cambio</div>
            <div className="change">{money(change)}</div>
            <button className="btn pay" style={{ marginTop: "1rem" }} onClick={completeSale}>Confirmar venta</button>
          </div>
        </div>
      )}
    </div>
  );
}
