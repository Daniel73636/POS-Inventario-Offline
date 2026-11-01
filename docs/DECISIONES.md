# Decisiones de ingeniería — POSInventario

## 2026-11-01 — Almacenamiento local web

**Decisión:** Migrar de `localStorage` a **Dexie (IndexedDB)** con esquema versionado, `navigator.storage.persist()` y exportación JSON de respaldo. Mantener adaptador `SyncStore` para no romper `sync-engine`. Tauri + SQLCipher queda documentado, no bloqueante.

## 2026-11-01 — Demo secrets

**Decisión:** Código `DEMO-2026` y PINs fijos solo activos si `DEMO_MODE=true` (default en desarrollo). En producción el emparejamiento exige códigos de un solo uso con caducidad.

## 2026-11-01 — Facturación DIAN

**Decisión:** Interfaz `FacturacionProvider` + mock sin pretender validez legal. Documentar trámites reales en docs.
