// Compile with the same DSP source as the iOS target.
#include "../ios/EqualizerDSP.h"
#include <assert.h>
#include <math.h>
#include <string.h>

int main(void) {
  const double frequencies[] = {60, 150, 400, 1000, 2400, 6000, 14000};
  const int rate = 48000;
  float stereo[2 * 128];
  for (int band = 0; band < PU_EQ_BANDS; ++band) {
    int gains[PU_EQ_BANDS] = {0};
    gains[band] = -6;
    PUEQCurve cut = PUEQMakeCurve(gains, rate);
    PUEQDelay memory[PU_EQ_BANDS] = {0}, previous[PU_EQ_BANDS] = {0};
    double inputPower = 0, outputPower = 0;
    for (int offset = 0; offset < rate; offset += 128) {
      for (int i = 0; i < 128; ++i) {
        stereo[2*i] = 0.2 * sin(6.283185307179586 * frequencies[band] * (offset + i) / rate);
        stereo[2*i+1] = 0.25;
        if (offset >= rate / 2) inputPower += stereo[2*i] * stereo[2*i];
      }
      PUEQProcess(stereo, 128, 2, &cut, memory, &cut, previous, 0);
      for (int i = 0; i < 128; ++i) {
        assert(stereo[2*i+1] == 0.25f);
        if (offset >= rate / 2) outputPower += stereo[2*i] * stereo[2*i];
      }
    }
    assert(fabs(10 * log10(outputPower / inputPower) + 6) < 0.02);
  }

  int gains[PU_EQ_BANDS] = {0};
  PUEQCurve flat = PUEQMakeCurve(gains, rate);
  float original[256];
  memcpy(original, stereo, sizeof(original));
  PUEQProcess(stereo, 256, 1, &flat, NULL, &flat, NULL, 0);
  assert(memcmp(original, stereo, sizeof(original)) == 0);
  return 0;
}
