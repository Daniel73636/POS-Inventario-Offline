export const metadata = { title: "POS Panel dueño" };
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body style={{ fontFamily: "Segoe UI, sans-serif", margin: 0, background: "#0b1220", color: "#e8eefc" }}>
        <header style={{ padding: "1rem 1.25rem", borderBottom: "1px solid #243049" }}>
          <strong>MiniMarket Demo</strong> · Panel del dueño
        </header>
        <main style={{ padding: "1.25rem", maxWidth: 1100, margin: "0 auto" }}>{children}</main>
      </body>
    </html>
  );
}
