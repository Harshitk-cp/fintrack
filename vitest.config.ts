import { defineConfig } from "vitest/config";

// DB test files reset the shared fintrack_test schema, so they must not overlap.
export default defineConfig({ test: { fileParallelism: false } });
