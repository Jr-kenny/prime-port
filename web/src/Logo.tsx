// The PRIME PORT wordmark exactly as drawn in the prototype nav.
export function Logo({ ink, width = 112 }: { ink: string; width?: number }) {
  const height = Math.round((width / 220) * 60 * (22 / (112 / 220 * 60)));
  return (
    <svg width={width} height={height} viewBox="0 0 220 60" fill="none">
      <path d="M20 40C20 28.9543 28.9543 20 40 20H45V40H20Z" fill={ink} />
      <path d="M30 45C30 39.4771 34.4772 35 40 35H55V45C55 50.5228 50.5228 55 45 55H30V45Z" fill={ink} opacity="0.8" />
      <text x="65" y="37" fontFamily="-apple-system,system-ui,sans-serif" fontWeight="800" fontSize="19" fill={ink}>PRIME</text>
      <text x="65" y="52" fontFamily="-apple-system,system-ui,sans-serif" fontWeight="300" fontSize="14" letterSpacing="0.15em" fill={ink}>PORT</text>
    </svg>
  );
}

export function ThemeIcon({ dark, ink }: { dark: boolean; ink: string }) {
  if (dark) {
    return (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="5" stroke={ink} strokeWidth="1.8" />
        <g stroke={ink} strokeWidth="1.8" strokeLinecap="round">
          <line x1="12" y1="1.5" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="22.5" />
          <line x1="1.5" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="22.5" y2="12" />
          <line x1="4.5" y1="4.5" x2="6.2" y2="6.2" /><line x1="17.8" y1="17.8" x2="19.5" y2="19.5" />
          <line x1="4.5" y1="19.5" x2="6.2" y2="17.8" /><line x1="17.8" y1="6.2" x2="19.5" y2="4.5" />
        </g>
      </svg>
    );
  }
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" fill={ink} />
    </svg>
  );
}

export function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l6-6C33.6 6 29 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.4-.1-2.7-.4-3.5Z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.6 15.8 18.9 13 24 13c3.1 0 5.8 1.1 8 3l6-6C33.6 6 29 4 24 4 16 4 9 8.5 6.3 14.7Z" />
      <path fill="#4CAF50" d="M24 44c5 0 9.5-1.9 12.9-5l-6-5c-2 1.4-4.5 2.2-6.9 2.2-5.2 0-9.6-3.3-11.2-8l-6.5 5C9 39.5 16 44 24 44Z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6 5C40.5 35.9 44 30.4 44 24c0-1.4-.1-2.7-.4-3.5Z" />
    </svg>
  );
}
