import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme";
import { borderStyle } from "../symbols";

const VISIBLE_LINES = 5;

export const CommandLog: React.FC<{ entries: string[] }> = ({ entries }) => {
  const tail = entries.slice(-VISIBLE_LINES);

  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyle()}
      borderColor={THEME.dim}
      borderTop={true}
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
    >
      <Text color={THEME.dim} bold>
        Command Log
      </Text>
      {tail.length === 0 ? (
        <Text color={THEME.dim}>  —</Text>
      ) : (
        tail.map((entry, i) => (
          <Text key={i}>
            <Text color={THEME.dim}>  $ </Text>
            <Text color={THEME.keyhint}>{entry}</Text>
          </Text>
        ))
      )}
    </Box>
  );
};
