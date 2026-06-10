/**
 * bee — CloudBees CLI build script.
 * Compiles the TypeScript source into a single standalone binary for RHEL8 (glibc 2.28+).
 *
 * Output: ./dist/bee
 */

const VERSION =
  (await Bun.file("package.json").json().then((p) => p.version).catch(() => "0.0.0")) ?? "0.0.0";

console.log(`Building bee v${VERSION} → ./dist/bee`);

const result = await Bun.build({
  entrypoints: ["./src/main.ts"],
  // Standalone executable for RHEL8 (glibc 2.28+). baseline = no AVX2 requirement.
  compile: { target: "bun-linux-x64-baseline", outfile: "./dist/bee" },
  minify: true,
  // NOTE: bytecode is intentionally NOT enabled. Ink's flexbox engine
  // (yoga-layout) fails to compile with bytecode. minify alone is fine.
  sourcemap: "linked",
  define: { BEE_VERSION: `"${VERSION}"` },
  jsx: {
    runtime: "automatic",
    importSource: "react",
    // CRITICAL: emit the production JSX runtime (jsx/jsxs), not jsxDEV.
    // The compiled binary has no jsxDEV symbol, so a dev-runtime build crashes
    // at first render with "<minified> is not a function". Neither NODE_ENV
    // (spawn env or --define) nor --compile/--production flip this — only this
    // explicit flag does. Verified against bun 1.3.x.
    development: false,
  },
});

if (!result.success) {
  console.error("\nBinary compilation failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log("\n  ✓ Binary built: ./dist/bee\n");

export {};
