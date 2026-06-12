/**
 * TuiContext provider + useTui() hook.
 *
 * Holds runtime state shared across all screens: session info, the modal queue
 * (openModal returns a promise resolved when the modal closes), and the current
 * toast. The actual modal/toast *rendering* happens in app.tsx; this provider
 * owns the state and the imperative API.
 */

import React, { createContext, useContext, useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { TuiContext as ITuiContext, ModalSpec, NotifyLevel, GetClientOptions } from "../../registry/types";
import type { CloudBeesClient } from "../api/types";
import { getClient as coreGetClient, loginSession, getActiveController } from "../client-factory";
import { loadSession, getActiveProfileName, switchProfile as coreSwitchProfile } from "../session/session";
import type { ToastMessage } from "./components/Toast";

interface ActiveModal {
  id: string;
  node: ReactNode;
}

interface SessionInfo {
  username: string;
  activeController: string | null;
  loggedIn: boolean;
  profile: string;
}

const MAX_COMMAND_LOG = 200;

interface TuiState extends ITuiContext {
  /** Currently rendered modal (or null). */
  activeModal: ActiveModal | null;
  /** Current toast (or null). */
  toast: ToastMessage | null;
  /** Update session info (called after login/logout/controller switch). */
  setSession(info: SessionInfo): void;
  /** Footer hints published by the active screen (read by the shell). */
  activeKeyHints: { key: string; label: string }[];
  /** True while a non-modal overlay owns input (shell suspends global keys). */
  inputCaptured: boolean;
  /** Accumulated CLI-equivalent command log entries. */
  commandLog: string[];
}

const Ctx = createContext<TuiState | null>(null);

export function useTui(): TuiState {
  const value = useContext(Ctx);
  if (!value) throw new Error("useTui() must be used inside <TuiProvider>");
  return value;
}

export interface TuiProviderProps {
  initialSession: SessionInfo;
  dbPath?: string;
  children: ReactNode;
}

export const TuiProvider: React.FC<TuiProviderProps> = ({ initialSession, dbPath, children }) => {
  const [session, setSession] = useState<SessionInfo>(initialSession);
  const [activeModal, setActiveModal] = useState<ActiveModal | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [activeKeyHints, setActiveKeyHintsState] = useState<{ key: string; label: string }[]>([]);
  const [inputCaptured, setInputCapturedState] = useState(false);
  const [commandLog, setCommandLog] = useState<string[]>([]);
  const toastSeq = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getClient = useCallback(
    async (opts?: GetClientOptions): Promise<CloudBeesClient> => coreGetClient({ ...opts, dbPath }),
    [dbPath],
  );

  const notify = useCallback((message: string, level: NotifyLevel = "info") => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text: message, level });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const openModal = useCallback(<T,>(spec: ModalSpec<T>): Promise<T | null> => {
    return new Promise<T | null>((resolve) => {
      const node = spec.render((value) => {
        setActiveModal(null);
        resolve(value);
      });
      setActiveModal({ id: spec.id, node });
    });
  }, []);

  // Stable setters — screens call these from effects, so referential stability
  // matters to avoid re-render loops. Guard against no-op updates.
  const setActiveKeyHints = useCallback((hints: { key: string; label: string }[]) => {
    setActiveKeyHintsState((prev) =>
      prev.length === hints.length &&
      prev.every((h, i) => h.key === hints[i]!.key && h.label === hints[i]!.label)
        ? prev
        : hints,
    );
  }, []);

  const setInputCaptured = useCallback((captured: boolean) => {
    setInputCapturedState(captured);
  }, []);

  // Login from the TUI modal: verify + persist via core, then refresh the
  // in-memory session so every screen re-renders as logged-in immediately.
  const login = useCallback(
    async (serverUrl: string, username: string, token: string) => {
      await loginSession(serverUrl, username, token, dbPath);
      const active = getActiveController(dbPath);
      setSession({ username, activeController: active ? active[0] : null, loggedIn: true, profile: getActiveProfileName(dbPath) });
    },
    [dbPath],
  );

  // Switch the active profile via core; on success, refresh the in-memory
  // session so every screen re-renders against the newly-active profile.
  const switchProfile = useCallback(
    (profileName: string): boolean => {
      const ok = coreSwitchProfile(profileName, dbPath);
      if (!ok) return false;
      const next = loadSession(dbPath);
      const active = getActiveController(dbPath);
      setSession({
        username: next?.username ?? "",
        activeController: active ? active[0] : null,
        loggedIn: next !== null,
        profile: getActiveProfileName(dbPath),
      });
      return true;
    },
    [dbPath],
  );

  // Re-read the active controller from the DB into the in-memory session, so the
  // header (and anything reading ctx.activeController) updates after a selection.
  // The DB write happens in the controller screen via selectController(); this
  // just syncs the React state that mirrors it.
  const refreshController = useCallback(() => {
    const active = getActiveController(dbPath);
    setSession((prev) => ({ ...prev, activeController: active ? active[0] : null }));
  }, [dbPath]);

  const logCommand = useCallback((cmd: string) => {
    setCommandLog((prev) => {
      const next = [...prev, cmd];
      return next.length > MAX_COMMAND_LOG ? next.slice(next.length - MAX_COMMAND_LOG) : next;
    });
  }, []);

  const value = useMemo<TuiState>(
    () => ({
      getClient,
      username: session.username,
      activeController: session.activeController,
      loggedIn: session.loggedIn,
      profile: session.profile,
      switchProfile,
      refreshController,
      openModal,
      notify,
      dbPath,
      activeModal,
      toast,
      setSession,
      setActiveKeyHints,
      setInputCaptured,
      login,
      activeKeyHints,
      inputCaptured,
      commandLog,
      logCommand,
    }),
    [getClient, session, switchProfile, refreshController, openModal, notify, dbPath, activeModal, toast, setActiveKeyHints, setInputCaptured, login, activeKeyHints, inputCaptured, commandLog, logCommand],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};
