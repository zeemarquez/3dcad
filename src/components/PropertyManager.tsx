import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  useCadStore,
  type SketchFeature,
  type ExtrudeFeature,
  type PlaneFeature,
  type PointFeature,
  type AxisFeature,
  type CutFeature,
  type RevolveFeature,
  type RevolveCutFeature,
  type FilletFeature,
  type ChamferFeature,
  type Feature,
  type GeometricSelectionRef,
} from '../store/useCadStore';
import { X, MousePointer, ChevronsLeftRight, ArrowRightLeft } from 'lucide-react';

// ──────────────────────────────────────────────────────────────────────────────
// Shared input classes
// ──────────────────────────────────────────────────────────────────────────────
const inputCls =
  'w-full bg-white border border-zinc-300 rounded py-1.5 px-2.5 text-sm text-zinc-900 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500';
const labelCls = 'block text-xs font-medium text-zinc-600 mb-1.5';
const sectionCls = 'space-y-3';

function formatCommandLabel(cmd: string): string {
  if (cmd === 'revolveCut') return 'Revolve cut';
  return cmd.charAt(0).toUpperCase() + cmd.slice(1);
}

function evaluateInputExpression(
  raw: string,
  env: Record<string, number>,
  selfName?: string
): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, message: 'Value is required' };
  if (!trimmed.startsWith('=')) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return { ok: false, message: 'Invalid numeric value' };
    return { ok: true, value: n };
  }
  const body = trimmed.slice(1).trim();
  if (!body) return { ok: false, message: 'Expression is empty' };
  if (selfName) {
    const selfRef = new RegExp(`\\b${selfName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (selfRef.test(body)) return { ok: false, message: 'Self reference is not allowed' };
  }
  let unknown: string | null = null;
  const replaced = body.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (token) => {
    if (Object.prototype.hasOwnProperty.call(env, token)) return String(env[token]);
    unknown = token;
    return token;
  });
  if (unknown) return { ok: false, message: `Unknown parameter: ${unknown}` };
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (${replaced});`);
    const result = Number(fn());
    if (!Number.isFinite(result)) return { ok: false, message: 'Expression result is not finite' };
    return { ok: true, value: result };
  } catch {
    return { ok: false, message: 'Invalid expression' };
  }
}

const ExpressionNumberInput: React.FC<{
  value: string;
  onValueChange: (value: string) => void;
  onCommit: (raw: string) => void;
  suggestions: string[];
  evaluate: (raw: string) => { ok: true; value: number } | { ok: false; message: string };
}> = ({ value, onValueChange, onCommit, suggestions, evaluate }) => {
  const [localValue, setLocalValue] = useState(value);
  const [isFocused, setIsFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  useEffect(() => {
    if (!isFocused) setLocalValue(value);
  }, [value, isFocused]);

  const tokenMatch = localValue.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
  const token = tokenMatch?.[1] ?? '';
  const typedExpression = localValue.trim().startsWith('=');
  const filtered = typedExpression
    ? suggestions.filter((s) => s.toUpperCase().startsWith(token.toUpperCase()) && s !== token).slice(0, 8)
    : [];
  const preview = evaluate(localValue);
  const replaceToken = (picked: string) => {
    const next = tokenMatch
      ? `${localValue.slice(0, tokenMatch.index ?? localValue.length)}${picked}`
      : `${localValue}${picked}`;
    setLocalValue(next);
    onValueChange(next);
    setOpen(false);
    setActiveIdx(0);
  };
  return (
    <div className="relative">
      <input
        type="text"
        value={localValue}
        onChange={(e) => {
          setLocalValue(e.target.value);
          onValueChange(e.target.value);
          setOpen(true);
          setActiveIdx(0);
        }}
        onFocus={() => {
          setIsFocused(true);
          setOpen(true);
        }}
        onBlur={(e) => {
          setIsFocused(false);
          setTimeout(() => setOpen(false), 120);
          onCommit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (open && filtered.length > 0 && e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIdx((i) => (i + 1) % filtered.length);
            return;
          }
          if (open && filtered.length > 0 && e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
            return;
          }
          if (e.key === 'Enter') {
            if (open && filtered.length > 0) {
              e.preventDefault();
              replaceToken(filtered[activeIdx] ?? filtered[0]);
              return;
            }
            onCommit((e.target as HTMLInputElement).value);
          }
        }}
        className={inputCls}
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-30 mt-1 w-full bg-white border border-zinc-300 rounded shadow-lg max-h-44 overflow-auto">
          {filtered.map((s, i) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                replaceToken(s);
              }}
              className={`w-full text-left px-2 py-1 text-xs ${i === activeIdx ? 'bg-blue-600 text-white' : 'hover:bg-zinc-100 text-zinc-800'}`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <p className={`mt-1 text-[11px] ${preview.ok ? 'text-zinc-600' : 'text-red-500'}`}>
        {preview.ok ? `Result: ${preview.value.toFixed(4)}` : `Invalid: ${preview.message}`}
      </p>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Geometric reference input (click to select plane/face in viewport)
// ──────────────────────────────────────────────────────────────────────────────
interface GeometricInputProps {
  label: string;
  value: GeometricSelectionRef | null;
  fieldKey: string;
  onChange: (ref: GeometricSelectionRef) => void;
}
interface SelectionInputProps {
  label: string;
  displayText: string;
  fieldKey: string;
  hasValue: boolean;
  onActivate: () => void;
}
const SelectionInput: React.FC<SelectionInputProps> = ({
  label,
  displayText,
  fieldKey,
  hasValue,
  onActivate,
}) => {
  const { activeInputField, deactivateGeometricInput } = useCadStore();
  const isActive = activeInputField === fieldKey;
  const objectLabel = fieldKey.startsWith('sketch_')
    ? 'sketch'
    : fieldKey.endsWith('Edges')
    ? 'edge'
    : fieldKey.toLowerCase().includes('point')
    ? 'point'
    : fieldKey.toLowerCase().includes('plane') || fieldKey.toLowerCase().includes('face')
    ? 'plane or face'
    : 'object';
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
        <span className="truncate">{isActive ? `Select ${objectLabel}` : displayText}</span>
      </button>
    </div>
  );
};
const GeometricInput: React.FC<GeometricInputProps> = ({ label, value, fieldKey, onChange }) => {
  return (
    <SelectionInput
      label={label}
      displayText={value?.label ?? 'Click to select…'}
      fieldKey={fieldKey}
      hasValue={!!value}
      onActivate={() =>
        useCadStore.getState().activateGeometricInput(fieldKey, onChange, {
          preselected: value ? [value] : undefined,
        })
      }
    />
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Sketch / feature reference input box
// ──────────────────────────────────────────────────────────────────────────────
interface SketchInputProps {
  label: string;
  value: string;
  sketches: SketchFeature[];
  fieldKey: string;
  onChange: (sketchId: string) => void;
}
const SketchInput: React.FC<SketchInputProps> = ({ label, value, sketches, fieldKey, onChange }) => {
  const found = sketches.find((s) => s.id === value);

  return (
    <SelectionInput
      label={label}
      displayText={found ? found.name : 'Click to select sketch…'}
      fieldKey={fieldKey}
      hasValue={!!found}
      onActivate={() => {
        const pre =
          found != null
            ? ([
                {
                  type: 'sketch' as const,
                  featureId: value,
                  featureName: found.name,
                  label: `${found.name} — Sketch`,
                },
              ] satisfies GeometricSelectionRef[])
            : undefined;
        useCadStore.getState().activateGeometricInput(
          fieldKey,
          (sel) => {
            if (sel.type !== 'sketch') return;
            onChange(sel.featureId);
          },
          { preselected: pre },
        );
      }}
    />
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Toggle checkbox row
// ──────────────────────────────────────────────────────────────────────────────
interface ToggleRowProps { label: string; icon?: React.ComponentType<{ className?: string }>; checked: boolean; onChange: (v: boolean) => void; }
const ToggleRow: React.FC<ToggleRowProps> = ({ label, icon: Icon, checked, onChange }) => (
  <label className="flex items-center justify-between cursor-pointer select-none">
    <span className="flex items-center gap-1.5 text-xs text-zinc-600">
      {Icon && <Icon className="w-3.5 h-3.5" />}
      {label}
    </span>
    <div
      onClick={() => onChange(!checked)}
      className={`relative w-9 h-5 rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-zinc-300'}`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </div>
  </label>
);

// ──────────────────────────────────────────────────────────────────────────────
// Derive the closest axis-aligned plane from a GeometricSelectionRef
// ──────────────────────────────────────────────────────────────────────────────
function geoRefToPlaneAndOffset(ref: GeometricSelectionRef | null): { plane: 'xy' | 'xz' | 'yz'; offset: number } {
  if (!ref) return { plane: 'xy', offset: 0 };
  if (ref.type === 'defaultPlane') return { plane: ref.name, offset: 0 };
  if (ref.type === 'plane') return { plane: 'xy', offset: 0 };
  if (ref.type === 'face') {
    const [nx, ny, nz] = ref.normal;
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    if (az >= ax && az >= ay) {
      const result = { plane: 'xy', offset: ref.faceOffset * (nz >= 0 ? 1 : -1) } as const;
      console.log('[CAD][SketchPlaneFromFace] dominant=Z', { normal: ref.normal, faceOffset: ref.faceOffset, result });
      return result;
    }
    if (ay >= ax) {
      const result = { plane: 'xz', offset: ref.faceOffset * (ny >= 0 ? 1 : -1) } as const;
      console.log('[CAD][SketchPlaneFromFace] dominant=Y', { normal: ref.normal, faceOffset: ref.faceOffset, result });
      return result;
    }
    const result = { plane: 'yz', offset: ref.faceOffset * (nx >= 0 ? 1 : -1) } as const;
    console.log('[CAD][SketchPlaneFromFace] dominant=X', { normal: ref.normal, faceOffset: ref.faceOffset, result });
    return result;
  }
  return { plane: 'xy', offset: 0 };
}

function planeToRef(plane: 'xy' | 'xz' | 'yz'): GeometricSelectionRef {
  const labels: Record<string, string> = { xy: 'XY Plane', xz: 'XZ Plane', yz: 'YZ Plane' };
  return { type: 'defaultPlane', name: plane, label: labels[plane] };
}

function isPlaneRef(ref: GeometricSelectionRef | null): ref is Extract<GeometricSelectionRef, { type: 'defaultPlane' | 'face' | 'plane' }> {
  return !!ref && (ref.type === 'defaultPlane' || ref.type === 'face' || ref.type === 'plane');
}
function isPointRef(ref: GeometricSelectionRef | null): ref is Extract<GeometricSelectionRef, { type: 'point' }> {
  return !!ref && ref.type === 'point';
}
function isEdgeRef(ref: GeometricSelectionRef | null): ref is Extract<GeometricSelectionRef, { type: 'edge' }> {
  return !!ref && ref.type === 'edge';
}

function planeFromRef(ref: GeometricSelectionRef | null): { n: [number, number, number]; d: number } | null {
  if (!ref) return null;
  if (ref.type === 'defaultPlane') {
    if (ref.name === 'xy') return { n: [0, 0, 1], d: 0 };
    if (ref.name === 'xz') return { n: [0, 1, 0], d: 0 };
    return { n: [1, 0, 0], d: 0 };
  }
  if (ref.type === 'face') return { n: ref.normal, d: ref.faceOffset };
  return null;
}

function normalize(v: [number, number, number]): [number, number, number] | null {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l < 1e-9) return null;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sub(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: [number, number, number], s: number): [number, number, number] {
  return [a[0] * s, a[1] * s, a[2] * s];
}

interface PointRefInputProps {
  label: string;
  value: string | null | undefined;
  points: PointFeature[];
  fieldKey: string;
  onChange: (pointId: string) => void;
}
const PointRefInput: React.FC<PointRefInputProps> = ({ label, value, points, fieldKey, onChange }) => {
  const found = points.find((p) => p.id === value);
  return (
    <SelectionInput
      label={label}
      displayText={found ? found.name : 'Click to select point…'}
      fieldKey={fieldKey}
      hasValue={!!found}
      onActivate={() => {
        const pre =
          found != null
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
            onChange(sel.featureId);
          },
          { preselected: pre },
        );
      }}
    />
  );
};

// ──────────────────────────────────────────────────────────────────────────────
// Main PropertyManager
// ──────────────────────────────────────────────────────────────────────────────
export const PropertyManager = () => {
  const {
    features,
    selectedFeatureId,
    setSelectedFeatureId,
    updateFeatureParameter,
    addFeature,
    activeCommand,
    setActiveCommand,
    enterSketchMode,
    activeModule,
    commandPreselection,
    activateGeometricInput,
    deactivateGeometricInput,
    activeInputField,
    setTransientPreviewFeature,
    selectedFeatureId: selFeatId,
    lastGeometricSelection,
    userParameters,
    dimensionParameters,
    linkDimensionExpression,
  } = useCadStore();

  const activeFeature = features.find((f) => f.id === selectedFeatureId);
  const sketches = useMemo(
    () => features.filter((f): f is SketchFeature => f.type === 'sketch'),
    [features]
  );
  const points = useMemo(
    () => features.filter((f): f is PointFeature => f.type === 'point'),
    [features]
  );
  const solidTargetFeatures = useMemo(
    () =>
      features.filter(
        (f): f is Extract<Feature, { type: 'extrude' | 'cut' | 'revolve' | 'revolveCut' | 'fillet' | 'chamfer' }> =>
          ['extrude', 'cut', 'revolve', 'revolveCut', 'fillet', 'chamfer'].includes(f.type)
      ),
    [features]
  );
  const sketchById = useMemo(() => new Map(sketches.map((s) => [s.id, s])), [sketches]);
  const axisFeatures = features.filter((f): f is AxisFeature => f.type === 'axis');
  const pointById = useMemo(() => new Map(points.map((p) => [p.id, p])), [points]);
  const hasSketchGeometry = (s?: SketchFeature) => {
    if (!s?.parameters?.sketchData) return false;
    const sd = s.parameters.sketchData;
    return (
      (sd.points?.length ?? 0) > 0 ||
      (sd.lines?.length ?? 0) > 0 ||
      (sd.circles?.length ?? 0) > 0 ||
      (sd.arcs?.length ?? 0) > 0
    );
  };
  const latestPopulatedSketch = [...sketches].reverse().find((s) => hasSketchGeometry(s));
  const preferredSketchId = commandPreselection ?? latestPopulatedSketch?.id ?? sketches[sketches.length - 1]?.id ?? '';
  const resolveSketchId = useCallback((candidate: string | null | undefined): string => {
    const direct = candidate ? sketchById.get(candidate) : undefined;
    if (direct && hasSketchGeometry(direct)) return direct.id;
    const pref = preferredSketchId ? sketchById.get(preferredSketchId) : undefined;
    if (pref) return pref.id;
    return sketches[sketches.length - 1]?.id ?? '';
  }, [preferredSketchId, sketchById, sketches]);

  // New-feature form state
  const [np, setNp] = useState<Record<string, any>>({});
  const updateNp = useCallback((patch: Record<string, any>) => setNp((p) => ({ ...p, ...patch })), []);
  const lastPreviewSigRef = useRef<string | null>(null);
  const [exprError, setExprError] = useState('');
  const [editFields, setEditFields] = useState<Record<string, string>>({});
  const parameterNames = useMemo(
    () => [...userParameters.map((p) => p.name), ...dimensionParameters.map((p) => p.name)],
    [userParameters, dimensionParameters]
  );
  const expressionEnv = useMemo(() => {
    const env: Record<string, number> = {};
    for (const p of userParameters) env[p.name] = p.resultValue;
    for (const p of dimensionParameters) env[p.name] = p.resultValue;
    return env;
  }, [userParameters, dimensionParameters]);
  const getLinkedExpression = useCallback((featureId: string, param: string, fallback: number) => {
    const match = dimensionParameters.find(
      (d) => d.target.kind === 'feature' && d.target.featureId === featureId && d.target.param === param && d.expression?.trim().startsWith('=')
    );
    return match?.expression ?? String(fallback);
  }, [dimensionParameters]);

  const evaluateToNumber = useCallback((raw: string): number | null => {
    const res = evaluateInputExpression(raw, expressionEnv);
    if (!res.ok) {
      setExprError(res.message);
      return null;
    }
    setExprError('');
    return res.value;
  }, [expressionEnv]);
  const evalExpressionPreview = useCallback((raw: string) => evaluateInputExpression(raw, expressionEnv), [expressionEnv]);
  const getFeatureTargetParamName = useCallback((featureId: string, param: string): string | null => {
    const match = dimensionParameters.find(
      (d) => d.target.kind === 'feature' && d.target.featureId === featureId && d.target.param === param
    );
    return match?.name ?? null;
  }, [dimensionParameters]);
  const evaluateFeatureTargetValue = useCallback((raw: string, featureId: string, param: string): number | null => {
    const selfName = getFeatureTargetParamName(featureId, param) ?? undefined;
    const res = evaluateInputExpression(raw, expressionEnv, selfName);
    if (!res.ok) {
      setExprError(res.message);
      return null;
    }
    setExprError('');
    return res.value;
  }, [expressionEnv, getFeatureTargetParamName]);

  // Watch for sketch selection while sketchInput is active
  useEffect(() => {
    if (activeInputField && activeInputField.startsWith('sketch_') && selFeatId) {
      const f = features.find((x) => x.id === selFeatId);
      if (f?.type === 'sketch') {
        const key = activeInputField.replace('sketch_', '') as 'sketchId';
        updateNp({ [key]: f.id });
        deactivateGeometricInput();
      }
    }
  }, [selFeatId, activeInputField]);

  useEffect(() => {
    const defaults: Record<string, any> = {};
    if (activeCommand === 'extrude' || activeCommand === 'cut') {
      defaults.sketchId = resolveSketchId(preferredSketchId);
      defaults.height = 10;
      defaults.depth = 10;
      defaults.reverse = false;
      defaults.symmetric = false;
      defaults.startOffset = 0;
    } else if (activeCommand === 'plane') {
      defaults.method = 'offset';
      defaults.reference = null;
      defaults.offset = 0;
      defaults.point1Id = points[0]?.id ?? null;
      defaults.point2Id = points[1]?.id ?? points[0]?.id ?? null;
      defaults.point3Id = points[2]?.id ?? points[0]?.id ?? null;
    } else if (activeCommand === 'axis') {
      defaults.method = 'twoPoints';
      defaults.point1Id = points[0]?.id ?? null;
      defaults.point2Id = points[1]?.id ?? points[0]?.id ?? null;
      defaults.pointId = points[0]?.id ?? null;
      defaults.planeRef = null;
      defaults.planeRefA = null;
      defaults.planeRefB = null;
    } else if (activeCommand === 'revolve' || activeCommand === 'revolveCut') {
      defaults.sketchId = resolveSketchId(preferredSketchId);
      defaults.angle = 360;
      defaults.axis = 'z';
      defaults.startOffset = 0;
    } else if (activeCommand === 'fillet') {
      defaults.targetFeatureId = commandPreselection ?? solidTargetFeatures[solidTargetFeatures.length - 1]?.id ?? '';
      defaults.radius = 1;
      defaults.edges = [];
    } else if (activeCommand === 'chamfer') {
      defaults.targetFeatureId = commandPreselection ?? solidTargetFeatures[solidTargetFeatures.length - 1]?.id ?? '';
      defaults.distance = 1;
      defaults.edges = [];
    } else if (activeCommand === 'sketch') {
      const preRef: GeometricSelectionRef | null = lastGeometricSelection ?? null;
      defaults.planeRef = preRef;

      if (!preRef) {
        activateGeometricInput('sketchPlane', (ref: GeometricSelectionRef) => {
          updateNp({ planeRef: ref });
        });
      }
    }
    setNp(defaults);

    return () => {
      deactivateGeometricInput();
      setTransientPreviewFeature(null);
    };
  }, [activeCommand]);

  useEffect(() => {
    if (activeFeature || !activeCommand) {
      lastPreviewSigRef.current = null;
      setTransientPreviewFeature(null);
      return;
    }
    const id = '__preview__';
    const name = `${formatCommandLabel(activeCommand)} Preview`;
    const num = (v: unknown, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    if (activeCommand === 'extrude') {
      const preview: Feature = {
        id,
        name,
        type: 'extrude',
        parameters: {
          sketchId: resolveSketchId(np.sketchId),
          height: Math.max(num(np.height, 10), 0.001),
          reverse: !!np.reverse,
          symmetric: !!np.symmetric,
          startOffset: num(np.startOffset, 0),
        },
      };
      const sig = JSON.stringify(preview);
      if (lastPreviewSigRef.current === sig) return;
      lastPreviewSigRef.current = sig;
      setTransientPreviewFeature(preview);
      return;
    }
    if (activeCommand === 'cut') {
      const preview: Feature = {
        id,
        name,
        type: 'cut',
        parameters: {
          sketchId: resolveSketchId(np.sketchId),
          depth: Math.max(num(np.depth, 10), 0.001),
          reverse: !!np.reverse,
          symmetric: !!np.symmetric,
          startOffset: num(np.startOffset, 0),
        },
      };
      const sig = JSON.stringify(preview);
      if (lastPreviewSigRef.current === sig) return;
      lastPreviewSigRef.current = sig;
      setTransientPreviewFeature(preview);
      return;
    }
    if (activeCommand === 'revolve' || activeCommand === 'revolveCut') {
      const preview: Feature = {
        id,
        name,
        type: activeCommand === 'revolveCut' ? 'revolveCut' : 'revolve',
        parameters: {
          sketchId: resolveSketchId(np.sketchId),
          angle: num(np.angle, 360),
          axis: (np.axis === 'x' || np.axis === 'y' || np.axis === 'z') ? np.axis : 'z',
          startOffset: num(np.startOffset, 0),
        },
      };
      const sig = JSON.stringify(preview);
      if (lastPreviewSigRef.current === sig) return;
      lastPreviewSigRef.current = sig;
      setTransientPreviewFeature(preview);
      return;
    }
    if (activeCommand === 'fillet') {
      const edges = (np.edges ?? []) as Extract<GeometricSelectionRef, { type: 'edge' }>[];
      if (!edges.length) {
        lastPreviewSigRef.current = null;
        setTransientPreviewFeature(null);
        return;
      }
      const preview: Feature = {
        id,
        name,
        type: 'fillet',
        parameters: {
          targetFeatureId: String(np.targetFeatureId ?? edges[0]?.featureId ?? ''),
          radius: Math.max(num(np.radius, 1), 0.001),
          edges,
        },
      };
      const sig = JSON.stringify(preview);
      if (lastPreviewSigRef.current === sig) return;
      lastPreviewSigRef.current = sig;
      setTransientPreviewFeature(preview);
      return;
    }
    if (activeCommand === 'chamfer') {
      const edges = (np.edges ?? []) as Extract<GeometricSelectionRef, { type: 'edge' }>[];
      if (!edges.length) {
        lastPreviewSigRef.current = null;
        setTransientPreviewFeature(null);
        return;
      }
      const preview: Feature = {
        id,
        name,
        type: 'chamfer',
        parameters: {
          targetFeatureId: String(np.targetFeatureId ?? edges[0]?.featureId ?? ''),
          distance: Math.max(num(np.distance, 1), 0.001),
          edges,
        },
      };
      const sig = JSON.stringify(preview);
      if (lastPreviewSigRef.current === sig) return;
      lastPreviewSigRef.current = sig;
      setTransientPreviewFeature(preview);
      return;
    }
    lastPreviewSigRef.current = null;
    setTransientPreviewFeature(null);
  }, [activeFeature, activeCommand, np, resolveSketchId, setTransientPreviewFeature]);

  if (activeModule === 'sketch') return null;
  if (!activeFeature && !activeCommand) return null;

  const title = activeFeature ? activeFeature.name : `New ${formatCommandLabel(activeCommand)}`;

  const closeDialog = () => {
    setSelectedFeatureId(null);
    setActiveCommand(null);
    deactivateGeometricInput();
    setTransientPreviewFeature(null);
  };

  const handleSave = () => {
    if (activeFeature) { closeDialog(); return; }
    if (!activeCommand) return;
    const parseOrStop = (raw: string): number => {
      const n = evaluateToNumber(raw);
      return n ?? Number.NaN;
    };

    const id = `f${Date.now()}`;
    const name = `${formatCommandLabel(activeCommand)} ${features.length + 1}`;
    let feature: Feature | null = null;
    const axisLineFromFeatureId = (axisFeatureId: string | null | undefined): { p: [number, number, number]; d: [number, number, number] } | null => {
      if (!axisFeatureId) return null;
      const af = axisFeatures.find((a) => a.id === axisFeatureId);
      if (!af) return null;
      const p = af.parameters;
      if (p.method === 'twoPoints') {
        const p1 = p.point1Id ? pointById.get(p.point1Id) : undefined;
        const p2 = p.point2Id ? pointById.get(p.point2Id) : undefined;
        if (!p1 || !p2) return null;
        const o: [number, number, number] = [p1.parameters.x, p1.parameters.y, p1.parameters.z];
        const dRaw: [number, number, number] = [
          p2.parameters.x - p1.parameters.x,
          p2.parameters.y - p1.parameters.y,
          p2.parameters.z - p1.parameters.z,
        ];
        const d = normalize(dRaw);
        if (!d) return null;
        return { p: o, d };
      }
      if (p.method === 'planePoint') {
        const pl = planeFromRef(p.planeRef ?? null);
        const pt = p.pointId ? pointById.get(p.pointId) : undefined;
        if (!pl || !pt) return null;
        const d = normalize(pl.n);
        if (!d) return null;
        return { p: [pt.parameters.x, pt.parameters.y, pt.parameters.z], d };
      }
      if (p.method === 'twoPlanes') {
        const pa = planeFromRef(p.planeRefA ?? null);
        const pb = planeFromRef(p.planeRefB ?? null);
        if (!pa || !pb) return null;
        const dRaw = cross(pa.n, pb.n);
        const d = normalize(dRaw);
        if (!d) return null;
        const dLenSq = dot(dRaw, dRaw);
        const term1 = scale(cross(pb.n, dRaw), pa.d);
        const term2 = scale(cross(dRaw, pa.n), pb.d);
        const origin = scale(add(term1, term2), 1 / dLenSq);
        return { p: origin, d };
      }
      return null;
    };
    const lineFromEdgeRef = (edge: Extract<GeometricSelectionRef, { type: 'edge' }> | null | undefined):
      { p: [number, number, number]; d: [number, number, number] } | null => {
      if (!edge) return null;
      const d = normalize(edge.direction);
      if (!d) return null;
      return { p: edge.midpoint, d };
    };
    const intersectLinePlane = (
      lp: [number, number, number],
      ld: [number, number, number],
      n: [number, number, number],
      planeD: number
    ): [number, number, number] | null => {
      const denom = dot(n, ld);
      if (Math.abs(denom) < 1e-8) return null;
      const t = (planeD - dot(n, lp)) / denom;
      return add(lp, scale(ld, t));
    };
    const closestIntersectionOfLines = (
      a: { p: [number, number, number]; d: [number, number, number] },
      b: { p: [number, number, number]; d: [number, number, number] }
    ): [number, number, number] | null => {
      const n = cross(a.d, b.d);
      const nLenSq = dot(n, n);
      if (nLenSq < 1e-10) return null;
      const p21 = sub(b.p, a.p);
      const t = dot(cross(p21, b.d), n) / nLenSq;
      const u = dot(cross(p21, a.d), n) / nLenSq;
      const pa = add(a.p, scale(a.d, t));
      const pb = add(b.p, scale(b.d, u));
      const dist = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
      if (dist > 1e-3) return null;
      return scale(add(pa, pb), 0.5);
    };

    switch (activeCommand) {
      case 'sketch': {
        const { plane, offset } = geoRefToPlaneAndOffset(np.planeRef ?? null);
        const planeRef = isPlaneRef(np.planeRef ?? null) ? np.planeRef : planeToRef(plane);
        // Face plane position is fully defined by planeRef (normal + faceOffset). Storing
        // geoRefToPlaneAndOffset's `offset` would duplicate that distance when rendering.
        const planeOffset = planeRef.type === 'face' || planeRef.type === 'plane' ? 0 : offset;
        console.log('[CAD][CreateSketch]', {
          sourceRef: planeRef,
          resolvedPlane: plane,
          resolvedOffset: planeOffset,
        });
        feature = { id, name, type: 'sketch', parameters: { plane, planeOffset, planeRef } };
        break;
      }
      case 'extrude':
        {
          const sketchId = resolveSketchId(np.sketchId);
          console.log('[CAD][ResolveSketchForFeature]', {
            featureType: 'extrude',
            candidate: np.sketchId ?? null,
            commandPreselection,
            preferredSketchId,
            resolved: sketchId,
          });
          const height = parseOrStop(String(np.height ?? 10));
          const startOffset = parseOrStop(String(np.startOffset ?? 0));
          if (!Number.isFinite(height) || !Number.isFinite(startOffset)) return;
          feature = {
            id, name, type: 'extrude',
            parameters: {
              sketchId,
              height,
              reverse: !!np.reverse,
              symmetric: !!np.symmetric,
              startOffset,
            },
          };
        }
        break;
      case 'plane':
        const method = np.method || 'offset';
        const offset = parseOrStop(String(np.offset ?? 0));
        if (!Number.isFinite(offset)) return;
        if (method === 'threePoints') {
          const p1 = String(np.point1Id ?? '');
          const p2 = String(np.point2Id ?? '');
          const p3 = String(np.point3Id ?? '');
          if (!p1 || !p2 || !p3) {
            setExprError('Select three points');
            return;
          }
          if (new Set([p1, p2, p3]).size < 3) {
            setExprError('Point 1, Point 2, and Point 3 must be different');
            return;
          }
        }
        feature = {
          id, name, type: 'plane',
          parameters: {
            method,
            reference: method === 'offset' ? (np.reference ?? null) : null,
            offset,
            point1Id: method === 'threePoints' ? (np.point1Id ?? null) : null,
            point2Id: method === 'threePoints' ? (np.point2Id ?? null) : null,
            point3Id: method === 'threePoints' ? (np.point3Id ?? null) : null,
          },
        };
        break;
      case 'point':
        {
          const method = np.pointMethod ?? 'coordinates';
          let x = Number.NaN;
          let y = Number.NaN;
          let z = Number.NaN;
          if (method === 'coordinates') {
            x = parseOrStop(String(np.x ?? 0));
            y = parseOrStop(String(np.y ?? 0));
            z = parseOrStop(String(np.z ?? 0));
          } else if (method === 'offsetPoint') {
            const baseId = String(np.basePointId ?? '');
            const base = pointById.get(baseId);
            if (!base) {
              setExprError('Select base point');
              return;
            }
            const dx = parseOrStop(String(np.dx ?? 0));
            const dy = parseOrStop(String(np.dy ?? 0));
            const dz = parseOrStop(String(np.dz ?? 0));
            if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return;
            x = base.parameters.x + dx;
            y = base.parameters.y + dy;
            z = base.parameters.z + dz;
          } else if (method === 'planeAxisIntersection') {
            const pl = planeFromRef(np.planeRef ?? null);
            if (!pl) {
              setExprError('Select plane or face');
              return;
            }
            const line =
              np.lineSourceType === 'edge'
                ? lineFromEdgeRef(np.edgeRef ?? null)
                : axisLineFromFeatureId(np.axisFeatureId ?? null);
            if (!line) {
              setExprError('Select axis/edge');
              return;
            }
            const hit = intersectLinePlane(line.p, line.d, pl.n, pl.d);
            if (!hit) {
              setExprError('Selected line is parallel to plane');
              return;
            }
            [x, y, z] = hit;
          } else if (method === 'twoAxesIntersection') {
            const lineA =
              np.lineAType === 'edge'
                ? lineFromEdgeRef(np.edgeRefA ?? null)
                : axisLineFromFeatureId(np.axisFeatureIdA ?? null);
            const lineB =
              np.lineBType === 'edge'
                ? lineFromEdgeRef(np.edgeRefB ?? null)
                : axisLineFromFeatureId(np.axisFeatureIdB ?? null);
            if (!lineA || !lineB) {
              setExprError('Select both axes/edges');
              return;
            }
            const hit = closestIntersectionOfLines(lineA, lineB);
            if (!hit) {
              setExprError('Selected lines are parallel or do not intersect');
              return;
            }
            [x, y, z] = hit;
          }
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
          feature = {
            id, name, type: 'point',
            parameters: {
              x,
              y,
              z,
              method,
              ...(method === 'offsetPoint'
                ? {
                    basePointId: np.basePointId ?? null,
                    dx: Number(np.dx ?? 0),
                    dy: Number(np.dy ?? 0),
                    dz: Number(np.dz ?? 0),
                  }
                : {}),
              ...(method === 'planeAxisIntersection'
                ? {
                    planeRef: isPlaneRef(np.planeRef ?? null) ? np.planeRef : null,
                    axisFeatureId: np.lineSourceType === 'axis' ? (np.axisFeatureId ?? null) : null,
                    edgeRef: np.lineSourceType === 'edge' && isEdgeRef(np.edgeRef ?? null) ? np.edgeRef : null,
                  }
                : {}),
              ...(method === 'twoAxesIntersection'
                ? {
                    axisFeatureIdA: np.lineAType === 'axis' ? (np.axisFeatureIdA ?? null) : null,
                    axisFeatureIdB: np.lineBType === 'axis' ? (np.axisFeatureIdB ?? null) : null,
                    edgeRefA: np.lineAType === 'edge' && isEdgeRef(np.edgeRefA ?? null) ? np.edgeRefA : null,
                    edgeRefB: np.lineBType === 'edge' && isEdgeRef(np.edgeRefB ?? null) ? np.edgeRefB : null,
                  }
                : {}),
            },
          };
        }
        break;
      case 'axis':
        feature = {
          id, name, type: 'axis',
          parameters: {
            method: np.method || 'twoPoints',
            point1Id: np.point1Id ?? null,
            point2Id: np.point2Id ?? null,
            pointId: np.pointId ?? null,
            planeRef: isPlaneRef(np.planeRef ?? null) ? np.planeRef : null,
            planeRefA: isPlaneRef(np.planeRefA ?? null) ? np.planeRefA : null,
            planeRefB: isPlaneRef(np.planeRefB ?? null) ? np.planeRefB : null,
          },
        };
        break;
      case 'cut':
        {
          const sketchId = resolveSketchId(np.sketchId);
          console.log('[CAD][ResolveSketchForFeature]', {
            featureType: 'cut',
            candidate: np.sketchId ?? null,
            commandPreselection,
            preferredSketchId,
            resolved: sketchId,
          });
          const depth = parseOrStop(String(np.depth ?? 10));
          const startOffset = parseOrStop(String(np.startOffset ?? 0));
          if (!Number.isFinite(depth) || !Number.isFinite(startOffset)) return;
          feature = {
            id, name, type: 'cut',
            parameters: {
              sketchId,
              depth,
              reverse: !!np.reverse,
              symmetric: !!np.symmetric,
              startOffset,
            },
          };
        }
        break;
      case 'revolve':
      case 'revolveCut':
        {
          const sketchId = resolveSketchId(np.sketchId);
          console.log('[CAD][ResolveSketchForFeature]', {
            featureType: activeCommand,
            candidate: np.sketchId ?? null,
            commandPreselection,
            preferredSketchId,
            resolved: sketchId,
          });
          const angle = parseOrStop(String(np.angle ?? 360));
          const startOffset = parseOrStop(String(np.startOffset ?? 0));
          if (!Number.isFinite(angle) || !Number.isFinite(startOffset)) return;
          const axis: 'x' | 'y' | 'z' =
            np.axis === 'x' || np.axis === 'y' || np.axis === 'z' ? np.axis : 'z';
          feature = {
            id,
            name,
            type: activeCommand === 'revolveCut' ? 'revolveCut' : 'revolve',
            parameters: { sketchId, angle, axis, startOffset },
          };
        }
        break;
      case 'fillet':
        {
          const edges = (np.edges ?? []) as Extract<GeometricSelectionRef, { type: 'edge' }>[];
          if (!edges.length) {
            setExprError('Select at least one edge');
            return;
          }
          const radius = parseOrStop(String(np.radius ?? 1));
          if (!Number.isFinite(radius)) return;
          feature = {
            id, name, type: 'fillet',
            parameters: {
              targetFeatureId: String(np.targetFeatureId ?? edges[0]?.featureId ?? ''),
              radius,
              edges,
            },
          };
        }
        break;
      case 'chamfer':
        {
          const edges = (np.edges ?? []) as Extract<GeometricSelectionRef, { type: 'edge' }>[];
          if (!edges.length) {
            setExprError('Select at least one edge');
            return;
          }
          const distance = parseOrStop(String(np.distance ?? 1));
          if (!Number.isFinite(distance)) return;
          feature = {
            id, name, type: 'chamfer',
            parameters: {
              targetFeatureId: String(np.targetFeatureId ?? edges[0]?.featureId ?? ''),
              distance,
              edges,
            },
          };
        }
        break;
    }

    if (feature) {
      addFeature(feature);
      if (feature.type === 'extrude') {
        if (String(np.height ?? '').trim().startsWith('=')) {
          linkDimensionExpression({ kind: 'feature', featureId: feature.id, param: 'height' }, String(np.height).trim());
        }
        if (String(np.startOffset ?? '').trim().startsWith('=')) {
          linkDimensionExpression({ kind: 'feature', featureId: feature.id, param: 'startOffset' }, String(np.startOffset).trim());
        }
      } else if (feature.type === 'cut') {
        if (String(np.depth ?? '').trim().startsWith('=')) {
          linkDimensionExpression({ kind: 'feature', featureId: feature.id, param: 'depth' }, String(np.depth).trim());
        }
        if (String(np.startOffset ?? '').trim().startsWith('=')) {
          linkDimensionExpression({ kind: 'feature', featureId: feature.id, param: 'startOffset' }, String(np.startOffset).trim());
        }
      } else if (feature.type === 'plane') {
        if (String(np.offset ?? '').trim().startsWith('=')) {
          linkDimensionExpression({ kind: 'feature', featureId: feature.id, param: 'offset' }, String(np.offset).trim());
        }
      } else if (feature.type === 'revolve' || feature.type === 'revolveCut') {
        if (String(np.angle ?? '').trim().startsWith('=')) {
          linkDimensionExpression({ kind: 'feature', featureId: feature.id, param: 'angle' }, String(np.angle).trim());
        }
        if (String(np.startOffset ?? '').trim().startsWith('=')) {
          linkDimensionExpression({ kind: 'feature', featureId: feature.id, param: 'startOffset' }, String(np.startOffset).trim());
        }
      } else if (feature.type === 'fillet') {
        if (String(np.radius ?? '').trim().startsWith('=')) {
          linkDimensionExpression({ kind: 'feature', featureId: feature.id, param: 'radius' }, String(np.radius).trim());
        }
      } else if (feature.type === 'chamfer') {
        if (String(np.distance ?? '').trim().startsWith('=')) {
          linkDimensionExpression({ kind: 'feature', featureId: feature.id, param: 'distance' }, String(np.distance).trim());
        }
      }
      if (feature.type === 'sketch') { enterSketchMode(feature.id); return; }
    }
    closeDialog();
  };

  // ── render helpers ──────────────────────────────────────────────────────────

  const ExtrudeOrCutFields = ({ isNew, isExtrude }: { isNew: boolean; isExtrude: boolean }) => {
    const feat = isExtrude
      ? (activeFeature as ExtrudeFeature | undefined)
      : (activeFeature as CutFeature | undefined);
    const heightKey = isExtrude ? 'height' : 'depth';

    if (isNew) {
      return (
        <div className={sectionCls}>
          <SketchInput
            label="Sketch Profile"
            value={np.sketchId ?? preferredSketchId}
            sketches={sketches}
            fieldKey={`sketch_sketchId`}
            onChange={(sketchId) => updateNp({ sketchId })}
          />
          <div>
            <label className={labelCls}>{isExtrude ? 'Height (mm)' : 'Depth (mm)'}</label>
            <ExpressionNumberInput
              value={String(np[heightKey] ?? 10)}
              onValueChange={(v) => updateNp({ [heightKey]: v })}
              onCommit={(raw) => {
                const n = evaluateToNumber(raw);
                if (n !== null && !raw.trim().startsWith('=')) updateNp({ [heightKey]: String(n) });
              }}
              suggestions={parameterNames}
              evaluate={evalExpressionPreview}
            />
          </div>
          <div className="pt-1 border-t border-zinc-300 space-y-2.5">
            <p className="text-[10px] text-zinc-600 uppercase tracking-wider font-medium">Direction</p>
            <ToggleRow label="Reverse direction" icon={ArrowRightLeft} checked={!!np.reverse} onChange={(v) => updateNp({ reverse: v })} />
            <ToggleRow label="Symmetric" icon={ChevronsLeftRight} checked={!!np.symmetric} onChange={(v) => updateNp({ symmetric: v })} />
          </div>
          <div>
            <label className={labelCls}>Start Offset (mm)</label>
            <ExpressionNumberInput
              value={String(np.startOffset ?? 0)}
              onValueChange={(v) => updateNp({ startOffset: v })}
              onCommit={(raw) => {
                const n = evaluateToNumber(raw);
                if (n !== null && !raw.trim().startsWith('=')) updateNp({ startOffset: String(n) });
              }}
              suggestions={parameterNames}
              evaluate={evalExpressionPreview}
            />
          </div>
        </div>
      );
    }

    // Editing existing feature
    return (
      <div className={sectionCls}>
        <div>
          <label className={labelCls}>Sketch Profile</label>
          <select
            value={feat?.parameters.sketchId ?? ''}
            onChange={(e) => updateFeatureParameter(activeFeature!.id, 'sketchId', e.target.value)}
            className={inputCls}
          >
            {sketches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>{isExtrude ? 'Height (mm)' : 'Depth (mm)'}</label>
          <ExpressionNumberInput
            value={editFields[`${activeFeature!.id}:${heightKey}`] ?? getLinkedExpression(
              activeFeature!.id,
              heightKey,
              isExtrude ? (feat as ExtrudeFeature)?.parameters.height ?? 10 : (feat as CutFeature)?.parameters.depth ?? 10
            )}
            onValueChange={(v) => setEditFields((s) => ({ ...s, [`${activeFeature!.id}:${heightKey}`]: v }))}
            onCommit={(raw) => {
              const n = evaluateFeatureTargetValue(raw, activeFeature!.id, heightKey);
              if (n !== null) {
                updateFeatureParameter(activeFeature!.id, heightKey, n);
                setEditFields((s) => ({ ...s, [`${activeFeature!.id}:${heightKey}`]: raw.trim().startsWith('=') ? raw.trim() : String(n) }));
                if (raw.trim().startsWith('=')) {
                  linkDimensionExpression(
                    { kind: 'feature', featureId: activeFeature!.id, param: heightKey },
                    raw.trim()
                  );
                }
              }
            }}
            suggestions={parameterNames.filter((n) => n !== getFeatureTargetParamName(activeFeature!.id, heightKey))}
            evaluate={(raw) => evaluateInputExpression(raw, expressionEnv, getFeatureTargetParamName(activeFeature!.id, heightKey) ?? undefined)}
          />
        </div>
        <div className="pt-1 border-t border-zinc-300 space-y-2.5">
          <p className="text-[10px] text-zinc-600 uppercase tracking-wider font-medium">Direction</p>
          <ToggleRow
            label="Reverse direction" icon={ArrowRightLeft}
            checked={!!feat?.parameters.reverse}
            onChange={(v) => updateFeatureParameter(activeFeature!.id, 'reverse', v)}
          />
          <ToggleRow
            label="Symmetric" icon={ChevronsLeftRight}
            checked={!!feat?.parameters.symmetric}
            onChange={(v) => updateFeatureParameter(activeFeature!.id, 'symmetric', v)}
          />
        </div>
        <div>
          <label className={labelCls}>Start Offset (mm)</label>
          <ExpressionNumberInput
            value={editFields[`${activeFeature!.id}:startOffset`] ?? getLinkedExpression(
              activeFeature!.id,
              'startOffset',
              feat?.parameters.startOffset ?? 0
            )}
            onValueChange={(v) => setEditFields((s) => ({ ...s, [`${activeFeature!.id}:startOffset`]: v }))}
            onCommit={(raw) => {
              const n = evaluateFeatureTargetValue(raw, activeFeature!.id, 'startOffset');
              if (n !== null) {
                updateFeatureParameter(activeFeature!.id, 'startOffset', n);
                setEditFields((s) => ({ ...s, [`${activeFeature!.id}:startOffset`]: raw.trim().startsWith('=') ? raw.trim() : String(n) }));
                if (raw.trim().startsWith('=')) {
                  linkDimensionExpression(
                    { kind: 'feature', featureId: activeFeature!.id, param: 'startOffset' },
                    raw.trim()
                  );
                }
              }
            }}
            suggestions={parameterNames.filter((n) => n !== getFeatureTargetParamName(activeFeature!.id, 'startOffset'))}
            evaluate={(raw) => evaluateInputExpression(raw, expressionEnv, getFeatureTargetParamName(activeFeature!.id, 'startOffset') ?? undefined)}
          />
        </div>
      </div>
    );
  };

  const PlaneFields = ({ isNew }: { isNew: boolean }) => {
    const feat = activeFeature as PlaneFeature | undefined;
    const method = isNew ? (np.method ?? 'offset') : (feat?.parameters.method ?? 'offset');
    const reference = isNew ? (np.reference ?? null) : (feat?.parameters.reference ?? null);
    const offset = isNew ? (np.offset ?? 0) : (feat?.parameters.offset ?? 0);
    const point1Id = isNew ? (np.point1Id ?? '') : (feat?.parameters.point1Id ?? '');
    const point2Id = isNew ? (np.point2Id ?? '') : (feat?.parameters.point2Id ?? '');
    const point3Id = isNew ? (np.point3Id ?? '') : (feat?.parameters.point3Id ?? '');
    const setPlaneField = (key: 'point1Id' | 'point2Id' | 'point3Id', value: string) => {
      if (isNew) updateNp({ [key]: value });
      else updateFeatureParameter(activeFeature!.id, key, value);
    };

    return (
      <div className={sectionCls}>
        <div>
          <label className={labelCls}>Creation Method</label>
          <select
            value={method}
            onChange={(e) => isNew ? updateNp({ method: e.target.value }) : updateFeatureParameter(activeFeature!.id, 'method', e.target.value)}
            className={inputCls}
          >
            <option value="offset">By Offset from Plane / Face</option>
            <option value="threePoints">By Three Points</option>
          </select>
        </div>

        {method === 'offset' && (
          <>
            <GeometricInput
              label="Reference Plane / Face"
              value={reference}
              fieldKey="planeRef"
              onChange={(ref) => isNew ? updateNp({ reference: ref }) : updateFeatureParameter(activeFeature!.id, 'reference', ref)}
            />
            <div>
              <label className={labelCls}>Offset (mm)</label>
              {isNew ? (
                <ExpressionNumberInput
                  value={String(offset)}
                  onValueChange={(v) => updateNp({ offset: v })}
                  onCommit={(raw) => {
                    const n = evaluateToNumber(raw);
                    if (n !== null && !raw.trim().startsWith('=')) updateNp({ offset: String(n) });
                  }}
                  suggestions={parameterNames}
                  evaluate={evalExpressionPreview}
                />
              ) : (
                <ExpressionNumberInput
                  value={editFields[`${activeFeature!.id}:offset`] ?? getLinkedExpression(activeFeature!.id, 'offset', Number(offset))}
                  onValueChange={(v) => setEditFields((s) => ({ ...s, [`${activeFeature!.id}:offset`]: v }))}
                  onCommit={(raw) => {
                    const n = evaluateFeatureTargetValue(raw, activeFeature!.id, 'offset');
                    if (n !== null) {
                      updateFeatureParameter(activeFeature!.id, 'offset', n);
                      setEditFields((s) => ({ ...s, [`${activeFeature!.id}:offset`]: raw.trim().startsWith('=') ? raw.trim() : String(n) }));
                      if (raw.trim().startsWith('=')) {
                        linkDimensionExpression(
                          { kind: 'feature', featureId: activeFeature!.id, param: 'offset' },
                          raw.trim()
                        );
                      }
                    }
                  }}
                  suggestions={parameterNames.filter((n) => n !== getFeatureTargetParamName(activeFeature!.id, 'offset'))}
                  evaluate={(raw) => evaluateInputExpression(raw, expressionEnv, getFeatureTargetParamName(activeFeature!.id, 'offset') ?? undefined)}
                />
              )}
            </div>
          </>
        )}

        {method === 'threePoints' && (
          <div className="space-y-2">
            <PointRefInput
              label="Point 1"
              value={point1Id}
              points={points}
              fieldKey="planePoint1Ref"
              onChange={(id) => setPlaneField('point1Id', id)}
            />
            <PointRefInput
              label="Point 2"
              value={point2Id}
              points={points}
              fieldKey="planePoint2Ref"
              onChange={(id) => setPlaneField('point2Id', id)}
            />
            <PointRefInput
              label="Point 3"
              value={point3Id}
              points={points}
              fieldKey="planePoint3Ref"
              onChange={(id) => setPlaneField('point3Id', id)}
            />
            <p className="text-[11px] text-zinc-600">Pick three existing point features to define the plane.</p>
          </div>
        )}
      </div>
    );
  };

  const AxisFields = ({ isNew }: { isNew: boolean }) => {
    const feat = activeFeature as AxisFeature | undefined;
    const method = isNew ? (np.method ?? 'twoPoints') : (feat?.parameters.method ?? 'twoPoints');
    const getVal = (key: string) => (isNew ? np[key] : (feat?.parameters as any)?.[key]);

    return (
      <div className={sectionCls}>
        <div>
          <label className={labelCls}>Creation Method</label>
          <select
            value={method}
            onChange={(e) => isNew ? updateNp({ method: e.target.value }) : updateFeatureParameter(activeFeature!.id, 'method', e.target.value)}
            className={inputCls}
          >
            <option value="twoPoints">By Two Points</option>
            <option value="planePoint">By Plane and Point</option>
            <option value="twoPlanes">By Two Planes Intersection</option>
          </select>
        </div>

        {method === 'twoPoints' && (
          <>
            <div>
              <label className={labelCls}>Point 1</label>
              <select
                value={getVal('point1Id') ?? ''}
                onChange={(e) => isNew ? updateNp({ point1Id: e.target.value }) : updateFeatureParameter(activeFeature!.id, 'point1Id', e.target.value)}
                className={inputCls}
              >
                <option value="">Select point</option>
                {points.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Point 2</label>
              <select
                value={getVal('point2Id') ?? ''}
                onChange={(e) => isNew ? updateNp({ point2Id: e.target.value }) : updateFeatureParameter(activeFeature!.id, 'point2Id', e.target.value)}
                className={inputCls}
              >
                <option value="">Select point</option>
                {points.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </>
        )}

        {method === 'planePoint' && (
          <>
            <GeometricInput
              label="Plane / Face"
              value={isPlaneRef(getVal('planeRef') ?? null) ? getVal('planeRef') : null}
              fieldKey="axisPlaneRef"
              onChange={(ref) => {
                if (!isPlaneRef(ref)) return;
                isNew ? updateNp({ planeRef: ref }) : updateFeatureParameter(activeFeature!.id, 'planeRef', ref);
              }}
            />
            <div>
              <label className={labelCls}>Point</label>
              <select
                value={getVal('pointId') ?? ''}
                onChange={(e) => isNew ? updateNp({ pointId: e.target.value }) : updateFeatureParameter(activeFeature!.id, 'pointId', e.target.value)}
                className={inputCls}
              >
                <option value="">Select point</option>
                {points.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </>
        )}

        {method === 'twoPlanes' && (
          <>
            <GeometricInput
              label="Plane A"
              value={isPlaneRef(getVal('planeRefA') ?? null) ? getVal('planeRefA') : null}
              fieldKey="axisPlaneRefA"
              onChange={(ref) => {
                if (!isPlaneRef(ref)) return;
                isNew ? updateNp({ planeRefA: ref }) : updateFeatureParameter(activeFeature!.id, 'planeRefA', ref);
              }}
            />
            <GeometricInput
              label="Plane B"
              value={isPlaneRef(getVal('planeRefB') ?? null) ? getVal('planeRefB') : null}
              fieldKey="axisPlaneRefB"
              onChange={(ref) => {
                if (!isPlaneRef(ref)) return;
                isNew ? updateNp({ planeRefB: ref }) : updateFeatureParameter(activeFeature!.id, 'planeRefB', ref);
              }}
            />
          </>
        )}
      </div>
    );
  };

  const FilletOrChamferFields = ({ isNew, isFillet }: { isNew: boolean; isFillet: boolean }) => {
    const feat = isFillet
      ? (activeFeature as FilletFeature | undefined)
      : (activeFeature as ChamferFeature | undefined);
    const valueKey = isFillet ? 'radius' : 'distance';
    const valueLabel = isFillet ? 'Radius (mm)' : 'Distance (mm)';
    const selectedEdges = (isNew
      ? (np.edges ?? [])
      : (feat?.parameters.edges ?? [])) as Extract<GeometricSelectionRef, { type: 'edge' }>[];
    const currentTarget = isNew
      ? (np.targetFeatureId ?? selectedEdges[0]?.featureId ?? commandPreselection ?? solidTargetFeatures[solidTargetFeatures.length - 1]?.id ?? '')
      : (feat?.parameters.targetFeatureId ?? selectedEdges[0]?.featureId ?? '');
    const targetName = solidTargetFeatures.find((f) => f.id === currentTarget)?.name ?? (selectedEdges[0]?.featureName ?? 'None');
    const edgeFieldKey = isFillet ? 'filletEdges' : 'chamferEdges';
    const edgePickingActive = activeInputField === edgeFieldKey;

    const edgeEquals = (a: Extract<GeometricSelectionRef, { type: 'edge' }>, b: Extract<GeometricSelectionRef, { type: 'edge' }>) =>
      a.featureId === b.featureId &&
      Math.abs(a.midpoint[0] - b.midpoint[0]) < 1e-6 &&
      Math.abs(a.midpoint[1] - b.midpoint[1]) < 1e-6 &&
      Math.abs(a.midpoint[2] - b.midpoint[2]) < 1e-6;

    const setEdges = (nextEdges: Extract<GeometricSelectionRef, { type: 'edge' }>[]) => {
      const targetFeatureId = nextEdges[0]?.featureId ?? '';
      if (isNew) updateNp({ edges: nextEdges, targetFeatureId });
      else {
        updateFeatureParameter(activeFeature!.id, 'edges', nextEdges);
        updateFeatureParameter(activeFeature!.id, 'targetFeatureId', targetFeatureId);
      }
    };

    const beginEdgePicking = () => {
      setExprError('');
      activateGeometricInput(
        edgeFieldKey,
        (sel) => {
          if (!isEdgeRef(sel)) return;
          const baseTarget = selectedEdges[0]?.featureId ?? currentTarget;
          if (baseTarget && sel.featureId !== baseTarget) {
            setExprError('All selected edges must belong to the same target feature');
            return;
          }
          if (selectedEdges.some((e) => edgeEquals(e, sel))) {
            return;
          }
          const nextEdges = [...selectedEdges, sel];
          setEdges(nextEdges);
          useCadStore.setState((s) => {
            if (s.activeInputField !== edgeFieldKey || !s.activeInputOptions) return {};
            return {
              activeInputOptions: { ...s.activeInputOptions, preselected: nextEdges },
            };
          });
        },
        {
          preselected: selectedEdges,
          pickFromBeforeFeature: !isNew,
        },
      );
    };
    const currentValue = isNew
      ? String(np[valueKey] ?? 1)
      : (editFields[`${activeFeature!.id}:${valueKey}`] ?? getLinkedExpression(
          activeFeature!.id,
          valueKey,
          isFillet ? (feat as FilletFeature)?.parameters.radius ?? 1 : (feat as ChamferFeature)?.parameters.distance ?? 1
        ));

    return (
      <div className={sectionCls}>
        <div>
          <SelectionInput
            label="Selected Edges"
            displayText={selectedEdges.length > 0 ? `${selectedEdges.length} edge(s) selected` : 'Click to select edge(s)…'}
            fieldKey={edgeFieldKey}
            hasValue={selectedEdges.length > 0}
            onActivate={beginEdgePicking}
          />
          <p className="mt-1 text-[11px] text-zinc-600">
            {selectedEdges.length} selected • Target: {targetName}
          </p>
          {selectedEdges.length > 0 && (
            <div className="mt-2 max-h-28 overflow-auto space-y-1">
              {selectedEdges.map((e, i) => (
                <div key={`${e.featureId}-${e.midpoint.join('-')}-${i}`} className="flex items-center justify-between text-[11px] bg-white border border-zinc-200 rounded px-2 py-1">
                  <span className="truncate">Edge {i + 1}</span>
                  <button
                    type="button"
                    onClick={() => setEdges(selectedEdges.filter((_, idx) => idx !== i))}
                    className="text-zinc-500 hover:text-zinc-900"
                    title="Remove edge"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <label className={labelCls}>{valueLabel}</label>
          <ExpressionNumberInput
            value={currentValue}
            onValueChange={(v) => {
              if (isNew) updateNp({ [valueKey]: v });
              else setEditFields((s) => ({ ...s, [`${activeFeature!.id}:${valueKey}`]: v }));
            }}
            onCommit={(raw) => {
              if (isNew) {
                const n = evaluateToNumber(raw);
                if (n !== null && !raw.trim().startsWith('=')) updateNp({ [valueKey]: String(n) });
                return;
              }
              const n = evaluateFeatureTargetValue(raw, activeFeature!.id, valueKey);
              if (n !== null) {
                updateFeatureParameter(activeFeature!.id, valueKey, n);
                setEditFields((s) => ({ ...s, [`${activeFeature!.id}:${valueKey}`]: raw.trim().startsWith('=') ? raw.trim() : String(n) }));
                if (raw.trim().startsWith('=')) {
                  linkDimensionExpression(
                    { kind: 'feature', featureId: activeFeature!.id, param: valueKey },
                    raw.trim()
                  );
                }
              }
            }}
            suggestions={
              isNew
                ? parameterNames
                : parameterNames.filter((n) => n !== getFeatureTargetParamName(activeFeature!.id, valueKey))
            }
            evaluate={
              isNew
                ? evalExpressionPreview
                : (raw) => evaluateInputExpression(raw, expressionEnv, getFeatureTargetParamName(activeFeature!.id, valueKey) ?? undefined)
            }
          />
        </div>
      </div>
    );
  };

  // ── content body ────────────────────────────────────────────────────────────
  const renderContent = () => {
    if (activeFeature) {
      switch (activeFeature.type) {
        case 'sketch': {
          const skFeat = activeFeature as SketchFeature;
          const skPlaneRef = skFeat.parameters.planeRef;
          return (
            <div className={sectionCls}>
              <GeometricInput
                label="Sketch Plane"
                value={isPlaneRef(skPlaneRef ?? null) && skPlaneRef ? skPlaneRef : planeToRef(skFeat.parameters.plane)}
                fieldKey="sketchPlaneEdit"
                onChange={(ref) => {
                  const r = geoRefToPlaneAndOffset(ref);
                  updateFeatureParameter(activeFeature.id, 'plane', r.plane);
                  updateFeatureParameter(activeFeature.id, 'planeOffset', ref.type === 'face' || ref.type === 'plane' ? 0 : r.offset);
                  if (isPlaneRef(ref)) {
                    updateFeatureParameter(activeFeature.id, 'planeRef', ref);
                  }
                }}
              />
              <button
                onClick={() => enterSketchMode(activeFeature.id)}
                className="w-full bg-blue-600 hover:bg-blue-500 text-white py-2 rounded text-sm font-medium transition-colors"
              >
                Edit Sketch
              </button>
            </div>
          );
        }
        case 'extrude': return ExtrudeOrCutFields({ isNew: false, isExtrude: true });
        case 'cut':     return ExtrudeOrCutFields({ isNew: false, isExtrude: false });
        case 'plane':   return PlaneFields({ isNew: false });
        case 'point':
          return (
            <div className={sectionCls}>
              {(['x', 'y', 'z'] as const).map((axis) => (
                <div key={axis}>
                  <label className={`${labelCls} uppercase`}>{axis} (mm)</label>
                  <input
                    type="number"
                    value={(activeFeature as PointFeature).parameters[axis]}
                    onChange={(e) => updateFeatureParameter(activeFeature.id, axis, Number(e.target.value))}
                    className={inputCls}
                  />
                </div>
              ))}
            </div>
          );
        case 'revolve':
        case 'revolveCut': {
          const feat = activeFeature as RevolveFeature | RevolveCutFeature;
          const so = feat.parameters.startOffset ?? 0;
          return (
            <div className={sectionCls}>
              <div>
                <label className={labelCls}>Sketch Profile</label>
                <select value={feat.parameters.sketchId} onChange={(e) => updateFeatureParameter(activeFeature.id, 'sketchId', e.target.value)} className={inputCls}>
                  {sketches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Axis</label>
                <select value={feat.parameters.axis} onChange={(e) => updateFeatureParameter(activeFeature.id, 'axis', e.target.value)} className={inputCls}>
                  <option value="x">X Axis</option>
                  <option value="y">Y Axis</option>
                  <option value="z">Z Axis</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Angle (deg)</label>
                <ExpressionNumberInput
                  value={editFields[`${activeFeature.id}:angle`] ?? getLinkedExpression(activeFeature.id, 'angle', feat.parameters.angle)}
                  onValueChange={(v) => setEditFields((s) => ({ ...s, [`${activeFeature.id}:angle`]: v }))}
                  onCommit={(raw) => {
                    const n = evaluateFeatureTargetValue(raw, activeFeature.id, 'angle');
                    if (n !== null) {
                      updateFeatureParameter(activeFeature.id, 'angle', n);
                      setEditFields((s) => ({ ...s, [`${activeFeature.id}:angle`]: raw.trim().startsWith('=') ? raw.trim() : String(n) }));
                      if (raw.trim().startsWith('=')) {
                        linkDimensionExpression(
                          { kind: 'feature', featureId: activeFeature.id, param: 'angle' },
                          raw.trim()
                        );
                      }
                    }
                  }}
                  suggestions={parameterNames.filter((n) => n !== getFeatureTargetParamName(activeFeature.id, 'angle'))}
                  evaluate={(raw) => evaluateInputExpression(raw, expressionEnv, getFeatureTargetParamName(activeFeature.id, 'angle') ?? undefined)}
                />
              </div>
              <div>
                <label className={labelCls}>Start Offset (mm)</label>
                <ExpressionNumberInput
                  value={editFields[`${activeFeature.id}:startOffset`] ?? getLinkedExpression(activeFeature.id, 'startOffset', so)}
                  onValueChange={(v) => setEditFields((s) => ({ ...s, [`${activeFeature.id}:startOffset`]: v }))}
                  onCommit={(raw) => {
                    const n = evaluateFeatureTargetValue(raw, activeFeature.id, 'startOffset');
                    if (n !== null) {
                      updateFeatureParameter(activeFeature.id, 'startOffset', n);
                      setEditFields((s) => ({ ...s, [`${activeFeature.id}:startOffset`]: raw.trim().startsWith('=') ? raw.trim() : String(n) }));
                      if (raw.trim().startsWith('=')) {
                        linkDimensionExpression(
                          { kind: 'feature', featureId: activeFeature.id, param: 'startOffset' },
                          raw.trim()
                        );
                      }
                    }
                  }}
                  suggestions={parameterNames.filter((n) => n !== getFeatureTargetParamName(activeFeature.id, 'startOffset'))}
                  evaluate={(raw) => evaluateInputExpression(raw, expressionEnv, getFeatureTargetParamName(activeFeature.id, 'startOffset') ?? undefined)}
                />
              </div>
            </div>
          );
        }
        case 'axis':
          return AxisFields({ isNew: false });
        case 'fillet':
          return FilletOrChamferFields({ isNew: false, isFillet: true });
        case 'chamfer':
          return FilletOrChamferFields({ isNew: false, isFillet: false });
        default: return null;
      }
    }

    // New feature creation
    switch (activeCommand) {
      case 'sketch':
        return (
          <div className={sectionCls}>
            <GeometricInput
              label="Sketch Plane"
              value={np.planeRef ?? null}
              fieldKey="sketchPlane"
              onChange={(ref) => updateNp({ planeRef: ref })}
            />
          </div>
        );
      case 'extrude': return ExtrudeOrCutFields({ isNew: true, isExtrude: true });
      case 'cut':     return ExtrudeOrCutFields({ isNew: true, isExtrude: false });
      case 'plane':   return PlaneFields({ isNew: true });
      case 'point':
        return (
          <div className={sectionCls}>
            <div>
              <label className={labelCls}>Creation Method</label>
              <select
                value={np.pointMethod ?? 'coordinates'}
                onChange={(e) => updateNp({ pointMethod: e.target.value })}
                className={inputCls}
              >
                <option value="coordinates">By Coordinates</option>
                <option value="offsetPoint">By Point + XYZ Offsets</option>
                <option value="planeAxisIntersection">By Plane/Face and Axis/Edge Intersection</option>
                <option value="twoAxesIntersection">By Two Non-Parallel Axes/Edges Intersection</option>
              </select>
            </div>
            {(np.pointMethod ?? 'coordinates') === 'coordinates' && (
              <>
                {(['x', 'y', 'z'] as const).map((axis) => (
                  <div key={axis}>
                    <label className={`${labelCls} uppercase`}>{axis} (mm)</label>
                    <input type="number" value={np[axis] ?? 0} onChange={(e) => updateNp({ [axis]: e.target.value })} className={inputCls} />
                  </div>
                ))}
              </>
            )}
            {(np.pointMethod ?? 'coordinates') === 'offsetPoint' && (
              <>
                <PointRefInput
                  label="Base Point"
                  value={np.basePointId ?? ''}
                  points={points}
                  fieldKey="pointBaseRef"
                  onChange={(id) => updateNp({ basePointId: id })}
                />
                {(['dx', 'dy', 'dz'] as const).map((axis) => (
                  <div key={axis}>
                    <label className={`${labelCls} uppercase`}>{axis} (mm)</label>
                    <input type="number" value={np[axis] ?? 0} onChange={(e) => updateNp({ [axis]: e.target.value })} className={inputCls} />
                  </div>
                ))}
              </>
            )}
            {(np.pointMethod ?? 'coordinates') === 'planeAxisIntersection' && (
              <>
                <GeometricInput
                  label="Plane / Face"
                  value={isPlaneRef(np.planeRef ?? null) ? np.planeRef : null}
                  fieldKey="pointPlaneRef"
                  onChange={(ref) => {
                    if (!isPlaneRef(ref)) return;
                    updateNp({ planeRef: ref });
                  }}
                />
                <div>
                  <label className={labelCls}>Line Source</label>
                  <select
                    value={np.lineSourceType ?? 'axis'}
                    onChange={(e) => updateNp({ lineSourceType: e.target.value })}
                    className={inputCls}
                  >
                    <option value="axis">Axis feature</option>
                    <option value="edge">Edge</option>
                  </select>
                </div>
                {(np.lineSourceType ?? 'axis') === 'axis' ? (
                  <div>
                    <label className={labelCls}>Axis Feature</label>
                    <select
                      value={np.axisFeatureId ?? ''}
                      onChange={(e) => updateNp({ axisFeatureId: e.target.value })}
                      className={inputCls}
                    >
                      <option value="">Select axis</option>
                      {axisFeatures.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                ) : (
                  <SelectionInput
                    label="Edge"
                    displayText={isEdgeRef(np.edgeRef ?? null) ? np.edgeRef.label : 'Click to select edge…'}
                    fieldKey="pointLineEdgeEdges"
                    hasValue={isEdgeRef(np.edgeRef ?? null)}
                    onActivate={() =>
                      activateGeometricInput(
                        'pointLineEdgeEdges',
                        (sel) => {
                          if (!isEdgeRef(sel)) return;
                          updateNp({ edgeRef: sel });
                        },
                        { preselected: isEdgeRef(np.edgeRef ?? null) ? [np.edgeRef!] : undefined },
                      )
                    }
                  />
                )}
              </>
            )}
            {(np.pointMethod ?? 'coordinates') === 'twoAxesIntersection' && (
              <>
                <div>
                  <label className={labelCls}>Line A Source</label>
                  <select
                    value={np.lineAType ?? 'axis'}
                    onChange={(e) => updateNp({ lineAType: e.target.value })}
                    className={inputCls}
                  >
                    <option value="axis">Axis feature</option>
                    <option value="edge">Edge</option>
                  </select>
                </div>
                {(np.lineAType ?? 'axis') === 'axis' ? (
                  <div>
                    <label className={labelCls}>Axis A</label>
                    <select
                      value={np.axisFeatureIdA ?? ''}
                      onChange={(e) => updateNp({ axisFeatureIdA: e.target.value })}
                      className={inputCls}
                    >
                      <option value="">Select axis</option>
                      {axisFeatures.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                ) : (
                  <SelectionInput
                    label="Edge A"
                    displayText={isEdgeRef(np.edgeRefA ?? null) ? np.edgeRefA.label : 'Click to select edge A…'}
                    fieldKey="pointLineAEdges"
                    hasValue={isEdgeRef(np.edgeRefA ?? null)}
                    onActivate={() =>
                      activateGeometricInput(
                        'pointLineAEdges',
                        (sel) => {
                          if (!isEdgeRef(sel)) return;
                          updateNp({ edgeRefA: sel });
                        },
                        { preselected: isEdgeRef(np.edgeRefA ?? null) ? [np.edgeRefA!] : undefined },
                      )
                    }
                  />
                )}

                <div>
                  <label className={labelCls}>Line B Source</label>
                  <select
                    value={np.lineBType ?? 'axis'}
                    onChange={(e) => updateNp({ lineBType: e.target.value })}
                    className={inputCls}
                  >
                    <option value="axis">Axis feature</option>
                    <option value="edge">Edge</option>
                  </select>
                </div>
                {(np.lineBType ?? 'axis') === 'axis' ? (
                  <div>
                    <label className={labelCls}>Axis B</label>
                    <select
                      value={np.axisFeatureIdB ?? ''}
                      onChange={(e) => updateNp({ axisFeatureIdB: e.target.value })}
                      className={inputCls}
                    >
                      <option value="">Select axis</option>
                      {axisFeatures.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                ) : (
                  <SelectionInput
                    label="Edge B"
                    displayText={isEdgeRef(np.edgeRefB ?? null) ? np.edgeRefB.label : 'Click to select edge B…'}
                    fieldKey="pointLineBEdges"
                    hasValue={isEdgeRef(np.edgeRefB ?? null)}
                    onActivate={() =>
                      activateGeometricInput(
                        'pointLineBEdges',
                        (sel) => {
                          if (!isEdgeRef(sel)) return;
                          updateNp({ edgeRefB: sel });
                        },
                        { preselected: isEdgeRef(np.edgeRefB ?? null) ? [np.edgeRefB!] : undefined },
                      )
                    }
                  />
                )}
              </>
            )}
          </div>
        );
      case 'axis':
        return AxisFields({ isNew: true });
      case 'revolve':
      case 'revolveCut':
        return (
          <div className={sectionCls}>
            <SketchInput
              label="Sketch Profile"
              value={np.sketchId ?? preferredSketchId}
              sketches={sketches}
              fieldKey="sketch_sketchId"
              onChange={(sketchId) => updateNp({ sketchId })}
            />
            <div>
              <label className={labelCls}>Axis</label>
              <select value={np.axis ?? 'z'} onChange={(e) => updateNp({ axis: e.target.value })} className={inputCls}>
                <option value="x">X Axis</option>
                <option value="y">Y Axis</option>
                <option value="z">Z Axis</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Angle (deg)</label>
              <ExpressionNumberInput
                value={String(np.angle ?? 360)}
                onValueChange={(v) => updateNp({ angle: v })}
                onCommit={(raw) => {
                  const n = evaluateToNumber(raw);
                  if (n !== null && !raw.trim().startsWith('=')) updateNp({ angle: String(n) });
                }}
                suggestions={parameterNames}
                evaluate={evalExpressionPreview}
              />
            </div>
            <div>
              <label className={labelCls}>Start Offset (mm)</label>
              <ExpressionNumberInput
                value={String(np.startOffset ?? 0)}
                onValueChange={(v) => updateNp({ startOffset: v })}
                onCommit={(raw) => {
                  const n = evaluateToNumber(raw);
                  if (n !== null && !raw.trim().startsWith('=')) updateNp({ startOffset: String(n) });
                }}
                suggestions={parameterNames}
                evaluate={evalExpressionPreview}
              />
            </div>
          </div>
        );
      case 'fillet':
        return FilletOrChamferFields({ isNew: true, isFillet: true });
      case 'chamfer':
        return FilletOrChamferFields({ isNew: true, isFillet: false });
      default:
        return (
          <p className="text-xs text-zinc-600">
            Define parameters for <span className="font-semibold text-zinc-900">{activeCommand}</span>.
          </p>
        );
    }
  };

  const showFooter = !activeFeature || activeFeature.type !== 'sketch';

  return (
    <div className="w-72 h-full bg-zinc-50 border-l border-zinc-300 flex flex-col flex-shrink-0 z-20">
      {/* Header */}
      <div className="p-3 border-b border-zinc-300 bg-white flex justify-between items-center shrink-0">
        <h2 className="text-sm font-semibold text-zinc-900 capitalize">{title}</h2>
        <button onClick={closeDialog} className="text-zinc-500 hover:text-zinc-900 transition-colors p-1 rounded-md hover:bg-zinc-100">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-4">
        {renderContent()}
        {exprError && <p className="mt-2 text-xs text-red-500">{exprError}</p>}
      </div>

      {/* Pinned footer */}
      {showFooter && (
        <div className="p-3 border-t border-zinc-300 bg-white flex justify-end space-x-2 shrink-0">
          <button
            onClick={closeDialog}
            className="px-3 py-1.5 rounded text-xs font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded text-xs font-medium transition-colors"
          >
            OK
          </button>
        </div>
      )}
    </div>
  );
};
