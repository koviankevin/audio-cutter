export function floatToInt16(samples) {
  const output = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i] || 0));
    output[i] = Math.round(value < 0 ? value * 32768 : value * 32767);
  }
  return output;
}

export function wavHeader(frames, channels, sampleRate) {
  const dataBytes = frames * channels * 2;
  if (dataBytes + 36 > 0xffffffff) throw new Error('WAV 檔案超過格式上限。');
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, dataBytes + 36, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, dataBytes, true);
  return bytes;
}

export function interleavePCM(channels) {
  const bytes = new Uint8Array(channels[0].length * channels.length * 2);
  const view = new DataView(bytes.buffer);
  const converted = channels.map(floatToInt16);
  let offset = 0;
  for (let i = 0; i < channels[0].length; i++) {
    for (const channel of converted) { view.setInt16(offset, channel[i], true); offset += 2; }
  }
  return bytes;
}
