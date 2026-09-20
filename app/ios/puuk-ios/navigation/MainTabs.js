import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  StyleSheet,
  DeviceEventEmitter,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { SymbolView } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import AppHeader from '../components/AppHeader';
import HomeScreen from '../components/HomeScreen';
import SearchScreen from '../components/SearchScreen';
import LibraryScreen from '../components/LibraryScreen';
import { getSettings, addSettingsListener } from '../utils/settings';

const Tab = createBottomTabNavigator();

const MainTabsScreen = React.memo(function MainTabsScreen({
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
  const [activeTab, setActiveTab] = useState('Home');
  const [accentColor, setAccentColor] = useState(() => getSettings().accentColor || '#FFDAB9');
  const [hapticsEnabled, setHapticsEnabled] = useState(() => getSettings().hapticsEnabled ?? true);

  useEffect(() => {
    const unsub = addSettingsListener((s) => {
      if (s.accentColor) setAccentColor(s.accentColor);
      if (typeof s.hapticsEnabled === 'boolean') setHapticsEnabled(s.hapticsEnabled);
    });
    return unsub;
  }, []);

  const handleTabPress = useCallback((tabName) => {
    if (hapticsEnabled) {
      Haptics.selectionAsync().catch(() => {});
    }
    if (activeTab === tabName) {
      DeviceEventEmitter.emit(`PUUK_SCROLL_TO_TOP_${tabName.toUpperCase()}`);
    }
    setActiveTab(tabName);
  }, [activeTab, hapticsEnabled]);

  const renderHome = useCallback(
    tabProps => (
      <HomeScreen
        {...tabProps}
        tracks={tracks}
        isPlaying={isPlaying}
        currentTrack={currentTrack}
        onPlayTrack={playTrack}
        onStartWave={startWave}
        onPressEllipsis={setTrackToManage}
        currentUser={currentUser}
        onOpenAuthModal={onOpenAuthModal}
      />
    ),
    [tracks, isPlaying, currentTrack, playTrack, startWave, setTrackToManage, currentUser, onOpenAuthModal]
  );

  const renderSearch = useCallback(
    tabProps => (
      <SearchScreen
        {...tabProps}
        isPlaying={isPlaying}
        currentTrack={currentTrack}
        onPlayTrack={playTrack}
        onAddToPlaylist={setTrackToManage}
        onPressEllipsis={setTrackToManage}
        currentUser={currentUser}
        onOpenAuthModal={onOpenAuthModal}
      />
    ),
    [isPlaying, currentTrack, playTrack, setTrackToManage, currentUser, onOpenAuthModal]
  );

  const renderLibrary = useCallback(
    tabProps => (
      <LibraryScreen
        {...tabProps}
        isPlaying={isPlaying}
        currentTrack={currentTrack}
        onPlayTrack={playTrack}
        onPlayTrackList={playTrackList}
        onPressEllipsis={setTrackToManage}
        currentUser={currentUser}
        onOpenAuthModal={onOpenAuthModal}
      />
    ),
    [isPlaying, currentTrack, playTrack, playTrackList, setTrackToManage, currentUser, onOpenAuthModal]
  );

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <SafeAreaView edges={['top']} style={{ backgroundColor: '#000' }}>
        <AppHeader
          activeTab={activeTab}
          currentUser={currentUser}
          onOpenAuthModal={onOpenAuthModal}
          onAddPlaylist={() => DeviceEventEmitter.emit('PUUK_CREATE_PLAYLIST')}
        />
      </SafeAreaView>
      <Tab.Navigator
        screenOptions={{
          lazy: false,
          detachInactiveScreens: false,
          headerShown: false,
          tabBarStyle: {
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            borderTopColor: 'rgba(255, 255, 255, 0.15)',
            borderTopWidth: StyleSheet.hairlineWidth,
            backgroundColor: 'transparent',
            elevation: 0,
          },
          tabBarBackground: () => (
            <View style={StyleSheet.absoluteFill}>
              <BlurView
                tint={Platform.OS === 'ios' ? 'systemChromeMaterialDark' : 'dark'}
                intensity={95}
                style={StyleSheet.absoluteFill}
              />
              <View
                style={[
                  StyleSheet.absoluteFill,
                  { backgroundColor: 'rgba(0, 0, 0, 0.35)' },
                ]}
              />
            </View>
          ),
          tabBarActiveTintColor: accentColor,
          tabBarInactiveTintColor: '#8E8E93',
          tabBarLabelStyle: {
            fontSize: 10,
            fontWeight: '500',
            letterSpacing: 0.12,
            marginBottom: Platform.OS === 'ios' ? 0 : 3,
          },
          tabBarIconStyle: {
            marginTop: 4,
          },
        }}
      >
        <Tab.Screen 
          name="Home" 
          listeners={{
            tabPress: () => handleTabPress('Home'),
            focus: () => setActiveTab('Home'),
          }}
          options={{ 
            tabBarLabel: 'Home', 
            tabBarIcon: ({ focused, color }) => (
              <SymbolView
                name={focused ? 'house.fill' : 'house'}
                size={24}
                tintColor={color}
                fallback={
                  <Ionicons
                    name={focused ? 'home' : 'home-outline'}
                    color={color}
                    size={24}
                  />
                }
              />
            ),
          }}
        >
          {renderHome}
        </Tab.Screen>
        <Tab.Screen 
          name="Search" 
          listeners={{
            tabPress: () => handleTabPress('Search'),
            focus: () => setActiveTab('Search'),
          }}
          options={{ 
            tabBarLabel: 'Search', 
            tabBarIcon: ({ focused, color }) => (
              <SymbolView
                name="magnifyingglass"
                size={24}
                weight={focused ? 'semibold' : 'regular'}
                tintColor={color}
                fallback={
                  <Ionicons
                    name={focused ? 'search' : 'search-outline'}
                    color={color}
                    size={24}
                  />
                }
              />
            ),
          }}
        >
          {renderSearch}
        </Tab.Screen>
        <Tab.Screen 
          name="Library" 
          listeners={{
            tabPress: () => handleTabPress('Library'),
            focus: () => setActiveTab('Library'),
          }}
          options={{ 
            tabBarLabel: 'Library', 
            tabBarIcon: ({ focused, color }) => (
              <SymbolView
                name={focused ? 'square.stack.fill' : 'square.stack'}
                size={24}
                tintColor={color}
                fallback={
                  <Ionicons
                    name={focused ? 'albums' : 'albums-outline'}
                    color={color}
                    size={24}
                  />
                }
              />
            ),
          }}
        >
          {renderLibrary}
        </Tab.Screen>
      </Tab.Navigator>
    </View>
  );
});

export default MainTabsScreen;
