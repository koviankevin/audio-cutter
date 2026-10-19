import { floatToInt16 } from './pcm.mjs';

// Float32 input avoids round-tripping through Int16 and batches each bounded
// source chunk into one native LAME call. Assets are pinned and served locally.
export async function createMp3Encoder(channels, sampleRate) {
  try {
    if (!globalThis.WebAssembly) throw Error('WebAssembly unavailable');
    if (!self.WasmMediaEncoder) self.importScripts('./vendor/WasmMediaEncoder-0.7.0.min.js');
    const response = await fetch(new URL('./vendor/lame-0.7.0.wasm', import.meta.url));
    if (!response.ok) throw Error('Encoder resource unavailable');
    const native = await self.WasmMediaEncoder.createEncoder('audio/mpeg', await response.arrayBuffer());
    native.configure({ channels, sampleRate, outputSampleRate: sampleRate, bitrate: 192 });
    return {
      kind: 'wasm',
      wasmBytes: () => native.module.memory.buffer.byteLength,
      encode(data) {
        // Match the existing export path's clipping/nonfinite handling.
        for (const channel of data)
          for (let i = 0; i < channel.length; i++) {
            const value = channel[i];
            if (!Number.isFinite(value)) channel[i] = 0;
            else if (value > 1) channel[i] = 1;
            else if (value < -1) channel[i] = -1;
          }
        return native.encode(data);
      },
      flush: () => native.finalize(),
    };
  } catch {
    if (!self.lamejs) self.importScripts('./vendor/lame.min.js');
    const encoder = new self.lamejs.Mp3Encoder(channels, sampleRate, 192);
    return {
      kind: 'lamejs',
      encode(data) {
        const samples = data.map(floatToInt16);
        return encoder.encodeBuffer(samples[0], samples[1]);
      },
      flush: () => encoder.flush(),
    };
  }
}
