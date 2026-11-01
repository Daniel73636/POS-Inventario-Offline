import { DEMO_PAIRING_CODE } from '@pos/contracts';
import {
  addToCart,
  computeCartTotals,
  emptyCart,
  allocateSaleLine,
  finalizeSale,
  formatMoney,
  parseMoney,
  PAYMENT_METHOD_LABELS,
  profitOfSale,
  saleLotWarnings,
  setLineQty,
  type Cart,
  type PaymentMethod,
} from '@pos/domain-pos';
import { findByBarcode, productLots, searchProducts, uuidv7, type ProductState } from '@pos/sync-engine';
import { StatusBar } from 'expo-status-bar';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Alert, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { backgroundSyncJob } from './src/background-sync';
import { Scanner } from './src/Scanner';
import { store } from './src/store';

let version = 0;
store.subscribe(() => {
  version++;
});
function useStore() {
  useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => version,
  );
  return store;
}

type Tab = 'venta' | 'precio' | 'tablero' | 'ajustes';

function SyncBadge() {
  const s = useStore();
  const { sync, config } = s;
  const demo = !config || config.mode === 'demo';
  const label = demo
    ? 'Demo local'
    : sync.state === 'revoked'
      ? 'Revocado'
      : sync.state === 'syncing'
        ? `Sincronizando${sync.pending ? ` (${sync.pending})` : '…'}`
        : sync.state === 'error'
          ? `Error · ${sync.pending} pend.`
          : sync.state === 'offline'
            ? `Sin conexión · ${sync.pending}`
            : sync.pending > 0
              ? `Pendiente (${sync.pending})`
              : 'Sincronizado';
  const color = demo
    ? '#64748b'
    : sync.state === 'offline' || sync.state === 'revoked' || sync.state === 'error'
      ? '#dc2626'
      : sync.state === 'syncing' || sync.pending
        ? '#d97706'
        : '#16a34a';
  const when = sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <Pressable onPress={() => s.syncNow()} style={[styles.badge, { borderColor: color }]} accessibilityLabel={sync.lastError ?? label}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={{ color, fontWeight: '600' }}>{label}{when && !demo ? ` · ${when}` : ''}</Text>
    </Pressable>
  );
}

function SaleScreen() {
  const s = useStore();
  const [cart, setCart] = useState<Cart>(emptyCart());
  const [code, setCode] = useState('');
  const [scan, setScan] = useState(false);
  const [paying, setPaying] = useState(false);
  const totals = useMemo(() => computeCartTotals(cart), [cart]);

  function addCode(raw: string) {
    const text = raw.trim();
    if (!text) return;
    const hit = findByBarcode(s.state, text);
    const product: ProductState | undefined = hit?.product ?? searchProducts(s.state, text, 1)[0];
    if (!product) {
      Alert.alert('No encontrado', `No existe un producto con "${text}"`);
      return;
    }
    setCart((c) => addToCart(c, product, 1, { packId: hit?.packId ?? null }));
    if ((s.state.stock[product.id] ?? 0) <= 0) Alert.alert('Stock', `"${product.name}" no tiene stock registrado. La venta se permite.`);
    setCode('');
  }

  return (
    <View style={styles.flex}>
      <View style={styles.row}>
        <TextInput style={[styles.input, styles.flex]} value={code} onChangeText={setCode} placeholder="Código o nombre" onSubmitEditing={() => addCode(code)} returnKeyType="done" />
        <Pressable style={styles.primary} onPress={() => setScan(true)}><Text style={styles.primaryText}>📷 Escanear</Text></Pressable>
      </View>
      <FlatList
        style={styles.flex}
        data={cart.lines}
        keyExtractor={(l) => l.lineId}
        ListEmptyComponent={<Text style={styles.muted}>Escanea o escribe un código para empezar. Prueba 7701234000011.</Text>}
        renderItem={({ item }) => (
          <View style={styles.line}>
            <View style={styles.flex}>
              <Text style={styles.lineName}>{item.name}</Text>
              <Text style={styles.muted}>{formatMoney(item.unitPriceCents)} c/u</Text>
            </View>
            <Pressable style={styles.qtyBtn} onPress={() => setCart((c) => setLineQty(c, item.lineId, item.qty - 1))}><Text style={styles.qtyText}>−</Text></Pressable>
            <Text style={styles.qty}>{item.qty}</Text>
            <Pressable style={styles.qtyBtn} onPress={() => setCart((c) => setLineQty(c, item.lineId, item.qty + 1))}><Text style={styles.qtyText}>+</Text></Pressable>
          </View>
        )}
      />
      <View style={styles.totalBox}>
        <Text style={styles.muted}>{totals.itemCount} artículos · IVA incl. {formatMoney(totals.taxCents)}</Text>
        <Text style={styles.total}>{formatMoney(totals.totalCents)}</Text>
        <Pressable disabled={!cart.lines.length} style={[styles.primary, styles.big, !cart.lines.length && styles.disabled]} onPress={() => setPaying(true)}>
          <Text style={[styles.primaryText, { fontSize: 22 }]}>Cobrar</Text>
        </Pressable>
      </View>
      <Scanner visible={scan} burst onScan={addCode} onClose={() => setScan(false)} />
      {paying && (
        <PaymentModal
          totalCents={totals.totalCents}
          onClose={() => setPaying(false)}
          onPay={(method, amount) => {
            const r = finalizeSale(cart, [{ method, amountCents: amount }]);
            if (!r.ok) {
              Alert.alert('No se pudo cobrar', r.errors.join('\n'));
              return;
            }
            const sessionId = s.currentSessionId();
            const localNumber = s.nextSaleNumber();
            const today = new Date().toISOString().slice(0, 10);
            const warnings: string[] = [];
            const items = r.sale.items.map((item) => {
              const product = s.state.products[item.productId];
              if (!product?.tracksLots) return item;
              const known = productLots(s.state, item.productId);
              if (!known.some((l) => l.qty > 0)) {
                warnings.push(`"${item.name}" controla lotes pero no hay existencias por lote.`);
                return item;
              }
              const alloc = allocateSaleLine(item.baseQty, known, today);
              warnings.push(...saleLotWarnings(item.name, alloc, today));
              return alloc.lots.length ? { ...item, lots: alloc.lots } : item;
            });
            s.emit('SaleCompleted', { saleId: uuidv7(), localNumber, cashSessionId: sessionId, userId: s.config?.userId ?? 'usr_movil', fiscalNumber: null, ...r.sale, items });
            setPaying(false);
            setCart(emptyCart());
            const headline = r.sale.changeCents ? `Cambio: ${formatMoney(r.sale.changeCents)}` : 'Registrada';
            Alert.alert(`Venta #${localNumber}`, warnings.length ? `${headline}\n${warnings.join('\n')}` : headline);
          }}
        />
      )}
    </View>
  );
}

function PaymentModal({ totalCents, onPay, onClose }: { totalCents: number; onPay: (m: PaymentMethod, amount: number) => void; onClose: () => void }) {
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [received, setReceived] = useState('');
  const amount = parseMoney(received) ?? totalCents;
  const change = method === 'cash' ? amount - totalCents : 0;
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.h2}>Cobrar {formatMoney(totalCents)}</Text>
          <View style={styles.row}>
            {(['cash', 'card', 'transfer'] as PaymentMethod[]).map((m) => (
              <Pressable key={m} onPress={() => setMethod(m)} style={[styles.chip, method === m && styles.chipActive]}>
                <Text style={method === m ? styles.primaryText : undefined}>{PAYMENT_METHOD_LABELS[m]}</Text>
              </Pressable>
            ))}
          </View>
          {method === 'cash' && (
            <TextInput style={styles.input} keyboardType="numeric" placeholder={`Recibido (vacío = exacto)`} value={received} onChangeText={setReceived} />
          )}
          {method === 'cash' && (
            <Text style={[styles.change, change < 0 && { color: '#dc2626' }]}>{change >= 0 ? `Cambio ${formatMoney(change)}` : `Falta ${formatMoney(-change)}`}</Text>
          )}
          <Pressable style={[styles.primary, styles.big]} onPress={() => onPay(method, method === 'cash' ? amount : totalCents)}>
            <Text style={[styles.primaryText, { fontSize: 20 }]}>Confirmar</Text>
          </Pressable>
          <Pressable onPress={onClose} style={styles.secondary}><Text>Cancelar</Text></Pressable>
        </View>
      </View>
    </Modal>
  );
}

function PriceScreen() {
  const s = useStore();
  const [q, setQ] = useState('');
  const [scan, setScan] = useState(false);
  const hit = q ? findByBarcode(s.state, q) : null;
  const results = hit ? [hit.product] : q.length >= 2 ? searchProducts(s.state, q, 10) : [];
  return (
    <View style={styles.flex}>
      <View style={styles.row}>
        <TextInput style={[styles.input, styles.flex]} value={q} onChangeText={setQ} placeholder="Buscar precio por código o nombre" />
        <Pressable style={styles.primary} onPress={() => setScan(true)}><Text style={styles.primaryText}>📷</Text></Pressable>
      </View>
      <FlatList
        data={results}
        keyExtractor={(p) => p.id}
        renderItem={({ item }) => {
          const stock = s.state.stock[item.id] ?? 0;
          return (
            <View style={styles.card}>
              <Text style={styles.lineName}>{item.name}</Text>
              <Text style={styles.price}>{formatMoney(item.priceCents)}</Text>
              {item.prices.filter((p) => p.minQty > 1 || p.priceListId !== 'general' || p.packId).map((p, i) => (
                <Text key={i} style={styles.muted}>
                  {p.packId ? item.packs.find((k) => k.id === p.packId)?.name : p.priceListId !== 'general' ? `Lista ${p.priceListId}` : `Desde ${p.minQty} und`}: {formatMoney(p.priceCents)}
                </Text>
              ))}
              <Text style={[styles.muted, stock <= (item.minStock ?? 0) && { color: '#d97706' }]}>Stock: {stock} · Código {item.barcodes[0]}</Text>
            </View>
          );
        }}
      />
      <Scanner visible={scan} onScan={setQ} onClose={() => setScan(false)} />
    </View>
  );
}

function DashboardScreen() {
  const s = useStore();
  const today = new Date().toISOString().slice(0, 10);
  const sales = Object.values(s.state.sales).filter((x) => x.status === 'completed' && x.occurredAt.slice(0, 10) === today);
  const total = sales.reduce((a, x) => a + x.totalCents, 0);
  const profit = profitOfSale({ items: sales.flatMap((x) => x.items) });
  const byMethod: Record<string, number> = {};
  for (const x of sales) for (const p of x.payments) byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amountCents;
  const low = Object.values(s.state.products).filter((p) => p.active && p.minStock !== null && (s.state.stock[p.id] ?? 0) <= p.minStock);
  return (
    <ScrollView contentContainerStyle={{ gap: 12, padding: 4 }}>
      <View style={styles.kpis}>
        <View style={styles.kpi}><Text style={styles.muted}>Ventas hoy</Text><Text style={styles.kpiVal}>{sales.length}</Text></View>
        <View style={styles.kpi}><Text style={styles.muted}>Total</Text><Text style={styles.kpiVal}>{formatMoney(total)}</Text></View>
        <View style={styles.kpi}><Text style={styles.muted}>Utilidad</Text><Text style={[styles.kpiVal, { color: '#16a34a' }]}>{formatMoney(profit.profitCents)}</Text></View>
      </View>
      <View style={styles.card}>
        <Text style={styles.h2}>Por medio de pago</Text>
        {Object.entries(byMethod).map(([m, v]) => <Text key={m}>{PAYMENT_METHOD_LABELS[m as PaymentMethod]}: {formatMoney(v)}</Text>)}
        {!sales.length && <Text style={styles.muted}>Sin ventas hoy en este dispositivo/tienda.</Text>}
      </View>
      <View style={styles.card}>
        <Text style={styles.h2}>Bajo mínimo ({low.length})</Text>
        {low.slice(0, 15).map((p) => <Text key={p.id}>{p.name}: {s.state.stock[p.id] ?? 0}</Text>)}
      </View>
      <Text style={styles.muted}>Eventos pendientes de subir: {s.sync.pending}</Text>
    </ScrollView>
  );
}

function SettingsScreen() {
  const s = useStore();
  const [apiUrl, setApiUrl] = useState('http://10.0.2.2:4000');
  const [code, setCode] = useState(DEMO_PAIRING_CODE);
  const [busy, setBusy] = useState(false);
  return (
    <ScrollView contentContainerStyle={{ gap: 10 }}>
      {s.config && (
        <View style={styles.card}>
          <Text style={styles.h2}>{s.config.storeName}</Text>
          <Text>Modo: {s.config.mode === 'server' ? `servidor (${s.config.apiUrl})` : 'demo local'}</Text>
          <Text style={styles.muted}>Dispositivo {s.config.deviceId}</Text>
          <Text>Estado: {s.sync.state} · pendientes {s.sync.pending}</Text>
          <Text>Última sincronización: {s.sync.lastSyncAt ? new Date(s.sync.lastSyncAt).toLocaleString('es-CO') : '—'}</Text>
          {s.sync.clockWarning && <Text style={{ color: '#d97706' }}>El reloj del teléfono está desfasado. Revísalo antes de vender.</Text>}
          {s.sync.lastError && <Text style={{ color: '#dc2626' }}>{s.sync.lastError}</Text>}
          <Text style={styles.muted}>{backgroundSyncJob().note} Intervalo previsto: {backgroundSyncJob().intervalMinutes} min con red.</Text>
          <Pressable style={styles.secondary} onPress={() => s.syncNow()}><Text>Sincronizar ahora</Text></Pressable>
        </View>
      )}
      <View style={styles.card}>
        <Text style={styles.h2}>Conectar a servidor</Text>
        <Text style={styles.muted}>Emulador Android: 10.0.2.2 apunta al PC. Celular físico: usa la IP del PC en la red Wi‑Fi.</Text>
        <TextInput style={styles.input} value={apiUrl} onChangeText={setApiUrl} autoCapitalize="none" />
        <TextInput style={styles.input} value={code} onChangeText={(t) => setCode(t.toUpperCase())} autoCapitalize="characters" />
        <Pressable
          style={[styles.primary, busy && styles.disabled]}
          disabled={busy}
          onPress={async () => {
            setBusy(true);
            try {
              await s.setupServer(apiUrl, code, 'Celular Android');
              Alert.alert('Listo', 'Dispositivo registrado y catálogo descargado.');
            } catch (e) {
              Alert.alert('Error', e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Text style={styles.primaryText}>{busy ? 'Conectando…' : 'Registrar dispositivo'}</Text>
        </Pressable>
        <Pressable style={styles.secondary} onPress={() => s.setupDemo()}><Text>Usar modo demo sin servidor</Text></Pressable>
        {s.config && (
          <Pressable style={styles.secondary} onPress={() => Alert.alert('Restablecer', '¿Borrar datos locales?', [{ text: 'Cancelar' }, { text: 'Borrar', style: 'destructive', onPress: () => s.reset() }])}>
            <Text style={{ color: '#dc2626' }}>Restablecer dispositivo</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'venta', label: '🛒 Venta' },
  { id: 'precio', label: '🏷 Precio' },
  { id: 'tablero', label: '📊 Día' },
  { id: 'ajustes', label: '⚙ Ajustes' },
];

function Root() {
  const s = useStore();
  const [tab, setTab] = useState<Tab>(s.config ? 'venta' : 'ajustes');
  const current: Tab = s.config ? tab : 'ajustes';
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={styles.title}>{s.config?.storeName ?? 'POS MiniMarket'}</Text>
        <SyncBadge />
      </View>
      <View style={styles.body}>
        {current === 'venta' && <SaleScreen />}
        {current === 'precio' && <PriceScreen />}
        {current === 'tablero' && <DashboardScreen />}
        {current === 'ajustes' && <SettingsScreen />}
      </View>
      <View style={styles.tabs}>
        {TABS.map((t) => (
          <Pressable key={t.id} style={[styles.tab, current === t.id && styles.tabActive]} onPress={() => setTab(t.id)} disabled={!s.config && t.id !== 'ajustes'}>
            <Text style={[styles.tabText, current === t.id && { color: '#0f766e' }]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f1f5f9' },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderColor: '#e2e8f0' },
  title: { fontSize: 18, fontWeight: '700' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  body: { flex: 1, padding: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 8 },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 17 },
  primary: { backgroundColor: '#0f766e', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  secondary: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 10, padding: 12, alignItems: 'center', backgroundColor: '#fff' },
  big: { paddingVertical: 16 },
  disabled: { opacity: 0.4 },
  muted: { color: '#64748b' },
  line: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', padding: 10, borderRadius: 10, marginBottom: 6, gap: 8 },
  lineName: { fontSize: 16, fontWeight: '600' },
  qtyBtn: { width: 40, height: 40, borderRadius: 8, borderWidth: 1, borderColor: '#cbd5e1', alignItems: 'center', justifyContent: 'center' },
  qtyText: { fontSize: 22, fontWeight: '700' },
  qty: { minWidth: 32, textAlign: 'center', fontSize: 18, fontWeight: '700' },
  totalBox: { backgroundColor: '#fff', borderRadius: 12, padding: 12, gap: 6 },
  total: { fontSize: 40, fontWeight: '800' },
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#fff', padding: 20, gap: 12, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  h2: { fontSize: 18, fontWeight: '700' },
  chip: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  chipActive: { backgroundColor: '#0f766e', borderColor: '#0f766e' },
  change: { fontSize: 32, fontWeight: '800', color: '#16a34a' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 14, gap: 4, marginBottom: 8 },
  price: { fontSize: 32, fontWeight: '800', color: '#0f766e' },
  kpis: { flexDirection: 'row', gap: 8 },
  kpi: { flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 12 },
  kpiVal: { fontSize: 20, fontWeight: '800' },
  tabs: { flexDirection: 'row', backgroundColor: '#fff', borderTopWidth: 1, borderColor: '#e2e8f0' },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabActive: { borderTopWidth: 3, borderColor: '#0f766e' },
  tabText: { fontWeight: '600', color: '#334155' },
});
