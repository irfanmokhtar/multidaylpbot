import type { SVGProps } from "react";

type IcnProps = SVGProps<SVGSVGElement>;

export const Icon = {
  copy: (p: IcnProps) => (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1" {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <path d="M2 8.5V2.5A.5.5 0 0 1 2.5 2h6" />
    </svg>
  ),
  ext: (p: IcnProps) => (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1" {...p}>
      <path d="M5 2H2.5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V7" />
      <path d="M7 2h3v3" />
      <path d="M5.5 6.5L10 2" />
    </svg>
  ),
  chev: (p: IcnProps) => (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" {...p}>
      <path d="M4 3l3 3-3 3" />
    </svg>
  ),
  search: (p: IcnProps) => (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.2" {...p}>
      <circle cx="5" cy="5" r="3" />
      <path d="M7.5 7.5L10 10" />
    </svg>
  ),
  warn: (p: IcnProps) => (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.2" {...p}>
      <path d="M6 2L1.5 10h9L6 2z" />
      <path d="M6 5v2.5M6 8.6v.4" strokeLinecap="round" />
    </svg>
  ),
  x: (p: IcnProps) => (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" {...p}>
      <path d="M3 3l6 6M9 3l-6 6" />
    </svg>
  ),
  refresh: (p: IcnProps) => (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.2" {...p}>
      <path d="M2 6a4 4 0 0 1 7-2.6M10 6a4 4 0 0 1-7 2.6" />
      <path d="M9 1.5V3.5H7M3 10.5V8.5h2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};
