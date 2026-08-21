# Third-party notices

Jixu's reference TUI uses standard Unicode text glyphs. No third-party icon,
font, or raster asset is embedded for that system.

The reference TUI includes these generated Tree-sitter parser assets:

- `tree-sitter-bash` 0.25.1, Copyright (c) 2017 Max Brunsfeld, MIT;
- `tree-sitter-python` 0.25.0, Copyright (c) 2016 Max Brunsfeld, MIT.

Each parser's WASM and `highlights.scm` are generated from the exact npm release
declared in `tree-sitter.parsers.json`. The corresponding MIT license is shipped
beside each parser under `dist/tree-sitter-assets/`.

The standalone reference TUI also bundles the following MIT-licensed packages
for lossless PNG encoding:

- `fast-png` 8.0.0, Copyright (c) 2015 Michaël Zasso;
- `fflate` 0.8.3, Copyright (c) 2026 Arjun Barrett;
- `iobuffer` 6.0.1, Copyright (c) 2015 Michaël Zasso.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
