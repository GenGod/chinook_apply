export default function Home() {
  // Fixed box sizes keep the snapshot deterministic across OS font metrics
  // (text is masked in the e2e visual gate; see tests/e2e/s0-smoke.spec.ts).
  const fixedBox = { width: 640, height: 96 } as const;
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '12px',
        background: '#0d1b2a',
        color: '#e0e6ed',
      }}
    >
      <h1 style={{ ...fixedBox, margin: 0, fontSize: '64px', lineHeight: '96px', letterSpacing: '2px' }}>
        Chinook
      </h1>
      <p style={{ ...fixedBox, margin: 0, fontSize: '20px', lineHeight: '96px', opacity: 0.8 }}>
        Alberta job search automation — S0 scaffold
      </p>
    </main>
  );
}
