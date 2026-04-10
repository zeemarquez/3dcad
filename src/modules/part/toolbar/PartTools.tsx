import {
  Square,
  Circle,
  PenTool,
  Box,
  Scissors,
  RotateCw,
  CornerDownRight,
  Axis3d,
  SlidersHorizontal,
} from 'lucide-react';
import { useCadStore } from '@/modules/part/store/useCadStore';
import { ToolBtn, Sep } from './ToolBtn';
import { partIcons } from './partIcons';

export const PartTools = () => {
  const { activeCommand, setActiveCommand, openParametersDialog } = useCadStore();

  return (
    <div className="flex items-center gap-1">
      <ToolBtn
        icon={PenTool}
        label="Sketch"
        title="Sketch"
        showLabel={false}
        iconSrc={partIcons.sketch}
        active={activeCommand === 'sketch'}
        onClick={() => setActiveCommand(activeCommand === 'sketch' ? null : 'sketch')}
      />

      <Sep />

      {[
        { id: 'extrude', label: 'Extrude', icon: Box, iconSrc: partIcons.extrude },
        { id: 'cut', label: 'Cut', icon: Scissors, iconSrc: partIcons.cut },
        { id: 'revolve', label: 'Revolve', icon: RotateCw, iconSrc: partIcons.revolve },
        { id: 'revolveCut', label: 'Revolve cut', icon: Scissors, iconSrc: partIcons.revolveCut },
        { id: 'fillet', label: 'Fillet', icon: Circle, iconSrc: partIcons.fillet },
        { id: 'chamfer', label: 'Chamfer', icon: CornerDownRight, iconSrc: partIcons.chamfer },
      ].map((t) => (
        <ToolBtn
          key={t.id}
          icon={t.icon}
          label={t.label}
          title={t.label}
          showLabel={false}
          iconSrc={t.iconSrc}
          active={activeCommand === t.id}
          onClick={() => setActiveCommand(activeCommand === t.id ? null : t.id)}
        />
      ))}

      <Sep />

      {[
        { id: 'plane', label: 'Plane', icon: Square, iconSrc: partIcons.plane },
        { id: 'point', label: 'Point', icon: Circle, iconSrc: partIcons.point },
        { id: 'axis', label: 'Axis', icon: Axis3d, iconSrc: partIcons.axis },
      ].map((t) => (
        <ToolBtn
          key={t.id}
          icon={t.icon}
          label={t.label}
          title={t.label}
          showLabel={false}
          iconSrc={t.iconSrc}
          active={activeCommand === t.id}
          onClick={() => setActiveCommand(activeCommand === t.id ? null : t.id)}
        />
      ))}

      <Sep />
      <ToolBtn
        icon={SlidersHorizontal}
        label="Parameters"
        title="Parameters"
        showLabel={false}
        onClick={openParametersDialog}
      />
    </div>
  );
};
