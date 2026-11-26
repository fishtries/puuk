#import "PUEqualizerMix.h"
#import "EqualizerDSP.h"
#import <MediaToolbox/MediaToolbox.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

// One atomic word publishes the seven gains together. The render thread owns
// its filter histories and never calls Swift, JavaScript, or a lock.
typedef struct {
  void *owner;
  atomic_uint_fast64_t *settings;
  uint64_t applied;
  double rate;
  UInt32 channels;
  size_t fade;
  PUEQCurve curve, previous;
  PUEQDelay *delays, *previousDelays;
} TapState;

@implementation PUEqualizerMix {
  atomic_uint_fast64_t _settings;
}

- (void)setGains:(NSArray<NSNumber *> *)gains {
  if (gains.count != PU_EQ_BANDS) return;
  uint64_t packed = 0;
  for (unsigned i = 0; i < PU_EQ_BANDS; ++i) {
    NSInteger db = MAX(-12, MIN(12, gains[i].integerValue));
    packed |= (uint64_t)(db + 12) << (5 * i);
  }
  atomic_store_explicit(&_settings, packed, memory_order_relaxed);
}

static void initialize(MTAudioProcessingTapRef tap, void *client, void **storage) {
  TapState *state = calloc(1, sizeof(TapState));
  *storage = state;
  if (!state) return;
  PUEqualizerMix *mix = (__bridge PUEqualizerMix *)client;
  state->owner = (__bridge_retained void *)mix;
  state->settings = &mix->_settings;
}

static void unprepare(MTAudioProcessingTapRef tap) {
  TapState *s = MTAudioProcessingTapGetStorage(tap);
  if (!s) return;
  free(s->delays);
  free(s->previousDelays);
  s->delays = s->previousDelays = NULL;
}

static void finalize(MTAudioProcessingTapRef tap) {
  TapState *s = MTAudioProcessingTapGetStorage(tap);
  if (!s) return;
  unprepare(tap);
  CFRelease(s->owner);
  free(s);
}

static void prepare(MTAudioProcessingTapRef tap, CMItemCount maxFrames,
                    const AudioStreamBasicDescription *format) {
  TapState *s = MTAudioProcessingTapGetStorage(tap);
  if (!s) return;
  unprepare(tap);
  if (format->mFormatID != kAudioFormatLinearPCM ||
      !(format->mFormatFlags & kAudioFormatFlagIsFloat) || format->mBitsPerChannel != 32 ||
      !format->mChannelsPerFrame || format->mSampleRate <= 0) return;
  s->channels = format->mChannelsPerFrame;
  s->rate = format->mSampleRate;
  s->delays = calloc(s->channels, PU_EQ_BANDS * sizeof(PUEQDelay));
  s->previousDelays = calloc(s->channels, PU_EQ_BANDS * sizeof(PUEQDelay));
  s->applied = UINT64_MAX;
  s->curve = (PUEQCurve){.flat = true, .preamp = 1};
}

static void process(MTAudioProcessingTapRef tap, CMItemCount requested,
                    MTAudioProcessingTapFlags flags, AudioBufferList *buffers,
                    CMItemCount *frames, MTAudioProcessingTapFlags *outFlags) {
  OSStatus status = MTAudioProcessingTapGetSourceAudio(tap, requested, buffers, outFlags, NULL, frames);
  TapState *s = MTAudioProcessingTapGetStorage(tap);
  if (status || *frames <= 0 || !s || !s->delays || !s->previousDelays) return;
  uint64_t packed = atomic_load_explicit(s->settings, memory_order_relaxed);
  if (s->applied != packed) {
    int gains[PU_EQ_BANDS];
    for (int i = 0; i < PU_EQ_BANDS; ++i) gains[i] = (int)((packed >> (5*i)) & 31) - 12;
    s->previous = s->curve;
    memcpy(s->previousDelays, s->delays, s->channels * PU_EQ_BANDS * sizeof(PUEQDelay));
    memset(s->delays, 0, s->channels * PU_EQ_BANDS * sizeof(PUEQDelay));
    s->curve = PUEQMakeCurve(gains, s->rate);
    s->fade = PU_EQ_FADE;
    s->applied = packed;
  }
  UInt32 channel = 0;
  for (UInt32 i = 0; i < buffers->mNumberBuffers; ++i) {
    AudioBuffer b = buffers->mBuffers[i];
    if (!b.mData || !b.mNumberChannels || channel + b.mNumberChannels > s->channels) return;
    size_t count = MIN((size_t)*frames, b.mDataByteSize / sizeof(float) / b.mNumberChannels);
    for (UInt32 c = 0; c < b.mNumberChannels; ++c, ++channel)
      PUEQProcess((float *)b.mData + c, count, b.mNumberChannels, &s->curve,
                  s->delays + channel * PU_EQ_BANDS, &s->previous,
                  s->previousDelays + channel * PU_EQ_BANDS, s->fade);
  }
  s->fade = s->fade > (size_t)*frames ? s->fade - (size_t)*frames : 0;
}

- (AVAudioMix *)mixForTrack:(AVAssetTrack *)track {
  MTAudioProcessingTapCallbacks callbacks = {kMTAudioProcessingTapCallbacksVersion_0,
    (__bridge void *)self, initialize, finalize, prepare, unprepare, process};
  MTAudioProcessingTapRef tap = NULL;
  if (MTAudioProcessingTapCreate(NULL, &callbacks, kMTAudioProcessingTapCreationFlag_PostEffects, &tap) != noErr)
    return nil;
  AVMutableAudioMixInputParameters *input = [AVMutableAudioMixInputParameters audioMixInputParametersWithTrack:track];
  input.audioTapProcessor = tap;
  CFRelease(tap);
  AVMutableAudioMix *mix = [AVMutableAudioMix audioMix];
  mix.inputParameters = @[input];
  return mix;
}
@end
