const bindings = new Map([
  ['api.getrelative.trade', 'LIVE_API_ORIGIN'],
  ['fixture-api.getrelative.trade', 'FIXTURE_API_ORIGIN'],
  ['signer.getrelative.trade', 'SIGNER_ORIGIN'],
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const binding = bindings.get(url.hostname);
    if (!binding) return new Response('Unknown service', { status: 404 });
    const origin = env[binding];
    if (!origin) return new Response('Service unavailable', { status: 503 });
    const target = new URL(url.pathname + url.search, origin);
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('forwarded');
    headers.delete('x-forwarded-host');
    headers.delete('x-forwarded-for');
    const client = request.headers.get('cf-connecting-ip');
    if (client) headers.set('x-forwarded-for', client);
    headers.delete('x-relative-gateway');
    if (env.GATEWAY_SECRET && binding !== 'SIGNER_ORIGIN') headers.set('x-relative-gateway', env.GATEWAY_SECRET);
    try {
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'manual',
        cache: 'no-store',
      });
      const response = new Response(upstream.body, upstream);
      response.headers.set('cache-control', 'no-store');
      return response;
    } catch {
      return new Response('Service unavailable', { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  },
};
