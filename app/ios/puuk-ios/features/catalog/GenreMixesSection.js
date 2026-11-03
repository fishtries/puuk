import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  DeviceEventEmitter,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInRight } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import CoverImage from '../../shared/media/CoverImage';
import { fetchPersonalizedRecommendations } from '../../shared/api/recommendations';
import { getSettings, addSettingsListener } from '../../shared/storage/settings';
import { getAuthToken, addAuthListener, getCachedUser } from '../../shared/api/api';

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

// Memory cache across component remounts / tab switches
let memoryCachedSections = null;

/**
 * Formats genre mix title (e.g. "Rock Mix" or section title).
 */
export function formatMixTitle(section) {
  if (!section) return 'Mix';
  if (section.genre && typeof section.genre === 'string' && section.genre.trim()) {
    const trimmed = section.genre.trim();
    // Capitalize first letter if needed
    const genreName = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    return `${genreName} Mix`;
  }
  return section.title || 'Mix';
}

/**
 * Single card for a personalized genre mix.
 */
export const GenreMixCard = React.memo(function GenreMixCard({
  section,
  index,
  accentColor,
  hapticsEnabled = true,
  onPress,
  onPlayPress,
}) {
  const title = formatMixTitle(section);
  const coverArt = section.tracks?.[0]?.coverArt;
  const trackCount = section.tracks?.length || 0;

  const handleCardPress = useCallback(() => {
    if (hapticsEnabled) {
      Haptics.selectionAsync().catch(() => {});
    }
    if (onPress) onPress(section);
  }, [hapticsEnabled, onPress, section]);

  const handlePlay = useCallback(
    (e) => {
      e?.stopPropagation?.();
      if (hapticsEnabled) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      }
      if (onPlayPress) {
        onPlayPress(section);
      } else if (onPress) {
        onPress(section);
      }
    },
    [hapticsEnabled, onPlayPress, onPress, section],
  );

  return (
    <AnimatedTouchable
      entering={FadeInRight.delay(Math.min(index * 40, 300)).duration(320)}
      style={styles.card}
      activeOpacity={0.75}
      onPress={handleCardPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, made for you, ${trackCount} tracks`}
      testID={`genre-mix-card-${section.id || index}`}
    >
      <View style={styles.coverWrapper}>
        {coverArt ? (
          <CoverImage source={coverArt} style={styles.coverImage} />
        ) : (
          <View style={styles.fallbackCover}>
            <Ionicons
              name="disc-outline"
              size={42}
              color={accentColor || '#FFDAB9'}
            />
            {Boolean(section.genre) && (
              <Text style={styles.fallbackGenreText} numberOfLines={1}>
                {section.genre}
              </Text>
            )}
          </View>
        )}

        {/* Track count badge */}
        {trackCount > 0 && (
          <View style={styles.countBadge}>
            <Text style={styles.countBadgeText}>{trackCount}</Text>
          </View>
        )}

        {/* Play button overlay */}
        <TouchableOpacity
          style={styles.playButtonOverlay}
          activeOpacity={0.8}
          onPress={handlePlay}
          accessibilityRole="button"
          accessibilityLabel={`Play ${title}`}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          testID={`genre-mix-play-${section.id || index}`}
        >
          <Ionicons
            name="play"
            size={16}
            color="#ffffff"
            style={styles.playIconOffset}
          />
        </TouchableOpacity>
      </View>

      <Text style={styles.cardTitle} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.cardSubtitle} numberOfLines={1}>
        made for you
      </Text>
    </AnimatedTouchable>
  );
});

export default function GenreMixesSection({
  currentUser,
  navigation,
  onPlayTrackList,
  accentColor: propAccentColor,
  sections: propSections,
}) {
  const [sections, setSections] = useState(() => {
    if (Array.isArray(propSections)) return propSections;
    if (Array.isArray(memoryCachedSections)) return memoryCachedSections;
    return [];
  });
  const [accentColor, setAccentColor] = useState(
    () => propAccentColor || getSettings().accentColor || '#FFDAB9',
  );
  const [hapticsEnabled, setHapticsEnabled] = useState(
    () => getSettings().hapticsEnabled ?? true,
  );
  const abortControllerRef = useRef(null);

  useEffect(() => {
    const unsub = addSettingsListener((s) => {
      if (s.accentColor && !propAccentColor) setAccentColor(s.accentColor);
      if (typeof s.hapticsEnabled === 'boolean')
        setHapticsEnabled(s.hapticsEnabled);
    });
    return unsub;
  }, [propAccentColor]);

  // Synchronize when propSections changes
  useEffect(() => {
    if (Array.isArray(propSections)) {
      setSections(propSections);
    }
  }, [propSections]);

  const loadRecommendations = useCallback(async () => {
    if (propSections !== undefined) return;

    const token = await getAuthToken();
    if (!token && !currentUser && !getCachedUser()) {
      setSections([]);
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetchPersonalizedRecommendations({
        limit: 20,
        sections: 3,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        const resultSections = Array.isArray(response.sections) ? response.sections : [];
        memoryCachedSections = resultSections;
        setSections(resultSections);
      }
    } catch (e) {
      if (e?.name !== 'AbortError' && !controller.signal.aborted) {
        console.warn('[GenreMixesSection error]', e);
        if (!memoryCachedSections) {
          setSections([]);
        }
      }
    }
  }, [currentUser, propSections]);

  useEffect(() => {
    loadRecommendations();

    const unsubAuth = addAuthListener(() => {
      loadRecommendations();
    });

    const subRefresh = DeviceEventEmitter.addListener(
      'PUUK_REFRESH_RECOMMENDATIONS',
      loadRecommendations,
    );

    return () => {
      unsubAuth();
      subRefresh.remove();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [loadRecommendations]);

  const handleOpenMix = useCallback(
    (section) => {
      const mixTitle = formatMixTitle(section);
      if (navigation && typeof navigation.navigate === 'function') {
        navigation.navigate('Playlist', {
          playlistId: section.id,
          playlistName: mixTitle,
          tracks: section.tracks,
          subtitle: 'made for you',
          coverArt: section.tracks?.[0]?.coverArt,
          isReadOnly: true,
        });
      } else if (onPlayTrackList && section.tracks?.length > 0) {
        onPlayTrackList(section.tracks, 0);
      }
    },
    [navigation, onPlayTrackList],
  );

  const handlePlayMix = useCallback(
    (section) => {
      if (onPlayTrackList && section.tracks?.length > 0) {
        onPlayTrackList(section.tracks, 0);
      } else {
        handleOpenMix(section);
      }
    },
    [onPlayTrackList, handleOpenMix],
  );

  // If no sections are available, don't occupy empty space
  if (!sections || sections.length === 0) {
    return null;
  }

  return (
    <View style={styles.container} testID="genre-mixes-section">
      <View style={styles.sectionHeader}>
        <View style={styles.headerTitleCol}>
          <Text style={styles.sectionTitle}>Genre Mixes</Text>
          <Text style={styles.sectionSubtitle}>made for you</Text>
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollList}
      >
        {sections.map((section, index) => (
          <GenreMixCard
            key={section.id || `section-${index}`}
            section={section}
            index={index}
            accentColor={accentColor}
            hapticsEnabled={hapticsEnabled}
            onPress={handleOpenMix}
            onPlayPress={handlePlayMix}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  headerTitleCol: {
    flex: 1,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: -0.3,
  },
  sectionSubtitle: {
    fontSize: 13,
    fontWeight: '500',
    color: '#8e8e93',
    letterSpacing: -0.1,
    marginTop: 2,
  },
  scrollList: {
    paddingHorizontal: 20,
    gap: 14,
    paddingBottom: 4,
  },
  card: {
    width: 140,
  },
  coverWrapper: {
    width: 140,
    height: 140,
    borderRadius: 14,
    backgroundColor: '#1c1c22',
    overflow: 'hidden',
    position: 'relative',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  coverImage: {
    width: '100%',
    height: '100%',
  },
  fallbackCover: {
    width: '100%',
    height: '100%',
    backgroundColor: '#18181c',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 8,
  },
  fallbackGenreText: {
    color: '#8e8e93',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 6,
    textAlign: 'center',
  },
  countBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  countBadgeText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '600',
  },
  playButtonOverlay: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  playIconOffset: {
    marginLeft: 2,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
    marginTop: 8,
    letterSpacing: -0.2,
  },
  cardSubtitle: {
    fontSize: 12,
    fontWeight: '400',
    color: '#8e8e93',
    marginTop: 2,
  },
});
