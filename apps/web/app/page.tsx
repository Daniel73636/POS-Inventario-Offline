"use client";

import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4003";

export default function OwnerPage() {
  const [products, setProducts] = useState<any[]>([]);
  const [sales, setSales] = useState<any[]>([]);

  useEffect(() => {
    Promise.all([
      fetch(`${API}/v1/products`).then((r) => r.json()),
      fetch(`${API}/v1/reports/sales`).then((r) => r.json()),
    ]).then(([p, s]) => {
      setProducts(p.products || []);
      setSales(s.sales || []);
    }).catch(() => undefined);
  }, []);

  const revenue = sales.reduce((a, s) => a + (s.totalCents || 0), 0);

  return (
    <div>
      <h1>Resumen</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: "1rem" }}>
        <div style={{ background: "#151c2c", padding: "1rem", borderRadius: 12 }}>
          <div style={{ opacity: 0.7 }}>Productos</div>
          <div style={{ fontSize: "2rem", fontWeight: 800 }}>{products.length}</div>
        </div>
        <div style={{ background: "#151c2c", padding: "1rem", borderRadius: 12 }}>
          <div style={{ opacity: 0.7 }}>Ventas sync</div>
          <div style={{ fontSize: "2rem", fontWeight: 800 }}>{sales.length}</div>
        </div>
        <div style={{ background: "#151c2c", padding: "1rem", borderRadius: 12 }}>
          <div style={{ opacity: 0.7 }}>Ingresos</div>
          <div style={{ fontSize: "2rem", fontWeight: 800 }}>
            {new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(revenue)}
          </div>
        </div>
      </div>

      <h2>Inventario</h2>
      <div style={{ display: "grid", gap: "0.5rem" }}>
        {products.map((p) => (
          <div key={p.id} style={{ background: "#151c2c", padding: "0.85rem 1rem", borderRadius: 10, display: "flex", justifyContent: "space-between" }}>
            <span>{p.name} <small style={{ opacity: 0.6 }}>{p.barcode}</small></span>
            <span>stock {p.stock} · {p.priceCents}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
