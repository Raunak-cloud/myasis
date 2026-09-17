import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Placement {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
}

/**
 * The small "i" beside a label, and the note it opens.
 *
 * The note is rendered at the end of the document rather than inside the
 * label. Every panel here is a card with `overflow: hidden`, which clipped a
 * note opening near a card's bottom edge down to a black sliver with no text
 * in it. Measured against the viewport instead, it is never clipped by an
 * ancestor, flips above the icon when the space below is short, and stays
 * inside the screen on a phone.
 *
 * A tap opens it as well as a hover, because a phone has no hover and the
 * note was unreachable there.
 */
export function InfoTip({ label, help }: { label: string; help: string }) {
  const trigger = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<Placement | null>(null);

  const place = useCallback(() => {
    const element = trigger.current;
    if (!element) return;
    const at = element.getBoundingClientRect();
    const gap = 8;
    const edge = 12;
    const width = Math.max(160, Math.min(280, window.innerWidth - edge * 2));
    const left = Math.min(
      Math.max(edge, at.left + at.width / 2 - width / 2),
      Math.max(edge, window.innerWidth - edge - width),
    );
    // Below the icon by default, above it when the room below has run out.
    const room = window.innerHeight - at.bottom;
    setBox(room < 110 && at.top > room
      ? { left, width, bottom: window.innerHeight - at.top + gap }
      : { left, width, top: at.bottom + gap });
  }, []);

  const hide = useCallback(() => setBox(null), []);

  // A note measured against the viewport is wrong the moment the page moves under it.
  useEffect(() => {
    if (!box) return;
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [box, hide]);

  return (
    <span
      ref={trigger}
      className="field-info"
      tabIndex={0}
      role="button"
      aria-label={`${label}: ${help}`}
      onMouseEnter={place}
      onMouseLeave={hide}
      onFocus={place}
      onBlur={hide}
      onClick={() => (box ? hide() : place())}
      onKeyDown={(event) => {
        if (event.key === 'Escape') hide();
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (box) hide(); else place();
        }
      }}
    >
      i
      {box && createPortal(
        <span
          className="field-tooltip"
          role="tooltip"
          style={{ left: box.left, width: box.width, top: box.top, bottom: box.bottom }}
        >
          {help}
        </span>,
        document.body,
      )}
    </span>
  );
}

export function FieldLabel({ label, help, optional = false }: {
  label: string;
  help: string;
  optional?: boolean;
}) {
  return (
    <span className="field-label field-label-with-info">
      <span>
        {label}{optional && <span className="optional"> optional</span>}
      </span>
      <InfoTip label={label} help={help} />
    </span>
  );
}
