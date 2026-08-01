// Synthesizes a short two-note "ding" (no external audio libraries or downloads) and
// writes it as a 16-bit PCM WAV to data/sounds/chime.wav for the countdown voice chime.
const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 48000;
const NOTES = [
  { freq: 880, durationMs: 110 },
  { freq: 1318.51, durationMs: 160 },
];
const FADE_MS = 8;

function synthesizeNote(freq, durationMs) {
  const numSamples = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const fadeSamples = Math.round((FADE_MS / 1000) * SAMPLE_RATE);
  const samples = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    let amp = 0.5;
    if (i < fadeSamples) amp *= i / fadeSamples;
    if (i > numSamples - fadeSamples) amp *= (numSamples - i) / fadeSamples;
    samples[i] = Math.round(amp * 32767 * Math.sin(2 * Math.PI * freq * t));
  }
  return samples;
}

function buildWav(samplesArrays) {
  const totalSamples = samplesArrays.reduce((sum, s) => sum + s.length, 0);
  const dataSize = totalSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (const samples of samplesArrays) {
    for (const sample of samples) {
      buffer.writeInt16LE(sample, offset);
      offset += 2;
    }
  }
  return buffer;
}

const wav = buildWav(NOTES.map(({ freq, durationMs }) => synthesizeNote(freq, durationMs)));
const outPath = path.join(__dirname, '..', 'data', 'sounds', 'chime.wav');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, wav);
console.log(`Wrote ${wav.length} bytes to ${outPath}`);
