// Gain is a function of original sample coordinates, so every read size agrees.
// Only removed gaps fade: trimmed file ends and ordinary preview boundaries do not.
export function applyJoinFades(channels, start, parts, frames) {
  if (!frames || !channels.length || !parts.length) return channels;
  const end = start + channels[0].length;
  let low = 0,
    high = parts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (parts[mid][1] <= start) low = mid + 1;
    else high = mid;
  }
  for (let index = low; index < parts.length && parts[index][0] < end; index++) {
    const [a, b] = parts[index];
    const incoming = index > 0 && a > parts[index - 1][1];
    const outgoing = index + 1 < parts.length && b < parts[index + 1][0];
    const length = Math.min(frames, Math.max(1, Math.floor((b - a) / (incoming && outgoing ? 2 : 1))));
    function ramp(first, last, gain) {
      for (let frame = Math.max(start, first); frame < Math.min(end, last); frame++) {
        const value = gain(frame) / Math.max(1, length - 1);
        for (const channel of channels) channel[frame - start] *= value;
      }
    }
    if (incoming) ramp(a, a + length, (frame) => frame - a);
    if (outgoing) ramp(b - length, b, (frame) => b - 1 - frame);
  }
  return channels;
}
