/** Sonidos distintos: escaneo correcto, producto no encontrado y error/alerta de stock. */
let ctx: AudioContext | null = null;

function beep(freq: number, ms: number, type: OscillatorType = 'sine', times = 1): void {
  try {
    ctx ??= new AudioContext();
    const ac = ctx;
    for (let i = 0; i < times; i++) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.value = 0.08;
      osc.connect(gain).connect(ac.destination);
      const start = ac.currentTime + i * (ms / 1000 + 0.05);
      osc.start(start);
      osc.stop(start + ms / 1000);
    }
  } catch {
    /* sin audio disponible */
  }
}

export const sounds = {
  ok: () => beep(1400, 60),
  notFound: () => beep(300, 180, 'square', 2),
  stock: () => beep(650, 120, 'triangle', 2),
  paid: () => beep(990, 90, 'sine', 2),
};
