/** Small stroke icons for the whole ARCHFLOW UI (one set, one stroke weight). Decorative: buttons carry their own labels. */
type Props = { className?: string };

const Svg = ({ className = "h-4 w-4", children }: Props & { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
    {children}
  </svg>
);

export const ResetIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </Svg>
);
export const TopViewIcon = (p: Props) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
    <path d="M4 12h9M13 4v16" />
  </Svg>
);
export const PlusIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const MinusIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
);
export const ExpandIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Svg>
);
export const CollapseIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
  </Svg>
);
export const PanelIcon = (p: Props) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </Svg>
);
export const HelpIcon = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.3M12 17h.01" />
  </Svg>
);
export const WarningIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M12 3 2 20h20L12 3z" />
    <path d="M12 10v4M12 17h.01" />
  </Svg>
);
export const CheckIcon = (p: Props) => (
  <Svg {...p}>
    <path d="m5 12 5 5 9-10" />
  </Svg>
);
export const PlayIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M7 5v14l11-7z" />
  </Svg>
);
export const PauseIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M8 5v14M16 5v14" />
  </Svg>
);
export const PrevIcon = (p: Props) => (
  <Svg {...p}>
    <path d="m15 5-7 7 7 7" />
  </Svg>
);
export const NextIcon = (p: Props) => (
  <Svg {...p}>
    <path d="m9 5 7 7-7 7" />
  </Svg>
);
export const VRIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h15A1.5 1.5 0 0 1 21 8.5v6a1.5 1.5 0 0 1-1.5 1.5h-4l-2-2.5h-3l-2 2.5h-4A1.5 1.5 0 0 1 3 14.5z" />
    <circle cx="8" cy="11.5" r="1.4" />
    <circle cx="16" cy="11.5" r="1.4" />
  </Svg>
);
export const WalkIcon = (p: Props) => (
  <Svg {...p}>
    <circle cx="13" cy="4.5" r="1.8" />
    <path d="M10.5 21l2-6 3 3v3M12.5 15l-1-5.5 4 1.5 2 3M11.5 9.5L8 11l-1 3.5" />
  </Svg>
);
export const InfoIcon = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Svg>
);
export const CloseIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const ArrowRightIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);
export const ArrowLeftIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
);
export const ExternalIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Svg>
);
export const UploadIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M12 15V4m0 0L8 8m4-4 4 4M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
  </Svg>
);
export const PencilIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />
  </Svg>
);
export const TrashIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" />
  </Svg>
);
export const LinkIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Svg>
);
export const CopyIcon = (p: Props) => (
  <Svg {...p}>
    <rect x="8" y="8" width="12" height="12" rx="1.5" />
    <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
  </Svg>
);
/** A model in 3D: a simple axonometric box. */
export const CubeIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3z" />
    <path d="M4 7.5 12 12l8-4.5M12 12v9" />
  </Svg>
);
/** A floor plan: outer walls with a door gap and one interior wall. */
export const PlanIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M10 4H4v16h16V4h-6M12 4v8h8M4 13h4" />
  </Svg>
);
export const SparkIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
  </Svg>
);
