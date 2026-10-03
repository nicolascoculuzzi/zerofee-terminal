/** Short synthesized alert tones (WebAudio, no audio files, no network). */
export type ToneKind = "new" | "final" | "migrated" | "fill" | "fail" | "tracked";

const TONES: Record<ToneKind, { freqs: number[]; type: OscillatorType; dur: number }> = {
  new: { freqs: [880], type: "sine", dur: 0.09 },
  final: { freqs: [660, 990], type: "triangle", dur: 0.08 },
  migrated: { freqs: [523, 784, 1046], type: "triangle", dur: 0.08 },
  fill: { freqs: [740, 1108], type: "sine", dur: 0.07 },
  fail: { freqs: [220, 170], type: "sawtooth", dur: 0.11 },
  tracked: { freqs: [1318], type: "sine", dur: 0.06 },
};

let ctx: AudioContext | null = null;
let lastPlayed = 0;

export function playTone(kind: ToneKind, volume = 0.5): void {
  if (typeof window === "undefined" || volume <= 0) return;
  const now = performance.now();
  if (now - lastPlayed < 120) return;
  lastPlayed = now;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const spec = TONES[kind];
    let t = ctx.currentTime;
    for (const f of spec.freqs) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = spec.type;
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18 * volume, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + spec.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + spec.dur + 0.02);
      t += spec.dur * 0.9;
    }
  } catch {
    // Audio unavailable (autoplay policy, no device): alerts stay visual.
  }
}
