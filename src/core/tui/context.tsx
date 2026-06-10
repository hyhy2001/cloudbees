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
import { getClient as coreGetClient } from "../client-factory";
import type { ToastMessage } from "./components/Toast";

interface ActiveModal {
  id: string;
  node: ReactNode;
}

interface SessionInfo {
  username: string;
  activeController: string | null;
  loggedIn: boolean;
}

interface TuiState extends ITuiContext {
  /** Currently rendered modal (or null). */
  activeModal: ActiveModal | null;
  /** Current toast (or null). */
  toast: ToastMessage | null;
  /** Update session info (called after login/logout/controller switch). */
  setSession(info: SessionInfo): void;
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

  const value = useMemo<TuiState>(
    () => ({
      getClient,
      username: session.username,
      activeController: session.activeController,
      loggedIn: session.loggedIn,
      openModal,
      notify,
      dbPath,
      activeModal,
      toast,
      setSession,
    }),
    [getClient, session, openModal, notify, dbPath, activeModal, toast],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};
