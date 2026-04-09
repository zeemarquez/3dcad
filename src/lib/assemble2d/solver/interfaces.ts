export interface SolverResult {
  points: {
    id: string;
    x: number;
    y: number;
  }[];
}

export interface SolverInfo {
  points: {
    id: string;
    x: number;
    y: number;
  }[];
  constraints: ConstraintInfo[];
}

type ConstraintInfo = | 
  CoincidentInfo |
  ConcentricInfo;

export interface CoincidentInfo {
  type: "coincident";
  p0: string;
  p1: string;
}

export interface ConcentricInfo {
  type: "concentric";
  c0: string;
  c1: string;
}