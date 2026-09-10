/**
 * Toene und Konfetti.
 *
 * Alles selbst erzeugt - keine Audiodateien, kein zusaetzliches Paket.
 * Laesst sich im Kopf der App komplett abschalten; wer in der Bahn spielt,
 * will keine Kassenklingel.
 */

let context: AudioContext | null = null;
let enabled = true;

export function setSoundEnabled(value: boolean): void {
  enabled = value;
}

export function isSoundEnabled(): boolean {
  return enabled;
}

function ctx(): AudioContext | null {
  if (!enabled) return null;
  if (!context) {
    const Ctor = window.AudioContext ?? (window as never as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
  }
  if (context.state === 'suspended') void context.resume();
  return context;
}

function tone(frequency: number, duration: number, type: OscillatorType = 'sine', gain = 0.05): void {
  const audio = ctx();
  if (!audio) return;

  const oscillator = audio.createOscillator();
  const volume = audio.createGain();

  oscillator.type = type;
  oscillator.frequency.value = frequency;
  volume.gain.setValueAtTime(gain, audio.currentTime);
  volume.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duration);

  oscillator.connect(volume).connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + duration);
}

export const sounds = {
  /** Kurzer Klick beim Absenden einer Order. */
  click: () => tone(880, 0.06, 'square', 0.03),
  /** Order ausgefuehrt. */
  fill: () => {
    tone(660, 0.09, 'sine', 0.05);
    setTimeout(() => tone(990, 0.12, 'sine', 0.045), 70);
  },
  /** Ordentlicher Gewinn. */
  win: () => {
    [523, 659, 784, 1047].forEach((frequency, index) => {
      setTimeout(() => tone(frequency, 0.18, 'triangle', 0.05), index * 90);
    });
  },
  /** Verlust. */
  loss: () => {
    tone(320, 0.18, 'sawtooth', 0.04);
    setTimeout(() => tone(220, 0.3, 'sawtooth', 0.04), 130);
  },
  /** Liquidation - soll wehtun. */
  liquidation: () => {
    [400, 300, 220, 150, 90].forEach((frequency, index) => {
      setTimeout(() => tone(frequency, 0.25, 'sawtooth', 0.07), index * 110);
    });
  },
  /** Achievement. */
  achievement: () => {
    [784, 1047, 1319].forEach((frequency, index) => {
      setTimeout(() => tone(frequency, 0.22, 'triangle', 0.05), index * 110);
    });
  },
  /** Rugpull - Alarm. */
  rug: () => {
    [200, 180, 160, 140].forEach((frequency, index) => {
      setTimeout(() => tone(frequency, 0.3, 'square', 0.06), index * 150);
    });
  },
  error: () => tone(180, 0.15, 'square', 0.04),
};

/** Konfetti ohne Fremdpaket: ein Canvas, ein paar hundert Rechtecke. */
export function confetti(durationMs = 2200): void {
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:9999;width:100%;height:100%';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);

  const context2d = canvas.getContext('2d');
  if (!context2d) {
    canvas.remove();
    return;
  }

  const colors = ['#31c48d', '#d4a24c', '#5b8def', '#e9edf3'];
  const pieces = Array.from({ length: 160 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.4,
    w: 5 + Math.random() * 7,
    h: 8 + Math.random() * 10,
    vx: -1.5 + Math.random() * 3,
    vy: 2 + Math.random() * 4,
    rotation: Math.random() * Math.PI,
    vr: -0.15 + Math.random() * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)] as string,
  }));

  const start = performance.now();

  const frame = (time: number): void => {
    const elapsed = time - start;
    context2d.clearRect(0, 0, canvas.width, canvas.height);

    for (const piece of pieces) {
      piece.x += piece.vx;
      piece.y += piece.vy;
      piece.vy += 0.04;
      piece.rotation += piece.vr;

      context2d.save();
      context2d.translate(piece.x, piece.y);
      context2d.rotate(piece.rotation);
      context2d.fillStyle = piece.color;
      context2d.globalAlpha = Math.max(0, 1 - elapsed / durationMs);
      context2d.fillRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h);
      context2d.restore();
    }

    if (elapsed < durationMs) {
      requestAnimationFrame(frame);
    } else {
      canvas.remove();
    }
  };

  requestAnimationFrame(frame);
}

/** Roter Blitz ueber den Bildschirm - fuer Liquidationen. */
export function flashDanger(): void {
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:9998;background:radial-gradient(circle at center, rgba(255,60,60,0.35), rgba(255,0,0,0.55));opacity:0;transition:opacity .18s';
  document.body.appendChild(overlay);
  document.body.classList.add('shake');

  requestAnimationFrame(() => {
    overlay.style.opacity = '1';
    setTimeout(() => {
      overlay.style.opacity = '0';
      setTimeout(() => {
        overlay.remove();
        document.body.classList.remove('shake');
      }, 250);
    }, 320);
  });
}
