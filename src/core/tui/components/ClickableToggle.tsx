import React from "react";
import { Box } from "ink";

export const ClickableToggle: React.FC<{
  children: React.ReactNode;
  onClick: () => void;
}> = ({ children, onClick }) => {
  return (
    <Box>
      {children}
    </Box>
  );
};
