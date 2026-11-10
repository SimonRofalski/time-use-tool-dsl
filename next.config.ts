import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Next.js configuration; the next-intl plugin wires in the i18n request config.
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  // Docker image (Dockerfile): self-contained server in .next/standalone, only the files it needs
  output: "standalone",
  poweredByHeader: false,
};

export default withNextIntl(nextConfig);
