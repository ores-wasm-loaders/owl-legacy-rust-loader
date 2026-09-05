// owl-rust-loader — the shared Rust/Wasm adapter family (wasm-bindgen, Leptos, Dioxus).
export { createRustAdapter, rustEntrypoints } from './src/wasm-bindgen.mjs';
export { createLeptosAdapter } from './src/leptos.mjs';
export { createDioxusAdapter, chunkForRoute } from './src/dioxus.mjs';
