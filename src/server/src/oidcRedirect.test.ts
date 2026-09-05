import { describe, expect, it } from 'vitest';
import { buildOidcGrantCallbackUrl } from './oidcRedirect.js';

describe('buildOidcGrantCallbackUrl', () => {
  it('keeps the configured redirect origin and path', () => {
    const url = buildOidcGrantCallbackUrl(
      'https://karaoke.example.com/api/auth/oidc/callback',
      '/api/auth/oidc/callback?code=abc&state=xyz',
    );

    expect(url.href).toBe('https://karaoke.example.com/api/auth/oidc/callback?code=abc&state=xyz');
  });

  it('does not replace the configured redirect URI with an internal proxy URL', () => {
    const url = buildOidcGrantCallbackUrl(
      'https://karaoke.example.com/api/auth/oidc/callback',
      'http://karaoke-api:5174/api/auth/oidc/callback?code=abc&state=xyz',
    );

    expect(url.href).toBe('https://karaoke.example.com/api/auth/oidc/callback?code=abc&state=xyz');
  });
});
