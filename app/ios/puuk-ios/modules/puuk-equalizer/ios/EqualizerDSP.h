#pragma once
#include <stdbool.h>
#include <stddef.h>

enum { PU_EQ_BANDS = 7 };
typedef struct { double b0, b1, b2, a1, a2; } PUEQFilter;
typedef struct { double z1, z2; } PUEQDelay;
typedef struct {
  PUEQFilter bands[PU_EQ_BANDS];
  double preamp;
  bool flat;
} PUEQCurve;

PUEQCurve PUEQMakeCurve(const int gains[PU_EQ_BANDS], double sampleRate);
void PUEQProcess(float *samples, size_t frames, size_t stride, const PUEQCurve *curve,
                 PUEQDelay delays[PU_EQ_BANDS], const PUEQCurve *previous,
                 PUEQDelay previousDelays[PU_EQ_BANDS], size_t fadeRemaining);
enum { PU_EQ_FADE = 256 };
