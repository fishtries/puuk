import { create } from 'zustand';
import { Album } from '../types/track';

/**
 * Cross-component album navigation: the Library drawer and other entry points
 * request opening an album, and the home stage consumes the request.
 */
interface AlbumNavigationState {
  pendingAlbum: Album | null;
  requestOpenAlbum: (album: Album) => void;
  consumePendingAlbum: () => Album | null;
}

export const useAlbumNavigationStore = create<AlbumNavigationState>((set, get) => ({
  pendingAlbum: null,
  requestOpenAlbum: (album: Album) => set({ pendingAlbum: album }),
  consumePendingAlbum: () => {
    const album = get().pendingAlbum;
    if (album) set({ pendingAlbum: null });
    return album;
  },
}));
