const { withAppDelegate } = require('expo/config-plugins');

const moduleImport = 'internal import PuukBackgroundDownloads';
const callback = `
  // Puuk background audio downloads
  public override func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    if PuukBackgroundEvents.handle(identifier, completion: completionHandler) {
      return
    }
    super.application(application, handleEventsForBackgroundURLSession: identifier, completionHandler: completionHandler)
  }
`;

module.exports = config => withAppDelegate(config, config => {
  const delegate = config.modResults;
  if (delegate.language !== 'swift') throw new Error('Puuk background downloads require a Swift AppDelegate');
  if (delegate.contents.includes('// Puuk background audio downloads')) {
    delegate.contents = delegate.contents.replace(/^import PuukBackgroundDownloads$/m, moduleImport);
    return config;
  }
  const template = /(@main\s+class AppDelegate:\s*ExpoAppDelegate(?:\s*,\s*[\w.]+)*\s*\{)/;
  if (!template.test(delegate.contents)) {
    throw new Error('Could not find the ExpoAppDelegate subclass for Puuk background downloads');
  }
  if (delegate.contents.includes('handleEventsForBackgroundURLSession')) {
    throw new Error('Wire PuukBackgroundEvents.handle into the existing background URLSession callback');
  }
  delegate.contents = moduleImport + '\n' + delegate.contents.replace(template, '$1\n' + callback);
  return config;
});
