type RandomSource = (bytes: Uint8Array) => Uint8Array;

let randomSource: RandomSource = (bytes) => {
  const c = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) return c.getRandomValues(bytes);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
};

/** Permite inyectar una fuente aleatoria (p. ej. expo-crypto en Android o una semilla en pruebas). */
export function setRandomSource(source: RandomSource): void {
  randomSource = source;
}

/** UUIDv7: 48 bits de tiempo + aleatorio. Ordenable por tiempo, generado en el dispositivo. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomSource(new Uint8Array(16));
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
