import type { NextConfig } from "next";
import { landingDir, stylexBabel } from "./stylex.babel.mjs";

const optionalModules = ["@farcaster/mini-app-solana", "pino-pretty"];

const config: NextConfig = {
  agentRules: false,
  transpilePackages: ["@eox/app-api"],
  turbopack: {
    resolveAlias: {
      ...Object.fromEntries(optionalModules.map((name) => [name, "./src/lib/empty-module.ts"])),
      "./cox-client.js": "../../packages/app-api/src/cox-client.ts",
      "./cox-types.js": "../../packages/app-api/src/cox-types.ts",
    },
    rules: {
      "*.{ts,tsx}": {
        condition: { path: /[\\/]src[\\/]landing[\\/]/ },
        loaders: [{ loader: "babel-loader", options: stylexBabel }],
      },
    },
  },
  webpack(webpackConfig) {
    webpackConfig.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    webpackConfig.resolve.alias = { ...webpackConfig.resolve.alias, ...Object.fromEntries(optionalModules.map((name) => [name, false])) };
    webpackConfig.ignoreWarnings = [...(webpackConfig.ignoreWarnings ?? []), { module: /[\\/]ox[\\/]_esm[\\/]tempo[\\/]internal[\\/]virtualMasterPool\.js$/, message: /the request of a dependency is an expression/ }];
    webpackConfig.module.rules.unshift({
      test: /\.tsx?$/,
      include: landingDir,
      enforce: "pre",
      use: [{ loader: "babel-loader", options: stylexBabel }],
    });
    return webpackConfig;
  },
};

export default config;
