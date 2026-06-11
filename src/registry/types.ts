/**
 * Plugin system type definitions.
 *
 * All built-in features (auth, controller, job, credential, node) are implemented
 * as plugins that satisfy these same contracts — there is no privileged path for
 * built-ins. A third-party plugin has exactly the same capabilities.
 */
import type { Command } from "commander";
import type { FC, ReactNode } from "react";
import type { CloudBeesClient } from "../core/api/types";

/** Plugin metadata */
export interface PluginMeta {
  /** Unique plugin identifier (e.g. "auth", "jobs", "my-custom-plugin") */
  name: string;
  /** Human-readable description */
  description: string;
  /** Semantic version */
  version: string;
  /** Plugin category for organization */
  category: PluginCategory;
}

export type PluginCategory =
  | "command" // CLI command provider (bee auth, bee job, ...)
  | "resource" // Resource type provider (job, node, cred, future: pipelines, ...)
  | "formatter" // Output formatter (table, json, yaml, ...)
  | "auth-provider"; // Authentication provider (basic, oauth, ...)

/** Base plugin interface — all plugins implement this */
export interface Plugin {
  meta: PluginMeta;
  /** Called once during CLI bootstrap to register commands, formatters, etc. */
  register(ctx: PluginContext): void | Promise<void>;
  /**
   * Optional: contribute a TUI tab. Built-in and third-party plugins use the
   * exact same contract — there is no privileged path for built-in tabs.
   */
  screen?(): TuiScreen;
}

/**
 * Context passed to plugins during registration.
 *
 * Intentionally minimal: it exposes the commander program (to attach commands),
 * a client factory (the one genuinely shared, cross-cutting concern), and the
 * formatter registry. Plugins import their own services/DTOs directly from their
 * own directory — the context does not proxy them.
 */
export interface PluginContext {
  /** Root commander program — plugins attach subcommands here */
  program: Command;
  /** Build an authenticated client scoped to the active controller (or raw server). */
  getClient(opts?: GetClientOptions): Promise<CloudBeesClient>;
  /** Register an output formatter under a name (e.g. "json", "yaml"). */
  registerFormatter(name: string, formatter: OutputFormatter): void;
  /** Look up a registered formatter (falls back to the default table formatter). */
  getFormatter(name: string): OutputFormatter | undefined;
}

export interface GetClientOptions {
  /** Profile name to use; defaults to the active/default profile. */
  profile?: string;
  /** When true (default), rebases the client onto the active controller's URL. */
  useController?: boolean;
}

/** Output formatter interface */
export interface OutputFormatter {
  /** Format tabular data */
  table(headers: string[], rows: string[][]): string;
  /** Format key-value pairs */
  kv(data: Record<string, unknown>): string;
  /** Format a single message (info, error, success, warning) */
  message(text: string, level: "info" | "error" | "success" | "warning"): string;
}

// ─── TUI plugin contract ────────────────────────────────────────────────────

/**
 * A TUI tab contributed by a plugin via `screen?()`.
 * The framework collects these, sorts by `order`, and renders one tab each.
 */
export interface TuiScreen {
  /** Stable id (e.g. "jobs") — also used as the tab's React key. */
  id: string;
  /** Tab label shown in the tab bar (e.g. "Jobs"). */
  title: string;
  /** Sort order in the tab bar (1-based; lower = leftmost). */
  order: number;
  /** Optional icon/glyph rendered before the title. */
  icon?: string;
  /** The React component rendered when this tab is shown. */
  Component: FC<TuiScreenProps>;
}

/** Props handed to every screen component. */
export interface TuiScreenProps {
  /** Shared TUI context (client factory, modals, notifications, session). */
  ctx: TuiContext;
  /** True when this tab is the active/focused one — gate `useInput` on it. */
  active: boolean;
}

/** Severity levels for toast notifications. */
export type NotifyLevel = "info" | "success" | "error" | "warning";

/**
 * Runtime context available to TUI screens. Distinct from PluginContext
 * (which is registration-time and commander-oriented).
 */
export interface TuiContext {
  /** Build an authenticated client scoped to the active controller (or raw server). */
  getClient(opts?: GetClientOptions): Promise<CloudBeesClient>;
  /** Logged-in username, or "" when not logged in. */
  username: string;
  /** Active controller name, or null when none selected. */
  activeController: string | null;
  /** Whether a session is currently loaded. */
  loggedIn: boolean;
  /** Active profile name. */
  profile: string;
  /** Switch the active profile; returns false if the target has no session. */
  switchProfile(profileName: string): boolean;
  /** Push a modal and resolve with its result (or null if dismissed). */
  openModal<T>(spec: ModalSpec<T>): Promise<T | null>;
  /** Show a transient toast notification. */
  notify(message: string, level?: NotifyLevel): void;
  /** Resolved DB path (for tracked-resource lookups). */
  dbPath?: string;
  /**
   * Publish the active screen's footer key hints to the shell. Screens call this
   * (in an effect) with the hints derived from their keymap; the shell renders
   * them in the StatusBar alongside the global hints. Pass [] to clear.
   */
  setActiveKeyHints(hints: { key: string; label: string }[]): void;
  /**
   * Mark a non-modal overlay (e.g. the log viewer) as owning all input. While
   * true, the shell suspends its own global keys so the overlay can handle keys
   * like `q` without the shell quitting. Always pair set(true) with set(false).
   */
  setInputCaptured(captured: boolean): void;
  /**
   * Verify credentials, persist an encrypted session, and refresh the TUI's
   * logged-in state. Used by the login modal. Throws on invalid credentials.
   */
  login(serverUrl: string, username: string, token: string): Promise<void>;
}

/**
 * A modal request. The component receives `resolve` to close itself with a
 * typed result; the framework renders it as an overlay above the active tab.
 */
export interface ModalSpec<T> {
  /** Stable id for React keying. */
  id: string;
  /** Renders the modal; call `resolve(value)` to close, `resolve(null)` to cancel. */
  render(resolve: (value: T | null) => void): ReactNode;
}
