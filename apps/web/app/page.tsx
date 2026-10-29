'use client';

import dynamic from 'next/dynamic';

const Panel = dynamic(() => import('@/Panel'), { ssr: false, loading: () => <p className="pad">Cargando panel…</p> });

export default function Page() {
  return <Panel />;
}
