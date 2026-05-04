import { useCallback, type ChangeEvent, type SyntheticEvent } from "react";
import type { Breakpoint } from '@core/page-tree/schemas'
import { Select } from "@ui/components/Select";
import { SmartphoneIcon } from "pixel-art-icons/icons/smartphone";
import { TabletIcon } from "pixel-art-icons/icons/tablet";
import { MonitorIcon } from "pixel-art-icons/icons/monitor";
import { LaptopIcon } from "pixel-art-icons/icons/laptop";
import { TvIcon } from "pixel-art-icons/icons/tv";
import styles from "./CanvasBreakpointSelector.module.css";

interface CanvasBreakpointSelectorProps {
  breakpoints: Breakpoint[];
  activeBreakpointId: string;
  onBreakpointChange: (breakpointId: string) => void;
}

export function CanvasBreakpointSelector({
  breakpoints,
  activeBreakpointId,
  onBreakpointChange,
}: CanvasBreakpointSelectorProps) {
  const activeBreakpoint = breakpoints.find(
    (breakpoint) => breakpoint.id === activeBreakpointId,
  );
  const selectedBreakpointId = activeBreakpoint?.id ?? breakpoints[0]?.id ?? "";

  const stopCanvasInteraction = useCallback((event: SyntheticEvent) => {
    event.stopPropagation();
  }, []);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      onBreakpointChange(event.target.value);
    },
    [onBreakpointChange],
  );

  if (breakpoints.length === 0) return null;

  return (
    <div
      className={styles.shell}
      data-testid="canvas-breakpoint-selector"
      onClick={stopCanvasInteraction}
      onMouseDown={stopCanvasInteraction}
      aria-label="Breakpoint editing context"
    >
      <div className={styles.notch}>
        <Select
          value={selectedBreakpointId}
          onChange={handleChange}
          aria-label="Canvas breakpoint"
          fieldSize="xs"
          emphasis="strong"
          className={styles.breakpointSelect}
          menuMinWidth={164}
          menuPlacement="left-start"
          options={breakpoints.map((breakpoint) => ({
            value: breakpoint.id,
            textValue: breakpoint.label,
            label: (
              <span className={styles.optionLabel}>
                <span>{breakpoint.label}</span>
                <span className={styles.optionWidth}>{breakpoint.width}px</span>
              </span>
            ),
            icon: <BreakpointIcon name={breakpoint.icon} />,
          }))}
        />
      </div>
    </div>
  );
}

function BreakpointIcon({ name }: { name: string }) {
  switch (name) {
    case "smartphone":
      return <SmartphoneIcon size={11} aria-hidden="true" />;
    case "tablet":
      return <TabletIcon size={11} aria-hidden="true" />;
    case "laptop":
      return <LaptopIcon size={11} aria-hidden="true" />;
    case "tv":
      return <TvIcon size={11} aria-hidden="true" />;
    case "monitor":
    default:
      return <MonitorIcon size={11} aria-hidden="true" />;
  }
}
