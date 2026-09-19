/** Shared play/pause driver for the landing's decorative videos (Hero +
 * FeatureGallery). One recipe for "only decode while the section is on
 * screen": the caller decides visibility with motion's `useInView` and hands
 * the element here.
 *
 * Autoplay attributes stay on the element (the video is the money shot the
 * moment it paints); this only stops an offscreen element from keeping its
 * decoder alive.
 */
export function setVideoPlaying(video: HTMLVideoElement | null, play: boolean): void {
  if (!video) return;
  // `canPlayType` doubles as the "real media stack present" probe: every
  // browser answers for video/mp4, while jsdom (unit tests) returns '' and
  // would raise a "not implemented" jsdom error for play()/pause().
  if (typeof video.canPlayType !== 'function' || !video.canPlayType('video/mp4')) return;
  if (play) {
    if (video.paused) void video.play().catch(() => {});
  } else if (!video.paused) {
    video.pause();
  }
}
