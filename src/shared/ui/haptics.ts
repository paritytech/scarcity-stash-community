// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Haptic feedback: play(name) fires every backend the device has: a gamepad's
// vibration actuator, navigator.vibrate, or the iOS Safari 18 switch trick (one
// light tap, https://webkit.org/blog/15865/webkit-features-in-safari-18-0/).
// A system "haptics off" or Low Power Mode swallows it silently.

type HapticEvent = 'grid-tick' | 'grid-light' | 'grid-medium';

interface HapticPattern {
  /** navigator.vibrate() duration, ms. */
  vibrate: number;
  /** Whether the iOS switch fires: one light system tap, its strength set by the OS. */
  ios: boolean;
  /** Gamepad vibrationActuator dual-rumble: duration in ms, magnitudes 0..1. */
  gamepad: { duration: number; strong: number; weak: number };
}

/** The grid's three taps (features/grid/engine/haptic.ts). Each vibration lasts
 *  10 ms at least, or an Android motor does not turn. */
const PATTERNS: Record<HapticEvent, HapticPattern> = {
  'grid-tick': { vibrate: 10, ios: false, gamepad: { duration: 25, strong: 0.18, weak: 0.1 } },
  'grid-light': { vibrate: 14, ios: true, gamepad: { duration: 35, strong: 0.25, weak: 0.12 } },
  'grid-medium': { vibrate: 20, ios: true, gamepad: { duration: 50, strong: 0.4, weak: 0.2 } },
};

/** The least time between two fires, ms: at most ten a second. */
const MIN_GAP_MS = 100;

interface Backends {
  vibrate: boolean;
  ios: boolean;
  /** Gamepads are looked up at each fire: connections come and go during a session. */
  hasGamepadAPI: boolean;
}

function detectBackends(): Backends {
  if (typeof navigator === 'undefined') return { vibrate: false, ios: false, hasGamepadAPI: false };
  const ua = navigator.userAgent;
  const isFirefoxAndroid = ua.includes('Firefox') && ua.includes('Android');
  const isIPhone = /iPhone|iPod/.test(ua);
  // Match Safari version >= 18 in the iPhone UA. Apple bumps Version/X.Y on
  // Safari major releases; matches double-digit 18..99.
  const isSafari18Plus = isIPhone && /Version\/(1[89]|[2-9]\d)/.test(ua);
  return {
    vibrate: 'vibrate' in navigator && !isFirefoxAndroid,
    ios: isSafari18Plus,
    hasGamepadAPI: typeof navigator.getGamepads === 'function',
  };
}

function getActiveGamepad(): Gamepad | null {
  try {
    const pads = 'getGamepads' in navigator ? navigator.getGamepads() : [];
    for (const p of pads) {
      // The vibrationActuator property is present on a connected pad whose
      // hardware supports rumble. Some pads expose it as an object only after
      // the first input event, so this is tried anyway.
      if (p?.vibrationActuator) return p;
    }
  } catch {
    // Some browsers throw on getGamepads() before user activation.
  }
  return null;
}

class HapticEngine {
  private backends: Backends = detectBackends();
  /** The iOS switch's label, mounted on the first gesture, and only where the switch works. */
  private iosLabel: HTMLLabelElement | null = null;
  private lastFireAt = 0;
  /** Set once the iOS switch's click() throws; iOS haptics stay off after that. */
  private iosBroken = false;

  /** Mounts the iOS switch where it applies and primes navigator.vibrate's sticky
   *  user activation with a zero-length vibration. Call from a user gesture. */
  initFromGesture(): void {
    if (this.backends.ios && !this.iosLabel) this.mountIosSwitch();
    if (this.backends.vibrate) {
      try {
        navigator.vibrate(0);
      } catch {
        // harmless
      }
    }
  }

  play(name: HapticEvent): void {
    const pattern = PATTERNS[name];
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastFireAt < MIN_GAP_MS) return;
    this.lastFireAt = now;

    // Backends fire additively: a desktop player with a connected gamepad gets
    // the rumble even though no other backend applies.
    if (this.backends.vibrate) {
      try {
        navigator.vibrate(pattern.vibrate);
      } catch {
        // harmless
      }
    }
    if (this.backends.ios && !this.iosBroken && pattern.ios) this.fireIos();
    if (this.backends.hasGamepadAPI) this.fireGamepad(pattern.gamepad);
  }

  private mountIosSwitch(): void {
    try {
      const input = document.createElement('input');
      input.type = 'checkbox';
      // The non-standard `switch` attribute is what Safari 18+ couples to
      // the system haptic. Setting it via setAttribute keeps TS happy and
      // applies even on browsers that don't recognise it (no-op there).
      input.setAttribute('switch', '');
      input.style.position = 'absolute';
      input.style.opacity = '0';
      input.style.pointerEvents = 'none';
      input.style.width = '0';
      input.style.height = '0';
      input.id = '__haptic_ios_switch__';
      const label = document.createElement('label');
      label.htmlFor = input.id;
      label.style.position = 'absolute';
      label.style.opacity = '0';
      label.style.pointerEvents = 'none';
      label.style.width = '0';
      label.style.height = '0';
      label.setAttribute('aria-hidden', 'true');
      document.body.appendChild(input);
      document.body.appendChild(label);
      this.iosLabel = label;
    } catch {
      this.iosBroken = true;
    }
  }

  /** One light system tap through the iOS switch, made at once, so a call from a
   *  gesture handler taps inside that gesture. */
  private fireIos(): void {
    if (!this.iosLabel) return;
    try {
      this.iosLabel.click();
    } catch {
      this.iosBroken = true;
    }
  }

  private fireGamepad(spec: { duration: number; strong: number; weak: number }): void {
    const pad = getActiveGamepad();
    const actuator = pad?.vibrationActuator;
    if (!actuator) return;
    try {
      // playEffect returns a Promise on Chromium; ignore failures silently.
      const result: unknown = actuator.playEffect('dual-rumble', {
        duration: spec.duration,
        strongMagnitude: spec.strong,
        weakMagnitude: spec.weak,
      });
      if (result instanceof Promise) {
        result.catch(() => {
          // ignored
        });
      }
    } catch {
      // Some implementations throw on bad params or a detached pad; silent.
    }
  }
}

export const haptic = new HapticEngine();
