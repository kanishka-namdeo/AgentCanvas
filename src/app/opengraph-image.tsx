import { ImageResponse } from 'next/og';

export const alt = 'AgentCanvas — the open-source canvas where AI agents do the drawing';

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = 'image/png';

/** OG image for `/` (spec §3). Dark ground, brand-gradient accent bar
 * (violet → fuchsia, matching --ac-brand-from/to), product name + tagline.
 * Satori requires explicit flex styles; ImageResponse's bundled default font
 * covers the Latin copy — no font embedding needed. */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '80px',
          backgroundColor: '#0a0a0f',
          backgroundImage:
            'radial-gradient(circle at 75% 20%, rgba(168,85,247,0.22), transparent 55%)',
        }}
      >
        <div
          style={{
            display: 'flex',
            width: '160px',
            height: '10px',
            borderRadius: '9999px',
            backgroundImage: 'linear-gradient(to bottom right, #8b5cf6, #d946ef)',
            marginBottom: '40px',
          }}
        />
        <div style={{ display: 'flex', fontSize: 72, fontWeight: 700, color: '#ffffff', letterSpacing: '-2px' }}>
          AgentCanvas
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 34,
            color: 'rgba(255,255,255,0.72)',
            marginTop: '24px',
            maxWidth: '860px',
          }}
        >
          The open-source canvas where AI agents do the drawing — and you direct.
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 22,
            color: 'rgba(255,255,255,0.45)',
            marginTop: '48px',
          }}
        >
          Figma for AI agents · AGPL-3.0 · github.com/kanishka-namdeo/co-canvas
        </div>
      </div>
    ),
    size,
  );
}
