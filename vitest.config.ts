import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          environment: "node",
          // Canlı ozdisan.com'a bağlanır: siteyi yormamak için dosyalar sırayla çalışır.
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
          retry: 1,
        },
      },
    ],
  },
});
