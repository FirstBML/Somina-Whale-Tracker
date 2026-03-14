/* @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.resolve.alias["@react-native-async-storage/async-storage"] = false;
    config.resolve.alias["pino-pretty"] = false;
    return config;
  },
};

module.exports = nextConfig;