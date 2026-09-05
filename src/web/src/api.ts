// Check for runtime config injected by container startup
const runtimeConfig = (window as any).__ENV__;
const envBase = runtimeConfig?.API_BASE?.trim() || (import.meta as any).env?.VITE_API_BASE?.trim();
const devDefault = 'http://localhost:5174';
const inferredBase =
  typeof window !== 'undefined' && window.location?.origin
    ? ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname)
      ? devDefault
      : window.location.origin
    : undefined;

export const API_BASE = envBase || inferredBase || devDefault;

export async function api(path: string, init?: RequestInit) {
  const r = await fetch(API_BASE + path, init);
  if (!r.ok) {
    const text = await r.text();
    let message = text || r.statusText;
    try {
      const body = JSON.parse(text);
      if (typeof body?.error === 'string') message = body.error;
      else if (typeof body?.message === 'string') message = body.message;
    } catch {
      // Keep the plain text response.
    }
    throw new Error(message || `HTTP ${r.status}`);
  }
  return r.json();
}

export function getWsUrl(sessionToken?: string) {
  const url = new URL(API_BASE.replace(/^http/, 'ws') + '/ws');
  if (sessionToken) {
    url.searchParams.set('sessionToken', sessionToken);
  }
  return url.toString();
}

export const wsUrl = getWsUrl();
