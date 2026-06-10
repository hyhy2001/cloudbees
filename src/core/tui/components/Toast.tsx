/**
 * Toast — transient notification line shown at the bottom of the app.
 * Ports the Textual `notify(...)` toasts.
 */

import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme";
import { SYM } from "../symbols";

export type ToastLevel = "info" | "success" | "error" | "warning";

export interface ToastMessage {
  id: number;
  text: string;
  level: ToastLevel;
}

const LEVEL_COLOR: Record<ToastLevel, string> = {
  info: THEME.keyhint,
  success: THEME.success,
  error: THEME.error,
  warning: THEME.warning,
};

const LEVEL_ICON: Record<ToastLevel, string> = {
  info: SYM.arrow,
  success: SYM.ok,
  error: SYM.fail,
  warning: SYM.warn,
};

export const Toast: React.FC<{ message: ToastMessage | null }> = ({ message }) => {
  if (!message) return null;
  return (
    <Box>
      <Text color={LEVEL_COLOR[message.level]}>
        {LEVEL_ICON[message.level]} {message.text}
      </Text>
    </Box>
  );
};
