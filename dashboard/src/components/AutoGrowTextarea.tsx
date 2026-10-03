import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

/**
 * A textarea as tall as its text, so a filled-in field reads at a glance
 * instead of through a two-line window. `rows` is the height when empty; it
 * stops growing at `maxVh` of the screen and scrolls past that.
 *
 * CSS `field-sizing: content` does this natively but is not in every browser
 * yet, so the height is measured: on every change of value, and when the
 * field's width changes (a narrower field wraps into more lines).
 */
export function AutoGrowTextarea({ maxVh = 60, style, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { maxVh?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const border = el.offsetHeight - el.clientHeight;
    const cap = (window.innerHeight * maxVh) / 100;
    const wanted = el.scrollHeight + border;
    el.style.height = `${Math.min(wanted, cap)}px`;
    el.style.overflowY = wanted > cap ? 'auto' : 'hidden';
  };

  useLayoutEffect(fit, [props.value, maxVh]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return; // its own height change, not a new width
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return <textarea ref={ref} {...props} style={{ resize: 'none', ...style }} />;
}
