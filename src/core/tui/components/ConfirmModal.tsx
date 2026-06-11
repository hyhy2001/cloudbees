/**
 * ConfirmModal — yes/no confirmation. Resolves true on confirm, false on cancel.
 * Port of legacy ConfirmModal (modals.py).
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import { Modal } from "./Modal";
import { THEME } from "../theme";

/** Props for ConfirmModal. `onResult` receives true on y/Y/Enter, false on n/N/Esc. */
export interface ConfirmModalProps {
  title?: string;
  message: string;
  onResult: (confirmed: boolean) => void;
}

/** Yes/no confirmation modal. Resolves true on confirm, false on cancel. */
export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  title = "Confirm Action",
  message,
  onResult,
}) => {
  useInput((input, key) => {
    if (input === "y" || input === "Y" || key.return) {
      onResult(true);
    } else if (input === "n" || input === "N" || key.escape) {
      onResult(false);
    }
  });

  return (
    <Modal title={title}>
      <Text>{message}</Text>
      <Box marginTop={1}>
        <Text color={THEME.success}>[Y]es</Text>
        <Text>{"   "}</Text>
        <Text color={THEME.error}>[N]o / Esc</Text>
      </Box>
    </Modal>
  );
};
