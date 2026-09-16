export default function Home() {
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
      <h1 style={{ margin: 0, fontSize: '64px', letterSpacing: '2px' }}>Chinook</h1>
      <p style={{ margin: 0, fontSize: '20px', opacity: 0.8 }}>
        Alberta job search automation — S0 scaffold
      </p>
    </main>
  );
}
