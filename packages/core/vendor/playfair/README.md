# Vendored PlayFair implementation

These files are the GPL PlayFair implementation distributed with
[UxPlay](https://github.com/FDH2/UxPlay), pinned to upstream commit
`3ca7526387e894d6848b84c209de361c3bedd1ec` (retrieved 2026-07-16).

The original PlayFair work is credited by UxPlay to Esteban Kubata. The
unmodified upstream C sources are retained here as the corresponding source for
the small, platform-neutral WebAssembly module used by `@openmirror/core`.
`wasm_api.c` is OpenMirror's freestanding adapter and can be rebuilt with:

```sh
node tools/build-playfair-wasm.js
```

The adapter exports a fixed scratch buffer and one decrypt operation. It has no
filesystem, network, clock, or other host imports.

See `LICENSE.md` in this directory and the repository's GPL-3.0 license.
