/**
 * bee — CloudBees CLI build script.
 * Compiles the TypeScript source into a single standalone binary for RHEL8 (glibc 2.28+).
 *
 * Output: ./dist/bee
 */

const VERSION =
  (await Bun.file("package.json").json().then((p) => p.version).catch(() => "0.0.0")) ?? "0.0.0";

console.log(`Building bee v${VERSION} → ./dist/bee`);

const proc = Bun.spawn(
  [
    "bun",
    "build",
    "--compile",
    "--target=bun-linux-x64-baseline",
    "--minify",
    // NOTE: --bytecode is intentionally NOT used. Ink's flexbox engine
    // (yoga-layout) fails to compile with bytecode. --minify alone is fine.
    "--sourcemap",
    `--define=BEE_VERSION="${VERSION}"`,
    // Ink/React must run in production mode: otherwise Bun emits the JSX dev
    // runtime (jsxDEV) which is undefined in the compiled binary and crashes.
    '--define=process.env.NODE_ENV="production"',
    "./src/main.ts",
    "--outfile",
    "./dist/bee",
  ],
  { stdout: "inherit", stderr: "inherit" },
);

const exitCode = await proc.exited;
if (exitCode !== 0) {
  console.error(`\nBinary compilation failed (exit ${exitCode})`);
  process.exit(exitCode);
}

console.log("\n  ✓ Binary built: ./dist/bee\n");

export {};
