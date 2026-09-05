// Leptos islands.
//
// In islands mode the page is server-rendered and only the marked islands become
// interactive: the release exports `hydrate_islands()`, not a whole-app mount. Two things
// follow, and both are enforced here rather than left to each product to remember:
//
//   * hydration happens once per document. Several islands entering the viewport at the
//     same moment must not each initialize the module — the coordinator de-duplicates the
//     activation, and this adapter refuses a second hydration of the same release anyway.
//   * an island boundary is not automatically a separate download. Whether the islands ship
//     as one bundle or several is decided by the emitted build graph and recorded in the
//     manifest; nothing here may assume one shape or the other.
import { createRustAdapter } from './wasm-bindgen.mjs';

const hydrated = new WeakSet();

export function createLeptosAdapter({ interfaces, importModule } = {}) {
  return createRustAdapter({
    framework: 'leptos',
    interfaces,
    importModule,
    start(exports, caps, manifest, options) {
      const declared = manifest.activation.islands ?? [];
      if (manifest.activation.mode !== 'hydrate-islands') {
        // A Leptos release may legitimately be a whole-app mount; honor what it declares.
        const mount = exports.main ?? exports.hydrate;
        if (typeof mount !== 'function') throw new Error(`${manifest.appId}: no \`main\`/\`hydrate\` export for run-app activation`);
        mount(options.host ?? undefined);
        return { framework: 'leptos', mode: manifest.activation.mode, islands: [] };
      }

      const hydrate = exports.hydrate_islands ?? exports.hydrateIslands;
      if (typeof hydrate !== 'function') {
        throw new Error(`${manifest.appId}: islands activation needs a \`hydrate_islands\` export (Leptos islands mode)`);
      }
      if (hydrated.has(exports)) {
        caps.log?.(`[owl-leptos] ${manifest.appId} already hydrated in this document`);
        return { framework: 'leptos', mode: 'hydrate-islands', islands: declared, alreadyHydrated: true };
      }

      hydrate();
      hydrated.add(exports);

      // The islands the release claims must actually be in the document; a silent mismatch
      // here is how "the button does nothing" bugs reach production.
      const present = declared.filter((name) => caps.document.querySelector?.(`[data-island="${name}"]`));
      const missing = declared.filter((name) => !present.includes(name));
      if (missing.length) caps.log?.(`[owl-leptos] ${manifest.appId}: declared islands not present in this document: ${missing.join(', ')}`);

      return { framework: 'leptos', mode: 'hydrate-islands', islands: present, missing };
    },
  });
}
