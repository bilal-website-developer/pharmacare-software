export function centralApiEndpoint(baseUrl: string, route: string): URL {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash) {
    throw new TypeError('CENTRAL_API_URL must not contain credentials, query parameters, or a fragment.');
  }
  if (!route.startsWith('/')) throw new TypeError('Central API routes must be absolute paths.');
  const basePath = base.pathname.replace(/\/+$/, '');
  return new URL(`${basePath}${route}`, base.origin);
}
