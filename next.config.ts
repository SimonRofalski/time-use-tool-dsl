import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import packageJson from "./package.json";

// Next.js configuration; the next-intl plugin wires in the i18n request config.
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  // Docker image (Dockerfile): self-contained server in .next/standalone, only the files it needs
  output: "standalone",
  poweredByHeader: false,
  // Shown in the settings panel ("App" tile): version from package.json (raise it before tagging a
  // release, see docs/ENTWICKLUNG.md) and the commit the image was built from (APP_COMMIT, set by
  // the GitLab pipeline; empty in local builds). Inlined at build time.
  env: {
    NEXT_PUBLIC_APP_VERSION: packageJson.version,
    NEXT_PUBLIC_APP_COMMIT: process.env.APP_COMMIT ?? "",
  },
};

export default withNextIntl(nextConfig);
