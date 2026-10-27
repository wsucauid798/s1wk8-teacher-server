// Reverse sample FRAMES, preserving the channels within each frame.
export function reverseWav(input) {
  const b = Buffer.from(input);
  if (
    b.length < 44 ||
    b.toString('ascii', 0, 4) !== 'RIFF' ||
    b.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new Error('Choose an uncompressed PCM 16-bit WAV file.');
  let fmt = null,
    data = null;
  for (let p = 12; p + 8 <= b.length; ) {
    const size = b.readUInt32LE(p + 4),
      end = p + 8 + size;
    if (end > b.length) throw new Error('Incomplete WAV file.');
    const id = b.toString('ascii', p, p + 4);
    if (id === 'fmt ' && size >= 16)
      fmt = {
        format: b.readUInt16LE(p + 8),
        channels: b.readUInt16LE(p + 10),
        block: b.readUInt16LE(p + 20),
        bits: b.readUInt16LE(p + 22),
      };
    if (id === 'data') data = { start: p + 8, size };
    p = end + (size % 2);
  }
  if (
    !fmt ||
    !data ||
    fmt.format !== 1 ||
    fmt.bits !== 16 ||
    fmt.channels < 1 ||
    fmt.channels > 8 ||
    fmt.block !== fmt.channels * 2 ||
    data.size < fmt.block ||
    data.size % fmt.block
  )
    throw new Error('Choose an uncompressed PCM 16-bit WAV file.');
  const result = Buffer.from(b),
    count = data.size / fmt.block;
  for (let i = 0; i < count; i++)
    b.copy(
      result,
      data.start + i * fmt.block,
      data.start + (count - 1 - i) * fmt.block,
      data.start + (count - i) * fmt.block,
    );
  return result;
}
