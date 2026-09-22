import type { Track } from './track';

export type MoodId = 'chill' | 'energetic' | 'focus' | 'happy' | 'sad' | 'night' | string;

export interface MoodCatalogItem {
  id: string;
  title: string;
  description: string;
}

export interface MoodPlaylistResponse {
  mood: {
    id: string;
    title: string;
  };
  playlist: {
    id: number | null;
    name: string;
  };
  tracks: Track[];
}

export interface YoullLikeThisSection {
  type: string;
  mood: string;
  title: string;
  tracks: Track[];
}

export interface YoullLikeThisResponse {
  sections: YoullLikeThisSection[];
}

export interface MoodItem {
  id: string;
  title: string;
  description: string;
  color: string;
  gradient: string;
  tracks: Track[];
  coverUrl?: string;
}
