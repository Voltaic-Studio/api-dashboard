import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'ApiFlora — Developer API Marketplace';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return new ImageResponse(
    <div
      style={{
        background: '#ffffff',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
        padding: '80px',
      }}
    >
      <div
        style={{
          color: '#FF9500',
          fontSize: 108,
          fontWeight: 800,
          letterSpacing: '-4px',
          lineHeight: 1,
        }}
      >
        ApiFlora
      </div>
      <div
        style={{
          color: '#1d1d1f',
          fontSize: 34,
          fontWeight: 400,
          marginTop: 28,
          textAlign: 'center',
          maxWidth: 700,
          lineHeight: 1.5,
          opacity: 0.6,
        }}
      >
        The definitive marketplace for developer APIs.
      </div>
    </div>,
    { ...size }
  );
}
