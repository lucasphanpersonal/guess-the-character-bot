// Synthesizes short in-game sound effects (correct guess, wrong guess, final win) the same
// way generate-chime.js does -- no external audio libraries or downloads, just sine waves
// written as 16-bit PCM WAV files to data/sounds/.
const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 48000;
const FADE_MS = 6;

function synthesizeNote(freq, durationMs, amplitude = 0.5) {
  const numSamples = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const fadeSamples = Math.round((FADE_MS / 1000) * SAMPLE_RATE);
  const samples = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    let amp = amplitude;
    if (i < fadeSamples) amp *= i / fadeSamples;
    if (i > numSamples - fadeSamples) amp *= (numSamples - i) / fadeSamples;
    samples[i] = Math.round(amp * 32767 * Math.sin(2 * Math.PI * freq * t));
  }
  return samples;
}

function buildWav(samplesArrays) {
  const totalSamples = samplesArrays.reduce((sum, s) => sum + s.length, 0);
  const dataSize = totalSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
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

function writeWav(filename, notes) {
  const wav = buildWav(notes.map(({ freq, durationMs, amplitude }) => synthesizeNote(freq, durationMs, amplitude)));
  const outPath = path.join(__dirname, '..', 'data', 'sounds', filename);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, wav);
  console.log(`Wrote ${wav.length} bytes to ${outPath}`);
}

// Bright ascending two-note "ding!" for a correct guess.
writeWav('correct.wav', [
  { freq: 1046.5, durationMs: 90 },
  { freq: 1568, durationMs: 180 },
]);

// Low, slightly dissonant two-note "buzz" for a wrong guess.
writeWav('wrong.wav', [
  { freq: 196, durationMs: 140, amplitude: 0.45 },
  { freq: 185, durationMs: 220, amplitude: 0.45 },
]);

// Four-note ascending fanfare for the final win.
writeWav('win.wav', [
  { freq: 523.25, durationMs: 140 },
  { freq: 659.25, durationMs: 140 },
  { freq: 783.99, durationMs: 140 },
  { freq: 1046.5, durationMs: 320 },
]);
