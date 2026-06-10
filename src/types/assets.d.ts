/**
 * Type declarations for non-code asset imports handled by the Bun bundler.
 *
 * `import sql from "./schema.sql" with { type: "text" }` inlines the file's
 * contents as a string at build time (works in both `bun run` and the
 * `--compile` standalone binary, unlike runtime fs reads).
 */
declare module "*.sql" {
  const content: string;
  export default content;
}
