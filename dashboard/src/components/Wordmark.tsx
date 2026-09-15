import { MascotLogo } from './MascotLogo';

/**
 * The brand name as it is drawn: the owl's face is the "o" of "owtomate",
 * followed by "wtomate" in a friendly script, with the "w" in the accent
 * colour so "ow" still reads as one.
 *
 * Size comes from wherever it is placed — the owl is sized in em so it stays a
 * letter at any font size. Read aloud as the word.
 */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`wordmark${className ? ` ${className}` : ''}`} role="img" aria-label="owtomate">
      <MascotLogo className="wordmark-owl" />
      <span className="wordmark-ow">w</span>tomate
    </span>
  );
}
