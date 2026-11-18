import { AccessibilityInfo, Alert } from 'react-native';
import { saveRatingWithFeedback, showRatingError } from '../ratingFeedback';
import { setLocalRating } from '../../../offline/outbox/runtime';
jest.mock('../../../offline/outbox/runtime', () => ({
  setLocalRating: jest.fn(),
}));
jest.mock('../../../shared/storage/settings', () => ({
  getSettings: () => ({ language: 'en' }),
}));

test('announces only a committed local rating and reports failures', async () => {
  const announce = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibility')
    .mockImplementation(() => {});
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  setLocalRating
    .mockResolvedValueOnce({ rating: 'dislike', state: 'pending' })
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error('disk'));
  await saveRatingWithFeedback({}, { id: 1 }, 'dislike');
  expect(announce).toHaveBeenCalledWith('Rating saved on this device');
  await expect(saveRatingWithFeedback({}, { id: 1 }, 'like')).rejects.toThrow();
  await expect(saveRatingWithFeedback({}, { id: 1 }, 'like')).rejects.toThrow(
    'disk',
  );
  showRatingError();
  expect(alert).toHaveBeenCalledWith(
    'Could not save rating',
    'Please try again.',
  );
  expect(announce).toHaveBeenCalledTimes(1);
});
