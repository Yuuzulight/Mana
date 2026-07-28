const assert = require("node:assert/strict");
const test = require("node:test");

const { pcmToWav, SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE } = require("../pcm-to-wav");

test("pcmToWav prepends a valid 44-byte RIFF/WAVE header", () => {
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const wav = pcmToWav(pcm);

  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.toString("ascii", 36, 40), "data");
});

test("pcmToWav's header fields describe Discord's fixed 48kHz/16-bit/stereo format", () => {
  const wav = pcmToWav(Buffer.alloc(100));

  assert.equal(wav.readUInt16LE(20), 1); // PCM format tag
  assert.equal(wav.readUInt16LE(22), CHANNELS);
  assert.equal(wav.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(wav.readUInt16LE(34), BITS_PER_SAMPLE);
  const expectedByteRate = (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8;
  assert.equal(wav.readUInt32LE(28), expectedByteRate);
});

test("pcmToWav's data/RIFF size fields match the actual PCM payload length", () => {
  const pcm = Buffer.alloc(2000, 7);
  const wav = pcmToWav(pcm);

  assert.equal(wav.readUInt32LE(40), pcm.length); // data chunk size
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length); // RIFF chunk size
  assert.deepEqual(wav.subarray(44), pcm);
});

test("pcmToWav handles an empty buffer without throwing", () => {
  const wav = pcmToWav(Buffer.alloc(0));
  assert.equal(wav.length, 44);
  assert.equal(wav.readUInt32LE(40), 0);
});
