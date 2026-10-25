import type { ReactNode, SVGProps } from "react";

/** Íconos de línea, del mismo trazo que los de Mimo. */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 24, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const HomeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
    <path d="M9 16h6" />
  </Icon>
);

export const AlbumIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="6.5" width="14" height="13" rx="2" />
    <path d="M7 3.5h11.5a2 2 0 0 1 2 2V17" />
    <path d="m3.8 17 4.2-4.2 3.2 3.2 2.3-2.3 4.3 4.3" />
    <circle cx="13.5" cy="10.5" r="1.3" />
  </Icon>
);

export const ClapperIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="5" width="17" height="14.5" rx="2" />
    <path d="M3.5 9.5h17M8 5l2 4.5M13 5l2 4.5" />
  </Icon>
);

export const SettingsIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6" />
  </Icon>
);

export const CameraIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 8.5a2 2 0 0 1 2-2h2l1.5-2h5l1.5 2h2a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="13" r="3.6" />
  </Icon>
);

export const DownloadIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />
  </Icon>
);

export const VideoIcon = (p: IconProps) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <rect x="2.5" y="6.5" width="13" height="11" rx="2" />
    <path d="m16.5 10.2 5-3v9.6l-5-3z" />
  </Icon>
);

export const CheckCircleIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20.5 12A8.5 8.5 0 1 1 15 4.1" />
    <path d="m8 11.5 3.5 3.5L21 5.5" />
  </Icon>
);

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 5 8 12l7 7" />
  </Icon>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9 5 7 7-7 7" />
  </Icon>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const InfoIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.6v.2" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const PlayIcon = (p: IconProps) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <path d="M7 4.8v14.4c0 .8.9 1.3 1.6.8l11-7.2a1 1 0 0 0 0-1.6l-11-7.2C7.9 3.5 7 4 7 4.8z" />
  </Icon>
);

export const PauseIcon = (p: IconProps) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <rect x="6" y="4.5" width="4" height="15" rx="1.2" />
    <rect x="14" y="4.5" width="4" height="15" rx="1.2" />
  </Icon>
);

export const ScissorsIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6.5" cy="17.5" r="2.8" />
    <circle cx="17.5" cy="17.5" r="2.8" />
    <path d="M8.5 15.5 18 4M15.5 15.5 6 4" />
  </Icon>
);

export const SplitIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v18" />
    <rect x="3" y="7" width="6" height="10" rx="1.5" />
    <rect x="15" y="7" width="6" height="10" rx="1.5" />
  </Icon>
);

export const SpeedIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.2 16.5a8.5 8.5 0 1 1 15.6 0" />
    <path d="m12 13 4-4.5" />
    <circle cx="12" cy="13" r="1.2" fill="currentColor" />
  </Icon>
);

export const VolumeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18.2 6.5a8 8 0 0 1 0 11" />
  </Icon>
);

export const MuteIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path d="m16 9.5 5 5M21 9.5l-5 5" />
  </Icon>
);

export const LogIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="6" width="19" height="12" rx="3" />
    <path d="M6 9.5v5h2.3M11.8 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM19 10.2a2.3 2.3 0 0 0-1.8-.7c-1.4 0-2.3 1.1-2.3 2.5s.9 2.5 2.3 2.5c.9 0 1.8-.4 1.8-1.6v-.8h-1.5" />
  </Icon>
);

export const AspectIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <rect x="9" y="5" width="6" height="14" />
  </Icon>
);

export const CompareIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <path d="M12 3v18" />
    <path d="M12 5h6.5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H12z" fill="currentColor" fillOpacity={0.35} stroke="none" />
  </Icon>
);

export const TrashIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 6.5h15M9.5 6.5V4.8c0-.5.4-.8.8-.8h3.4c.5 0 .8.3.8.8v1.7M6.5 6.5l.8 12.2c.1 1 .9 1.8 1.9 1.8h5.6c1 0 1.8-.8 1.9-1.8l.8-12.2" />
  </Icon>
);

export const FolderIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </Icon>
);

export const UsbIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="7" y="9" width="10" height="12" rx="2" />
    <path d="M9 9V3.5h6V9M10.8 5.8h.1M13.2 5.8h.1" />
  </Icon>
);

export const WifiIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 9.2a13 13 0 0 1 18 0M6 12.5a8.5 8.5 0 0 1 12 0M9 15.7a4 4 0 0 1 6 0" />
    <circle cx="12" cy="19" r="1" fill="currentColor" />
  </Icon>
);

export const BluetoothIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m7 7.5 10 9-5 4.5V3l5 4.5-10 9" />
  </Icon>
);

export const GridIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </Icon>
);

export const ListIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 6.5h11M9 12h11M9 17.5h11" />
    <circle cx="4.8" cy="6.5" r="1" fill="currentColor" />
    <circle cx="4.8" cy="12" r="1" fill="currentColor" />
    <circle cx="4.8" cy="17.5" r="1" fill="currentColor" />
  </Icon>
);

export const PaletteIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="9" r="5" />
    <circle cx="15" cy="9" r="5" />
    <circle cx="12" cy="14.5" r="5" />
  </Icon>
);

export const ChipIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3" />
  </Icon>
);

export const SparkIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5z" />
  </Icon>
);

export const ExternalIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 4.5h5.5V10M19.5 4.5 11 13M17 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1H10" />
  </Icon>
);

export const SphereIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <ellipse cx="12" cy="12" rx="8.5" ry="3.4" />
    <path d="M12 3.5c2.4 2.3 3.5 5.1 3.5 8.5s-1.1 6.2-3.5 8.5c-2.4-2.3-3.5-5.1-3.5-8.5s1.1-6.2 3.5-8.5z" />
  </Icon>
);
