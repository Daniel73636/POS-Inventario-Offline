import { useMemo, useState } from "react";
import { SafeAreaView, Text, TextInput, Pressable, FlatList, View, StyleSheet } from "react-native";
import { StatusBar } from "expo-status-bar";

type Product = { id: string; name: string; barcode: string; priceCents: number };
type Line = { product: Product; qty: number };

const DEMO: Product[] = [
  { id: "1", name: "Agua 600ml", barcode: "7701001001001", priceCents: 2500 },
  { id: "2", name: "Gaseosa 1.5L", barcode: "7701001001002", priceCents: 5500 },
  { id: "3", name: "Pan tajado", barcode: "7701001001003", priceCents: 4800 },
  { id: "4", name: "Leche 1L", barcode: "7701001001005", priceCents: 4200 },
];

export default function App() {
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<Line[]>([]);

  const total = useMemo(() => cart.reduce((s, l) => s + l.product.priceCents * l.qty, 0), [cart]);

  function add(p: Product) {
    setCart((prev) => {
      const i = prev.findIndex((x) => x.product.id === p.id);
      if (i >= 0) {
        const copy = [...prev];
        copy[i] = { ...copy[i]!, qty: copy[i]!.qty + 1 };
        return copy;
      }
      return [...prev, { product: p, qty: 1 }];
    });
  }

  const filtered = DEMO.filter(
    (p) => p.name.toLowerCase().includes(query.toLowerCase()) || p.barcode.includes(query),
  );

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <Text style={styles.title}>POS Android</Text>
      <Text style={styles.sub}>Venta móvil · dominio compartido @pos/domain-pos</Text>
      <TextInput
        style={styles.input}
        placeholder="Buscar / escanear código"
        placeholderTextColor="#8aa"
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={() => {
          const p = DEMO.find((x) => x.barcode === query.trim());
          if (p) { add(p); setQuery(""); }
        }}
      />
      <FlatList
        data={filtered}
        keyExtractor={(i) => i.id}
        style={{ flex: 1 }}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => add(item)}>
            <Text style={styles.name}>{item.name}</Text>
            <Text style={styles.price}>${item.priceCents}</Text>
          </Pressable>
        )}
      />
      <View style={styles.footer}>
        <Text style={styles.total}>Total ${total}</Text>
        <Pressable style={styles.pay} onPress={() => setCart([])}>
          <Text style={styles.payText}>{cart.length ? "Cobrar / Limpiar" : "Carrito vacío"}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#10141c", padding: 16 },
  title: { color: "#fff", fontSize: 28, fontWeight: "800" },
  sub: { color: "#9aa8c2", marginBottom: 12 },
  input: { backgroundColor: "#1a2230", color: "#fff", borderRadius: 12, padding: 14, marginBottom: 12, borderColor: "#22c55e", borderWidth: 1 },
  row: { paddingVertical: 14, borderBottomColor: "#2a3447", borderBottomWidth: 1, flexDirection: "row", justifyContent: "space-between" },
  name: { color: "#eef3ff", fontSize: 16 },
  price: { color: "#22c55e", fontWeight: "700" },
  footer: { paddingTop: 12, gap: 8 },
  total: { color: "#22c55e", fontSize: 32, fontWeight: "800" },
  pay: { backgroundColor: "#22c55e", borderRadius: 12, padding: 16, alignItems: "center" },
  payText: { color: "#052e16", fontWeight: "800", fontSize: 16 },
});
