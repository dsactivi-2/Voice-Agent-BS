export function preprocessAudioForASR(
  audioBuffer: Buffer,
  previousBuffer?: Buffer
): Buffer {
  let processed = audioBuffer;
  
  // 1. High-Pass Filter
  processed = applyHighPassFilter(processed);
  
  // 2. Dynamische Kompression
  processed = applyDynamicCompression(processed);
  
  // 3. Echo-Reduktion
  if (previousBuffer) {
    processed = reduceEcho(processed, previousBuffer, 0.2);
  }
  
  // 4. Noise Gate
  processed = applyNoiseGate(processed, 0.04);
  
  return processed;
}

function applyNoiseGate(audioBuffer: Buffer, threshold: number): Buffer {
  const samples = new Int16Array(
    audioBuffer.buffer,
    audioBuffer.byteOffset,
    audioBuffer.length / 2
  );
  const normalized = new Int16Array(samples.length);
  
  let rmsSum = 0;
  for (let i = 0; i < samples.length; i++) {
    const normalized16 = samples[i]! / 32768.0;
    rmsSum += normalized16 * normalized16;
  }
  const rms = Math.sqrt(rmsSum / samples.length);
  
  if (rms < threshold) {
    for (let i = 0; i < samples.length; i++) {
      normalized[i] = 0;
    }
  } else {
    const gain = 0.8 / Math.max(rms, 0.001);
    for (let i = 0; i < samples.length; i++) {
      const boosted = (samples[i] ?? 0) * gain;
      normalized[i] = Math.max(-32768, Math.min(32767, boosted));
    }
  }
  
  return Buffer.from(normalized.buffer);
}

function applyHighPassFilter(audioBuffer: Buffer): Buffer {
  const samples = new Int16Array(
    audioBuffer.buffer,
    audioBuffer.byteOffset,
    audioBuffer.length / 2
  );
  const filtered = new Int16Array(samples.length);
  
  const alpha = 0.95;
  let prevFiltered = 0;
  
  for (let i = 0; i < samples.length; i++) {
    const current = samples[i] ?? 0;
    const prev = i > 0 ? samples[i - 1] ?? 0 : 0;
    const newFiltered = alpha * (prevFiltered + current - prev);
    filtered[i] = Math.max(-32768, Math.min(32767, newFiltered));
    prevFiltered = newFiltered;
  }
  
  return Buffer.from(filtered.buffer);
}

function applyDynamicCompression(audioBuffer: Buffer): Buffer {
  const samples = new Int16Array(
    audioBuffer.buffer,
    audioBuffer.byteOffset,
    audioBuffer.length / 2
  );
  const compressed = new Int16Array(samples.length);
  
  const threshold = 16000;
  const ratio = 4;
  
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] ?? 0;
    const abs = Math.abs(sample);
    
    if (abs > threshold) {
      const excess = abs - threshold;
      const compressedExcess = excess / ratio;
      const newLevel = threshold + compressedExcess;
      compressed[i] = (sample < 0 ? -1 : 1) * Math.min(newLevel, 32767);
    } else {
      compressed[i] = sample;
    }
  }
  
  return Buffer.from(compressed.buffer);
}

function reduceEcho(
  currentBuffer: Buffer,
  previousBuffer: Buffer,
  echoFactor: number
): Buffer {
  if (previousBuffer.length !== currentBuffer.length) {
    return currentBuffer;
  }
  
  const current = new Int16Array(
    currentBuffer.buffer,
    currentBuffer.byteOffset,
    currentBuffer.length / 2
  );
  const previous = new Int16Array(
    previousBuffer.buffer,
    previousBuffer.byteOffset,
    previousBuffer.length / 2
  );
  const result = new Int16Array(current.length);
  
  for (let i = 0; i < current.length; i++) {
    const echoReduced = (current[i] ?? 0) - ((previous[i] ?? 0) * echoFactor);
    result[i] = Math.max(-32768, Math.min(32767, echoReduced));
  }
  
  return Buffer.from(result.buffer);
}
