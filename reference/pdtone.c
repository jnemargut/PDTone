/*
 * pdtone.c — PDTone reference codec in portable C (single-precision float).
 *
 * Framework-agnostic: operates on plain int16 PCM buffers, so it drops into
 * embedded targets (it was first written for the Playdate, whose FPU is
 * single-precision — hence sinf/cosf and -ffast-math-friendly math).
 *
 *   int  pdtone_encode(const char *text, int16_t *out, int maxSamples, float sr);
 *        // returns number of samples written (a full transmission), or -1
 *
 *   int  pdtone_decode(const int16_t *buf, int n, float sr, char *out, int outSize);
 *        // scans a buffer that contains one full transmission; returns bytes
 *        // decoded (out is NUL-terminated), or 0 if none found
 *
 * Protocol: sync 1350 Hz (300 ms), 16 data tones 1500..2850 Hz (90 Hz apart),
 * end marker 1200 Hz; 100 ms tone + 40 ms gap per symbol; 2 tones per byte.
 *
 * MIT licensed.
 */
#include <math.h>
#include <string.h>
#include <stdint.h>

#define PDTONE_NDATA   16
#define PDTONE_SYNC    1350.0f
#define PDTONE_END     1200.0f
#define PDTONE_MAXTEXT 40

static float pdtone_data_freq(int k) { return 1500.0f + 90.0f * (float)k; }

/* ---- encode ------------------------------------------------------------ */
static int put_tone(int16_t *out, int pos, int max, float freq, int n, float sr) {
    int ramp = (int)(0.005f * sr);
    for (int i = 0; i < n && pos < max; i++) {
        float env = 1.0f;
        if (i < ramp)            env = (float)i / ramp;
        else if (i > n - ramp)   env = (float)(n - i) / ramp;
        out[pos++] = (int16_t)(sinf(2.0f * (float)M_PI * freq * i / sr) * env * 9000.0f);
    }
    return pos;
}
static int put_silence(int16_t *out, int pos, int max, int n) {
    for (int i = 0; i < n && pos < max; i++) out[pos++] = 0;
    return pos;
}

int pdtone_encode(const char *text, int16_t *out, int maxSamples, float sr) {
    if (!text || !out) return -1;
    int len = (int)strlen(text); if (len > PDTONE_MAXTEXT) len = PDTONE_MAXTEXT;
    int tone = (int)(0.100f * sr), gap = (int)(0.040f * sr), pre = (int)(0.300f * sr);
    int pos = 0;
    pos = put_silence(out, pos, maxSamples, (int)(0.05f * sr));
    pos = put_tone(out, pos, maxSamples, PDTONE_SYNC, pre, sr);
    pos = put_silence(out, pos, maxSamples, gap);
    for (int c = 0; c < len; c++) {
        unsigned char b = (unsigned char)text[c];
        pos = put_tone(out, pos, maxSamples, pdtone_data_freq((b >> 4) & 0xF), tone, sr);
        pos = put_silence(out, pos, maxSamples, gap);
        pos = put_tone(out, pos, maxSamples, pdtone_data_freq(b & 0xF), tone, sr);
        pos = put_silence(out, pos, maxSamples, gap);
    }
    pos = put_tone(out, pos, maxSamples, PDTONE_END, tone, sr);
    pos = put_silence(out, pos, maxSamples, (int)(0.20f * sr));
    return pos;
}

/* ---- decode ------------------------------------------------------------ */
static const int16_t *g_buf; static int g_n;
static float sample_at(int t) { return (t >= 0 && t < g_n) ? g_buf[t] * (1.0f / 32768.0f) : 0.0f; }

static float goertzel(float f, int a, int b, float sr) {
    float coeff = 2.0f * cosf(2.0f * (float)M_PI * f / sr), q1 = 0, q2 = 0;
    for (int t = a; t < b; t++) { float q0 = coeff * q1 - q2 + sample_at(t); q2 = q1; q1 = q0; }
    return q1 * q1 + q2 * q2 - coeff * q1 * q2;
}
static float win_energy(int a, int b) {
    float e = 0; for (int t = a; t < b; t++) { float x = sample_at(t); e += x * x; }
    return (b > a) ? e / (float)(b - a) : 0.0f;
}

int pdtone_decode(const int16_t *buf, int n, float sr, char *out, int outSize) {
    if (!buf || !out || outSize < 1) return 0;
    g_buf = buf; g_n = n;
    #define S(sec) ((int)((sec) * sr))

    int Wp = S(0.10f), STEP = S(0.04f);
    float peak = 0;
    for (int w = 0; w + Wp < n; w += STEP) { float e = win_energy(w, w + Wp); if (e > peak) peak = e; }
    if (peak < 1e-7f) return 0;
    float floorE = peak * 0.10f;

    /* sustained 1350 Hz preamble */
    const int didx[3] = { 1, 9, 16 };
    int run = 0, runStart = 0, runFound = -1;
    for (int w = 0; w + Wp < n; w += STEP) {
        int sy = 0;
        if (win_energy(w, w + Wp) > floorE) {
            float sp = goertzel(PDTONE_SYNC, w, w + Wp, sr), dm = 0;
            for (int j = 0; j < 3; j++) { float p = goertzel(pdtone_data_freq(didx[j]-1), w, w + Wp, sr); if (p > dm) dm = p; }
            if (sp > dm) sy = 1;
        }
        if (sy) { if (run == 0) runStart = w; if (++run >= 5) { runFound = runStart; break; } }
        else run = 0;
    }
    if (runFound < 0) return 0;

    /* refine onset to the rising edge */
    int a0 = runFound - S(0.10f); if (a0 < 0) a0 = 0;
    int a1 = runFound + S(0.15f), WW = S(0.02f), HOP = S(0.01f);
    float lp = 0; for (int w = a0; w < a1; w += HOP) { float e = win_energy(w, w + WW); if (e > lp) lp = e; }
    float th = lp * 0.30f; int onset = runFound;
    for (int w = a0; w < a1; w += HOP) { if (win_energy(w, w + WW) > th) { onset = w; break; } }

    float noiseE = (onset > S(0.35f)) ? win_energy(onset - S(0.30f), onset - S(0.05f)) : 1e-6f;
    float floorD = noiseE * 6.0f; if (floorD < 1e-7f) floorD = 1e-7f;

    /* clock out symbols until the 1200 Hz end marker */
    int base = onset + S(0.340f) + S(0.020f);
    int WIN_LEN = S(0.060f), PERIOD = S(0.140f);
    unsigned char nibs[256]; int nn = 0, sawEnd = 0;
    for (int i = 0; i < 200; i++) {
        int a = base + i * PERIOD, b = a + WIN_LEN;
        if (b > n) break;
        if (win_energy(a, b) < floorD) break;
        float best = -1, endP = goertzel(PDTONE_END, a, b, sr); int bi = 0;
        for (int k = 0; k < PDTONE_NDATA; k++) { float p = goertzel(pdtone_data_freq(k), a, b, sr); if (p > best) { best = p; bi = k; } }
        if (endP > best) { sawEnd = 1; break; }
        if (nn < (int)sizeof(nibs)) nibs[nn++] = (unsigned char)bi;
    }
    if (!sawEnd) return 0;

    int nbytes = nn / 2; if (nbytes > outSize - 1) nbytes = outSize - 1;
    for (int i = 0; i < nbytes; i++) out[i] = (char)((nibs[2*i] << 4) | nibs[2*i + 1]);
    out[nbytes] = 0;
    #undef S
    return nbytes;
}
