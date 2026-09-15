import { MascotLogo } from './MascotLogo';

/**
 * The brand name as it is drawn: the owl's face is the "o" of "owtomate",
 * joined to "wtomate" in a friendly script. The owl is cropped to its head,
 * leans with the letters, and a tail in the accent colour runs from its cheek
 * into the "w" the way script letters join, so the two read as one word.
 *
 * Size comes from wherever it is placed — the owl is sized in em so it stays
 * a letter at any font size. Read aloud as the word.
 */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`wordmark${className ? ` ${className}` : ''}`} role="img" aria-label="owtomate">
      <MascotLogo className="wordmark-owl" crop="head" tail />
      <span className="wordmark-ow">w</span>tomate
    </span>
  );
}
