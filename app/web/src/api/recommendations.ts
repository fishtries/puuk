import { apiClient } from './client';
import type { PersonalizedRecommendationsResponse } from '../types/recommendations';

/**
 * Персональные жанровые подборки «You'll like this».
 * Пустой профиль пользователя → { sections: [] } — без подстановки контента библиотеки.
 * Максимум 20 треков в секции, максимум 3 секции (гарантируется бэкендом).
 */
export async function fetchPersonalizedRecommendations(
  options: { limit?: number; sections?: number } = {}
): Promise<PersonalizedRecommendationsResponse> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.append('limit', String(options.limit));
  if (options.sections !== undefined) params.append('sections', String(options.sections));

  const query = params.toString();
  return apiClient<PersonalizedRecommendationsResponse>(
    `/api/recommendations/youll-like-this${query ? `?${query}` : ''}`
  );
}
