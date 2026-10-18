# lamejs 1.2.1

MP3 encoder: https://github.com/zhuker/lamejs

`lame.min.js` is the unmodified browser distribution from https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js.

SHA-256: `15d285e2587b3bdbfd18a68de6ce07cc074f7480a82c3815da2dc1c348ec6df4`

The library is licensed under LGPL-3.0; see `lamejs-LICENSE.txt`. Corresponding source for the pinned release is available at https://registry.npmjs.org/lamejs/-/lamejs-1.2.1.tgz. This library is kept as a separate, replaceable file and is not included under the application's MIT license.

# mpg123-decoder 1.0.3

`mpg123-decoder.min.js` is the unmodified `dist/mpg123-decoder.min.js` from
https://registry.npmjs.org/mpg123-decoder/-/mpg123-decoder-1.0.3.tgz.
The WebAssembly bytes are embedded; no CDN request is needed at runtime.

SHA-256: `c13a80f0455795eb0c8a1c7844fb5e567cf37acc00fdd3e1f3e6b89f7b4601ce`

JavaScript wrapper: Copyright 2021–2025 Ethan Halsall, MIT
(`mpg123-decoder-LICENSE.txt`). Bundled libmpg123: Copyright (c) 1995–2020
Michael Hipp and others, LGPL-2.1 (`mpg123-LICENSE.txt`). These third-party
components retain their own licenses, separately from the application.

Corresponding source and build scripts, pinned to the published package's gitHead:
https://github.com/eshaz/wasm-audio-decoders/tree/8f2428c1cd96b54dab74836c8471ff75fe35cbee

The libmpg123 submodule at that revision is:
https://github.com/madebr/mpg123/tree/08247b317163175e62035893af3ff9e71a5dfefd

Source archives:
https://github.com/eshaz/wasm-audio-decoders/archive/8f2428c1cd96b54dab74836c8471ff75fe35cbee.tar.gz
https://github.com/madebr/mpg123/archive/08247b317163175e62035893af3ff9e71a5dfefd.tar.gz

The decoder is a separate, replaceable file. To rebuild with modifications,
check out the pinned wrapper repository, initialize its submodules, and follow
its Emscripten build instructions; replace this file with the resulting bundle.
