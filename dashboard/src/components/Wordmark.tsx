import { MascotLogo } from './MascotLogo';

/**
 * The brand name as it is drawn: the owl at its laptop, in its tile, is the
 * "o" of "owtomate", followed by "wtomate" in a friendly script. The tile is
 * sized in em so it stays a letter at any font size. Read aloud as the word.
 */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`wordmark${className ? ` ${className}` : ''}`} role="img" aria-label="owtomate">
      <MascotLogo className="wordmark-owl" crop="laptop" />
      <span className="wordmark-ow">w</span>tomate
    </span>
  );
}
