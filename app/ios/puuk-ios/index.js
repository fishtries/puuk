import { registerRootComponent } from 'expo';

import App from './App';

// Metro receives only React's warning text on some Expo Go versions. Preserve
// the dispatch/effect stack once so an update loop can be traced to its owner.
if (__DEV__ && !globalThis.__puukUpdateLoopTraceInstalled) {
  globalThis.__puukUpdateLoopTraceInstalled = true;
  const reportError = console.error.bind(console);
  let reported = false;
  console.error = (...args) => {
    reportError(...args);
    if (!reported && typeof args[0] === 'string' &&
        args[0].includes('Maximum update depth exceeded')) {
      reported = true;
      reportError(new Error('Puuk update loop dispatch stack').stack);
    }
  };
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
