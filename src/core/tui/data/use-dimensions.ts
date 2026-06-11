/**
 * useDimensions — current terminal size (columns × rows), live-updated on resize.
 *
 * Ink's stdout stream is a TTY that emits "resize" events. We seed from
 * stdout.columns/rows and re-read on every resize so the layout reflows. Falls
 * back to a sane 80×24 when the stream has no size (piped output, tests).
 *
 * Used by the layout to size the DataTable column budget (width) and the log
 * viewer / table viewport (height) to the real terminal instead of hardcoded
 * character counts.
 */

import { useEffect, useState } from "react";
import { useStdout } from "ink";

export interface Dimensions {
  columns: number;
  rows: number;
}

const FALLBACK: Dimensions = { columns: 80, rows: 24 };

export function useDimensions(): Dimensions {
  const { stdout } = useStdout();

  const read = (): Dimensions => ({
    columns: stdout?.columns ?? FALLBACK.columns,
    rows: stdout?.rows ?? FALLBACK.rows,
  });

  const [dims, setDims] = useState<Dimensions>(read);

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setDims(read);
    stdout.on("resize", onResize);
    // Re-read once on mount in case the size changed before the listener attached.
    onResize();
    return () => {
      stdout.off("resize", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout]);

  return dims;
}
