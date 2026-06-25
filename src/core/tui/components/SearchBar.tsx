import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme";
import { SYM } from "../symbols";
import type { SearchState } from "../data/use-search";

export const SearchBar: React.FC<{ state: SearchState; matchCount?: number; onActivate?: () => void }> = ({
  state,
  matchCount,
  onActivate,
}) => {
  if (!state.editing && !state.query) return null;

  if (state.editing) {
    return (
      <Box>
      <Text>
        {" "}
        <Text color={THEME.active}>/</Text>
        <Text>{state.query}</Text>
        <Text color={THEME.active}>_</Text>
        <Text color={THEME.dim}>
          {matchCount !== undefined ? `  ${matchCount} match${matchCount === 1 ? "" : "es"}  ·  ` : "  "}
          Enter=keep  ·  Esc=clear
        </Text>
      </Text>
      </Box>
    );
  }

  return (
    <Box>
    <Text>
      {" "}
      <Text color={THEME.dim}>{SYM.arrow} filter: </Text>
      <Text color={THEME.yellow}>{state.query}</Text>
      {matchCount !== undefined ? (
        <Text color={THEME.dim}>
          {`  ${matchCount} match${matchCount === 1 ? "" : "es"}  ·  / edit  ·  Esc clear`}
        </Text>
      ) : null}
    </Text>
    </Box>
  );
};
