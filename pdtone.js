// pdtone.js — PDTone: a tiny voice-band data-over-sound protocol.
//
// Send short text messages between devices using sound alone — no wifi, no
// pairing, no servers. Works browser-to-browser, phone-to-laptop, or with any
// device that implements the same protocol (e.g. a Playdate).
//
// Protocol
// --------
//   sync (start) : 1350 Hz, 300 ms
//   end  marker  : 1200 Hz, 100 ms
//   data tones   : 16 tones, 1500..2850 Hz, 90 Hz apart (one tone = one nibble)
//   symbol       : 100 ms tone + 40 ms gap
//   encoding     : 2 tones per byte (high nibble, then low nibble)
//   detection    : Goertzel filters (no FFT, no resampling — tones are absolute Hz)
//
// All tones sit in the 1.2–2.85 kHz "voice band", which is where small/cheap
// mics (like the Playdate's) hear best.
//
// Usage (browser)
// ---------------
//   <script src="pdtone.js"></script>
//   PDTone.send("hi there");                       // transmit
//   const rx = PDTone.createReceiver({ onMessage: m => console.log(m) });
//   await rx.start();   // asks for mic; needs HTTPS or localhost
//   rx.stop();
//
// MIT licensed.

(function (root) {
  'use strict';

  // ---- protocol constants ----
  var SYNC = 1350;
  var END  = 1200;
  var DATA = []; for (var k = 0; k < 16; k++) DATA.push(1500 + 90 * k);
  var FREQ = [SYNC].concat(DATA);          // [0]=sync, [1..16]=data
  var TONE_S = 0.100, GAP_S = 0.040, PRE_S = 0.300, RAMP = 0.005;

  // =====================================================================
  // SEND — synthesize the tones with the Web Audio API
  // =====================================================================
  // Returns { duration (seconds), bytes (Uint8Array) }.
  function send(message, opts) {
    opts = opts || {};
    var AC = window.AudioContext || window.webkitAudioContext;
    var ac = opts.audioContext || new AC();
    var vol = (opts.volume == null) ? 0.9 : opts.volume;
    var osc = ac.createOscillator(), g = ac.createGain();
    osc.type = 'sine';
    osc.connect(g); g.connect(ac.destination);
    g.gain.setValueAtTime(0, ac.currentTime);

    var t = ac.currentTime + 0.15;        // lead-in silence
    function symbol(freq, dur) {
      osc.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + RAMP);
      g.gain.setValueAtTime(vol, t + dur - RAMP);
      g.gain.linearRampToValueAtTime(0, t + dur);
      t += dur + GAP_S;
    }

    symbol(SYNC, PRE_S);
    var bytes = new TextEncoder().encode(message).slice(0, 40);
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      symbol(DATA[(b >> 4) & 0xF], TONE_S);
      symbol(DATA[b & 0xF], TONE_S);
    }
    symbol(END, TONE_S);                   // end-of-message marker

    osc.start();
    osc.stop(t + 0.4);
    var duration = (t - ac.currentTime + 0.4);
    if (!opts.audioContext) osc.onended = function () { ac.close(); };
    return { duration: duration, bytes: bytes };
  }

  // =====================================================================
  // RECEIVE — mic capture + Goertzel decode
  // =====================================================================
  // createReceiver({ onMessage, onError, onStatus, captureSeconds })
  //   -> { start(): Promise, stop(), isListening() }
  function createReceiver(cfg) {
    cfg = cfg || {};
    var onMessage = cfg.onMessage || function () {};
    var onError   = cfg.onError   || function () {};
    var onStatus  = cfg.onStatus  || function () {};
    var CAP_SECONDS = cfg.captureSeconds || 15;

    var SR = 44100, cap = null, capLen = 0, head = 0;
    var lastP = -1e9, decodeCount = 0;
    var listening = false, micCtx = null, node = null, scanTimer = null, stream = null;

    function capAt(i) { return cap[((i % capLen) + capLen) % capLen]; }
    function goertzel(f, a, b) {
      var coeff = 2 * Math.cos(2 * Math.PI * f / SR), q1 = 0, q2 = 0;
      for (var t = a; t < b; t++) { var q0 = coeff * q1 - q2 + capAt(t); q2 = q1; q1 = q0; }
      return q1 * q1 + q2 * q2 - coeff * q1 * q2;
    }
    function winEnergy(a, b) { var e = 0; for (var t = a; t < b; t++) { var x = capAt(t); e += x * x; } return e / (b - a); }

    function scanDecode() {
      var S = function (s) { return Math.round(s * SR); };
      var now = head;
      if (now < S(0.6)) return;
      var look = S(14.0);
      var rs = now > look ? now - look : 0;
      var re = now > S(0.20) ? now - S(0.20) : now;
      if (re <= rs + S(0.10)) return;
      var Wp = S(0.10), STEP = S(0.04);

      var peak = 0, w, e;
      for (w = rs; w + Wp < re; w += STEP) { e = winEnergy(w, w + Wp); if (e > peak) peak = e; }
      if (peak < 1e-7) return;
      var floorE = peak * 0.10;

      // find the sustained 1350 Hz preamble (rejects clicks and the 1-symbol end tone)
      var didx = [1, 9, 16], run = 0, runStart = 0, runFound = 0, found = false;
      for (w = rs; w + Wp < re; w += STEP) {
        var sy = false;
        if (winEnergy(w, w + Wp) > floorE) {
          var sp = goertzel(FREQ[0], w, w + Wp), dm = 0;
          for (var j = 0; j < didx.length; j++) { var p = goertzel(FREQ[didx[j]], w, w + Wp); if (p > dm) dm = p; }
          if (sp > dm) sy = true;
        }
        if (sy) { if (run === 0) runStart = w; if (++run >= 5) { found = true; runFound = runStart; break; } }
        else run = 0;
      }
      if (!found) return;
      if (Math.abs(runFound - lastP) < S(1.0)) return;   // already decoded this one

      // refine onset to the rising edge near the preamble start
      var a0 = Math.max(0, runFound - S(0.10)), a1 = runFound + S(0.15), WW = S(0.02), HOP = S(0.01);
      var lp = 0; for (w = a0; w < a1; w += HOP) { e = winEnergy(w, w + WW); if (e > lp) lp = e; }
      var th = lp * 0.30, onset = runFound;
      for (w = a0; w < a1; w += HOP) { if (winEnergy(w, w + WW) > th) { onset = w; break; } }

      var noiseE = onset > S(0.35) ? winEnergy(onset - S(0.30), onset - S(0.05)) : 1e-6;
      var floorD = noiseE * 6; if (floorD < 1e-8) floorD = 1e-8;

      // clock out symbols; stop ONLY at the explicit 1200 Hz end tone
      var base = onset + S(0.340) + S(0.020);   // pre-gap + window-skip
      var WIN_LEN = S(0.060), PERIOD = S(0.140), endbound = now - S(0.05);
      var nibs = [], sawEnd = false;
      for (var i = 0; i < 180; i++) {
        var a = base + i * PERIOD, b = a + WIN_LEN;
        if (b > endbound) return;                // tail not buffered yet — wait
        var we = winEnergy(a, b), best = -1, bi = 0;
        for (var kk = 0; kk < 16; kk++) { var pp = goertzel(FREQ[kk + 1], a, b); if (pp > best) { best = pp; bi = kk; } }
        var endP = goertzel(END, a, b);
        if (we < floorD) break;                  // silence before end tone: incomplete
        if (endP > best) { sawEnd = true; break; } // end-of-message marker
        nibs.push(bi);
      }
      if (!sawEnd) return;

      var nbytes = nibs.length >> 1;
      if (nbytes < 1) return;
      var out = new Uint8Array(nbytes);
      for (i = 0; i < nbytes; i++) out[i] = ((nibs[2 * i] << 4) | nibs[2 * i + 1]) & 0xFF;
      var txt;
      try { txt = new TextDecoder().decode(out); } catch (e2) { txt = String.fromCharCode.apply(null, out); }
      lastP = runFound; decodeCount++;
      onMessage(txt, { bytes: out, count: decodeCount });
    }

    function start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        var err = new Error('Microphone unavailable: PDTone receive needs HTTPS or localhost.');
        onError(err); return Promise.reject(err);
      }
      return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      }).then(function (s) {
        stream = s;
        var AC = window.AudioContext || window.webkitAudioContext;
        micCtx = new AC();
        SR = micCtx.sampleRate;
        capLen = Math.round(CAP_SECONDS * SR); cap = new Float32Array(capLen); head = 0; lastP = -1e9;
        var src = micCtx.createMediaStreamSource(stream);
        node = micCtx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = function (ev) {
          var buf = ev.inputBuffer.getChannelData(0);
          for (var i = 0; i < buf.length; i++) { cap[head % capLen] = buf[i]; head++; }
        };
        src.connect(node); node.connect(micCtx.destination);
        listening = true;
        scanTimer = setInterval(scanDecode, 250);
        onStatus('listening', { sampleRate: SR });
      }).catch(function (e) { onError(e); throw e; });
    }

    function stop() {
      listening = false;
      if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
      if (node) { node.onaudioprocess = null; node = null; }
      if (micCtx) { micCtx.close(); micCtx = null; }
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      onStatus('stopped', {});
    }

    return { start: start, stop: stop, isListening: function () { return listening; } };
  }

  var PDTone = {
    send: send,
    createReceiver: createReceiver,
    SYNC: SYNC, END: END, DATA: DATA,
    TONE_S: TONE_S, GAP_S: GAP_S, PRE_S: PRE_S, RAMP: RAMP
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PDTone;
  else root.PDTone = PDTone;
})(typeof self !== 'undefined' ? self : this);
