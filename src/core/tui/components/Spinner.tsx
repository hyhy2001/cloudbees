/**
 * Spinner — animated loading indicator.
 * Port of legacy/cb/tui/widgets/loader.py (AsciiLoader).
 *
 * Cycles through SYM.spinnerFrames every 100ms while mounted.
 */

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { SYM } from "../symbols";
import { THEME } from "../theme";

export interface SpinnerProps {
  /** Label shown next to the spinner. Defaults to "Loading...". */
  label?: string;
}

export const Spinner: React.FC<SpinnerProps> = ({ label = "Loading..." }) => {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % SYM.spinnerFrames.length);
    }, 100);
    return () => clearInterval(id);
  }, []);

  return (
    <Box>
      <Text color={THEME.active} bold>
        {SYM.spinnerFrames[frame]}
      </Text>
      <Text color={THEME.dim}> {label}</Text>
    </Box>
  );
};
