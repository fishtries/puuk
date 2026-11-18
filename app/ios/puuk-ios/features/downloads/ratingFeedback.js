import { AccessibilityInfo, Alert } from 'react-native';
import { getSettings } from '../../shared/storage/settings';
import { setLocalRating } from '../../offline/outbox/runtime';

export async function saveRatingWithFeedback(session, track, rating) {
  const result = await setLocalRating(session, track, rating);
  if (!result || result.rating !== rating)
    throw new Error('Rating was not saved');
  const ru = getSettings().language === 'ru';
  AccessibilityInfo?.announceForAccessibility?.(
    ru ? 'Оценка сохранена на устройстве' : 'Rating saved on this device',
  );
  return result;
}

export function showRatingError() {
  const ru = getSettings().language === 'ru';
  Alert.alert(
    ru ? 'Не удалось сохранить оценку' : 'Could not save rating',
    ru ? 'Попробуйте ещё раз.' : 'Please try again.',
  );
}
