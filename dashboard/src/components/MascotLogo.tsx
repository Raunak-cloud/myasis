interface MascotLogoProps {
  size?: number;
  className?: string;
  /**
   * `head` crops to the owl's head so it can stand in for a letter; the full
   * box leaves room around the head for the standalone mark.
   */
  crop?: 'full' | 'head';
  /** A script-style tail from the cheek into the next letter, in `currentColor`. */
  tail?: boolean;
}

export function MascotLogo({ size = 48, className = '', crop = 'full', tail = false }: MascotLogoProps) {
  return (
    <svg
      className={`mascot-logo ${className}`.trim()}
      width={crop === 'head' ? undefined : size}
      height={crop === 'head' ? undefined : size}
      viewBox={crop === 'head' ? '12 8 40 48' : '0 0 64 64'}
      fill="none"
      overflow="visible"
      aria-hidden="true"
      focusable="false"
    >
      <g className="mascot-head">
        <path d="M13.5 25.5 16.7 8.4l12 7.3a30 30 0 0 1 6.6 0l12-7.3 3.2 17.1Z" fill="#2466A8" />
        <path d="M15.6 15.1 17.2 10l5.8 4.1Z" fill="#78AFE2" />
        <path d="m48.4 15.1-1.6-5.1-5.8 4.1Z" fill="#78AFE2" />
        <path d="M51.5 31.3C51.5 46.9 42.8 56 32 56S12.5 46.9 12.5 31.3 20 14.4 32 14.4s19.5 1.3 19.5 16.9Z" fill="#2F73B9" />
        <ellipse cx="23.4" cy="31.1" rx="8.8" ry="9.4" fill="#F8FBFF" />
        <ellipse cx="40.6" cy="31.1" rx="8.8" ry="9.4" fill="#F8FBFF" />
        <g className="mascot-pupils" fill="#14243D">
          <circle cx="23.4" cy="31.4" r="3.8" />
          <circle cx="40.6" cy="31.4" r="3.8" />
        </g>
        <path className="mascot-smile" d="M21.1 45.1c3.2 2.5 6.8 3.8 10.9 3.8s7.7-1.3 10.9-3.8" stroke="#8FC3F0" strokeWidth="3.4" strokeLinecap="round" />
        <path d="m28.7 40.4 3.3 2.3 3.3-2.3" stroke="#163F70" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      {tail && (
        <path d="M47 44 C 52 50, 56 52, 61 47" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" fill="none" />
      )}
    </svg>
  );
}
