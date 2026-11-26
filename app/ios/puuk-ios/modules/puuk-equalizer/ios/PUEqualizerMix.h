#import <AVFoundation/AVFoundation.h>

NS_ASSUME_NONNULL_BEGIN
@interface PUEqualizerMix : NSObject
- (void)setGains:(NSArray<NSNumber *> *)gains NS_SWIFT_NAME(update(gains:));
- (nullable AVAudioMix *)mixForTrack:(AVAssetTrack *)track NS_SWIFT_NAME(makeMix(track:));
@end
NS_ASSUME_NONNULL_END
