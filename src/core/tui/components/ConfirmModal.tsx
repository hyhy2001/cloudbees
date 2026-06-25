/**
 * ConfirmModal — yes/no confirmation. Resolves true on Enter, false on Esc.
 * Port of legacy ConfirmModal (modals.py).
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import { Modal } from "./Modal";
import { THEME } from "../theme";

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
  useInput((_input, key) => {
    if (key.return) {
      onResult(true);
    } else if (key.escape) {
      onResult(false);
    }
  });

  return (
    <Modal title={title} severity="danger">
      <Text color={THEME.normal}>{message}</Text>
      <Box marginTop={1}>
        <Box>
          <Text color={THEME.active}>[Enter] </Text>
          <Text color={THEME.danger}>confirm</Text>
        </Box>
        <Box>
          <Text color={THEME.dim}>  ·  [Esc] cancel</Text>
        </Box>
      </Box>
    </Modal>
  );
};
