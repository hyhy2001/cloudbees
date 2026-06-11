/**
 * Modal — overlay frame used by ConfirmModal and FormModal.
 *
 * Ink has no true z-index overlay; the app renders at most one modal *instead of*
 * the main content (or below it), so "modal" here is a bordered, centered panel.
 */

import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme";
import { borderStyle } from "../symbols";

/** Props for the Modal overlay frame. */
export interface ModalProps {
  title: string;
  children: React.ReactNode;
}

/** Bordered, centered panel used as the base frame for all modal dialogs. */
export const Modal: React.FC<ModalProps> = ({ title, children }) => {
  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyle()}
      borderColor={THEME.keyhint}
      paddingX={2}
      paddingY={1}
      marginX={2}
    >
      <Text color={THEME.keyhint} bold>
        {title}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
    </Box>
  );
};
