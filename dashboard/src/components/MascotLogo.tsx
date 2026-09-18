interface MascotLogoProps {
  size?: number;
  className?: string;
  /**
   * `head` crops to the owl's head so it can stand in for a letter; the full
   * box leaves room around the head for the standalone mark; `laptop` is the
   * owl at work behind its laptop, in a rounded tile — the product's mark.
   */
  crop?: 'full' | 'head' | 'laptop';
  /** A script-style tail from the cheek into the next letter, in `currentColor`. */
  tail?: boolean;
}

export function MascotLogo({ size = 48, className = '', crop = 'full', tail = false }: MascotLogoProps) {
  if (crop === 'laptop') return <OwlAtLaptop size={size} className={className} />;
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

/**
 * The owl behind its laptop, in a rounded tile.
 *
 * The head is the same drawing as above, scaled down and sat behind the
 * laptop's lid so only the eyes and brow show over it, the way someone looks
 * up from a screen. The tile is a fixed light blue whatever the theme: a
 * mark keeps its colours, and this one is also the favicon.
 */
function OwlAtLaptop({ size, className }: { size: number; className: string }) {
  return (
    <svg
      className={`mascot-logo mascot-tile ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="1" width="62" height="62" rx="14" fill="#EAF3FC" stroke="#C9DDF2" strokeWidth="2" />
      <g className="mascot-head" transform="translate(12.2 3) scale(.62)">
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
        <path d="m28.7 40.4 3.3 2.3 3.3-2.3" stroke="#163F70" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <rect x="16" y="34" width="32" height="18" rx="2.5" fill="#FFFFFF" stroke="#14243D" strokeWidth="2" />
      <rect x="19.5" y="37.5" width="25" height="11" rx="1.2" fill="#DCEBFA" />
      <path d="M9 52h46l-3.2 6H12.2z" fill="#FFFFFF" stroke="#14243D" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
