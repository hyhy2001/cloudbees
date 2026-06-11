/**
 * StatusBar — footer showing the active key hints.
 * Ports the Textual Footer.
 */

import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme";

/** A key/label pair displayed as a single hint in the status bar footer. */
export interface KeyHint {
  key: string;
  label: string;
}

/** Footer bar that renders a row of key hints for the active tab. */
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
