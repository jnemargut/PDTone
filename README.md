# PDTone 🔊

**A tiny voice-band data-over-sound protocol.** Send short text messages between devices using sound alone — no wifi, no pairing, no servers. Browser-to-browser, phone-to-laptop, or to any device that speaks the same tones (it was built for a [Playdate](https://play.date)).

PDTone deliberately lives in the **1.2–2.85 kHz "voice band"**, which is where small/cheap microphones hear best. That's the whole trick: full-band data-over-sound libraries put energy up at 4–8 kHz, where tiny mics roll off and can't hear — PDTone stays where they're sensitive, so it works on hardware that otherwise can't receive.

## Try it

Open [`demo.html`](demo.html) on two devices in the same room (or two browser tabs). One taps **Listen**, the other types a note and taps **Send**. Mic access needs **HTTPS or localhost**.

## Protocol

| Element | Value |
|--------|-------|
| Sync (start marker) | **1350 Hz**, 300 ms |
| End marker | **1200 Hz**, 100 ms |
| Data tones | **16 tones, 1500–2850 Hz**, 90 Hz apart (one tone = one nibble) |
| Symbol | 100 ms tone + 40 ms gap |
| Encoding | 2 tones per byte: high nibble, then low nibble |
| Detection | **Goertzel** filters (no FFT, no resampling — tones are absolute Hz) |

A transmission is: lead-in silence → **sync** preamble → for each byte, two data tones → **end** marker → trailing silence.

Two design choices make it robust on real hardware:

- **Periodic sync scan for onset.** A few times a second the receiver scans the recent audio for the sustained 1350 Hz preamble. This rejects transient clicks (a plain energy gate gets fooled by them).
- **Clock-locked symbol decoding.** Once the onset is found, symbols are read at fixed time offsets rather than by detecting gaps. Room reverb fills the inter-tone gaps on real hardware, so gap-based segmentation fails; a fixed clock doesn't.
- **Explicit end marker.** Decoding stops only when the 1200 Hz end tone is seen, so messages are never cut short or padded with noise.

## Browser usage

```html
<script src="pdtone.js"></script>
<script>
  // send
  PDTone.send("hi there");                       // returns { duration, bytes }

  // receive (asks for mic; needs HTTPS or localhost)
  const rx = PDTone.createReceiver({
    onMessage: (text) => console.log("got:", text),
    onError:   (err)  => console.warn(err.message),
  });
  await rx.start();
  // ...later
  rx.stop();
</script>
```

`pdtone.js` is dependency-free and also works as a CommonJS module (`const PDTone = require('./pdtone.js')`) for the encode side.

### API

- `PDTone.send(message, opts?)` → `{ duration, bytes }`. `opts.volume` (0–1, default 0.9), `opts.audioContext` to reuse one. Messages are truncated to 40 bytes (UTF-8).
- `PDTone.createReceiver({ onMessage, onError, onStatus, captureSeconds })` → `{ start(), stop(), isListening() }`. `onMessage(text, { bytes, count })`.
- Constants: `PDTone.SYNC`, `PDTone.END`, `PDTone.DATA`, `PDTone.TONE_S`, `PDTone.GAP_S`, `PDTone.PRE_S`.

## C reference (embedded / Playdate)

[`reference/pdtone.c`](reference/pdtone.c) is a portable, single-precision-float implementation that operates on plain `int16` PCM buffers — no dependencies, no FFT — so it drops onto microcontrollers and handhelds:

```c
int  pdtone_encode(const char *text, int16_t *out, int maxSamples, float sr);
int  pdtone_decode(const int16_t *buf, int n, float sr, char *out, int outSize);
```

```c
static int16_t buf[44100 * 15];
int ns = pdtone_encode("hi there!", buf, sizeof(buf)/2, 44100.0f);
char msg[64];
int nb = pdtone_decode(buf, ns, 44100.0f, msg, sizeof(msg));   // -> "hi there!"
```

The Goertzel filter computes per-tone power directly, so the decoder is cheap enough to run in real time on a small CPU. On a streaming device you keep a rolling buffer and call the scan a few times a second (see the comments).

## Notes & limitations

- Best **in the same room, with volume up**. It's acoustic — walls, noise, and distance all matter.
- Payload is short by design (≤ 40 bytes). It's for notes, codes, handles — not files.
- There's **no error correction** yet (the explicit markers + clock recovery handle the common failure modes). PRs welcome.
- Receiving in a browser requires a **secure context** (HTTPS or `localhost`) because it uses the microphone.

## License

MIT © jontomato. See [LICENSE](LICENSE).

Built for [Sound Mailbox](https://soundmailbox.com), a Playdate sound-toy.
