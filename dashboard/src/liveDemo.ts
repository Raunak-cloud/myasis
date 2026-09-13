/** Only enable after an actual run has been recorded, edited and verified. */
export const LIVE_DEMO = {
  available: true,
  src: '/demo/myasis-live-run.mp4?v=15s',
  poster: '/demo/myasis-live-run-poster.jpg?v=15s',
  captions: '/demo/myasis-live-run.vtt?v=15s',
};

/** The second hero window. Points at the same recording until the next one is cut. */
export const LIVE_DEMO_2 = {
  src: LIVE_DEMO.src,
  poster: LIVE_DEMO.poster,
  captions: LIVE_DEMO.captions,
};
