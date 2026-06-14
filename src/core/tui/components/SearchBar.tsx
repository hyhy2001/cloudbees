import React from "react";
import { Text } from "ink";
import { THEME } from "../theme";
import { SYM } from "../symbols";
import type { SearchState } from "../data/use-search";

export const SearchBar: React.FC<{ state: SearchState; matchCount?: number }> = ({
  state,
  matchCount,
}) => {
  if (!state.editing && !state.query) return null;

  if (state.editing) {
    return (
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
    );
  }

  return (
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
  );
};
