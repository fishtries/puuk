import type { Track } from './track';

export interface PersonalizedPlaylistSection {
  id: string;
  type: 'genre';
  title: string;
  description: string;
  genre: string;
  tracks: Track[];
}

export interface PersonalizedRecommendationsResponse {
  sections: PersonalizedPlaylistSection[];
}
