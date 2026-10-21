import { createApi, json } from './app.js';
import { githubStore } from './github-store.js';
let service, configuredEnvironment;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (!service || configuredEnvironment !== env) {
        try {
          service = createApi(env, githubStore(env));
          configuredEnvironment = env;
        } catch (error) {
          return json({ error: error.message }, 503);
        }
      }
      return service(request);
    }
    if (['/', '/admin', '/admin/'].includes(url.pathname))
      return Response.redirect(url.origin + '/admin.html', 302);
    if (url.pathname !== '/admin.html' && !/^\/(js|css|images|fonts|lib)\//.test(url.pathname))
      return new Response('Not found', { status: 404 });
    const asset = await env.ASSETS.fetch(new Request(url, request));
    const response = new Response(asset.body, asset);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src https://docs.google.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    return response;
  },
};
