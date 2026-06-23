import React, { useRef } from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme";
import { SYM } from "../symbols";
import type { SearchState } from "../data/use-search";
import { useOnClick } from "@ink-tools/ink-mouse";

const SearchBarClickHandler: React.FC<{
  barRef: React.RefObject<any>;
  onActivate: () => void;
}> = ({ barRef, onActivate }) => {
  useOnClick(barRef as any, () => onActivate());
  return null;
};

export const SearchBar: React.FC<{ state: SearchState; matchCount?: number; onActivate?: () => void }> = ({
  state,
  matchCount,
  onActivate,
}) => {
  const barRef = useRef<typeof Box>(null);
  const isTty = Boolean(process.stdout.isTTY);

  if (!state.editing && !state.query) return null;

  if (state.editing) {
    return (
      <Box ref={barRef as any}>
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
      {isTty && onActivate && <SearchBarClickHandler barRef={barRef as any} onActivate={onActivate} />}
      </Box>
    );
  }

  return (
    <Box ref={barRef as any}>
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
    {isTty && onActivate && <SearchBarClickHandler barRef={barRef as any} onActivate={onActivate} />}
    </Box>
  );
};
