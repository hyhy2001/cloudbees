import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme";
import { SYM, borderStyle } from "../symbols";

const VISIBLE_LINES = 4;

export const CommandLog: React.FC<{ entries: string[] }> = ({ entries }) => {
  const tail = entries.slice(-VISIBLE_LINES);

  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyle()}
      borderColor={THEME.subtle}
      borderTop={true}
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
      marginTop={0}
    >
      <Text color={THEME.dim}>
        {`${SYM.iconLog}  Command Log`}
        {entries.length > 0 ? <Text color={THEME.subtle}>{`  (${entries.length})`}</Text> : null}
      </Text>
      {tail.length === 0 ? (
        <Text color={THEME.subtle}>{"  "}—</Text>
      ) : (
        tail.map((entry, i) => (
          <Text key={i}>
            <Text color={THEME.subtle}>{"  $ "}</Text>
            <Text color={THEME.keyhint}>{entry}</Text>
          </Text>
        ))
      )}
    </Box>
  );
};
