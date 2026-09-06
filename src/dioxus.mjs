// Dioxus route chunks.
//
// Dioxus can split a full-stack app into per-route Wasm chunks. The adapter's job is to
// cooperate with that splitter — mount the route the visitor asked for and let the framework
// pull the chunk it owns — never to re-implement splitting on top of it.
import { createRustAdapter } from './wasm-bindgen.mjs';

/** The chunk a route maps to, as recorded from the emitted build graph. */
export function chunkForRoute(manifest, route) {
  const routes = manifest.activation.routes ?? {};
  if (routes[route]) return routes[route];
  // Longest declared prefix wins, so `/app/reports/42` resolves to the `/app/reports` chunk.
  const prefix = Object.keys(routes)
    .filter((r) => route === r || route.startsWith(r.endsWith('/') ? r : `${r}/`))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? routes[prefix] : null;
}

export function createDioxusAdapter({ interfaces, importModule } = {}) {
  return createRustAdapter({
    framework: 'dioxus',
    interfaces,
    importModule,
    start(exports, caps, manifest, options) {
      const host = options.host ?? (manifest.activation.hostSelector ? caps.document.querySelector(manifest.activation.hostSelector) : null);
      if (!host) throw new Error(`${manifest.appId}: no host element (looked for ${manifest.activation.hostSelector ?? 'options.host'})`);

      if (manifest.activation.mode !== 'mount-route') {
        const run = exports.main ?? exports.run;
        if (typeof run !== 'function') throw new Error(`${manifest.appId}: no \`main\`/\`run\` export`);
        run(host);
        return { framework: 'dioxus', mode: manifest.activation.mode, route: null };
      }

      const route = options.route ?? '/';
      const chunk = chunkForRoute(manifest, route);
      if (!chunk) {
        throw new Error(`${manifest.appId}: route ${route} maps to no chunk in this release (declared: ${Object.keys(manifest.activation.routes ?? {}).join(', ') || 'none'})`);
      }

      const mount = exports.mount_route ?? exports.mountRoute ?? exports.main;
      if (typeof mount !== 'function') throw new Error(`${manifest.appId}: no \`mount_route\`/\`main\` export for route activation`);
      mount(host, route);
      caps.log?.(`[owl-dioxus] ${manifest.appId} mounted ${route} (chunk ${chunk})`);

      return { framework: 'dioxus', mode: 'mount-route', route, chunk, host };
    },
  });
}
