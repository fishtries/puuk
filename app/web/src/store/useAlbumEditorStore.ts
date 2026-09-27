import { create } from 'zustand';
import { Album } from '../types/track';

export interface AlbumEditorStoreState {
  isOpen: boolean;
  album: Album | null;
  openAlbumEditor: (album: Album) => void;
  closeAlbumEditor: () => void;
}

export const useAlbumEditorStore = create<AlbumEditorStoreState>((set) => ({
  isOpen: false,
  album: null,
  openAlbumEditor: (album: Album) => set({ isOpen: true, album }),
  closeAlbumEditor: () => set({ isOpen: false, album: null }),
}));
