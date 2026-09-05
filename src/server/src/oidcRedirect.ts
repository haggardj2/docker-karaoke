export function buildOidcGrantCallbackUrl(redirectUri: string, requestOriginalUrl: string): URL {
  const callbackUrl = new URL(redirectUri);
  const requestUrl = new URL(requestOriginalUrl, callbackUrl);
  callbackUrl.search = requestUrl.search;
  callbackUrl.hash = '';
  return callbackUrl;
}
