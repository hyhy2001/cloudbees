/**
 * ConfirmModal — yes/no confirmation. Resolves true on Enter, false on Esc.
 * Port of legacy ConfirmModal (modals.py).
 */

import React, { useRef } from "react";
import { Box, Text, useInput } from "ink";
import { Modal } from "./Modal";
import { THEME } from "../theme";
import { useOnClick } from "@ink-tools/ink-mouse";

const ConfirmBtnHandler: React.FC<{
  yesRef: React.RefObject<any>;
  noRef: React.RefObject<any>;
  onResult: (v: boolean) => void;
}> = ({ yesRef, noRef, onResult }) => {
  useOnClick(yesRef as any, () => onResult(true));
  useOnClick(noRef as any, () => onResult(false));
  return null;
};

/** Props for ConfirmModal. `onResult` receives true on Enter, false on Esc. */
export interface ConfirmModalProps {
  title?: string;
  message: string;
  onResult: (confirmed: boolean) => void;
}

/** Confirmation modal. Enter=confirm, Esc=cancel. */
export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  title = "Confirm Action",
  message,
  onResult,
}) => {
  const yesRef = useRef<typeof Box>(null);
  const noRef = useRef<typeof Box>(null);
  const isTty = Boolean(process.stdout.isTTY);

  useInput((_input, key) => {
    if (key.return) {
      onResult(true);
    } else if (key.escape) {
      onResult(false);
    }
  });

  return (
    <Modal title={title} severity="danger">
      {isTty && <ConfirmBtnHandler yesRef={yesRef} noRef={noRef} onResult={onResult} />}
      <Text color={THEME.normal}>{message}</Text>
      <Box marginTop={1}>
        <Box ref={isTty ? yesRef as any : undefined}>
          <Text color={THEME.active}>[Enter] </Text>
          <Text color={THEME.danger}>confirm</Text>
        </Box>
        <Box ref={isTty ? noRef as any : undefined}>
          <Text color={THEME.dim}>  ·  [Esc] cancel</Text>
        </Box>
      </Box>
    </Modal>
  );
};
