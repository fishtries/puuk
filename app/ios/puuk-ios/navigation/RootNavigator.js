import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import MainTabsScreen from './MainTabs';
import AlbumScreen from '../components/AlbumScreen';
import AlbumEditScreen from '../components/AlbumEditScreen';
import PlaylistScreen from '../components/PlaylistScreen';
import TrackEditScreen from '../components/TrackEditScreen';

const Stack = createNativeStackNavigator();

export default function RootNavigator({
  tracks,
  isPlaying,
  currentTrack,
  playTrack,
  playTrackList,
  startWave,
  setTrackToManage,
  currentUser,
  onOpenAuthModal,
}) {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MainTabs">
        {props => (
          <MainTabsScreen
            {...props}
            tracks={tracks}
            isPlaying={isPlaying}
            currentTrack={currentTrack}
            playTrack={playTrack}
            playTrackList={playTrackList}
            startWave={startWave}
            setTrackToManage={setTrackToManage}
            currentUser={currentUser}
            onOpenAuthModal={onOpenAuthModal}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Album">
        {props => <AlbumScreen {...props} onPlayTrack={playTrack} onPressEllipsis={(track) => setTrackToManage(track)} />}
      </Stack.Screen>
      <Stack.Screen name="AlbumEdit" component={AlbumEditScreen} />
      <Stack.Screen name="Playlist">
        {props => <PlaylistScreen {...props} onPlayTrack={playTrack} />}
      </Stack.Screen>
      <Stack.Screen name="TrackEdit" component={TrackEditScreen} />
    </Stack.Navigator>
  );
}
