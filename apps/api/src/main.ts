import Fastify from "fastify";
import cors from "@fastify/cors";
import { load, save, uid } from "./store.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.get("/health", async () => ({ ok: true, service: "pos-api" }));

app.get("/v1/products", async () => {
  const s = load();
  return { products: s.products.filter((p) => p.active) };
});

app.post("/v1/devices/register", async (req) => {
  const body = req.body as { code?: string; name?: string };
  const s = load();
  const device = {
    id: uid(),
    tenantId: s.tenantId,
    storeId: s.storeId,
    name: body.name || "Caja 1",
    token: uid(),
    cursor: 0,
  };
  s.devices.push(device);
  save();
  return {
    deviceId: device.id,
    token: device.token,
    tenantId: device.tenantId,
    storeId: device.storeId,
    codeAccepted: body.code || "DEMO",
    snapshot: { products: s.products },
  };
});

app.post("/v1/sync/push", async (req, reply) => {
  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const s = load();
  const device = s.devices.find((d) => d.token === auth);
  if (!device) return reply.code(401).send({ title: "Dispositivo no autorizado" });
  const body = req.body as {
    events?: Array<{ id: string; seq: number; type: string; payload: unknown; occurredAt: string }>;
  };
  const accepted: string[] = [];
  for (const ev of body.events || []) {
    const exists = s.events.some((e) => e.deviceId === device.id && e.seq === ev.seq);
    if (exists) {
      accepted.push(ev.id);
      continue;
    }
    s.serverSeq += 1;
    s.events.push({
      id: ev.id,
      tenantId: device.tenantId,
      storeId: device.storeId,
      deviceId: device.id,
      seq: ev.seq,
      type: ev.type,
      payload: ev.payload,
      occurredAt: ev.occurredAt,
      serverSeq: s.serverSeq,
    });
    if (ev.type === "SaleCompleted") {
      s.sales.push(ev.payload);
      const payload = ev.payload as { items?: Array<{ productId: string; baseQty: number }> };
      for (const item of payload.items || []) {
        const p = s.products.find((x) => x.id === item.productId);
        if (p) p.stock -= item.baseQty;
      }
    }
    accepted.push(ev.id);
  }
  save();
  return { accepted, rejected: [], serverTime: new Date().toISOString() };
});

app.get("/v1/sync/pull", async (req, reply) => {
  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const s = load();
  const device = s.devices.find((d) => d.token === auth);
  if (!device) return reply.code(401).send({ title: "Dispositivo no autorizado" });
  const cursor = Number((req.query as { cursor?: string }).cursor || 0);
  const events = s.events.filter((e) => e.serverSeq > cursor && e.deviceId !== device.id).slice(0, 200);
  const nextCursor = events.length ? events[events.length - 1]!.serverSeq : cursor;
  device.cursor = nextCursor;
  save();
  return { events, cursor: nextCursor, serverTime: new Date().toISOString() };
});

app.get("/v1/sync/snapshot", async (req, reply) => {
  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const s = load();
  const device = s.devices.find((d) => d.token === auth);
  if (!device) return reply.code(401).send({ title: "Dispositivo no autorizado" });
  return { products: s.products, salesCount: s.sales.length, cursor: s.serverSeq };
});

app.get("/v1/reports/sales", async () => {
  const s = load();
  return { sales: s.sales.slice(-100), count: s.sales.length };
});

const port = Number(process.env.PORT || 4003);
await app.listen({ port, host: "0.0.0.0" });
console.log(`POS API on :${port}`);
