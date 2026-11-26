import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import MainTabsScreen from './MainTabs';
import AlbumScreen from '../features/albums/AlbumScreen';
import AlbumEditScreen from '../features/albums/AlbumEditScreen';
import PlaylistScreen from '../features/playlists/PlaylistScreen';
import DownloadedScreen from '../features/downloads/DownloadedScreen';
import TrackEditScreen from '../features/library/TrackEditScreen';
import ArtistScreen from '../features/artists/ArtistScreen';
import ArtistCreditBulkScreen from '../features/artists/ArtistCreditBulkScreen';
import ArtistArtworkEditScreen from '../features/artists/ArtistArtworkEditScreen';

import EqualizerScreen from '../features/equalizer/EqualizerScreen';
import SettingsScreen from '../features/auth/SettingsScreen';
import AccountScreen from '../features/auth/AccountScreen';
import { OfflineSettingsScreen } from '../features/auth/OfflineSettings';

const Stack = createNativeStackNavigator();

const RootNavigator = React.memo(function RootNavigator({
  tracks,
  isPlaying,
  currentTrack,
  playTrack,
  playTrackList,
  startWave,
  isModalOpen,
  setTrackToManage,
  onAddToPlaylist,
  onEditTrack,
  currentUser,
  onOpenAuthModal,
  expandProgress,
  isPlayerVisible,
  onExpand,
  dismissProgress,
  dismissDragY,
  onDismiss,
  onLoadMoreTracks,
  hasMoreTracks,
  isLoadingMoreTracks,
  onRefreshTracks,
  syncStatus,
  onRetry,
}) {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MainTabs">
        {(props) => (
          <MainTabsScreen
            {...props}
            tracks={tracks}
            isPlaying={isPlaying}
            currentTrack={currentTrack}
            playTrack={playTrack}
            playTrackList={playTrackList}
            startWave={startWave}
            isModalOpen={isModalOpen}
            setTrackToManage={setTrackToManage}
            currentUser={currentUser}
            onOpenAuthModal={onOpenAuthModal}
            expandProgress={expandProgress}
            isPlayerVisible={isPlayerVisible}
            onExpand={onExpand}
            dismissProgress={dismissProgress}
            dismissDragY={dismissDragY}
            onDismiss={onDismiss}
            onLoadMoreTracks={onLoadMoreTracks}
            hasMoreTracks={hasMoreTracks}
            isLoadingMoreTracks={isLoadingMoreTracks}
            onRefreshTracks={onRefreshTracks}
            syncStatus={syncStatus}
            onRetry={onRetry}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Settings">
        {(props) => <SettingsScreen {...props} currentUser={currentUser} />}
      </Stack.Screen>
      <Stack.Screen name="Account">
        {(props) => <AccountScreen {...props} currentUser={currentUser} />}
      </Stack.Screen>
      <Stack.Screen name="Equalizer" component={EqualizerScreen} />
      <Stack.Screen name="OfflineSettings" component={OfflineSettingsScreen} />
      <Stack.Screen name="Album">
        {(props) => (
          <AlbumScreen
            {...props}
            onPlayTrackList={playTrackList}
            onPressEllipsis={setTrackToManage}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="ArtistDetail">
        {(props) => (
          <ArtistScreen
            {...props}
            currentUser={currentUser}
            onPlayTrack={playTrack}
            onPressEllipsis={setTrackToManage}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="ArtistCreditBulk">
        {(props) => (
          <ArtistCreditBulkScreen {...props} currentUser={currentUser} />
        )}
      </Stack.Screen>
      <Stack.Screen name="ArtistEdit">
        {(props) => (
          <ArtistArtworkEditScreen {...props} currentUser={currentUser} />
        )}
      </Stack.Screen>
      <Stack.Screen name="AlbumEdit" component={AlbumEditScreen} />
      <Stack.Screen name="Playlist">
        {(props) => (
          <PlaylistScreen
            {...props}
            onPlayTrackList={playTrackList}
            onAddToPlaylist={onAddToPlaylist}
            onEditTrack={onEditTrack}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Downloaded">
        {(props) => <DownloadedScreen {...props} isCovered={isModalOpen || isPlayerVisible} onPlayTrackList={playTrackList} />}
      </Stack.Screen>
      <Stack.Screen name="TrackEdit" component={TrackEditScreen} />
    </Stack.Navigator>
  );
});

export default RootNavigator;
