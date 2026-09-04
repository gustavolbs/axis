import {
  BriefcaseBusiness,
  Building2,
  Code2,
  GraduationCap,
  HeartPulse,
  Landmark,
  Palette,
  Rocket
} from 'lucide-react';

import type { CompanyIconId } from './app-types.js';

export function CompanyIcon({ icon, size = 16 }: { icon: CompanyIconId; size?: number }) {
  if (icon === 'briefcase-business') return <BriefcaseBusiness size={size} />;
  if (icon === 'code-2') return <Code2 size={size} />;
  if (icon === 'rocket') return <Rocket size={size} />;
  if (icon === 'landmark') return <Landmark size={size} />;
  if (icon === 'heart-pulse') return <HeartPulse size={size} />;
  if (icon === 'graduation-cap') return <GraduationCap size={size} />;
  if (icon === 'palette') return <Palette size={size} />;
  return <Building2 size={size} />;
}
