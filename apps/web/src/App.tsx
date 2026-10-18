import { useEffect, useState } from 'react';
import { TPS, COLORS } from '@pixel-turf/shared';

function App() {
  const [health, setHealth] = useState<string>('Checking...');

  useEffect(() => {
    fetch('/health')
      .then(res => res.json())
      .then(data => setHealth(`Server Status: ${data.status} (${data.time})`))
      .catch(() => setHealth('Server Offline'));
  }, []);

  return (
    <div style={{ fontFamily: 'Inter, sans-serif', padding: '2rem', color: '#e8ebff', background: '#0b0e1a', minHeight: '100vh' }}>
      <h1 style={{ fontFamily: '"Press Start 2P", monospace', background: 'linear-gradient(90deg,#ff6b6b,#ffc145,#4ade9c,#4cc9f0,#a78bfa)', WebkitBackgroundClip: 'text', color: 'transparent' }}>
        PIXEL TURF
      </h1>
      <p>M0 Scaffold Complete. Shared TPS: {TPS}</p>
      <p>Primary Color: {COLORS[0]}</p>
      <p style={{ marginTop: '2rem', padding: '1rem', background: '#141830', borderRadius: '8px' }}>{health}</p>
    </div>
  );
}

export default App;
