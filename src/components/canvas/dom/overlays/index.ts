// Barrel + side-effect imports for the overlay-utils package.
//
// Each overlay self-registers via registerOverlayUtil on import. Adding a
// new overlay is: create `./<name>.tsx` with a self-registering call,
// then append one `import './<name>'` line here.

import './agent-activity';

export { registerOverlayUtil, unregisterOverlayUtil, hasOverlayUtil, listOverlayUtils } from '../overlay-registry';
export type { OverlayUtil, OverlayUtilProps } from '../overlay-registry';
export { OverlayLayer } from '../OverlayLayer';
