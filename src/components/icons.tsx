// Clean stroke icons (one consistent set) — currentColor, sized via prop.
type P = { size?: number };
const base = (size = 18) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": "true" as const,
});

export function IconMic({ size }: P) {
  return (
    <svg {...base(size)}>
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4" />
    </svg>
  );
}
export function IconWave({ size }: P) {
  return (
    <svg {...base(size)}>
      <path d="M3 12v0" />
      <path d="M7 8v8" />
      <path d="M11 5v14" />
      <path d="M15 9v6" />
      <path d="M19 11v2" />
    </svg>
  );
}
export function IconScan({ size }: P) {
  return (
    <svg {...base(size)}>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
export function IconCompass({ size }: P) {
  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.2 7.8 13.6 13.6 7.8 16.2 10.4 10.4" />
    </svg>
  );
}
export function IconShield({ size }: P) {
  return (
    <svg {...base(size)}>
      <path d="M12 2 4 5.2V11c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V5.2L12 2Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
export function IconHeart({ size }: P) {
  return (
    <svg {...base(size)}>
      <path d="M12 20s-6.5-4.3-9-8.2C1.2 8.7 2.6 5 6.2 5c2 0 3.2 1.2 4 2.3C11 6.2 12.2 5 14.2 5c3.6 0 5 3.7 3.2 6.8" />
      <path d="M21 12h-3l-1.6 3.2L13 9l-1.6 4H8.5" />
    </svg>
  );
}
export function IconDoc({ size }: P) {
  return (
    <svg {...base(size)}>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M5 3h9l5 5v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  );
}
export function IconSparkle({ size }: P) {
  return (
    <svg {...base(size)}>
      <path d="M12 3l1.7 4.8L18.5 9.5l-4.8 1.7L12 16l-1.7-4.8L5.5 9.5l4.8-1.7L12 3Z" />
      <path d="M19 14l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z" />
    </svg>
  );
}
export function IconLayers({ size }: P) {
  return (
    <svg {...base(size)}>
      <path d="M12 2 2 7l10 5 10-5-10-5Z" />
      <path d="m2 12 10 5 10-5" />
      <path d="m2 17 10 5 10-5" />
    </svg>
  );
}
export function IconLock({ size }: P) {
  return (
    <svg {...base(size)}>
      <rect x="4" y="10" width="16" height="11" rx="2.2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
export function IconCheck({ size }: P) {
  return (
    <svg {...base(size)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
export function IconArrow({ size }: P) {
  return (
    <svg {...base(size)}>
      <path d="M5 12h14" />
      <path d="m13 5 7 7-7 7" />
    </svg>
  );
}
export function IconLink({ size }: P) {
  return (
    <svg {...base(size)}>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M11 6.2 12.8 4.4a4 4 0 1 1 5.7 5.7l-1.8 1.8" />
      <path d="M13 17.8 11.2 19.6a4 4 0 1 1-5.7-5.7l1.8-1.8" />
    </svg>
  );
}
export function IconAlert({ size }: P) {
  return (
    <svg {...base(size)}>
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </svg>
  );
}
export function IconLogout({ size }: P) {
  return (
    <svg {...base(size)}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}
