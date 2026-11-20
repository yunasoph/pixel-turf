import { BrowserRouter, Routes, Route } from "react-router-dom";
import GamePage from "./pages/Game";
import OnlinePage from "./pages/Online";
import { BgLoop } from "./components/BgLoop";

function Home() {
  return (
    <>
      <BgLoop />

      <div className="lobby">
        <div className="card home-card">
          <h1 className="title">
            PIXEL
            <br />
            TURF
          </h1>

          <p className="home-tagline">
            Paint the grid. Steal rival tiles. Own the most territory when the
            timer ends.
          </p>

          <div className="home-actions">
            <a className="btn" href="/offline">
              Play Offline vs Bots
            </a>

            <a className="btn ghost" href="/online">
              Online Rooms
            </a>

            <a className="btn ghost" href="/online">
              Quick Play
            </a>
          </div>

          <div className="home-badges">
            <span className="home-badge">40×40 grid</span>
            <span className="home-badge">90s rounds</span>
            <span className="home-badge">Sprint + power-ups</span>
            <span className="home-badge">1–5 bots</span>
          </div>

          <p className="home-note">
            Online rooms use room codes and share links. Create a room, then
            open the link in another browser tab or device.
          </p>
        </div>
      </div>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/offline" element={<GamePage />} />
        <Route path="/online" element={<OnlinePage />} />
        <Route path="/r/:code" element={<OnlinePage />} />
      </Routes>
    </BrowserRouter>
  );
}
