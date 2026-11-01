/**
 * Sincronización en segundo plano (WorkManager).
 *
 * Hoy el celular sólo sube y baja eventos mientras la app está abierta:
 * `SyncClient` corre cada 20 s en el proceso de JS. Android puede matar ese
 * proceso al pasar a segundo plano, así que las ventas quedan en SQLite hasta
 * que alguien abre la app.
 *
 * El trabajo nativo previsto, cuando se enlace WorkManager (módulo propio o
 * `expo-task-manager` + una tarea periódica), es este:
 */
export interface BackgroundSyncJob {
  id: 'pos-sync';
  /** PeriodicWorkRequest. No menos de 15 min: es el mínimo de WorkManager. */
  intervalMinutes: 15;
  constraints: { network: 'connected'; batteryNotLow: true };
  /** Qué haría el worker: push de pendientes y pull desde el cursor, igual que SyncClient.syncNow. */
  steps: Array<'push-pending' | 'pull-cursor' | 'persist-sqlite'>;
  note: string;
}

export function backgroundSyncJob(): BackgroundSyncJob {
  return {
    id: 'pos-sync',
    intervalMinutes: 15,
    constraints: { network: 'connected', batteryNotLow: true },
    steps: ['push-pending', 'pull-cursor', 'persist-sqlite'],
    note: 'WorkManager no está enlazado. La caja Android sincroniza sólo con la app abierta.',
  };
}
