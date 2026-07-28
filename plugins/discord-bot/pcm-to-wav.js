// Discord's voice receive stream is always 48kHz, 16-bit, stereo PCM once
// decoded from Opus (prism-media's opus.Decoder default) -- wrapping it in
// a standard 44-byte RIFF/WAVE header is the entire job, so this is a
// one-off helper rather than a dependency. whisper-cli reads the result
// directly, same as any other WAV file it's already given elsewhere in
// this codebase.
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;

function pcmToWav(pcmBuffer) {
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
  const byteRate = SAMPLE_RATE * blockAlign;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

module.exports = { pcmToWav, SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE };
