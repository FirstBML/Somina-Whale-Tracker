/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Stub out optional React Native / pino deps that don't exist in browser
      config.resolve.alias["@react-native-async-storage/async-storage"] = false;
      config.resolve.alias["pino-pretty"] = false;
    }
    return config;
  },
};

module.exports = nextConfig;