# Third-party notices

Jixu's reference TUI uses standard Unicode text glyphs. No third-party icon,
font, or raster asset is embedded for that system.

The reference TUI includes these generated Tree-sitter parser assets:

- `tree-sitter-bash` 0.25.1, Copyright (c) 2017 Max Brunsfeld, MIT;
- `tree-sitter-python` 0.25.0, Copyright (c) 2016 Max Brunsfeld, MIT.

Each parser's WASM and `highlights.scm` are generated from the exact npm release
declared in `tree-sitter.parsers.json`. The corresponding MIT license is shipped
beside each parser under `dist/tree-sitter-assets/`.
