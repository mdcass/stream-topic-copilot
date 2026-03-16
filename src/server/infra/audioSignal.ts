import fs from "node:fs/promises";

export interface WaveSignalAnalysis {
  sampleCount: number;
  rms: number;
  peak: number;
  silent: boolean;
}

const SILENCE_RMS_THRESHOLD = 0.0005;
const SILENCE_PEAK_THRESHOLD = 0.002;

export async function analyzeWaveSignal(audioPath: string): Promise<WaveSignalAnalysis | null> {
  let data: Buffer;
  try {
    data = await fs.readFile(audioPath);
  } catch {
    return null;
  }

  if (data.length < 44 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let sampleDataOffset = -1;
  let sampleDataLength = 0;
  let bitsPerSample = 0;
  let channels = 0;
  let formatCode = 0;

  while (offset + 8 <= data.length) {
    const chunkId = data.toString("ascii", offset, offset + 4);
    const chunkSize = data.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;

    if (chunkEnd > data.length) {
      break;
    }

    if (chunkId === "fmt " && chunkSize >= 16) {
      formatCode = data.readUInt16LE(chunkStart);
      channels = data.readUInt16LE(chunkStart + 2);
      bitsPerSample = data.readUInt16LE(chunkStart + 14);
    } else if (chunkId === "data") {
      sampleDataOffset = chunkStart;
      sampleDataLength = chunkSize;
      break;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (sampleDataOffset < 0 || sampleDataLength <= 0 || formatCode !== 1 || bitsPerSample !== 16 || channels < 1) {
    return null;
  }

  const bytesPerFrame = channels * 2;
  const sampleCount = Math.floor(sampleDataLength / bytesPerFrame);
  if (sampleCount <= 0) {
    return null;
  }

  let peak = 0;
  let sumSquares = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = data.readInt16LE(sampleDataOffset + (index * bytesPerFrame));
    const normalized = sample / 32768;
    const absolute = Math.abs(normalized);
    peak = Math.max(peak, absolute);
    sumSquares += normalized * normalized;
  }

  const rms = Math.sqrt(sumSquares / sampleCount);
  return {
    sampleCount,
    rms,
    peak,
    silent: rms < SILENCE_RMS_THRESHOLD && peak < SILENCE_PEAK_THRESHOLD
  };
}
