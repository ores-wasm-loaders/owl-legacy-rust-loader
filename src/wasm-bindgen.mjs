// The shared Rust/Wasm lifecycle.
//
// Every Rust web build in the fleet — Leptos islands, Dioxus routes, a plain wasm-bindgen
// bundle — reaches the browser the same way: a generated JS glue module that knows how to
// instantiate exactly one companion `.wasm`, and exported functions the page then calls.
// What differs is only the last step, so that is the only thing the framework adapters
// below override.
//
// What is emphatically NOT shared: the glue itself. It is generated for one module's
// imports and exports and belongs to that release. This package wraps the lifecycle; it
// never substitutes one app's glue for another's.

const WASM = 'application/wasm';

/** The glue and module entrypoints of a release, or a clear error naming what is missing. */
export function rustEntrypoints(manifest) {
  const glue = manifest.entrypoints.find((e) => e.role === 'glue');
  const module = manifest.entrypoints.find((e) => e.role === 'module');
  if (!glue) throw new Error(`${manifest.appId}: no entrypoint with role \`glue\` — the wasm-bindgen JS is part of the release`);
  if (!module) throw new Error(`${manifest.appId}: no entrypoint with role \`module\``);
  return { glue, module };
}

/**
 * Build a Rust adapter.
 *
 * @param interfaces  the owl-interfaces module (injected so this package has no import-time
 *                    dependency on a resolver, and so tests can supply a stub).
 * @param start       `(exports, caps, manifest, options) => instance` — the framework step.
 * @param importModule how to load the glue module. Injected for testability; the default is
 *                    a dynamic import, which is legal here because this runs in ACTIVATION.
 */
export function createRustAdapter({ framework, interfaces, start, importModule = (url) => import(url) }) {
  return {
    framework,
    supports: ['fetch', 'compile'],

    plan(manifest) {
      // Ordering (entrypoints, then critical, then optional; never lazy) is owl-interfaces'
      // rule, kept in one place so every framework prepares in the same order.
      return interfaces.preparableAssets(manifest);
    },

    async activate(caps, manifest, options = {}) {
      const { glue, module } = rustEntrypoints(manifest);
      const glueUrl = `${manifest.baseUrl}${glue.path}`;
      const moduleUrl = `${manifest.baseUrl}${module.path}`;

      const glueModule = await importModule(glueUrl);
      const init = glueModule.default ?? glueModule.init;
      if (typeof init !== 'function') {
        throw new Error(`${manifest.appId}: the glue module at ${glue.path} exports no init function`);
      }

      // Reuse a module preparation compiled earlier, when preparation got that far. When it
      // did not — cancelled, over budget, never started — this is simply a URL, and the
      // browser's own cache decides whether the bytes are already local.
      const preparedModule = caps.prepared.get(module.path);
      const source = preparedModule?.kind === 'module' && preparedModule.module ? preparedModule.module : moduleUrl;

      const exports = (await init({ module_or_path: source })) ?? glueModule;
      caps.log?.(`[owl-rust] ${manifest.appId} initialized from ${typeof source === 'string' ? 'url' : 'prepared module'}`);

      return start(exports.__owl_exports ?? glueModule, caps, manifest, options);
    },

    /** Preparation is the shared default: fetch, and compile only where it is permitted. */
    async prepareAsset(caps, item, url) {
      const response = await caps.fetch(url, { signal: caps.signal, credentials: 'omit', mode: 'cors' });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      if (caps.compileStreaming && item.contentType === WASM) {
        return { kind: 'module', module: await caps.compileStreaming(response), bytes: item.bytes };
      }
      const body = await response.arrayBuffer();
      return { kind: 'bytes', bytes: body.byteLength };
    },
  };
}
