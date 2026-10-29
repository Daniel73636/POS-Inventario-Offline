'use client';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export function getToken(): string | null {
  return typeof window === 'undefined' ? null : localStorage.getItem('panel:token');
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string | string[]; issues?: Array<{ path: string; message: string }> };
    if (res.status === 401 && typeof window !== 'undefined' && path !== '/v1/auth/login') {
      localStorage.removeItem('panel:token');
      window.dispatchEvent(new Event('panel:logout'));
    }
    const message = Array.isArray(body.message) ? body.message.join('; ') : body.message;
    throw new ApiError(res.status, body.issues?.map((e) => `${e.path}: ${e.message}`).join('; ') || message || `Error ${res.status}`);
  }
  return (await res.json()) as T;
}
