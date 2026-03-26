const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName.includes("@livekit/react-native-webrtc") ||
    moduleName.includes("@livekit/react-native") ||
    moduleName.includes("livekit-client")
  ) {
    return { type: "empty" };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;