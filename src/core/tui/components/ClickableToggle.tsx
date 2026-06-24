import React, { useRef } from "react";
import { Box } from "ink";
import { useOnClick } from "@ink-tools/ink-mouse";

const ToggleClickHandler: React.FC<{
  toggleRef: React.RefObject<any>;
  onClick: () => void;
}> = ({ toggleRef, onClick }) => {
  useOnClick(toggleRef as any, () => onClick());
  return null;
};

export const ClickableToggle: React.FC<{
  children: React.ReactNode;
  onClick: () => void;
}> = ({ children, onClick }) => {
  const ref = useRef<typeof Box>(null);
  const isTty = Boolean(process.stdout.isTTY);
  return (
    <Box ref={isTty ? ref as any : undefined}>
      {isTty && <ToggleClickHandler toggleRef={ref} onClick={onClick} />}
      {children}
    </Box>
  );
};
