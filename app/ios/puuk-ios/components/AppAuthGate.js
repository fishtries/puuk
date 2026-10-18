import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import LoginModal from './LoginModal';

export default function AppAuthGate({
  isChecking,
  currentUser,
  onLoginSuccess,
}) {
  if (isChecking) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: '#000',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <StatusBar style="light" />
        <ActivityIndicator size="large" color="#FA243C" />
      </View>
    );
  }

  if (!currentUser) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <StatusBar style="light" />
        <LoginModal
          visible
          mandatory
          onClose={() => {}}
          currentUser={currentUser}
          onLoginSuccess={onLoginSuccess}
        />
      </View>
    );
  }

  return null;
}
