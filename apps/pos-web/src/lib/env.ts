/** Modo demo (catálogo local, PINs conocidos). Por defecto sólo fuera de producción. */
export const DEMO_MODE =
  process.env.NEXT_PUBLIC_DEMO_MODE !== undefined
    ? process.env.NEXT_PUBLIC_DEMO_MODE === 'true'
    : process.env.NODE_ENV !== 'production';
