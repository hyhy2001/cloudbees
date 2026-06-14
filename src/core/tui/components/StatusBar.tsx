import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme";

export interface KeyHint {
  key: string;
  label: string;
}

/**
 * Footer bar — screen-specific hints on the left, global hints on the right.
 * Keys use bracket style: [key] label. Groups are visually separated.
 */
export const StatusBar: React.FC<{ hints: KeyHint[]; globalHints?: KeyHint[] }> = ({
  hints,
  globalHints = [],
}) => {
  const renderHint = (h: KeyHint, i: number) => (
    <Text key={`${h.key}-${i}`}>
      {i > 0 && <Text color={THEME.subtle}>  </Text>}
      <Text color={THEME.keyhint} bold>[{h.key}]</Text>
      <Text color={THEME.dim}> {h.label}</Text>
    </Text>
  );

  const hasScreen = hints.length > 0;
  const hasGlobal = globalHints.length > 0;

  return (
    <Box justifyContent="space-between" width="100%">
      <Box flexWrap="nowrap">
      {hints.map((h, i) => renderHint(h, i))}
      </Box>
      {hasScreen && hasGlobal && (
        <Box>
          <Text color={THEME.subtle}>    </Text>
          {globalHints.map((h, i) => renderHint(h, i))}
        </Box>
      )}
      {!hasScreen && hasGlobal && (
        <Box>
          {globalHints.map((h, i) => renderHint(h, i))}
        </Box>
      )}
    </Box>
  );
};
