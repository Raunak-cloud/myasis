import { MascotLogo } from './MascotLogo';

/**
 * The story the landing page opens with: job hunting by hand against job
 * hunting with Owtomate, as two rows of steps.
 *
 * Drawn in the page's own sketch style rather than shipped as a picture, so
 * it stays sharp at any size, the captions are real text (they wrap, scale
 * and are read aloud), and it stacks into one column on a phone.
 */

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

function Arrow() {
  return (
    <span className="story-arrow" aria-hidden="true">
      <svg viewBox="0 0 36 18" width="36" height="18" {...stroke}>
        <path d="M2 9.5c8-2.5 16 2.5 24 0" />
        <path d="m20 3 7 6.4-7 6.4" />
      </svg>
    </span>
  );
}

function StackIcon() {
  return (
    <svg className="story-icon" viewBox="0 0 48 48" {...stroke}>
      <rect x="6" y="14" width="26" height="28" rx="3" fill="#fff" />
      <path d="M12 10h26v28" />
      <path d="M18 6h24v26" />
      <path d="M12 23h14M12 29h14M12 35h9" />
    </svg>
  );
}

function RejectedIcon() {
  return (
    <svg className="story-icon" viewBox="0 0 48 48" {...stroke}>
      <rect x="5" y="13" width="34" height="24" rx="3" fill="#fff" />
      <path d="m5 16 17 12 17-12" />
      <circle cx="38" cy="14" r="7.5" fill="#fff" stroke="#c8384a" />
      <path d="m34.8 10.8 6.4 6.4M41.2 10.8l-6.4 6.4" stroke="#c8384a" />
    </svg>
  );
}

function StressIcon() {
  return (
    <svg className="story-icon" viewBox="0 0 48 48" {...stroke}>
      <circle cx="24" cy="27" r="15" fill="#fff" />
      <path d="M17 24.5c1.2-1.4 3-1.4 4.2 0M26.8 24.5c1.2-1.4 3-1.4 4.2 0" />
      <path d="M17.5 34.5c3.6-3.4 9.4-3.4 13 0" />
      <path d="M32 6c2 1.6 2 3.4 0 5s-2 3.4 0 5" />
      <path d="M38 8c1.5 1.2 1.5 2.6 0 3.8" />
      <path d="M12 5.5c2 1.6 2 3.4 0 5" />
    </svg>
  );
}

function MatchIcon() {
  return (
    <svg className="story-icon" viewBox="0 0 48 48" {...stroke}>
      <rect x="5" y="9" width="34" height="30" rx="3" fill="#fff" />
      <circle cx="15" cy="20" r="4.2" />
      <path d="M23 17.5h10M23 23h8M12 31.5h20" />
      <circle cx="39" cy="12" r="7.5" fill="#e8f7ef" stroke="#1f8a5b" />
      <path d="m35.3 12.2 2.6 2.6 4.8-5" stroke="#1f8a5b" />
    </svg>
  );
}

function OwlAtLaptop() {
  return (
    <span className="story-owl" aria-hidden="true">
      <MascotLogo size={40} className="story-owl-face" />
      <svg className="story-laptop" viewBox="0 0 56 22" width="56" height="22" {...stroke}>
        <path d="M9 2h38v13H9z" fill="#fff" />
        <path d="M3 15h50l-3 5H6z" fill="#fff" />
      </svg>
    </span>
  );
}

function OutcomeIcon({ good }: { good: boolean }) {
  const colour = good ? '#1f8a5b' : '#c8384a';
  return (
    <svg className="story-outcome-icon" viewBox="0 0 32 24" width="32" height="24" {...stroke}>
      <rect x="1.5" y="3" width="24" height="18" rx="2.5" fill="#fff" />
      <path d="m1.5 5.5 12.5 9 12.5-9" />
      <circle cx="25.5" cy="6" r="5.5" fill="#fff" stroke={colour} />
      {good ? <path d="m22.7 6.2 1.9 1.9 3.5-3.7" stroke={colour} /> : <path d="m23.2 3.7 4.6 4.6M27.8 3.7l-4.6 4.6" stroke={colour} />}
    </svg>
  );
}

export function HeroStory() {
  return (
    <figure className="story" aria-label="Job hunting the old way against job hunting with Owtomate">
      <div className="story-row story-old">
        <p className="story-tagline">
          <span className="story-tag">The old way</span>
          <span className="story-note">Time-consuming and stressful</span>
        </p>
        <ol className="story-steps">
          <li className="story-step"><StackIcon /><span>Search and apply to job after job</span></li>
          <Arrow />
          <li className="story-step"><RejectedIcon /><span>Rejections pile up</span></li>
          <Arrow />
          <li className="story-step"><StressIcon /><span>Feel stressed and discouraged</span></li>
        </ol>
      </div>
      <div className="story-row story-new">
        <p className="story-tagline">
          <span className="story-tag">The Owtomate way</span>
          <span className="story-note">Smarter matching, less stress, more opportunities</span>
        </p>
        <ol className="story-steps">
          <li className="story-step"><OwlAtLaptop /><span>Owtomate finds jobs that fit and applies for you</span></li>
          <Arrow />
          <li className="story-step"><MatchIcon /><span>You get better job matches</span></li>
          <Arrow />
          <li className="story-fork">
            <span className="story-outcome bad"><OutcomeIcon good={false} /><span><strong>If rejected:</strong> keep going. More matches are already on the way.</span></span>
            <span className="story-outcome good"><OutcomeIcon good /><span><strong>If accepted:</strong> you got the job.</span></span>
          </li>
        </ol>
      </div>
    </figure>
  );
}
