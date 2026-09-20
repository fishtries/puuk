import { create } from 'zustand';
import { Track } from '../types/track';

export interface TagEditorStoreState {
  isOpen: boolean;
  track: Track | null;
  openTagEditor: (track: Track) => void;
  closeTagEditor: () => void;
}

export const useTagEditorStore = create<TagEditorStoreState>((set) => ({
  isOpen: false,
  track: null,
  openTagEditor: (track: Track) => set({ isOpen: true, track }),
  closeTagEditor: () => set({ isOpen: false, track: null }),
}));
