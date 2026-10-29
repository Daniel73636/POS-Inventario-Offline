'use client';

import dynamic from 'next/dynamic';

// La caja es 100 % cliente: lee y escribe la base local, nunca depende del servidor para vender.
const PosApp = dynamic(() => import('@/components/PosApp'), {
  ssr: false,
  loading: () => <div className="center-screen">Cargando caja…</div>,
});

export default function Page() {
  return <PosApp />;
}
