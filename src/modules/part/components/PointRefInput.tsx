import React from 'react';
import { MousePointer } from 'lucide-react';
import { useCadStore, type GeometricSelectionRef, type PointFeature } from '@/modules/part/store/useCadStore';
import { isPointRef } from '@/core/geoSelectionRef';

const labelCls = 'block text-xs font-medium text-zinc-600 mb-1.5';

/** Unified placeholder for all viewport point picks (construction + body vertices) */
export const POINT_REF_INPUT_PLACEHOLDER = 'Click to select point…';

interface SelectionTriggerProps {
  label: string;
  displayText: string;
  fieldKey: string;
  hasValue: boolean;
  onActivate: () => void;
}

/** Shared button row for geometric point picking — same chrome everywhere */
const PointSelectionTrigger: React.FC<SelectionTriggerProps> = ({
  label,
  displayText,
  fieldKey,
  hasValue,
  onActivate,
}) => {
  const { activeInputField, deactivateGeometricInput } = useCadStore();
  const isActive = activeInputField === fieldKey;
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <button
        type="button"
        onClick={() => (isActive ? deactivateGeometricInput() : onActivate())}
        className={`w-full flex items-center gap-2 rounded py-1.5 px-2.5 text-sm border transition-colors text-left ${
          isActive
            ? 'bg-blue-600/20 border-blue-500 text-blue-600'
            : hasValue
            ? 'bg-white border-zinc-400 text-zinc-900'
            : 'bg-white border-zinc-300 text-zinc-500'
        }`}
      >
        <MousePointer className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{isActive ? 'Select point' : displayText}</span>
      </button>
    </div>
  );
};

export interface PointRefInputProps {
  label: string;
  value: string | null | undefined;
  /** When the selection is a body vertex or explicit ref, not matched by `value` as point feature id */
  pointRef?: Extract<GeometricSelectionRef, { type: 'point' }> | null;
  points: PointFeature[];
  fieldKey: string;
  onChange: (sel: Extract<GeometricSelectionRef, { type: 'point' }>) => void;
  /**
   * Solid B-rep vertices in the viewport (default: on). Set false to only pick construction points.
   */
  allowSolidVertices?: boolean;
}

/**
 * Single shared control for every feature that picks a 3D point (plane / axis / point tools).
 * Shows construction points and (by default) mesh vertices with the same hover/click behavior.
 */
export const PointRefInput: React.FC<PointRefInputProps> = ({
  label,
  value,
  pointRef,
  points,
  fieldKey,
  onChange,
  allowSolidVertices,
}) => {
  const found = points.find((p) => p.id === value);
  const displayText = found?.name ?? pointRef?.label ?? POINT_REF_INPUT_PLACEHOLDER;
  const hasValue = !!found || !!pointRef;
  return (
    <PointSelectionTrigger
      label={label}
      displayText={displayText}
      fieldKey={fieldKey}
      hasValue={hasValue}
      onActivate={() => {
        const pre =
          pointRef != null
            ? [pointRef]
            : found != null
            ? ([
                {
                  type: 'point' as const,
                  featureId: found.id,
                  featureName: found.name,
                  position: [found.parameters.x, found.parameters.y, found.parameters.z] as [number, number, number],
                  label: `${found.name} — Point`,
                },
              ] satisfies GeometricSelectionRef[])
            : undefined;
        useCadStore.getState().activateGeometricInput(
          fieldKey,
          (sel) => {
            if (!isPointRef(sel)) return;
            onChange(sel);
          },
          { preselected: pre, allowSolidVertices: allowSolidVertices !== false },
        );
      }}
    />
  );
};
