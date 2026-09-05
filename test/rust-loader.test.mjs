import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePackage } from './resolve.mjs';

const { createCoordinator } = await import(resolvePackage('owl-coordinator', 'ores-wasm-loaders'));
import { createLeptosAdapter, createDioxusAdapter, createRustAdapter, chunkForRoute, rustEntrypoints } from '../index.mjs';
import { interfaces, manifests, testEnv, fakeDocument } from './helpers.mjs';

const validate = (m) => interfaces.checkManifest(m, interfaces.manifestSchema);

/** A stand-in for a wasm-bindgen glue module: records how it was initialized. */
function fakeGlue(exports = {}) {
  const calls = { init: [], hydrate: 0, mount: [] };
  const mod = {
    calls,
    async default({ module_or_path: source }) {
      calls.init.push(typeof source === 'string' ? 'url' : 'module');
      return undefined;
    },
    hydrate_islands() {
      calls.hydrate += 1;
    },
    mount_route(host, route) {
      calls.mount.push({ host, route });
    },
    ...exports,
  };
  return mod;
}

function documentWithIslands(names) {
  const doc = fakeDocument();
  doc.querySelector = (selector) => {
    const m = selector.match(/data-island="([^"]+)"/);
    return m && names.includes(m[1]) ? { island: m[1] } : null;
  };
  return doc;
}

test('the glue module and its companion wasm are named by the manifest, not by convention', () => {
  const { glue, module } = rustEntrypoints(manifests.leptos);
  assert.equal(glue.path, 'islands.js');
  assert.equal(module.path, 'islands_bg.wasm');
  assert.throws(
    () => rustEntrypoints({ ...manifests.leptos, entrypoints: manifests.leptos.entrypoints.filter((e) => e.role !== 'glue') }),
    /no entrypoint with role `glue`/,
  );
});

test('leptos activation hydrates islands once and reports which are present', async () => {
  const glue = fakeGlue();
  const document = documentWithIslands(['PricingCalculator', 'SignupWizard']);
  const env = testEnv({ document });
  const adapter = createLeptosAdapter({ interfaces, importModule: async () => glue });
  const coordinator = createCoordinator({ env, validate, adapters: [adapter] });
  coordinator.register(manifests.leptos);

  const instance = await coordinator.activate('owl-fixture-leptos');
  assert.equal(glue.calls.hydrate, 1);
  assert.deepEqual(instance.islands, ['PricingCalculator', 'SignupWizard']);
  assert.deepEqual(instance.missing, ['StatusTicker']);

  // A second activation in the same document reuses the instance; the module is never
  // initialized twice, however many islands ask for it.
  const again = await coordinator.activate('owl-fixture-leptos');
  assert.equal(again, instance);
  assert.equal(glue.calls.init.length, 1);
});

test('a compiled module from preparation is handed to init; without it, the URL is', async () => {
  const wasm = { compileStreaming: async () => ({ fake: 'module' }), Function: function () {} };

  const warm = fakeGlue();
  const warmCoordinator = createCoordinator({
    env: testEnv({ wasm, document: documentWithIslands([]) }),
    validate,
    adapters: [createLeptosAdapter({ interfaces, importModule: async () => warm })],
  });
  warmCoordinator.register(manifests.leptos);
  await warmCoordinator.prepare('owl-fixture-leptos');
  await warmCoordinator.activate('owl-fixture-leptos');
  assert.deepEqual(warm.calls.init, ['module'], 'prepared compilation should be reused');

  const cold = fakeGlue();
  const coldCoordinator = createCoordinator({
    env: testEnv({ wasm, document: documentWithIslands([]) }),
    validate,
    adapters: [createLeptosAdapter({ interfaces, importModule: async () => cold })],
  });
  coldCoordinator.register(manifests.leptos);
  await coldCoordinator.activate('owl-fixture-leptos');
  assert.deepEqual(cold.calls.init, ['url'], 'cold entry must still work');
});

test('leptos refuses to hydrate a release that exports no hydrate_islands', async () => {
  const glue = fakeGlue({ hydrate_islands: undefined });
  const coordinator = createCoordinator({
    env: testEnv({ document: documentWithIslands([]) }),
    validate,
    adapters: [createLeptosAdapter({ interfaces, importModule: async () => glue })],
  });
  coordinator.register(manifests.leptos);
  await assert.rejects(() => coordinator.activate('owl-fixture-leptos'), /needs a `hydrate_islands` export/);
});

test('dioxus mounts the chunk the build graph declares for the route', async () => {
  const glue = fakeGlue();
  const host = { id: 'dioxus-root' };
  const document = fakeDocument();
  document.querySelector = (s) => (s === '#dioxus-root' ? host : null);
  const coordinator = createCoordinator({
    env: testEnv({ document }),
    validate,
    adapters: [createDioxusAdapter({ interfaces, importModule: async () => glue })],
  });
  coordinator.register(manifests.dioxus);

  const instance = await coordinator.activate('owl-fixture-dioxus', { route: '/app/reports' });
  assert.equal(instance.chunk, 'chunks/reports.wasm');
  assert.deepEqual(glue.calls.mount, [{ host, route: '/app/reports' }]);
});

test('route resolution prefers the longest declared prefix and refuses unknown routes', async () => {
  assert.equal(chunkForRoute(manifests.dioxus, '/app'), 'chunks/app.wasm');
  assert.equal(chunkForRoute(manifests.dioxus, '/app/reports/42'), 'chunks/reports.wasm');
  assert.equal(chunkForRoute(manifests.dioxus, '/marketing'), null);

  const coordinator = createCoordinator({
    env: testEnv({ document: fakeDocument() }),
    validate,
    adapters: [createDioxusAdapter({ interfaces, importModule: async () => fakeGlue() })],
  });
  coordinator.register(manifests.dioxus);
  await assert.rejects(
    () => coordinator.activate('owl-fixture-dioxus', { host: {}, route: '/marketing' }),
    /maps to no chunk in this release/,
  );
});

test('the shared adapter prepares in the interfaces order and refuses a missing init export', async () => {
  const adapter = createRustAdapter({
    framework: 'wasm-bindgen',
    interfaces,
    importModule: async () => ({ notInit: true }),
    start: () => ({}),
  });
  assert.deepEqual(
    adapter.plan(manifests.leptos).map((i) => i.path),
    interfaces.preparableAssets(manifests.leptos).map((i) => i.path),
  );

  const coordinator = createCoordinator({ env: testEnv({ document: fakeDocument() }), validate, adapters: [adapter] });
  coordinator.register({ ...manifests.leptos, framework: 'wasm-bindgen', activation: { mode: 'run-app' } });
  await assert.rejects(() => coordinator.activate('owl-fixture-leptos', { host: {} }), /exports no init function/);
});
