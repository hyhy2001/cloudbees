/**
 * StatusBar — footer showing the active key hints.
 * Ports the Textual Footer.
 */

import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme";

export interface KeyHint {
  key: string;
  label: string;
}

export const StatusBar: React.FC<{ hints: KeyHint[] }> = ({ hints }) => {
  return (
    <Box>
      {hints.map((h, i) => (
        <Text key={i}>
          <Text color={THEME.keyhint} bold>
            {" "}
            {h.key}
          </Text>
          <Text color={THEME.dim}> {h.label}</Text>
        </Text>
      ))}
    </Box>
  );
};
