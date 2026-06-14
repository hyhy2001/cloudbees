import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme";
import { borderStyle } from "../symbols";

export interface ModalProps {
  title: string;
  children: React.ReactNode;
  /** Controls border color. Default "info". */
  severity?: "info" | "danger" | "warning";
}

const SEVERITY_COLOR = {
  info: THEME.keyhint,
  danger: THEME.danger,
  warning: THEME.warning,
};

export const Modal: React.FC<ModalProps> = ({ title, children, severity = "info" }) => {
  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyle()}
      borderColor={SEVERITY_COLOR[severity]}
      paddingX={2}
      paddingY={1}
      marginX={2}
    >
      <Text color={SEVERITY_COLOR[severity]} bold>
        {title}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
    </Box>
  );
};
