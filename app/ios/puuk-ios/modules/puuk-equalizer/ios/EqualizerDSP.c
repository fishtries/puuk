#include "EqualizerDSP.h"
#include <math.h>

PUEQCurve PUEQMakeCurve(const int gains[PU_EQ_BANDS], double sampleRate) {
  static const double frequencies[] = {60, 150, 400, 1000, 2400, 6000, 14000};
  PUEQCurve curve = {.preamp = 1, .flat = true};
  double peakBoost = 0;
  for (int i = 0; i < PU_EQ_BANDS; ++i) {
    PUEQFilter *band = &curve.bands[i];
    band->b0 = 1;
    if (!gains[i] || frequencies[i] >= sampleRate * 0.48) continue;
    const double gain = fmax(-12, fmin(12, gains[i]));
    const double amplitude = pow(10, gain / 40);
    const double omega = 6.283185307179586 * frequencies[i] / sampleRate;
    const double alpha = sin(omega) / (2 * 1.1); // Constant-Q peaking biquad
    const double a0 = 1 + alpha / amplitude;
    band->b0 = (1 + alpha * amplitude) / a0;
    band->b1 = -2 * cos(omega) / a0;
    band->b2 = (1 - alpha * amplitude) / a0;
    band->a1 = band->b1;
    band->a2 = (1 - alpha / amplitude) / a0;
    peakBoost = fmax(peakBoost, gain);
    curve.flat = false;
  }
  curve.preamp = pow(10, -peakBoost / 20);
  return curve;
}

static double filtered(double x, const PUEQCurve *curve, PUEQDelay *delays) {
  if (curve->flat) return x;
  x *= curve->preamp;
  for (int i = 0; i < PU_EQ_BANDS; ++i) {
    const PUEQFilter *f = &curve->bands[i];
    const double y = f->b0 * x + delays[i].z1;
    delays[i].z1 = f->b1 * x - f->a1 * y + delays[i].z2;
    delays[i].z2 = f->b2 * x - f->a2 * y;
    x = y;
  }
  return fmin(1, fmax(-1, x));
}

void PUEQProcess(float *samples, size_t frames, size_t stride, const PUEQCurve *curve,
                 PUEQDelay delays[PU_EQ_BANDS], const PUEQCurve *previous,
                 PUEQDelay previousDelays[PU_EQ_BANDS], size_t fadeRemaining) {
  if (curve->flat && !fadeRemaining) return;
  for (size_t i = 0; i < frames; ++i, samples += stride) {
    const double input = *samples;
    double output = filtered(input, curve, delays);
    if (i < fadeRemaining) {
      const double mix = (double)(fadeRemaining - i) / PU_EQ_FADE;
      output += mix * (filtered(input, previous, previousDelays) - output);
    }
    *samples = (float)output;
  }
}
